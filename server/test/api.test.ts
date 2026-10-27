import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { signSession } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { EventBus } from '../src/events.js';
import { createMemoryStores } from '../src/repo/memory.js';
import type { Executor } from '../src/executor.js';
import type { Job } from '../src/types.js';

const config = {
  sessionSecret: 'test-secret',
  adminPassword: 'correct-password',
  clientOrigin: 'http://localhost:5173',
  nodeEnv: 'development',
};

function fakeExecutor(): Executor & { started: Job[] } {
  const started: Job[] = [];
  return {
    started,
    async start(job) {
      started.push(job);
    },
    async cancel(jobId) {
      const stores = current.stores;
      await stores.jobs.update(jobId, { status: 'cancelled', finishedAt: new Date().toISOString(), error: null });
    },
    async recover() {
      return undefined;
    },
  };
}

const current: { stores: ReturnType<typeof createMemoryStores> } = { stores: createMemoryStores() };

async function boot() {
  current.stores = createMemoryStores();
  const bus = new EventBus();
  const executor = fakeExecutor();
  const app = createApp({ config, stores: current.stores, bus, executor });
  const server: Server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, base: `http://127.0.0.1:${port}`, bus, executor, stores: current.stores };
}

function cookieFrom(res: Response): string {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') ?? ''];
  return list.map((item) => item.split(';')[0]).filter(Boolean).join('; ');
}

test('loadConfig lists missing names and never values', () => {
  assert.throws(() => loadConfig({ ADMIN_PASSWORD: 'super-secret-value' }), (err: unknown) => {
    const message = err instanceof Error ? err.message : '';
    assert.match(message, /DATABASE_URL/);
    assert.match(message, /SESSION_SECRET/);
    assert.equal(message.includes('super-secret-value'), false);
    return true;
  });
});

test('login, me, logout, bad password, rate limit, and a tampered cookie', async () => {
  const { server, base } = await boot();
  try {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    const denied = await fetch(`${base}/api/me`);
    assert.equal(denied.status, 401);

    const bad = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'nope' }),
    });
    assert.equal(bad.status, 401);

    const good = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'correct-password' }),
    });
    assert.equal(good.status, 200);
    const cookie = cookieFrom(good);
    assert.match(cookie, /pp_session=/);
    const me = await fetch(`${base}/api/me`, { headers: { cookie } });
    assert.equal(me.status, 200);
    const loggedOut = await fetch(`${base}/api/logout`, { method: 'POST', headers: { cookie } });
    assert.equal(loggedOut.status, 200);

    const fresh = await boot();
    for (let i = 0; i < 5; i += 1) {
      const res = await fetch(`${fresh.base}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'nope' }),
      });
      assert.equal(res.status, 401);
    }
    const blocked = await fetch(`${fresh.base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'correct-password' }),
    });
    assert.equal(blocked.status, 429);
    await new Promise((resolve) => fresh.server.close(resolve));

    const tampered = `${cookie.slice(0, -1)}${cookie.endsWith('a') ? 'b' : 'a'}`;
    const me2 = await fetch(`${base}/api/me`, { headers: { cookie: tampered } });
    assert.equal(me2.status, 401);
    const signed = signSession('other-secret');
    const me3 = await fetch(`${base}/api/me`, { headers: { cookie: `pp_session=${signed}` } });
    assert.equal(me3.status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('project validation and job creation', async () => {
  const { server, base, executor } = await boot();
  try {
    const login = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'correct-password' }),
    });
    const cookie = cookieFrom(login);
    const headers = { cookie, 'content-type': 'application/json' };

    const badOwner = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Bad', mode: 'repo', repo_owner: 'not valid', repo_name: 'demo' }),
    });
    assert.equal(badOwner.status, 400);
    const badRoot = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Bad root', mode: 'repo', repoOwner: 'acme', repoName: 'demo', rootDir: '../secret' }),
    });
    assert.equal(badRoot.status, 400);
    const absolute = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Abs', mode: 'repo', repoOwner: 'acme', repoName: 'demo', rootDir: 'C:/outside' }),
    });
    assert.equal(absolute.status, 400);

    const urlProject = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'URL', mode: 'url', url: 'http://localhost:4200/' }),
    });
    assert.equal(urlProject.status, 201);
    const urlBody = (await urlProject.json()) as { id: string };
    const repoProject = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Repo', mode: 'repo', repo_owner: 'acme', repo_name: 'demo', root_dir: 'demo-site' }),
    });
    assert.equal(repoProject.status, 201);
    const repoBody = (await repoProject.json()) as { id: string; rootDir: string };
    assert.equal(repoBody.rootDir, 'demo-site');

    const optimizeOnUrl = await fetch(`${base}/api/projects/${urlBody.id}/jobs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ type: 'optimize' }),
    });
    assert.equal(optimizeOnUrl.status, 400);

    const first = await fetch(`${base}/api/projects/${repoBody.id}/jobs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ type: 'optimize', runs: 4, maxSteps: 5, useAi: true }),
    });
    const second = await fetch(`${base}/api/projects/${repoBody.id}/jobs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ type: 'audit' }),
    });
    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    const firstBody = (await first.json()) as { id: string };
    const secondBody = (await second.json()) as { id: string };
    assert.deepEqual(executor.started.map((job) => job.id), [firstBody.id, secondBody.id]);
    const stored = (await (await fetch(`${base}/api/jobs/${firstBody.id}`, { headers: { cookie } })).json()) as { params: { runs: number } };
    assert.equal(stored.params.runs, 4);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('SSE replays events after Last-Event-ID and then closes on job-end', async () => {
  const { server, base, bus, stores } = await boot();
  try {
    const login = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'correct-password' }),
    });
    const cookie = cookieFrom(login);
    const created = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'URL', mode: 'url', url: 'http://localhost:4200/' }),
    });
    const project = (await created.json()) as { id: string };
    const jobRes = await fetch(`${base}/api/projects/${project.id}/jobs`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'audit' }),
    });
    const job = (await jobRes.json()) as { id: string };
    const first = await stores.events.append(job.id, 'job-start', { n: 1 });
    const second = await stores.events.append(job.id, 'log', { n: 2 });
    await stores.events.append(job.id, 'log', { n: 3 });

    const res = await fetch(`${base}/api/jobs/${job.id}/events`, {
      headers: { cookie, 'last-event-id': String(first.id) },
    });
    assert.equal(res.status, 200);
    const reader = res.body?.getReader();
    assert.ok(reader);
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('"n":3')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value);
    }
    assert.equal(text.includes(`"n":1`), false);
    assert.match(text, new RegExp(`id: ${second.id}`));
    const end = await stores.events.append(job.id, 'job-end', { ok: true });
    bus.publish(end);
    while (!text.includes('job-end')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value);
    }
    assert.match(text, /job-end/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('recent jobs and project summary', async () => {
  const { server, base } = await boot();
  try {
    const login = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'correct-password' }),
    });
    const cookie = cookieFrom(login);
    const headers = { cookie, 'content-type': 'application/json' };
    const created = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Repo', mode: 'repo', repoOwner: 'acme', repoName: 'demo' }),
    });
    const project = (await created.json()) as { id: string };
    const job = await fetch(`${base}/api/projects/${project.id}/jobs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ type: 'audit' }),
    });
    assert.equal(job.status, 202);
    const recent = (await (await fetch(`${base}/api/jobs?limit=20`, { headers: { cookie } })).json()) as Array<{ projectName: string; type: string }>;
    assert.equal(recent[0]?.projectName, 'Repo');
    assert.equal(recent[0]?.type, 'audit');
    const summary = (await (await fetch(`${base}/api/projects/${project.id}/summary`, { headers: { cookie } })).json()) as {
      jobCount: number;
      lastJob: { type: string } | null;
      lastPrUrl: string | null;
    };
    assert.equal(summary.jobCount, 1);
    assert.equal(summary.lastJob?.type, 'audit');
    assert.equal(summary.lastPrUrl, null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('SameSite=None forces a Secure cookie', async () => {
  const stores = createMemoryStores();
  const app = createApp({
    config: { ...config, cookieSameSite: 'none' },
    stores,
    bus: new EventBus(),
    executor: fakeExecutor(),
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'correct-password' }),
    });
    const header = (typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') ?? '']).join(';');
    assert.match(header, /SameSite=None/i);
    assert.match(header, /Secure/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
