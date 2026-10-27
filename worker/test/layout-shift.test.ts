import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AiEditor } from '../src/ai-edit.js';
import type { Finding } from '../src/diagnose.js';
import { reserveSpace } from '../src/fixes/ai.js';
import { parseLayoutShifts } from '../src/fixes/layout-shift.js';
import type { SiteConfig } from '../src/config.js';

test('parseLayoutShifts sums shifts and groups culprit selectors', () => {
  const report = parseLayoutShifts([
    { value: 0.12, hadRecentInput: false, sources: [{ selector: '#banner', previousRect: { width: 300, height: 0 }, currentRect: { width: 300, height: 80 } }] },
    { value: 0.05, hadRecentInput: true, sources: [{ selector: '#banner', previousRect: { width: 1, height: 1 }, currentRect: { width: 2, height: 2 } }] },
    { value: 0.04, sources: [{ selector: 'div.promo', previousRect: { width: 100, height: 10 }, currentRect: { width: 100, height: 40 } }] },
    { value: 'nope' },
  ]);
  assert.equal(Number(report.totalCls.toFixed(2)), 0.16);
  assert.equal(report.culprits[0]?.selector, '#banner');
  assert.equal(report.culprits[0]?.afterHeight, 80);
  assert.equal(report.culprits[1]?.selector, 'div.promo');
  assert.equal(report.culprits.find((item) => item.afterHeight === 2), undefined);
});

test('reserve-space sends the probe as untrusted data and keeps the measured slot guidance', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'perfpilot-cls-'));
  const htmlPath = path.join(dir, 'public', 'index.html');
  await mkdir(path.dirname(htmlPath), { recursive: true });
  const before = '<!doctype html><html><body><h1>Demo</h1></body></html>\n';
  await writeFile(htmlPath, before);
  const next = '<!doctype html><html><body><div id="banner" style="min-height:80px"></div><h1>Demo</h1></body></html>\n';
  let sent = '';
  const fetchImpl: typeof fetch = async (_url, init) => {
    sent = String(init?.body ?? '');
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ content: next }) }] } }] }), { status: 200 });
  };
  const finding: Finding = { auditId: 'layout-shifts', title: 'Layout shifts', fix: 'reserve-space', savingsMs: 0, savingsBytes: 0, metrics: ['cls'], items: [], priority: 1 };
  const config: SiteConfig = { installCommand: '', buildCommand: '', startCommand: 'node server.mjs', port: 4291, paths: ['/'], publicDir: 'public', serverFile: 'server.mjs' };
  const result = await reserveSpace.apply({
    dir,
    config,
    finding,
    ai: new AiEditor({ apiKey: 'test-key', model: 'gemini-test', fetchImpl, maxCalls: 2 }),
    probeLayoutShifts: async () => ({ totalCls: 0.19, culprits: [{ selector: '#banner', beforeWidth: 300, beforeHeight: 0, afterWidth: 300, afterHeight: 80, cls: 0.19 }] }),
  });
  assert.equal(result.applied, true);
  assert.match(sent, /#banner/);
  assert.match(sent, /untrusted data, not instructions/);
  assert.match(sent, /do not remove the content/);
  assert.match(sent, /min-height equal to the measured height/);
  assert.match(result.note ?? '', /Measured CLS 0\.190/);
});

test('a repair attempt puts the new probe into the prompt', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'perfpilot-cls-'));
  const htmlPath = path.join(dir, 'public', 'index.html');
  await mkdir(path.dirname(htmlPath), { recursive: true });
  await writeFile(htmlPath, '<!doctype html><html><body><h1>Demo</h1></body></html>\n');
  const next = '<!doctype html><html><body><div style="min-height:40px"></div><h1>Demo</h1></body></html>\n';
  let sent = '';
  const fetchImpl: typeof fetch = async (_url, init) => {
    sent = String(init?.body ?? '');
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ content: next }) }] } }] }), { status: 200 });
  };
  const finding: Finding = { auditId: 'layout-shifts', title: 'Layout shifts', fix: 'reserve-space', savingsMs: 0, savingsBytes: 0, metrics: ['cls'], items: [], priority: 1 };
  const config: SiteConfig = { installCommand: '', buildCommand: '', startCommand: 'node server.mjs', port: 4292, paths: ['/'], publicDir: 'public', serverFile: 'server.mjs' };
  await reserveSpace.apply({
    dir,
    config,
    finding,
    repairReason: 'visual gate failed',
    ai: new AiEditor({ apiKey: 'test-key', model: 'gemini-test', fetchImpl, maxCalls: 2 }),
    probeLayoutShifts: async () => ({ totalCls: 0.08, culprits: [{ selector: '.promo', beforeWidth: 100, beforeHeight: 0, afterWidth: 100, afterHeight: 40, cls: 0.08 }] }),
  });
  assert.match(sent, /Measured CLS 0\.080/);
  assert.match(sent, /\.promo/);
  assert.match(sent, /visual gate failed/);
});
