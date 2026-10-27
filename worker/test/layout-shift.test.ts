import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AiEditor } from '../src/ai-edit.js';
import type { Finding } from '../src/diagnose.js';
import { reserveSpace } from '../src/fixes/ai.js';
import { classifyLayoutShift, parseLayoutShifts, sitsAboveOrBeside } from '../src/fixes/layout-shift.js';
import { appendSlotRule, insertBodySlot } from '../src/fixes/reserve-slot.js';
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

test('classifyLayoutShift separates late causes from shifted victims', () => {
  const banner = {
    selector: 'div.promo',
    parentSelector: 'html > body',
    index: 0,
    tag: 'div',
    classList: ['promo'],
    outerHtml: '<div class="promo">',
    top: 0,
    height: 156,
    position: 'static',
    insertedAt: 1000,
  };
  const below = { ...banner, selector: 'div.late', parentSelector: 'section', index: 2, top: 2400, height: 40, insertedAt: 1000 };
  const tooEarly = { ...banner, selector: 'div.old', insertedAt: 100 };
  const shifts = [{
    startTime: 1200,
    value: 0.2,
    hadRecentInput: false,
    sources: [{ selector: 'header.top', previousRect: { top: 0, height: 48, width: 400 }, currentRect: { top: 156, height: 48, width: 400 } }],
  }, {
    startTime: 1200,
    value: 0.9,
    hadRecentInput: true,
    sources: [{ selector: 'main', previousRect: { top: 0, height: 10 }, currentRect: { top: 400, height: 10 } }],
  }];
  const report = classifyLayoutShift([banner, below, tooEarly, { selector: '' }], shifts);
  assert.deepEqual(report.causes.map((item) => item.selector), ['div.promo']);
  assert.deepEqual(report.victims.map((item) => item.selector), ['header.top']);
  assert.equal(sitsAboveOrBeside(banner, { top: 156, height: 48 }), true);
  assert.equal(sitsAboveOrBeside(below, { top: 156, height: 48 }), false);
});

test('a body-first banner gets a slot and an out-of-flow rule', () => {
  const html = '<!doctype html><html><head><link rel="stylesheet" href="/css/base.css"></head><body>\n<header>Top</header></body></html>\n';
  const next = insertBodySlot(html, 156);
  assert.match(next, /<body><div class="pp-slot" aria-hidden="true" style="height:156px"><\/div>/);
  assert.match(next, /<header>Top<\/header>/);
  assert.equal(insertBodySlot(next, 156), next);
  const css = appendSlotRule('body { margin: 0; }\n', 'html > body > div.promo', 156);
  assert.match(css, /html > body > div\.promo \{ position:absolute; top:0; left:0; right:0; height:156px; \}/);
  assert.equal(appendSlotRule(css, 'html > body > div.promo', 156), css);
});
