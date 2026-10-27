import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStores } from '../src/repo/memory.js';
import type { Project } from '../src/types.js';
import { failureMessage, notifyEnvFrom, prMessage, resetNotifySkipLog, sendNotification, testMessage, type NotifyEnv } from '../src/notify/dispatch.js';

const SECRET = 'resend-secret-value';
const TOKEN = 'telegram-secret-token';

function project(extra: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Demo <site>',
    mode: 'repo',
    url: null,
    repoOwner: 'acme',
    repoName: 'demo',
    baseBranch: 'main',
    rootDir: '',
    notifyEmail: 'ops@example.com',
    telegramChatId: '12345',
    scheduleCron: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

function env(fetchImpl: NotifyEnv['fetchImpl'], extra: Partial<NotifyEnv> = {}): NotifyEnv {
  return {
    resendApiKey: SECRET,
    emailFrom: 'PerfPilot <bot@example.com>',
    notifyEmailDefault: '',
    telegramBotToken: TOKEN,
    telegramChatId: '',
    dryRun: false,
    clientOrigin: 'http://localhost:5173',
    fetchImpl,
    log: () => undefined,
    ...extra,
  };
}

function ok(): Response {
  return new Response('{}', { status: 200 });
}

test('email and telegram payloads, attachment, escaping, and one retry', async () => {
  const stores = createMemoryStores();
  const created = await stores.projects.create({ name: project().name, mode: 'repo', repoOwner: 'acme', repoName: 'demo', notifyEmail: 'ops@example.com', telegramChatId: '12345' });
  const calls: Array<{ url: string; body: string; isForm: boolean }> = [];
  let emailTries = 0;
  const fetchImpl: NotifyEnv['fetchImpl'] = async (url, init) => {
    const href = String(url);
    if (href.includes('api.resend.com')) {
      emailTries += 1;
      if (emailTries === 1) return new Response('no', { status: 500 });
    }
    calls.push({ url: href, body: init?.body instanceof FormData ? 'form' : String(init?.body ?? ''), isForm: init?.body instanceof FormData });
    if (href.includes(TOKEN)) throw new Error(`network ${TOKEN}`);
    return ok();
  };
  const pdf = Buffer.from('pdf-bytes');
  const message = prMessage(created, 2, {
    baseline: { score: { median: 38 }, lcp: { median: 30800 }, tbt: { median: 543 }, totalBytes: { median: 8000000 } },
    final: { score: { median: 65 }, lcp: { median: 4770 }, tbt: { median: 31 }, totalBytes: { median: 799000 } },
  }, 'https://github.com/acme/demo/pull/3');
  message.pdf = pdf;
  const result = await sendNotification(env(fetchImpl, { log: () => undefined }), stores, created, 'job-1', message);
  assert.equal(result.email.status, 'sent');
  assert.equal(emailTries, 2);
  const email = calls.find((call) => call.url.includes('api.resend.com'));
  assert.ok(email);
  const payload = JSON.parse(email.body) as { attachments: Array<{ content: string }>; html: string; subject: string };
  assert.equal(payload.subject, 'PerfPilot opened a PR: 2 proven improvements on Demo <site>');
  assert.equal(payload.attachments[0]?.content, pdf.toString('base64'));
  assert.match(payload.html, /Demo &lt;site&gt;/);
  assert.doesNotMatch(payload.html, /Demo <site>/);
  assert.equal(result.telegram.status, 'failed');
  const rows = await stores.notifications.listByJob('job-1');
  assert.equal(rows.find((row) => row.channel === 'telegram')?.error, 'network error');
  assert.equal(JSON.stringify(rows).includes(TOKEN), false);
  assert.equal(JSON.stringify(rows).includes(SECRET), false);
});

test('dry-run records status and logs no secrets', async () => {
  resetNotifySkipLog();
  const stores = createMemoryStores();
  const created = await stores.projects.create({ name: 'Demo', mode: 'url', url: 'http://example.com' });
  const lines: string[] = [];
  let calls = 0;
  const result = await sendNotification(env(async () => {
    calls += 1;
    return ok();
  }, { dryRun: true, log: (line) => lines.push(line), resendApiKey: SECRET, telegramBotToken: TOKEN, notifyEmailDefault: 'ops@example.com', telegramChatId: '999' }), stores, created, 'job-dry', testMessage(created));
  assert.equal(result.email.status, 'dry-run');
  assert.equal(result.telegram.status, 'dry-run');
  assert.equal(calls, 0);
  assert.match(lines.join('\n'), /dry-run/);
  assert.equal(lines.join('\n').includes(SECRET), false);
  assert.equal(lines.join('\n').includes(TOKEN), false);
  const listed = await stores.notifications.listByJob('job-dry');
  assert.deepEqual(listed.map((row) => row.status), ['dry-run', 'dry-run']);
});

test('a missing recipient is skipped once and stores nothing', async () => {
  resetNotifySkipLog();
  const stores = createMemoryStores();
  const created = await stores.projects.create({ name: 'Demo', mode: 'url', url: 'http://example.com' });
  const lines: string[] = [];
  let calls = 0;
  const blank = env(async () => {
    calls += 1;
    return ok();
  }, { log: (line) => lines.push(line), notifyEmailDefault: '', telegramChatId: '', resendApiKey: '', telegramBotToken: '' });
  const first = await sendNotification(blank, stores, created, 'job-2', failureMessage(created, 'job-2', 'boom <script>', 'http://localhost:5173'));
  const second = await sendNotification(blank, stores, created, 'job-2', failureMessage(created, 'job-2', 'boom', 'http://localhost:5173'));
  assert.equal(first.email.status, 'skipped');
  assert.equal(first.telegram.status, 'skipped');
  assert.equal(second.email.status, 'skipped');
  assert.equal(calls, 0);
  assert.equal(lines.filter((line) => line.includes('email')).length, 1);
  assert.equal((await stores.notifications.listByJob('job-2')).length, 0);
  assert.match(failureMessage(created, 'job-2', 'boom <script>', 'http://localhost:5173').html, /boom &lt;script&gt;/);
  assert.match(failureMessage(created, 'job-2', 'boom <script>', 'http://localhost:5173').html, /http:\/\/localhost:5173\/jobs\/job-2/);
});

test('notify env reads names without requiring them', () => {
  const loaded = notifyEnvFrom({ NOTIFY_DRY_RUN: '1', EMAIL_FROM: 'a@b.c' }, 'http://localhost:5173');
  assert.equal(loaded.dryRun, true);
  assert.equal(loaded.emailFrom, 'a@b.c');
  assert.equal(loaded.resendApiKey, '');
});
