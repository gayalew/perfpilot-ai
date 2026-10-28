import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, renderReportHtml } from '../src/report/html.js';
import { formatSummary, type Ledger } from '../src/optimize.js';
import type { MetricKey } from '../src/metrics.js';

function summary(value: number) {
  return { median: value, mean: value, min: value, max: value, mad: 0, n: 4 };
}

test('report html escapes ledger text and renders every section', () => {
  assert.equal(escapeHtml(`<img src=x onerror="alert(1)">`), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  const keys: MetricKey[] = ['score', 'lcp', 'fcp', 'tbt', 'cls', 'speedIndex', 'totalBytes', 'requests'];
  const baseline = Object.fromEntries(keys.map((key) => [key, summary(key === 'score' ? 38 : 1000)])) as Ledger['baseline'];
  const final = Object.fromEntries(keys.map((key) => [key, summary(key === 'score' ? 65 : 200)])) as Ledger['final'];
  const ledger: Ledger = {
    runId: 'run-1',
    repo: 'acme/demo',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:10:00.000Z',
    aiSource: 'gemini',
    baseline,
    final,
    finalComparison: null,
    runs: 4,
    finalRuns: 5,
    steps: [
      {
        order: 1,
        fix: 'optimize-images',
        title: 'Resize images',
        status: 'kept',
        reason: 'Improved: page weight',
        files: ['<script>alert(1)</script>.js'],
        commit: 'abc123def456',
        gates: [{
          name: 'performance',
          passed: true,
          details: 'ok',
          ms: 10,
          comparison: {
            verdict: 'improved',
            summary: 'improved',
            metrics: [{
              key: 'totalBytes',
              label: 'page weight',
              primary: true,
              verdict: 'improved',
              baselineMedian: 1000,
              candidateMedian: 200,
              absoluteChange: -800,
              relativeChange: -0.8,
              pBetter: 0.01,
              pWorse: 0.99,
              baselineN: 4,
              candidateN: 4,
              method: 'mann-whitney',
              noise: false,
              reason: 'improved',
            }],
          },
        }],
        metrics: [],
      },
      {
        order: 2,
        fix: 'compress-text',
        title: 'Compress',
        status: 'reverted',
        reason: 'no measurable improvement <b>bad</b>',
        files: [],
        gates: [],
        metrics: [],
        regressions: [{ key: 'tbt', before: 100, after: 400, harm: true }],
      },
      {
        order: 3,
        fix: 'preconnect',
        title: 'Preconnect',
        status: 'skipped',
        reason: 'not auto-fixable; reported only',
        files: [],
        gates: [],
        metrics: [],
      },
    ],
  };
  const html = renderReportHtml(ledger, { projectName: 'Demo <site>', target: 'acme/demo', version: '0.1.0', prUrl: 'https://github.com/acme/demo/pull/2' });
  assert.match(html, /Before and after/);
  assert.match(html, /Kept changes/);
  assert.match(html, /Reverted and skipped changes/);
  assert.match(html, /Remaining recommendations/);
  assert.match(html, /Methodology/);
  assert.match(html, /simulated slow 4G/);
  assert.match(html, /Mann-Whitney U/);
  assert.match(html, /never merges/);
  assert.match(html, /1 proven performance improvement/);
  assert.doesNotMatch(html, /1 proven performance improvements/);
  assert.match(formatSummary(ledger), /1 proven performance improvement/);
  assert.match(html, /Score 38 to 65/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;\.js/);
  assert.match(html, /&lt;b&gt;bad&lt;\/b&gt;/);
  assert.match(html, /Counted as harm: tbt/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<b>bad<\/b>/);
  const runtime = renderReportHtml({ ...ledger, aiSource: 'runtime' }, { projectName: 'Demo <site>', target: 'acme/demo', version: '0.1.0' });
  assert.match(runtime, /1 proven runtime improvement/);
  assert.doesNotMatch(runtime, /1 proven runtime improvements/);
});
