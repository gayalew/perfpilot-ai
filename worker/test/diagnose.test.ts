import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFindings, heuristicPlan, mergeByFix } from '../src/diagnose.js';
import { planFixes, validatePlan } from '../src/gemini.js';
import type { LhrLike } from '../src/metrics.js';

const lhr = {
  audits: {
    'render-blocking-resources': {
      score: 0.2, scoreDisplayMode: 'metricSavings', metricSavings: { FCP: 900, LCP: 900 },
      details: { type: 'opportunity', overallSavingsMs: 900, items: [{ url: 'http://x/css/base.css', wastedMs: 450 }, { url: 'http://x/js/vendor.js', wastedMs: 450 }] },
    },
    'uses-text-compression': { score: 0, details: { type: 'opportunity', overallSavingsMs: 300, overallSavingsBytes: 500_000, items: [{ url: 'http://x/js/vendor.js', wastedBytes: 400_000 }] } },
    'uses-optimized-images': { score: 0, details: { type: 'opportunity', overallSavingsMs: 2000, overallSavingsBytes: 3_000_000, items: [{ url: 'http://x/img/hero.png', wastedBytes: 2_000_000 }] } },
    'modern-image-formats': { score: 0, details: { type: 'opportunity', overallSavingsMs: 2500, overallSavingsBytes: 3_500_000, items: [{ url: 'http://x/img/hero.png', wastedBytes: 2_100_000 }] } },
    'unsized-images': { score: 0, scoreDisplayMode: 'metricSavings', details: { type: 'table', items: [{ node: { selector: 'img.g1', snippet: '<img>' } }] } },
    'uses-long-cache-ttl': { score: 1, details: { type: 'table', items: [] } },
    'unused-javascript': { score: 1, details: { type: 'opportunity', items: [] } },
    'dom-size': { score: null, scoreDisplayMode: 'notApplicable' },
  },
} as unknown as LhrLike;

test('extractFindings keeps failed audits and drops passing or inapplicable ones', () => {
  const fixes = extractFindings(lhr).map((f) => f.fix);
  assert.ok(fixes.includes('defer-scripts'));
  assert.ok(fixes.includes('compress-text'));
  assert.ok(fixes.includes('optimize-images'));
  assert.ok(fixes.includes('image-dimensions'));
  assert.ok(!fixes.includes('cache-headers'), 'passing audit must not become a finding');
  assert.ok(!fixes.includes('remove-unused-code'));
  assert.ok(!fixes.includes('reduce-dom'));
});

test('lcp-lazy-loaded maps to preload-lcp-image and merges with the preload audit', () => {
  const lazyOnly = extractFindings({
    audits: {
      'lcp-lazy-loaded': {
        score: 0,
        title: 'Largest Contentful Paint image was lazily loaded',
        metricSavings: { LCP: 400 },
        details: { type: 'table', items: [{ node: { selector: 'img.hero', snippet: '<img loading="lazy">' } }] },
      },
    },
  } as unknown as LhrLike);
  assert.equal(lazyOnly.length, 1);
  assert.equal(lazyOnly[0].fix, 'preload-lcp-image');
  assert.equal(lazyOnly[0].auditId, 'lcp-lazy-loaded');
  assert.equal(lazyOnly[0].savingsMs, 400);

  const merged = extractFindings({
    audits: {
      'lcp-lazy-loaded': {
        score: 0,
        title: 'Largest Contentful Paint image was lazily loaded',
        metricSavings: { LCP: 400 },
        details: { type: 'table', items: [{ node: { selector: 'img.hero' } }] },
      },
      'prioritize-lcp-image': {
        score: 0,
        title: 'Preload Largest Contentful Paint image',
        details: { type: 'opportunity', overallSavingsMs: 900, items: [{ url: 'http://x/img/hero.png', wastedMs: 900 }] },
      },
    },
  } as unknown as LhrLike);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].fix, 'preload-lcp-image');
  assert.equal(merged[0].auditId, 'prioritize-lcp-image');
  assert.equal(merged[0].savingsMs, 900);
});

test('findings that share a fix are merged into one', () => {
  const found = extractFindings(lhr).filter((f) => f.fix === 'optimize-images');
  assert.equal(found.length, 1);
  assert.equal(found[0].savingsMs, 2500);
  assert.equal(found[0].items.length, 1, 'same image listed once');
});

test('findings are sorted with the biggest expected gain first', () => {
  const found = extractFindings(lhr);
  assert.equal(found[0].fix, 'optimize-images');
  for (let i = 1; i < found.length; i++) assert.ok(found[i - 1].priority >= found[i].priority);
});

test('mergeByFix keeps the higher priority finding as the base', () => {
  const base = { auditId: 'a', title: 'A', fix: 'compress-text' as const, savingsMs: 1, savingsBytes: 0, metrics: ['fcp'], items: [], priority: 10 };
  const merged = mergeByFix([base, { ...base, auditId: 'b', title: 'B', priority: 99, metrics: ['lcp'] }]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].auditId, 'b');
  assert.deepEqual(merged[0].metrics.sort(), ['fcp', 'lcp']);
});

test('heuristicPlan numbers the steps and honours the limit', () => {
  const plan = heuristicPlan(extractFindings(lhr), 2);
  assert.equal(plan.source, 'heuristic');
  assert.deepEqual(plan.steps.map((s) => s.order), [1, 2]);
});

test('validatePlan drops unknown and duplicate fixes and appends skipped findings', () => {
  const findings = extractFindings(lhr);
  const steps = validatePlan(
    { steps: [{ fix: 'delete-everything', rationale: 'x' }, { fix: 'defer-scripts', rationale: 'r' }, { fix: 'defer-scripts', rationale: 'again' }] },
    findings,
  );
  assert.equal(steps[0].fix, 'defer-scripts');
  assert.equal(steps.filter((s) => s.fix === 'defer-scripts').length, 1);
  assert.ok(!steps.some((s) => (s.fix as string) === 'delete-everything'));
  assert.ok(steps.length === findings.length, 'every finding is still covered');
});

test('validatePlan rejects a reply with no usable steps', () => {
  assert.throws(() => validatePlan({ steps: [{ fix: 'nope' }] }, extractFindings(lhr)));
  assert.throws(() => validatePlan({}, extractFindings(lhr)));
});

const reply = (text: string): typeof fetch => (async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 })) as typeof fetch;

test('planFixes uses the model order when the reply is valid', async () => {
  const text = '```json\n{"steps":[{"fix":"compress-text","rationale":"cheap","expectedImpact":"fcp"}]}\n```';
  const plan = await planFixes(extractFindings(lhr), { apiKey: 'k', model: 'models/m', fetchImpl: reply(text) });
  assert.equal(plan.source, 'gemini');
  assert.equal(plan.steps[0].fix, 'compress-text');
});

test('planFixes falls back without a key, on HTTP errors, and on garbage replies', async () => {
  const findings = extractFindings(lhr);
  assert.equal((await planFixes(findings, { apiKey: '', model: 'm' })).source, 'heuristic');
  const quota = (async () => new Response('{}', { status: 429 })) as typeof fetch;
  const limited = await planFixes(findings, { apiKey: 'k', model: 'm', fetchImpl: quota, sleep: async () => undefined });
  assert.equal(limited.source, 'heuristic');
  assert.match(limited.note ?? '', /quota/);
  const garbage = await planFixes(findings, { apiKey: 'k', model: 'm', fetchImpl: reply('not json') });
  assert.equal(garbage.source, 'heuristic');
  const thrown = (async () => { throw new Error('network down'); }) as typeof fetch;
  assert.equal((await planFixes(findings, { apiKey: 'k', model: 'm', fetchImpl: thrown, sleep: async () => undefined })).source, 'heuristic');
});

test('planFixes never sends the api key in the body or url', async () => {
  let seenUrl = '', seenBody = '';
  const spy = (async (url: string, init: RequestInit) => { seenUrl = url; seenBody = String(init.body); return new Response('{}', { status: 500 }); }) as unknown as typeof fetch;
  await planFixes(extractFindings(lhr), { apiKey: 'SECRET123', model: 'm', fetchImpl: spy, sleep: async () => undefined });
  assert.ok(!seenUrl.includes('SECRET123') && !seenBody.includes('SECRET123'));
});
