import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrBody, type Ledger } from '../../worker/src/optimize.js';
import { parseSpec } from '../../worker/src/job-runner.js';
import type { MetricKey } from '../../worker/src/metrics.js';

function summary(value: number) {
  return { median: value, mean: value, min: value, max: value, n: 4 };
}

test('parseSpec fills defaults and rejects a bad type', () => {
  const spec = parseSpec(JSON.stringify({
    jobId: 'job-1',
    type: 'optimize',
    runDir: 'runs/job-1',
    project: { mode: 'repo', repoOwner: 'acme', repoName: 'demo', baseBranch: 'main', rootDir: '' },
  }));
  assert.equal(spec.runs, 4);
  assert.equal(spec.maxSteps, 12);
  assert.equal(spec.useAi, true);
  assert.throws(() => parseSpec('{"type":"nope"}'), /audit, optimize, or monitor/);
});

test('buildPrBody includes the before and after table, evidence, and methodology', () => {
  const keys: MetricKey[] = ['score', 'lcp', 'fcp', 'tbt', 'cls', 'speedIndex', 'totalBytes', 'requests'];
  const baseline = Object.fromEntries(keys.map((key) => [key, summary(key === 'score' ? 40 : 1000)])) as Ledger['baseline'];
  const final = Object.fromEntries(keys.map((key) => [key, summary(key === 'score' ? 70 : 500)])) as Ledger['final'];
  const ledger: Ledger = {
    runId: 'run-1',
    repo: 'C:/demo',
    startedAt: '2026-10-27T00:00:00.000Z',
    finishedAt: '2026-10-27T00:10:00.000Z',
    aiSource: 'heuristic',
    baseline,
    final,
    finalComparison: null,
    runs: 4,
    finalRuns: 5,
    branch: 'perfpilot/optimize-20261027-0000',
    steps: [
      {
        order: 1,
        fix: 'lazy-load-images',
        title: 'Lazy-load images',
        status: 'kept',
        reason: 'Improved: Total Blocking Time',
        files: ['public/index.html'],
        attempts: 1,
        gates: [
          {
            name: 'performance',
            passed: true,
            details: 'improved',
            ms: 10,
            comparison: {
              baselineUrl: 'a',
              candidateUrl: 'b',
              verdict: 'improved',
              summary: 'Improved: Total Blocking Time',
              metrics: [
                {
                  key: 'tbt',
                  label: 'Total Blocking Time',
                  primary: true,
                  verdict: 'improved',
                  baselineMedian: 600,
                  candidateMedian: 20,
                  absoluteChange: -580,
                  relativeChange: -0.96,
                  pBetter: 0.014,
                  pWorse: 0.9,
                  method: 'exact',
                  noise: 10,
                  reason: 'improved',
                  baselineN: 4,
                  candidateN: 4,
                },
              ],
            },
          },
        ],
        metrics: [],
      },
      {
        order: 2,
        fix: 'defer-scripts',
        title: 'Defer scripts',
        status: 'reverted',
        reason: 'performance: harm: tbt',
        files: ['public/index.html'],
        attempts: 1,
        regressions: [{ key: 'tbt', before: 20, after: 400, harm: true }],
        gates: [],
        metrics: [],
      },
    ],
  };
  const body = buildPrBody(ledger);
  assert.match(body, /## Before and after/);
  assert.match(body, /\| Metric \| Before \| After \| Change \|/);
  assert.match(body, /Total Blocking Time: .+ -> .+ \(p=0\.014, 4 runs per side\)/);
  assert.match(body, /Runs per side: 4/);
  assert.match(body, /Mann-Whitney U/);
  assert.match(body, /minimum effect size/);
  assert.match(body, /noise floor/);
  assert.match(body, /The tool never merges/);
  assert.match(body, /defer-scripts: performance: harm: tbt \(harm: tbt\)/);
  assert.match(body, /Performance checks used 4 runs per side/);
});
