import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export type MonitorStatus = 'ok' | 'learning' | 'breach' | 'regression';

export interface MonitorPoint {
  id: string;
  takenAt: string;
  status: MonitorStatus;
  samples: Partial<Record<string, number[]>>;
}

export interface MonitorComparison {
  key: string;
  label: string;
  baselineMedian: number;
  candidateMedian: number;
  relativeChange: number;
  verdict: 'improved' | 'regressed' | 'unchanged';
  noise: number;
  breach: boolean;
  pWorse: number;
}

export interface MonitorEvaluation {
  status: MonitorStatus;
  reference: { samples: Record<string, number[]>; medians: Record<string, number> } | null;
  comparisons: MonitorComparison[];
  consecutiveBreaches: number;
  openIncident: boolean;
  shouldAlert: boolean;
  shouldSendRecovery: boolean;
  /** When the current breach streak started, from a previous measurement. */
  firstBreachAt: string | null;
}

export interface EvaluateOptions {
  minHistory?: number;
  incidentOpen?: boolean;
}

interface CompareResult {
  verdict: 'improved' | 'regressed' | 'unchanged';
  baselineMedian: number;
  candidateMedian: number;
  relativeChange: number;
  pWorse: number;
  noise: number;
}

interface MetricInfo {
  key: string;
  label: string;
  direction: 'lower' | 'higher';
  minAbsoluteEffect: number;
}

interface Bridge {
  compareSamples: (baseline: number[], candidate: number[], options: {
    direction: 'lower' | 'higher';
    alpha?: number;
    minRelativeEffect?: number;
    minAbsoluteEffect?: number;
  }) => CompareResult;
  METRICS: MetricInfo[];
  regressionCountsAsHarm: (metric: { key: string; verdict: string; baselineMedian: number; candidateMedian: number }) => boolean;
}

const PRIMARY = ['score', 'lcp', 'tbt', 'cls'];

let bridge: Bridge | undefined;

function workerFns(): Bridge {
  if (bridge) return bridge;
  const stats = require('../../../worker/src/stats.ts') as Pick<Bridge, 'compareSamples'>;
  const metrics = require('../../../worker/src/metrics.ts') as Pick<Bridge, 'METRICS'>;
  const optimize = require('../../../worker/src/optimize.ts') as Pick<Bridge, 'regressionCountsAsHarm'>;
  bridge = {
    compareSamples: stats.compareSamples,
    METRICS: metrics.METRICS,
    regressionCountsAsHarm: optimize.regressionCountsAsHarm,
  };
  return bridge;
}

function byTime(a: MonitorPoint, b: MonitorPoint): number {
  const delta = Date.parse(a.takenAt) - Date.parse(b.takenAt);
  if (delta !== 0 && Number.isFinite(delta)) return delta;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function finite(values: unknown): number[] {
  if (!Array.isArray(values)) return [];
  return values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

function empty(status: MonitorStatus, incidentOpen: boolean): MonitorEvaluation {
  return {
    status,
    reference: null,
    comparisons: [],
    consecutiveBreaches: 0,
    openIncident: incidentOpen,
    shouldAlert: false,
    shouldSendRecovery: false,
    firstBreachAt: null,
  };
}

/**
 * Compare a fresh measurement with the healthy history.
 * Reference samples are the per-run values pooled from the last three usable checks.
 * A breach measurement is left out of that pool.
 */
export function evaluateMonitor(history: MonitorPoint[], current: { samples: Partial<Record<string, number[]>> }, options: EvaluateOptions = {}): MonitorEvaluation {
  const minHistory = options.minHistory ?? 3;
  const sorted = [...history].sort(byTime);
  const eligible = sorted.filter((point) => point.status === 'ok' || point.status === 'learning');
  if (eligible.length < minHistory) return empty('learning', Boolean(options.incidentOpen));

  const ok = eligible.filter((point) => point.status === 'ok');
  const pool = (ok.length >= minHistory ? ok : eligible).slice(-3);
  const fns = workerFns();
  const referenceSamples: Record<string, number[]> = {};
  const referenceMedians: Record<string, number> = {};
  const comparisons: MonitorComparison[] = [];

  for (const key of PRIMARY) {
    const info = fns.METRICS.find((metric) => metric.key === key);
    if (!info) continue;
    const baseline = pool.flatMap((point) => finite(point.samples[key]));
    const candidate = finite(current.samples[key]);
    if (baseline.length === 0 || candidate.length === 0) continue;
    referenceSamples[key] = baseline;
    const compared = fns.compareSamples(baseline, candidate, {
      direction: info.direction,
      alpha: 0.05,
      minRelativeEffect: key === 'cls' ? 0 : 0.05,
      minAbsoluteEffect: info.minAbsoluteEffect,
    });
    referenceMedians[key] = compared.baselineMedian;
    const breach = compared.verdict === 'regressed' && fns.regressionCountsAsHarm({
      key,
      verdict: compared.verdict,
      baselineMedian: compared.baselineMedian,
      candidateMedian: compared.candidateMedian,
    });
    comparisons.push({
      key,
      label: info.label,
      baselineMedian: compared.baselineMedian,
      candidateMedian: compared.candidateMedian,
      relativeChange: compared.relativeChange,
      verdict: compared.verdict,
      noise: compared.noise,
      breach,
      pWorse: compared.pWorse,
    });
  }

  const breached = comparisons.some((row) => row.breach);
  let trailing = 0;
  let firstBreachAt: string | null = null;
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const status = sorted[index]?.status;
    if (status !== 'breach' && status !== 'regression') break;
    trailing += 1;
    firstBreachAt = sorted[index]?.takenAt ?? firstBreachAt;
  }
  const consecutiveBreaches = breached ? trailing + 1 : 0;
  const incidentOpen = Boolean(options.incidentOpen);

  if (breached && (consecutiveBreaches >= 2 || incidentOpen)) {
    return {
      status: 'regression',
      reference: { samples: referenceSamples, medians: referenceMedians },
      comparisons,
      consecutiveBreaches,
      openIncident: true,
      shouldAlert: consecutiveBreaches >= 2 && !incidentOpen,
      shouldSendRecovery: false,
      firstBreachAt,
    };
  }
  if (breached) {
    return {
      status: 'breach',
      reference: { samples: referenceSamples, medians: referenceMedians },
      comparisons,
      consecutiveBreaches,
      openIncident: false,
      shouldAlert: false,
      shouldSendRecovery: false,
      firstBreachAt: null,
    };
  }
  if (incidentOpen) {
    return {
      status: 'ok',
      reference: { samples: referenceSamples, medians: referenceMedians },
      comparisons,
      consecutiveBreaches: 0,
      openIncident: false,
      shouldAlert: false,
      shouldSendRecovery: true,
      firstBreachAt: null,
    };
  }
  return {
    status: 'ok',
    reference: { samples: referenceSamples, medians: referenceMedians },
    comparisons,
    consecutiveBreaches: 0,
    openIncident: false,
    shouldAlert: false,
    shouldSendRecovery: false,
    firstBreachAt: null,
  };
}
