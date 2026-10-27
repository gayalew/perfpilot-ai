import { METRICS, extractSample, type MetricKey, type Sample } from './metrics.js';
import { runLighthouseOnce, type ProfileName } from './lighthouse-runner.js';
import { summarize, type Summary } from './stats.js';

/** At least this many successful runs are needed for a measurement to be trusted. */
export const MIN_SUCCESSFUL_RUNS = 3;

export interface Measurement {
  url: string;
  profile: ProfileName;
  requestedRuns: number;
  samples: Sample[];
  failures: string[];
  startedAt: string;
  finishedAt: string;
}

export type Aggregate = Record<MetricKey, Summary | null>;

export interface MeasureOptions {
  url: string;
  runs?: number;
  profile?: ProfileName;
  chromePath?: string;
  onProgress?: (message: string) => void;
}

/** Runs Lighthouse once with one retry, since a single flaky run should not sink a measurement. */
async function sampleWithRetry(url: string, profile: ProfileName, chromePath?: string): Promise<Sample> {
  try {
    return extractSample(await runLighthouseOnce({ url, profile, chromePath }));
  } catch (first) {
    try {
      return extractSample(await runLighthouseOnce({ url, profile, chromePath }));
    } catch {
      throw first;
    }
  }
}

export function newMeasurement(url: string, profile: ProfileName, runs: number): Measurement {
  const now = new Date().toISOString();
  return { url, profile, requestedRuns: runs, samples: [], failures: [], startedAt: now, finishedAt: now };
}

/** Runs one more sample and records it (or the failure) on the measurement. */
export async function addRun(m: Measurement, chromePath?: string): Promise<void> {
  try {
    m.samples.push(await sampleWithRetry(m.url, m.profile, chromePath));
  } catch (err) {
    m.failures.push(err instanceof Error ? err.message : String(err));
  }
  m.finishedAt = new Date().toISOString();
}

export function assertUsable(m: Measurement): void {
  if (m.samples.length < MIN_SUCCESSFUL_RUNS) {
    const why = m.failures.length ? ` Last error: ${m.failures[m.failures.length - 1]}` : '';
    throw new Error(`Only ${m.samples.length} of ${m.requestedRuns} runs succeeded for ${m.url} (need ${MIN_SUCCESSFUL_RUNS}).${why}`);
  }
}

export async function measureUrl(options: MeasureOptions): Promise<Measurement> {
  const runs = options.runs ?? 5;
  const m = newMeasurement(options.url, options.profile ?? 'mobile', runs);
  for (let i = 1; i <= runs; i++) {
    options.onProgress?.(`${m.url}  run ${i}/${runs}`);
    await addRun(m, options.chromePath);
  }
  assertUsable(m);
  return m;
}

/**
 * Measures two URLs back to back (A, B, A, B, ...). Interleaving cancels slow drift in the
 * machine's speed, so a baseline and a candidate see the same conditions.
 */
export async function measureInterleaved(
  urlA: string,
  urlB: string,
  options: Omit<MeasureOptions, 'url'> = {},
): Promise<[Measurement, Measurement]> {
  const runs = options.runs ?? 5;
  const profile = options.profile ?? 'mobile';
  const a = newMeasurement(urlA, profile, runs);
  const b = newMeasurement(urlB, profile, runs);
  for (let i = 1; i <= runs; i++) {
    options.onProgress?.(`pair ${i}/${runs}`);
    await addRun(a, options.chromePath);
    await addRun(b, options.chromePath);
  }
  assertUsable(a);
  assertUsable(b);
  return [a, b];
}

export function values(m: Measurement, key: MetricKey): number[] {
  return m.samples.map((s) => s.metrics[key]).filter((v): v is number => typeof v === 'number');
}

export function aggregate(m: Measurement): Aggregate {
  const out = {} as Aggregate;
  for (const metric of METRICS) {
    const v = values(m, metric.key);
    out[metric.key] = v.length ? summarize(v) : null;
  }
  return out;
}
