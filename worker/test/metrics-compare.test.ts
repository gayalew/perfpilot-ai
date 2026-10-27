import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSample, formatMetric, type LhrLike } from '../src/metrics.js';
import { compareMeasurements } from '../src/compare.js';
import type { Measurement } from '../src/measure.js';
import type { Sample } from '../src/metrics.js';

const lhr: LhrLike = {
  lighthouseVersion: '12.0.0',
  finalDisplayedUrl: 'http://localhost/',
  categories: { performance: { score: 0.734 } },
  audits: {
    'first-contentful-paint': { numericValue: 1800 },
    'largest-contentful-paint': { numericValue: 3200 },
    'total-blocking-time': { numericValue: 450 },
    'cumulative-layout-shift': { numericValue: 0.12 },
    'speed-index': { numericValue: 2900 },
    interactive: { numericValue: 5000 },
    'server-response-time': { numericValue: 120 },
    'total-byte-weight': { numericValue: 2_500_000 },
    'network-requests': { details: { items: [{}, {}, {}] } },
    'largest-contentful-paint-element': {
      details: { type: 'table', items: [{ node: { type: 'node', selector: 'img.hero', snippet: '<img class="hero">' } }] },
    },
  },
};

test('extractSample reads metrics from a Lighthouse result', () => {
  const s = extractSample(lhr);
  assert.equal(s.metrics.score, 73);
  assert.equal(s.metrics.lcp, 3200);
  assert.equal(s.metrics.tbt, 450);
  assert.equal(s.metrics.cls, 0.12);
  assert.equal(s.metrics.requests, 3);
  assert.equal(s.lcpElement?.selector, 'img.hero');
});

test('extractSample tolerates missing audits', () => {
  const s = extractSample({ categories: {}, audits: {} });
  assert.equal(s.metrics.score, null);
  assert.equal(s.metrics.lcp, null);
  assert.equal(s.lcpElement, undefined);
});

test('formatMetric renders units', () => {
  assert.equal(formatMetric('lcp', 3200), '3.20 s');
  assert.equal(formatMetric('tbt', 450), '450 ms');
  assert.equal(formatMetric('totalBytes', 2_621_440), '2.50 MB');
  assert.equal(formatMetric('score', null), 'n/a');
});

function measurement(url: string, series: Partial<Record<keyof Sample['metrics'], number[]>>, n = 5): Measurement {
  const samples: Sample[] = Array.from({ length: n }, (_, i) => ({
    metrics: {
      score: series.score?.[i] ?? 50,
      fcp: series.fcp?.[i] ?? 1000,
      lcp: series.lcp?.[i] ?? 3000,
      tbt: series.tbt?.[i] ?? 400,
      cls: series.cls?.[i] ?? 0,
      speedIndex: series.speedIndex?.[i] ?? 2000,
      tti: series.tti?.[i] ?? 4000,
      ttfb: series.ttfb?.[i] ?? 100,
      totalBytes: series.totalBytes?.[i] ?? 1_000_000,
      requests: series.requests?.[i] ?? 20,
    },
    warnings: [],
  }));
  return { url, profile: 'mobile', requestedRuns: n, samples, failures: [], startedAt: '', finishedAt: '' };
}

test('compareMeasurements marks a clear win as improved', () => {
  const base = measurement('a', { score: [50, 52, 51, 49, 50], lcp: [4000, 4100, 3900, 4050, 3950], tbt: [800, 820, 790, 810, 805] });
  const cand = measurement('b', { score: [75, 76, 74, 77, 75], lcp: [2000, 2100, 1950, 2050, 2020], tbt: [200, 210, 190, 205, 198] });
  const c = compareMeasurements(base, cand);
  assert.equal(c.verdict, 'improved');
  assert.equal(c.metrics.find((m) => m.key === 'lcp')?.verdict, 'improved');
});

test('compareMeasurements flags a regression even when another metric improved', () => {
  const base = measurement('a', { lcp: [2000, 2100, 1950, 2050, 2020], tbt: [800, 820, 790, 810, 805] });
  const cand = measurement('b', { lcp: [4000, 4100, 3900, 4050, 3950], tbt: [200, 210, 190, 205, 198] });
  assert.equal(compareMeasurements(base, cand).verdict, 'regressed');
});

test('compareMeasurements treats identical measurements as unchanged', () => {
  const m = measurement('a', {});
  assert.equal(compareMeasurements(m, measurement('b', {})).verdict, 'unchanged');
});
