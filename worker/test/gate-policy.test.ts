import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CWV_GOOD, judgePerformance, regressionCountsAsHarm } from '../src/optimize.js';
import type { MetricComparison } from '../src/compare.js';
import type { Comparison } from '../src/compare.js';
import type { MetricKey } from '../src/metrics.js';

function metric(key: MetricKey, verdict: MetricComparison['verdict'], before: number, after: number, primary = true): MetricComparison {
  return {
    key,
    label: key,
    primary,
    verdict,
    baselineMedian: before,
    candidateMedian: after,
    absoluteChange: after - before,
    relativeChange: before === 0 ? NaN : (after - before) / Math.abs(before),
    pBetter: verdict === 'improved' ? 0.01 : 0.8,
    pWorse: verdict === 'regressed' ? 0.01 : 0.8,
    method: 'exact',
    noise: 1,
    reason: verdict,
    baselineN: 4,
    candidateN: 4,
  };
}

function comparison(metrics: MetricComparison[], verdict: Comparison['verdict']): Comparison {
  return { baselineUrl: 'a', candidateUrl: 'b', metrics, verdict, summary: verdict };
}

test('CWV good thresholds are the published ceilings', () => {
  assert.deepEqual(CWV_GOOD, { lcp: 2500, tbt: 200, cls: 0.1 });
});

test('a regressed performance score always counts as harm', () => {
  assert.equal(regressionCountsAsHarm(metric('score', 'regressed', 80, 70)), true);
});

test('crossing a Core Web Vitals ceiling counts as harm', () => {
  assert.equal(regressionCountsAsHarm(metric('lcp', 'regressed', 2400, 2600)), true);
  assert.equal(regressionCountsAsHarm(metric('tbt', 'regressed', 180, 240)), true);
  assert.equal(regressionCountsAsHarm(metric('cls', 'regressed', 0.08, 0.12)), true);
});

test('a regression that stays inside the good range is not harm', () => {
  assert.equal(regressionCountsAsHarm(metric('lcp', 'regressed', 1800, 2200)), false);
  assert.equal(regressionCountsAsHarm(metric('tbt', 'regressed', 40, 90)), false);
  assert.equal(regressionCountsAsHarm(metric('cls', 'regressed', 0.02, 0.05)), false);
});

test('an already-poor metric counts as harm only when it gets more than 10% worse', () => {
  assert.equal(regressionCountsAsHarm(metric('lcp', 'regressed', 4000, 4500)), true);
  assert.equal(regressionCountsAsHarm(metric('lcp', 'regressed', 4000, 4300)), false);
  assert.equal(regressionCountsAsHarm(metric('tbt', 'regressed', 300, 340)), true);
  assert.equal(regressionCountsAsHarm(metric('cls', 'regressed', 0.2, 0.21)), false);
});

test('other metrics do not count as harm', () => {
  assert.equal(regressionCountsAsHarm(metric('totalBytes', 'regressed', 1000, 5000, false)), false);
});

test('judgePerformance keeps an improvement when the regression is harmless', () => {
  const decision = judgePerformance(comparison([
    metric('lcp', 'improved', 5000, 3000),
    metric('tbt', 'regressed', 40, 80),
  ], 'regressed'));
  assert.equal(decision.passed, true);
  assert.equal(decision.regressions.find((item) => item.key === 'tbt')?.harm, false);
});

test('judgePerformance rejects an improvement when a regression counts as harm', () => {
  const decision = judgePerformance(comparison([
    metric('lcp', 'improved', 5000, 3000),
    metric('tbt', 'regressed', 150, 400),
  ], 'regressed'));
  assert.equal(decision.passed, false);
  assert.match(decision.details, /harm: tbt/);
});

test('judgePerformance rejects an unchanged comparison', () => {
  const decision = judgePerformance(comparison([metric('lcp', 'unchanged', 3000, 3000)], 'unchanged'));
  assert.equal(decision.passed, false);
  assert.match(decision.details, /unchanged/);
});
