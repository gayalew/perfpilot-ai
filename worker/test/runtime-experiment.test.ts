import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MetricValues, Sample } from '../src/metrics.js';
import type { Measurement } from '../src/measure.js';
import { heuristicPlan, type Finding } from '../src/diagnose.js';
import { runRuntimeExperiments } from '../src/runtime/experiment.js';

function sample(score: number, lcp: number): Sample {
  const metrics: MetricValues = {
    score, fcp: 1000, lcp, tbt: 80, cls: 0.02, speedIndex: 2000, tti: 3000, ttfb: 40, totalBytes: 100000, requests: 8,
  };
  return { metrics, warnings: [] };
}

function measurement(url: string, score: number, lcp: number): Measurement {
  const now = new Date().toISOString();
  return { url, profile: 'mobile', requestedRuns: 4, samples: [sample(score, lcp), sample(score, lcp), sample(score, lcp), sample(score, lcp)], failures: [], startedAt: now, finishedAt: now };
}

const findings: Finding[] = [
  { auditId: 'render-blocking-resources', title: 'blocking', fix: 'defer-scripts', savingsMs: 400, savingsBytes: 0, metrics: ['lcp'], items: [], priority: 1 },
  { auditId: 'layout-shifts', title: 'shift', fix: 'reserve-space', savingsMs: 0, savingsBytes: 0, metrics: ['cls'], items: [], priority: 1 },
];

test('a runtime fix is kept from real samples and a repo-only fix is skipped', async () => {
  const plan = heuristicPlan(findings);
  const report = await runRuntimeExperiments({
    url: 'http://example.test/',
    runs: 4,
    findings,
    plan,
    measure: async (url) => measurement(url, url === 'http://example.test/' ? 40 : 80, 3000),
    openProxy: async () => ({ url: 'http://example.test/candidate', close: async () => undefined }),
  });
  const defer = report.steps.find((step) => step.fix === 'defer-scripts');
  const reserve = report.steps.find((step) => step.fix === 'reserve-space');
  assert.equal(defer?.status, 'kept');
  assert.equal(reserve?.status, 'skipped');
  assert.match(reserve?.reason ?? '', /repository/);
});

test('measurePair compares an interleaved raw URL against the proxy URL', async () => {
  const plan = heuristicPlan([findings[0]!]);
  const seen: string[] = [];
  const report = await runRuntimeExperiments({
    url: 'http://example.test/',
    findings: [findings[0]!],
    plan,
    measure: async () => { throw new Error('the raw page must be measured inside the pair'); },
    measurePair: async (baselineUrl, candidateUrl) => {
      seen.push(baselineUrl, candidateUrl);
      return [measurement(baselineUrl, 40, 3200), measurement(candidateUrl, 80, 1400)];
    },
    openProxy: async () => ({ url: 'http://127.0.0.1:9/proxied', close: async () => undefined }),
  });
  assert.deepEqual(seen, ['http://example.test/', 'http://127.0.0.1:9/proxied']);
  assert.equal(report.baseline?.score?.median, 40);
  assert.equal(report.steps[0]?.status, 'kept');
});

test('a blocked redirect note is kept on the experiment step', async () => {
  const plan = heuristicPlan([findings[0]!]);
  const report = await runRuntimeExperiments({
    url: 'http://example.test/',
    findings: [findings[0]!],
    plan,
    measure: async (url) => measurement(url, url.includes('candidate') ? 80 : 40, 3000),
    openProxy: async () => ({ url: 'http://example.test/candidate', notes: ['blocked redirect'], close: async () => undefined }),
  });
  assert.match(report.steps[0]?.reason ?? '', /blocked redirect/);
  assert.deepEqual(report.steps[0]?.notes, ['blocked redirect']);
});

test('a candidate that does not improve is reverted', async () => {
  const plan = heuristicPlan([findings[0]!]);
  const report = await runRuntimeExperiments({
    url: 'http://example.test/',
    findings: [findings[0]!],
    plan,
    measure: async (url) => measurement(url, 50, 3000),
    openProxy: async () => ({ url: 'http://example.test/same', close: async () => undefined }),
  });
  assert.equal(report.steps[0]?.status, 'reverted');
});
