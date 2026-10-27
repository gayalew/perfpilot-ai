import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareSamples, mad, mannWhitneyU, median, normalCdf, scaledMad, summarize } from '../src/stats.js';

const close = (actual: number, expected: number, tol = 1e-4) =>
  assert.ok(Math.abs(actual - expected) <= tol, `expected ${actual} to be within ${tol} of ${expected}`);

test('median handles odd, even and empty input', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.ok(Number.isNaN(median([])));
});

test('mad and scaledMad', () => {
  assert.equal(mad([1, 2, 3, 4, 100]), 1);
  close(scaledMad([1, 2, 3, 4, 100]), 1.4826);
  assert.equal(mad([5, 5, 5]), 0);
});

test('summarize reports the basics', () => {
  const s = summarize([10, 20, 30]);
  assert.deepEqual({ n: s.n, median: s.median, min: s.min, max: s.max, mean: s.mean }, { n: 3, median: 20, min: 10, max: 30, mean: 20 });
});

test('normalCdf matches known values', () => {
  close(normalCdf(0), 0.5, 1e-6);
  close(normalCdf(1.96), 0.975, 1e-4);
  close(normalCdf(-1.96), 0.025, 1e-4);
});

// Reference values below were computed with scipy.stats.mannwhitneyu.
test('exact Mann-Whitney, fully separated samples (n=3 vs 3)', () => {
  const x = [1, 2, 3];
  const y = [4, 5, 6];
  const less = mannWhitneyU(x, y, 'less');
  assert.equal(less.method, 'exact');
  assert.equal(less.u, 0);
  close(less.p, 0.05);
  close(mannWhitneyU(x, y, 'greater').p, 1);
  close(mannWhitneyU(x, y, 'two-sided').p, 0.1);
});

test('exact Mann-Whitney, fully separated samples (n=5 vs 5)', () => {
  const x = [1, 2, 3, 4, 5];
  const y = [6, 7, 8, 9, 10];
  close(mannWhitneyU(x, y, 'less').p, 0.003968, 1e-6);
  close(mannWhitneyU(x, y, 'two-sided').p, 0.007937, 1e-6);
});

test('exact Mann-Whitney, interleaved samples with unequal sizes', () => {
  const x = [3, 5, 7, 9, 11, 13];
  const y = [4, 6, 8, 10, 12, 14, 15];
  close(mannWhitneyU(x, y, 'less').p, 0.222611, 1e-5);
  close(mannWhitneyU(x, y, 'greater').p, 0.817016, 1e-5);
  close(mannWhitneyU(x, y, 'two-sided').p, 0.445221, 1e-5);
});

test('exact Mann-Whitney stays valid with ties (permutation reference)', () => {
  const x = [50, 52, 51, 49, 50];
  const y = [50, 51, 52, 49, 51];
  close(mannWhitneyU(x, y, 'less').p, 0.452381, 1e-5);
  close(mannWhitneyU(x, y, 'greater').p, 0.714286, 1e-5);
  const hi = [75, 76, 74, 77, 75];
  const lo = [50, 52, 51, 49, 50];
  close(mannWhitneyU(hi, lo, 'greater').p, 0.003968, 1e-6);
});

test('identical samples give p = 1', () => {
  assert.equal(mannWhitneyU([5, 5, 5], [5, 5, 5], 'less').p, 1);
  assert.equal(mannWhitneyU([5, 5, 5], [5, 5, 5], 'two-sided').p, 1);
  const big = new Array(12).fill(5);
  assert.equal(mannWhitneyU(big, big, 'less').p, 1);
});

test('normal approximation matches scipy for larger samples', () => {
  const x = Array.from({ length: 12 }, (_, i) => i + 1);
  const y = x.map((v) => v + 3);
  const r = mannWhitneyU(x, y, 'less');
  assert.equal(r.method, 'normal');
  close(r.p, 0.036463, 5e-4);
  close(mannWhitneyU(x, y, 'two-sided').p, 0.072925, 1e-3);

  const a = [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6];
  const b = [2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7];
  close(mannWhitneyU(a, b, 'less').p, 0.104635, 5e-4);
});

test('mannWhitneyU rejects empty samples', () => {
  assert.throws(() => mannWhitneyU([], [1]));
});

test('compareSamples: clear improvement in a higher-is-better metric', () => {
  const r = compareSamples([50, 52, 51, 49, 50], [75, 76, 74, 77, 75], { direction: 'higher' });
  assert.equal(r.verdict, 'improved');
  assert.equal(r.baselineMedian, 50);
  assert.equal(r.candidateMedian, 75);
  close(r.relativeChange, 0.5);
});

test('compareSamples: clear improvement in a lower-is-better metric', () => {
  const r = compareSamples([4000, 4100, 3900, 4050, 3950], [2000, 2100, 1950, 2050, 2020], { direction: 'lower' });
  assert.equal(r.verdict, 'improved');
  assert.ok(r.relativeChange < -0.4);
});

test('compareSamples: noise alone is not an improvement', () => {
  const r = compareSamples([50, 52, 51, 49, 50], [50, 51, 52, 49, 51], { direction: 'higher' });
  assert.equal(r.verdict, 'unchanged');
});

test('compareSamples: detects a regression', () => {
  const r = compareSamples([2000, 2100, 1950, 2050, 2020], [4000, 4100, 3900, 4050, 3950], { direction: 'lower' });
  assert.equal(r.verdict, 'regressed');
  assert.ok(r.pWorse < 0.05);
});

test('compareSamples: a tiny but consistent change is below the minimum effect size', () => {
  const r = compareSamples([1000, 1001, 1002, 1003, 1004], [995, 996, 997, 998, 999], { direction: 'lower' });
  assert.equal(r.verdict, 'unchanged');
  assert.match(r.reason, /minimum effect size|noise/);
});

test('compareSamples: a change smaller than the baseline noise is rejected', () => {
  const baseline = [1000, 1400, 800, 1200, 600]; // noisy
  const candidate = [900, 1100, 700, 1000, 500];
  const r = compareSamples(baseline, candidate, { direction: 'lower', minRelativeEffect: 0.05 });
  assert.equal(r.verdict, 'unchanged');
});

test('compareSamples: honors a custom minimum relative effect', () => {
  const base = [1000, 1010, 990, 1005, 995];
  const cand = [940, 950, 930, 945, 935];
  assert.equal(compareSamples(base, cand, { direction: 'lower', minRelativeEffect: 0.05 }).verdict, 'improved');
  assert.equal(compareSamples(base, cand, { direction: 'lower', minRelativeEffect: 0.2 }).verdict, 'unchanged');
});
