import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { GithubActionsExecutor, RunRegistry } from '../src/actions-executor.js';
import { actionsRunDir, dispatchRequest } from '../src/actions.js';
import { createApp } from '../src/app.js';
import { EventBus } from '../src/events.js';
import { createMemoryStores } from '../src/repo/memory.js';

test('the actions run directory is relative so a Linux runner can create it', () => {
  assert.equal(actionsRunDir('318db5db-61b2-4502-8b72-ee8d2725d441'), 'runs/318db5db-61b2-4502-8b72-ee8d2725d441');
  assert.equal(actionsRunDir('318db5db-61b2-4502-8b72-ee8d2725d441').includes('\\'), false);
  assert.throws(() => actionsRunDir('C:\\Users\\runs'), /uuid/);
});

test('dispatch keeps the token out of the URL', () => {
  const request = dispatchRequest({
    owner: 'acme',
    repo: 'demo',
    ref: 'main',
    jobId: 'job-1',
    callbackUrl: 'https://perfpilot.example',
    token: 'secret-token',
  });
  assert.equal(request.url.includes('secret-token'), false);
  assert.match(request.url, /perfpilot-job\.yml\/dispatches$/);
  const body = JSON.parse(String(request.init.body)) as { inputs: { job_id: string; callback_url: string } };
  assert.equal(body.inputs.job_id, 'job-1');
  assert.equal(body.inputs.callback_url, 'https://perfpilot.example');
  assert.throws(() => dispatchRequest({ owner: 'acme', repo: '../x', ref: 'main', jobId: 'j', callbackUrl: 'https://x', token: 't' }), /not allowed/);
});

test('the actions executor dispatches once and records the posted result', async () => {
  const stores = createMemoryStores();
  const project = await stores.projects.create({ name: 'URL', mode: 'url', url: 'http://localhost:4200/' });
  const job = await stores.jobs.create({ projectId: project.id, type: 'field', params: { runs: 1 } });
  const calls: string[] = [];
  const actions = new GithubActionsExecutor({
    stores,
    bus: new EventBus(),
    owner: 'acme',
    repo: 'demo',
    token: 'secret-token',
    callbackUrl: 'https://perfpilot.example',
    runs: new RunRegistry(),
    specFor: () => ({ jobId: job.id, type: 'field' }),
    fetchImpl: async (url) => {
      calls.push(String(url));
      return new Response(null, { status: 204 });
    },
  });
  await actions.start(job);
  await actions.start(job);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.includes('secret-token'), false);
  const running = await stores.jobs.get(job.id);
  assert.equal(running?.status, 'running');
  const app = createApp({
    config: { sessionSecret: 'test-secret', adminPassword: 'correct-password', clientOrigin: 'http://localhost:5173', nodeEnv: 'development' },
    stores,
    bus: new EventBus(),
    executor: actions,
    jobSecret: 'test-job-secret',
    actions,
  });
  const server: Server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const missing = await fetch(`${base}/api/internal/jobs/${job.id}/spec`);
    assert.equal(missing.status, 401);
    const spec = await fetch(`${base}/api/internal/jobs/${job.id}/spec`, { headers: { 'x-job-secret': 'test-job-secret' } });
    assert.equal(spec.status, 200);
    const posted = await fetch(`${base}/api/internal/jobs/${job.id}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-job-secret': 'test-job-secret' },
      body: JSON.stringify({ type: 'job-end', payload: { ok: true, field: { notes: [], psi: { score: 70 }, crux: null, url: 'http://localhost:4200/', origin: 'http://localhost:4200', fetchedAt: '2026-10-27T00:00:00.000Z' } } }),
    });
    assert.equal(posted.status, 200);
    const done = await stores.jobs.get(job.id);
    assert.equal(done?.status, 'succeeded');
    const again = await fetch(`${base}/api/internal/jobs/${job.id}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-job-secret': 'test-job-secret' },
      body: JSON.stringify({ type: 'log', payload: { line: 'late' } }),
    });
    const body = await again.json() as { result: string };
    assert.equal(body.result, 'closed');
    const rows = await stores.measurements.listByProject(project.id);
    assert.equal(rows.some((row) => row.profile === 'field'), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a second Actions run for the same job is rejected', async () => {
  const stores = createMemoryStores();
  const project = await stores.projects.create({ name: 'Repo', mode: 'repo', repoOwner: 'acme', repoName: 'demo', baseBranch: 'main' });
  const job = await stores.jobs.create({ projectId: project.id, type: 'optimize', params: { runs: 4 } });
  const runs = new RunRegistry();
  const actions = new GithubActionsExecutor({
    stores,
    bus: new EventBus(),
    owner: 'acme',
    repo: 'demo',
    token: 'secret-token',
    callbackUrl: 'https://perfpilot.example',
    runs,
    specFor: () => ({ jobId: job.id }),
    fetchImpl: async () => new Response(null, { status: 204 }),
  });
  await actions.start(job);
  const app = createApp({
    config: { sessionSecret: 'test-secret', adminPassword: 'correct-password', clientOrigin: 'http://localhost:5173', nodeEnv: 'development' },
    stores,
    bus: new EventBus(),
    executor: actions,
    jobSecret: 'test-job-secret',
    actions,
  });
  const server: Server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (runId: number) => fetch(`${base}/api/internal/jobs/${job.id}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-job-secret': 'test-job-secret' },
    body: JSON.stringify({ type: 'actions-run', payload: { runId } }),
  });
  try {
    const first = await post(11);
    assert.equal(first.status, 200);
    const second = await post(22);
    assert.equal(second.status, 409);
    assert.equal(runs.get(job.id), 11);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
