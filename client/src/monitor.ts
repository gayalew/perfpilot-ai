export type MonitorStatus = 'ok' | 'learning' | 'breach' | 'regression';

export function scheduleWords(cron: string | null | undefined): string {
  if (!cron || !cron.trim()) return 'Off';
  const normalized = cron.trim().replace(/\s+/g, ' ');
  if (normalized === '0 9 * * *') return 'Daily at 09:00';
  if (normalized === '0 9 * * 1') return 'Weekly Monday 09:00';
  return 'custom cron';
}

export function monitorStatusLabel(input: {
  minHistory: number;
  baselineCount: number;
  latestStatus: MonitorStatus | null;
  incidentOpen: boolean;
}): string {
  if (input.incidentOpen || input.latestStatus === 'regression') return 'Regression open';
  if (input.latestStatus === 'breach') return 'Breach 1 of 2';
  if (input.latestStatus === 'learning' || input.latestStatus == null || input.baselineCount < input.minHistory) {
    const n = Math.max(0, Math.min(input.baselineCount, input.minHistory));
    return `Learning ${n} of ${input.minHistory}`;
  }
  return 'Healthy';
}

export interface ScaledPoint {
  x: number;
  y: number;
  value: number;
}

/** Maps values onto an SVG box. Larger values sit higher. Nulls stay gaps. */
export function chartScale(values: Array<number | null>, width: number, height: number, pad = 8, extras: number[] = []): {
  points: Array<ScaledPoint | null>;
  min: number;
  max: number;
  yFor: (value: number) => number;
} {
  const nums = [...values.filter((value): value is number => value != null && Number.isFinite(value)), ...extras.filter((value) => Number.isFinite(value))];
  const min = nums.length ? Math.min(...nums) : 0;
  const max = nums.length ? Math.max(...nums) : 1;
  const span = max - min || 1;
  const innerW = Math.max(1, width - pad * 2);
  const innerH = Math.max(1, height - pad * 2);
  const yFor = (value: number) => pad + (1 - (value - min) / span) * innerH;
  const step = values.length <= 1 ? 0 : innerW / Math.max(1, values.length - 1);
  const points = values.map((value, index) => {
    if (value == null || !Number.isFinite(value)) return null;
    return { x: pad + index * (values.length <= 1 ? innerW / 2 : step), y: yFor(value), value };
  });
  return { points, min, max, yFor };
}
