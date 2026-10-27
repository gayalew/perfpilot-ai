import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { signSession } from '../src/auth.js';
import { EventBus } from '../src/events.js';
import { enqueueDueMonitors } from '../src/monitor/due.js';
import { evaluateMonitor, type MonitorPoint, type MonitorStatus } from '../src/monitor/evaluate.js';
import { createMemoryStores } from '../src/repo/memory.js';
import type { Executor } from '../src/executor.js';

function point(id: string, takenAt: string, status: MonitorStatus, lcp: number[], score = [80, 80, 80, 80]): MonitorPoint {
  return {
    id,
    takenAt,
    status,
    samples: { score, lcp, tbt: [80, 80, 80, 80], cls: [0.05, 0.05, 0.05, 0.05] },
  };
}

const same = { samples: { score: [80, 80, 80, 80], lcp: [4000, 4000, 4000, 4000], tbt: [80, 80, 80, 80], cls: [0.05, 0.05, 0.05, 0.05] } };
const worse = { samples: { score: [80, 80, 80, 80], lcp: [6000, 6100, 5900, 6200], tbt: [80, 80, 80, 80], cls: [0.05, 0.05, 0.05, 0.05] } };

function healthy(count: number): MonitorPoint[] {
  return Array.from({ length: count }, (_, index) => point(String(index + 1), `2026-01-0${index + 1}T00:00:00.000Z`, 'ok', [4000, 4010, 3990, 4005]));
}

test('learning phase does not alert', () => {
  const result = evaluateMonitor(healthy(2), same, { minHistory: 3 });
  assert.equal(result.status, 'learning');
  assert.equal(result.shouldAlert, false);
  assert.equal(result.shouldSendRecovery, false);
  assert.equal(result.comparisons.length, 0);
});

test('noise does not alert', () => {
  const result = evaluateMonitor(healthy(3), same, { minHistory: 3 });
  assert.equal(result.status, 'ok');
  assert.equal(result.shouldAlert, false);
  assert.equal(result.comparisons.find((row) => row.key === 'lcp')?.verdict, 'unchanged');
});

test('a single breach does not alert and two consecutive breaches alert once', () => {
  const first = evaluateMonitor(healthy(3), worse, { minHistory: 3 });
  assert.equal(first.status, 'breach');
  assert.equal(first.consecutiveBreaches, 1);
  assert.equal(first.shouldAlert, false);
  assert.equal(first.openIncident, false);

  const history = [...healthy(3), point('9', '2026-01-09T00:00:00.000Z', 'breach', [6000, 6100, 5900, 6200])];
  const second = evaluateMonitor(history, worse, { minHistory: 3 });
  assert.equal(second.status, 'regression');
  assert.equal(second.consecutiveBreaches, 2);
  assert.equal(second.shouldAlert, true);
  assert.equal(second.openIncident, true);

  const thirdHistory = [...history, point('10', '2026-01-10T00:00:00.000Z', 'regression', [6000, 6100, 5900, 6200])];
  const third = evaluateMonitor(thirdHistory, worse, { minHistory: 3, incidentOpen: true });
  assert.equal(third.shouldAlert, false);
  assert.equal(third.openIncident, true);
  assert.equal(third.status, 'regression');
});

test('recovery is sent once', () => {
  const history = [...healthy(3), point('9', '2026-01-09T00:00:00.000Z', 'regression', [6000, 6000, 6000, 6000])];
  const recovered = evaluateMonitor(history, same, { minHistory: 3, incidentOpen: true });
  assert.equal(recovered.status, 'ok');
  assert.equal(recovered.shouldSendRecovery, true);
  assert.equal(recovered.shouldAlert, false);
  assert.equal(recovered.openIncident, false);
  const again = evaluateMonitor([...history, point('11', '2026-01-11T00:00:00.000Z', 'ok', [4000, 4000, 4000, 4000])], same, { minHistory: 3 });
  assert.equal(again.shouldSendRecovery, false);
});

test('a regression that stays inside the good band is ignored', () => {
  const history = [1, 2, 3].map((day) => point(String(day), `2026-02-0${day}T00:00:00.000Z`, 'ok', [1000, 1000, 1000, 1000]));
  const current = { samples: { score: [80, 80, 80, 80], lcp: [1500, 1500, 1500, 1500], tbt: [80, 80, 80, 80], cls: [0.05, 0.05, 0.05, 0.05] } };
  const result = evaluateMonitor(history, current, { minHistory: 3 });
  const lcp = result.comparisons.find((row) => row.key === 'lcp');
  assert.equal(lcp?.verdict, 'regressed');
  assert.equal(lcp?.breach, false);
  assert.equal(result.status, 'ok');
  assert.equal(result.shouldAlert, false);
});

test('history order does not change the reference', () => {
  const a = point('a', '2026-03-01T00:00:00.000Z', 'ok', [1000, 1100, 1200, 1300]);
  const b = point('b', '2026-03-02T00:00:00.000Z', 'ok', [1400, 1500, 1600, 1700]);
  const c = point('c', '2026-03-03T00:00:00.000Z', 'ok', [1800, 1900, 2000, 2100]);
  const breach = point('d', '2026-03-04T00:00:00.000Z', 'breach', [9000, 9000, 9000, 9000]);
  const current = { samples: { score: [80, 80, 80, 80], lcp: [1600, 1600, 1600, 1600], tbt: [80, 80, 80, 80], cls: [0.05, 0.05, 0.05, 0.05] } };
  const left = evaluateMonitor([c, a, breach, b], current, { minHistory: 3 });
  const right = evaluateMonitor([b, breach, c, a], current, { minHistory: 3 });
  assert.equal(left.reference?.medians.lcp, right.reference?.medians.lcp);
  assert.deepEqual(left.comparisons.map((row) => row.verdict), right.comparisons.map((row) => row.verdict));
  assert.ok((left.reference?.medians.lcp ?? 0) < 3000);
});

test('run-due enqueues each due project once', async () => {
  const stores = createMemoryStores();
  const project = await stores.projects.create({ name: 'Watch', mode: 'url', url: 'http://localhost:4200/', scheduleCron: '0 * * * *' });
  await stores.projects.create({ name: 'Idle', mode: 'url', url: 'http://localhost:4200/' });
  const executor: Executor = { async start() {}, async cancel() {}, async recover() {} };
  const now = new Date('2026-10-27T12:30:00.000Z');
  const first = await enqueueDueMonitors(stores, executor, now);
  const second = await enqueueDueMonitors(stores, executor, now);
  assert.deepEqual(first, [project.id]);
  assert.deepEqual(second, []);
});

test('run-due requires the job secret and is idempotent over HTTP', async () => {
  const stores = createMemoryStores();
  const project = await stores.projects.create({ name: 'Watch', mode: 'url', url: 'http://localhost:4200/', scheduleCron: '0 * * * *' });
  const executor: Executor = { async start() {}, async cancel() {}, async recover() {} };
  const config = { sessionSecret: 'test-secret', adminPassword: 'correct-password', clientOrigin: 'http://localhost:5173', nodeEnv: 'development' };
  const app = createApp({
    config,
    stores,
    bus: new EventBus(),
    executor,
    jobSecret: 'test-job-secret',
    runDue: () => enqueueDueMonitors(stores, executor, new Date('2026-10-27T12:30:00.000Z')),
  });
  const server: Server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const missing = await fetch(`${base}/api/internal/run-due`, { method: 'POST' });
    assert.equal(missing.status, 401);
    const wrong = await fetch(`${base}/api/internal/run-due`, { method: 'POST', headers: { 'x-job-secret': 'nope' } });
    assert.equal(wrong.status, 401);
    const cookie = `pp_session=${signSession(config.sessionSecret)}`;
    const badCron = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'Bad', mode: 'url', url: 'http://localhost:4200/', scheduleCron: 'not a cron' }),
    });
    assert.equal(badCron.status, 400);
    const ok = await fetch(`${base}/api/internal/run-due`, { method: 'POST', headers: { 'x-job-secret': 'test-job-secret' } });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { enqueued: string[] };
    assert.deepEqual(body.enqueued, [project.id]);
    const again = await fetch(`${base}/api/internal/run-due`, { method: 'POST', headers: { 'x-job-secret': 'test-job-secret' } });
    const second = (await again.json()) as { enqueued: string[] };
    assert.equal(again.status, 200);
    assert.deepEqual(second.enqueued, []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
