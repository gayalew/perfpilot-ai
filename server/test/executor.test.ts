import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventBus } from '../src/events.js';
import { LocalExecutor } from '../src/executor.js';
import { createMemoryStores } from '../src/repo/memory.js';
import { redactSecrets } from '../src/redact.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function executorFor(script: string, stores: ReturnType<typeof createMemoryStores>, bus: EventBus, env: NodeJS.ProcessEnv = {}) {
  return new LocalExecutor({
    stores,
    bus,
    redact: (text) => redactSecrets(text, ['SECRET_VALUE']),
    envFor: () => ({ ...process.env, ...env }),
    commandFor: () => ({
      command: process.execPath,
      args: [path.join(fixtures, script)],
      cwd: fixtures,
      shell: false,
    }),
    specFor: (job) => ({ jobId: job.id }),
  });
}

async function waitFor(check: () => Promise<boolean>, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 8000) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test('jobs run one at a time in queue order', async () => {
  const stores = createMemoryStores();
  const bus = new EventBus();
  const dir = await mkdtemp(path.join(tmpdir(), 'perfpilot-order-'));
  const orderFile = path.join(dir, 'order.txt');
  const executor = executorFor('exit-child.mjs', stores, bus, { ORDER_FILE: orderFile });
  const project = await stores.projects.create({ name: 'p', mode: 'url', url: 'http://localhost:4200/' });
  const first = await stores.jobs.create({ projectId: project.id, type: 'audit', params: {} });
  const second = await stores.jobs.create({ projectId: project.id, type: 'audit', params: {} });
  await executor.start(first);
  await executor.start(second);
  await waitFor(async () => (await stores.jobs.get(second.id))?.status === 'succeeded', 'second job');
  const order = (await readFile(orderFile, 'utf8')).trim().split(/\r?\n/);
  assert.deepEqual(order, [first.id, second.id]);
  const firstJob = await stores.jobs.get(first.id);
  const secondJob = await stores.jobs.get(second.id);
  assert.ok(firstJob?.finishedAt && secondJob?.startedAt);
  assert.ok(firstJob.finishedAt <= secondJob.startedAt);
});

test('cancel kills the child and marks the job cancelled', async () => {
  const stores = createMemoryStores();
  const bus = new EventBus();
  const executor = executorFor('hold-child.mjs', stores, bus);
  const project = await stores.projects.create({ name: 'p', mode: 'url', url: 'http://localhost:4200/' });
  const job = await stores.jobs.create({ projectId: project.id, type: 'audit', params: {} });
  await executor.start(job);
  await waitFor(async () => executor.activePid() !== null && (await stores.jobs.get(job.id))?.status === 'running', 'child');
  const pid = executor.activePid();
  assert.ok(pid);
  await executor.cancel(job.id);
  const stored = await stores.jobs.get(job.id);
  assert.equal(stored?.status, 'cancelled');
  await waitFor(async () => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }, 'child exit');
});

test('recover fails stale running jobs and requeues queued ones', async () => {
  const stores = createMemoryStores();
  const bus = new EventBus();
  const executor = executorFor('exit-child.mjs', stores, bus);
  const project = await stores.projects.create({ name: 'p', mode: 'url', url: 'http://localhost:4200/' });
  const stale = await stores.jobs.create({ projectId: project.id, type: 'audit', params: {} });
  await stores.jobs.update(stale.id, { status: 'running', startedAt: new Date().toISOString() });
  const queued = await stores.jobs.create({ projectId: project.id, type: 'audit', params: {} });
  await executor.recover();
  const failed = await stores.jobs.get(stale.id);
  assert.equal(failed?.status, 'failed');
  assert.equal(failed?.error, 'server restarted');
  await waitFor(async () => (await stores.jobs.get(queued.id))?.status === 'succeeded', 'requeued job');
});

test('a transient database failure is retried and does not drop the job', async () => {
  const stores = createMemoryStores();
  const realAppend = stores.events.append.bind(stores.events);
  let failed = false;
  stores.events.append = async (jobId, type, payload) => {
    if (!failed) {
      failed = true;
      const err = new Error('getaddrinfo ENOTFOUND example.db');
      (err as NodeJS.ErrnoException).code = 'ENOTFOUND';
      throw err;
    }
    return realAppend(jobId, type, payload);
  };
  const executor = executorFor('exit-child.mjs', stores, new EventBus());
  const project = await stores.projects.create({ name: 'p', mode: 'url', url: 'http://localhost:4200/' });
  const job = await stores.jobs.create({ projectId: project.id, type: 'audit', params: {} });
  await executor.start(job);
  await waitFor(async () => (await stores.jobs.get(job.id))?.status === 'succeeded', 'retried job');
  assert.equal(failed, true);
  const events = await stores.events.list(job.id);
  assert.ok(events.some((event) => event.type === 'job-end'));
});

test('non-JSON logs are truncated and tokens are redacted', async () => {
  const stores = createMemoryStores();
  const bus = new EventBus();
  const executor = executorFor('exit-child.mjs', stores, bus);
  const project = await stores.projects.create({ name: 'p', mode: 'url', url: 'http://localhost:4200/' });
  const job = await stores.jobs.create({ projectId: project.id, type: 'audit', params: {} });
  await executor.start(job);
  await waitFor(async () => (await stores.jobs.get(job.id))?.status === 'succeeded', 'job');
  const events = await stores.events.list(job.id);
  const log = events.find((event) => event.type === 'log');
  const line = (log?.payload as { line?: string } | undefined)?.line ?? '';
  assert.match(line, /<redacted>/);
  assert.equal(line.includes('SECRET_VALUE'), false);
  assert.ok(line.length <= 2000);
});
