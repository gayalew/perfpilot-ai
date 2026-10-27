import type { Direction } from './stats.js';

/** The metrics PerfPilot tracks for every measurement. */
export type MetricKey = 'score' | 'fcp' | 'lcp' | 'tbt' | 'cls' | 'speedIndex' | 'tti' | 'ttfb' | 'totalBytes' | 'requests';

export interface MetricInfo {
  key: MetricKey;
  label: string;
  unit: 'points' | 'ms' | 'score' | 'bytes' | 'count';
  /** Whether lower or higher is better. */
  direction: Direction;
  /** Smallest absolute change worth acting on, in the metric's own unit. */
  minAbsoluteEffect: number;
  /** Main metrics shown first and used by the performance gate. */
  primary: boolean;
}

export const METRICS: MetricInfo[] = [
  { key: 'score', label: 'Performance score', unit: 'points', direction: 'higher', minAbsoluteEffect: 3, primary: true },
  { key: 'lcp', label: 'Largest Contentful Paint', unit: 'ms', direction: 'lower', minAbsoluteEffect: 100, primary: true },
  { key: 'fcp', label: 'First Contentful Paint', unit: 'ms', direction: 'lower', minAbsoluteEffect: 100, primary: false },
  { key: 'tbt', label: 'Total Blocking Time', unit: 'ms', direction: 'lower', minAbsoluteEffect: 50, primary: true },
  { key: 'cls', label: 'Cumulative Layout Shift', unit: 'score', direction: 'lower', minAbsoluteEffect: 0.01, primary: true },
  { key: 'speedIndex', label: 'Speed Index', unit: 'ms', direction: 'lower', minAbsoluteEffect: 150, primary: false },
  { key: 'tti', label: 'Time to Interactive', unit: 'ms', direction: 'lower', minAbsoluteEffect: 200, primary: false },
  { key: 'ttfb', label: 'Server response time', unit: 'ms', direction: 'lower', minAbsoluteEffect: 50, primary: false },
  { key: 'totalBytes', label: 'Page weight', unit: 'bytes', direction: 'lower', minAbsoluteEffect: 10_000, primary: false },
  { key: 'requests', label: 'Requests', unit: 'count', direction: 'lower', minAbsoluteEffect: 1, primary: false },
];

export const METRIC_BY_KEY: Record<MetricKey, MetricInfo> = Object.fromEntries(METRICS.map((m) => [m.key, m])) as Record<
  MetricKey,
  MetricInfo
>;

export type MetricValues = Record<MetricKey, number | null>;

/** One Lighthouse run, reduced to what PerfPilot needs. */
export interface Sample {
  metrics: MetricValues;
  /** CSS selector and HTML snippet of the Largest Contentful Paint element, when known. */
  lcpElement?: { selector?: string; snippet?: string };
  finalUrl?: string;
  lighthouseVersion?: string;
  warnings: string[];
}

// A minimal shape of a Lighthouse result, so we do not depend on its full type definitions.
interface AuditLike {
  numericValue?: number;
  score?: number | null;
  details?: unknown;
}
export interface LhrLike {
  lighthouseVersion?: string;
  finalDisplayedUrl?: string;
  finalUrl?: string;
  runWarnings?: string[];
  runtimeError?: { code?: string; message?: string };
  categories?: { performance?: { score?: number | null } };
  audits?: Record<string, AuditLike | undefined>;
}

function numeric(lhr: LhrLike, id: string): number | null {
  const v = lhr.audits?.[id]?.numericValue;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function requestCount(lhr: LhrLike): number | null {
  const details = lhr.audits?.['network-requests']?.details as { items?: unknown[] } | undefined;
  return Array.isArray(details?.items) ? details.items.length : null;
}

/** Finds the first element-like node ({ selector, snippet }) inside a Lighthouse details object. */
function findNode(value: unknown, depth = 0): { selector?: string; snippet?: string } | undefined {
  if (!value || typeof value !== 'object' || depth > 6) return undefined;
  const obj = value as Record<string, unknown>;
  if (obj.type === 'node' || typeof obj.selector === 'string') {
    return { selector: obj.selector as string | undefined, snippet: obj.snippet as string | undefined };
  }
  for (const child of Object.values(obj)) {
    const found = findNode(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}

export function extractSample(lhr: LhrLike): Sample {
  const rawScore = lhr.categories?.performance?.score;
  const metrics: MetricValues = {
    score: typeof rawScore === 'number' ? Math.round(rawScore * 100) : null,
    fcp: numeric(lhr, 'first-contentful-paint'),
    lcp: numeric(lhr, 'largest-contentful-paint'),
    tbt: numeric(lhr, 'total-blocking-time'),
    cls: numeric(lhr, 'cumulative-layout-shift'),
    speedIndex: numeric(lhr, 'speed-index'),
    tti: numeric(lhr, 'interactive'),
    ttfb: numeric(lhr, 'server-response-time'),
    totalBytes: numeric(lhr, 'total-byte-weight'),
    requests: requestCount(lhr),
  };
  return {
    metrics,
    lcpElement: findNode(lhr.audits?.['largest-contentful-paint-element']?.details),
    finalUrl: lhr.finalDisplayedUrl ?? lhr.finalUrl,
    lighthouseVersion: lhr.lighthouseVersion,
    warnings: lhr.runWarnings ?? [],
  };
}

export function formatMetric(key: MetricKey, value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  switch (METRIC_BY_KEY[key].unit) {
    case 'points':
      return `${Math.round(value)}`;
    case 'ms':
      return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
    case 'score':
      return value.toFixed(3);
    case 'bytes':
      return value >= 1_048_576 ? `${(value / 1_048_576).toFixed(2)} MB` : `${(value / 1024).toFixed(0)} KB`;
    case 'count':
      return `${Math.round(value)}`;
  }
}
