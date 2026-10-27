import { describe, expect, test } from 'vitest';
import { reduceEvents, type JobEventInput } from './jobState.ts';

function agg(score: number, lcp: number, tbt: number, cls: number, bytes: number) {
  const row = (median: number) => ({ median, mean: median, min: median, max: median, n: 4 });
  return { score: row(score), lcp: row(lcp), tbt: row(tbt), cls: row(cls), totalBytes: row(bytes), fcp: row(3000), speedIndex: row(8000), requests: row(14) };
}

function metric(key: string, label: string, before: number, after: number, verdict: string) {
  const relativeChange = before === 0 ? 0 : (after - before) / Math.abs(before);
  return { key, label, primary: true, verdict, baselineMedian: before, candidateMedian: after, relativeChange, pBetter: 0.01, pWorse: 0.99 };
}

function eventsFor(order: number, fix: string, status: string, reason: string, failAt?: string): JobEventInput[] {
  const gates = ['build', 'smoke', 'visual', 'performance'];
  const list: JobEventInput[] = [{ id: order * 10, type: 'step-start', payload: { order, fix } }];
  for (const gate of gates) {
    if (failAt && gates.indexOf(gate) > gates.indexOf(failAt)) break;
    list.push({ id: order * 10 + gates.indexOf(gate) + 1, type: 'gate-start', payload: { order, fix, gate } });
    const passed = gate !== failAt;
    list.push({ id: order * 10 + gates.indexOf(gate) + 5, type: 'gate-end', payload: { order, fix, gate, passed, details: passed ? 'ok' : 'failed', ms: 20 } });
    if (!passed) break;
  }
  list.push({ id: order * 10 + 9, type: 'step-end', payload: { order, fix, status, reason } });
  return list;
}

const ledger = {
  aiSource: 'gemini',
  baseline: agg(38, 30800, 543, 0.19, 8.13 * 1024 * 1024),
  final: agg(65, 4770, 31, 0.19, 799 * 1024),
  steps: [
    { order: 1, fix: 'lazy-load-images', title: 'Lazy-load below-the-fold images', status: 'kept', reason: 'Improved: TBT', attempts: 1, gates: [{ name: 'performance', passed: true, comparison: { metrics: [metric('tbt', 'TBT', 543, 200, 'improved')] } }] },
    { order: 2, fix: 'optimize-images', title: 'Resize and recompress images (WebP/AVIF)', status: 'kept', reason: 'Improved: page weight', attempts: 1, gates: [{ name: 'performance', passed: true, comparison: { metrics: [metric('totalBytes', 'page weight', 8000000, 800000, 'improved')] } }] },
    {
      order: 3,
      fix: 'compress-text',
      title: 'Enable gzip/brotli compression',
      status: 'reverted',
      reason: 'Performance gate failed: harm: score, tbt',
      attempts: 2,
      gates: [{ name: 'performance', passed: false, comparison: { metrics: [metric('score', 'score', 38, 30, 'regressed'), metric('tbt', 'TBT', 543, 600, 'regressed')] } }],
    },
    { order: 4, fix: 'defer-scripts', title: 'Defer render-blocking scripts', status: 'skipped', reason: 'Needs a review before it can be applied automatically.', attempts: 1, gates: [] },
  ],
};

describe('job reducer', () => {
  test('replays a successful optimize: two kept, one reverted, one skipped', () => {
    const events: JobEventInput[] = [
      { id: 1, type: 'job-start', payload: { type: 'optimize' } },
      ...eventsFor(1, 'lazy-load-images', 'kept', 'Improved: TBT'),
      ...eventsFor(2, 'optimize-images', 'kept', 'Improved: page weight'),
      ...eventsFor(3, 'compress-text', 'reverted', 'Performance gate failed', 'smoke'),
      { id: 40, type: 'step-start', payload: { order: 4, fix: 'defer-scripts' } },
      { id: 49, type: 'step-end', payload: { order: 4, fix: 'defer-scripts', status: 'skipped', reason: 'Needs a review' } },
      { id: 50, type: 'run-end', payload: { kept: 2, reverted: 1, skipped: 1, errored: 0 } },
      { id: 51, type: 'pr-created', payload: { url: 'https://github.com/acme/demo/pull/1', number: 1 } },
      { id: 52, type: 'log', payload: { line: 'done' } },
      { id: 52, type: 'log', payload: { line: 'duplicate' } },
      { id: 53, type: 'not-a-real-event', payload: { surprise: true } },
      { id: 54, type: 'job-end', payload: { ok: true, prUrl: 'https://github.com/acme/demo/pull/1', ledger } },
    ];
    const view = reduceEvents(events);
    expect(view.finished).toBe(true);
    expect(view.ok).toBe(true);
    expect(view.counts).toEqual({ kept: 2, reverted: 1, skipped: 1 });
    expect(view.experiments.map((item) => item.status)).toEqual(['kept', 'kept', 'reverted', 'skipped']);
    expect(view.experiments[2]?.attempts).toBe(2);
    expect(view.experiments[2]?.metrics.some((row) => row.verdict === 'regressed')).toBe(true);
    expect(view.experiments[0]?.metrics[0]?.verdict).toBe('improved');
    expect(view.experiments[3]?.gates.every((gate) => gate.state === 'not-run')).toBe(true);
    expect(view.baseline?.score).toBe(38);
    expect(view.final?.lcp).toBe(4770);
    expect(view.planSource).toBe('gemini');
    expect(view.plan).toHaveLength(4);
    expect(view.prUrl).toBe('https://github.com/acme/demo/pull/1');
    expect(view.logs).toEqual(['done']);
    expect(view.experiments).toHaveLength(4);
  });

  test('records a failed job', () => {
    const view = reduceEvents([
      { id: 1, type: 'job-start', payload: { type: 'audit' } },
      { id: 2, type: 'job-end', payload: { ok: false, error: 'lighthouse timed out' } },
    ]);
    expect(view.finished).toBe(true);
    expect(view.ok).toBe(false);
    expect(view.error).toBe('lighthouse timed out');
    expect(view.baseline).toBeNull();
  });

  test('reads an audit plan and baseline from job-end, including a heuristic fallback note', () => {
    const view = reduceEvents([
      { id: 1, type: 'job-start', payload: { type: 'audit' } },
      {
        id: 2,
        type: 'job-end',
        payload: {
          ok: true,
          baseline: agg(34, 30600, 646, 0.19, 8000000),
          plan: {
            source: 'heuristic',
            note: 'Gemini unavailable; used the built-in ranking.',
            steps: [{ order: 1, fix: 'optimize-images', rationale: 'Images are larger than the viewport.' }],
          },
        },
      },
    ]);
    expect(view.baseline?.cls).toBe(0.19);
    expect(view.planSource).toBe('heuristic');
    expect(view.planNote).toMatch(/built-in ranking/);
    expect(view.plan[0]?.title).toBe('Resize and recompress images (WebP/AVIF)');
    expect(view.plan[0]?.rationale).toMatch(/viewport/);
  });

  test('a repair attempt is taken from the ledger when the live step-end has no attempts field', () => {
    const view = reduceEvents([
      ...eventsFor(1, 'compress-text', 'reverted', 'gate failed', 'performance'),
      { id: 90, type: 'job-end', payload: { ok: true, prUrl: null, reason: 'No fix was kept, so no branch was pushed.', ledger: { aiSource: 'heuristic (Gemini unavailable (HTTP 503); used the built-in ranking.)', steps: [{ ...ledger.steps[2], order: 1 }], baseline: agg(38, 30800, 543, 0.19, 1000), final: null } } },
    ]);
    expect(view.experiments[0]?.attempts).toBe(2);
    expect(view.planSource).toBe('heuristic');
    expect(view.planNote).toMatch(/HTTP 503/);
    expect(view.resultNote).toMatch(/no branch/);
  });
});
