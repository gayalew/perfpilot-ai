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
