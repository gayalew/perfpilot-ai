import { describe, expect, test } from 'vitest';
import { estimateMinutes, formatBytes, formatDuration, formatMs, formatPercentChange, formatRelativeTime, formatRunTitle, isQuietChange, resultHeadline, safeGithubUrl } from './format.ts';

describe('format helpers', () => {
  test('formats milliseconds and seconds', () => {
    expect(formatMs(31)).toBe('31 ms');
    expect(formatMs(1200)).toBe('1.2 s');
    expect(formatMs(30800)).toBe('30.8 s');
    expect(formatMs(null)).toBe('n/a');
  });

  test('formats bytes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(799 * 1024)).toBe('799 KB');
    expect(formatBytes(8.13 * 1024 * 1024)).toBe('8.13 MB');
  });

  test('formats signed percent change', () => {
    expect(formatPercentChange(38, 65)).toBe('+71.1%');
    expect(formatPercentChange(30.8, 4.77)).toBe('-84.5%');
    expect(formatPercentChange(0, 1)).toBe('n/a');
  });

  test('formats relative time and duration', () => {
    const now = Date.parse('2026-10-27T12:00:00Z');
    expect(formatRelativeTime('2026-10-27T11:00:00Z', now)).toBe('1 hour ago');
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(19 * 60_000 + 15_000)).toBe('19m 15s');
    expect(formatDuration(90 * 60_000)).toBe('1h 30m');
  });

  test('allows only GitHub links', () => {
    expect(safeGithubUrl('https://github.com/gayalew/perfpilot-ai/pull/1')).toBe('https://github.com/gayalew/perfpilot-ai/pull/1');
    expect(safeGithubUrl('http://github.com/acme/demo')).toBeNull();
    expect(safeGithubUrl('https://example.com')).toBeNull();
  });

  test('names a run with the local start time', () => {
    const started = new Date(2026, 9, 27, 10, 14).toISOString();
    expect(formatRunTitle('optimize', started)).toBe('Optimize run, Oct 27, 10:14');
    expect(formatRunTitle('audit', null)).toBe('Audit run');
    expect(formatRunTitle('optimize', 'not-a-date')).toBe('Optimize run');
  });

  test('builds a headline from the three largest proven improvements', () => {
    expect(resultHeadline([
      { key: 'lcp', before: 30800, after: 4770, verdict: 'improved' },
      { key: 'tbt', before: 543, after: 31, verdict: 'improved' },
      { key: 'totalBytes', before: 8_130_000, after: 799_000, verdict: 'improved' },
      { key: 'score', before: 38, after: 65, verdict: 'improved' },
      { key: 'fcp', before: 3490, after: 3400, verdict: 'unchanged' },
      { key: 'cls', before: 0.19, after: 0.4, verdict: 'regressed' },
    ])).toBe('TBT -94%, page weight -90%, LCP -85%');
    expect(resultHeadline([
      { key: 'cls', before: 0.19, after: 0.19, verdict: 'unchanged' },
      { key: 'score', before: 38, after: 30, verdict: 'regressed' },
    ])).toBe('No proven improvement');
    expect(resultHeadline([{ key: 'lcp', before: 0, after: 10, verdict: 'improved' }])).toBe('No proven improvement');
  });

  test('mutes a row only when the change is under 0.5% and the verdict is unchanged', () => {
    expect(isQuietChange(1000, 1004, 'unchanged')).toBe(true);
    expect(isQuietChange(1000, 1005, 'unchanged')).toBe(false);
    expect(isQuietChange(1000, 1002, 'improved')).toBe(false);
    expect(isQuietChange(1000, 800, 'unchanged')).toBe(false);
    expect(isQuietChange(null, 1, 'unchanged')).toBe(false);
  });

  test('estimates run length from the job type, runs, and selected fixes', () => {
    expect(estimateMinutes('audit', 4, 8)).toBe(3);
    expect(estimateMinutes('monitor', 5, 8)).toBe(4);
    expect(estimateMinutes('field', 4, 8)).toBe(2);
    expect(estimateMinutes('optimize', 4, 8)).toBe(20);
    expect(estimateMinutes('optimize', 4, 8, [])).toBe(20);
    expect(estimateMinutes('optimize', 4, 8, ['defer-scripts', 'minify-assets', 'optimize-images'])).toBe(14);
    expect(estimateMinutes('experiment', 4, 8)).toBe(13);
    expect(estimateMinutes('experiment', 4, 8, ['defer-scripts'])).toBe(6);
  });
});
