import { describe, expect, test } from 'vitest';
import { estimateMinutes, formatBytes, formatDuration, formatMs, formatPercentChange, formatRelativeTime, safeGithubUrl } from './format.ts';

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

  test('estimates run length', () => {
    expect(estimateMinutes('audit', 4, 8)).toBeGreaterThan(0);
    expect(estimateMinutes('optimize', 4, 8)).toBeGreaterThan(estimateMinutes('audit', 4, 8));
  });
});
