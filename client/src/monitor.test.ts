import { describe, expect, it } from 'vitest';
import { chartScale, monitorStatusLabel, scheduleWords } from './monitor.ts';

describe('schedule words', () => {
  it('names the built-in schedules and leaves anything else as custom', () => {
    expect(scheduleWords(null)).toBe('Off');
    expect(scheduleWords('  ')).toBe('Off');
    expect(scheduleWords('0 9 * * *')).toBe('Daily at 09:00');
    expect(scheduleWords('0 9 * * 1')).toBe('Weekly Monday 09:00');
    expect(scheduleWords('0 */6 * * *')).toBe('custom cron');
  });
});

describe('monitor status label', () => {
  it('describes learning, health, a single breach, and an open regression', () => {
    expect(monitorStatusLabel({ minHistory: 3, baselineCount: 1, latestStatus: 'learning', incidentOpen: false })).toBe('Learning 1 of 3');
    expect(monitorStatusLabel({ minHistory: 3, baselineCount: 4, latestStatus: 'ok', incidentOpen: false })).toBe('Healthy');
    expect(monitorStatusLabel({ minHistory: 3, baselineCount: 4, latestStatus: 'breach', incidentOpen: false })).toBe('Breach 1 of 2');
    expect(monitorStatusLabel({ minHistory: 3, baselineCount: 4, latestStatus: 'regression', incidentOpen: true })).toBe('Regression open');
  });
});

describe('chart scale', () => {
  it('puts larger values higher and keeps x in order', () => {
    const scaled = chartScale([10, 30, null], 100, 40, 8);
    const first = scaled.points[0];
    const second = scaled.points[1];
    expect(first && second).toBeTruthy();
    expect(second!.y).toBeLessThan(first!.y);
    expect(second!.x).toBeGreaterThan(first!.x);
    expect(scaled.points[2]).toBeNull();
    expect(Number.isFinite(scaled.yFor(20))).toBe(true);
  });

  it('includes the reference band in the range', () => {
    const scaled = chartScale([10, 12], 80, 40, 4, [0, 40]);
    expect(scaled.min).toBe(0);
    expect(scaled.max).toBe(40);
  });
});
