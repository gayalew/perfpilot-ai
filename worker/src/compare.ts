import { METRICS, formatMetric, type MetricKey } from './metrics.js';
import { values, type Measurement } from './measure.js';
import { compareSamples, type CompareResult, type Verdict } from './stats.js';

export interface MetricComparison extends CompareResult {
  key: MetricKey;
  label: string;
  primary: boolean;
  baselineN: number;
  candidateN: number;
}

export interface Comparison {
  baselineUrl: string;
  candidateUrl: string;
  metrics: MetricComparison[];
  /**
   * Overall verdict on the primary metrics:
   *  - regressed: any primary metric got significantly worse
   *  - improved: at least one primary metric got significantly better and none got worse
   *  - unchanged: otherwise
   */
  verdict: Verdict;
  summary: string;
}

export interface CompareConfig {
  alpha?: number;
  minRelativeEffect?: number;
}

export function compareMeasurements(baseline: Measurement, candidate: Measurement, config: CompareConfig = {}): Comparison {
  const metrics: MetricComparison[] = [];
  for (const info of METRICS) {
    const b = values(baseline, info.key);
    const c = values(candidate, info.key);
    if (b.length === 0 || c.length === 0) continue;
    // CLS is often exactly 0 on both sides; the relative test is meaningless there, so rely on the absolute floor.
    const result = compareSamples(b, c, {
      direction: info.direction,
      alpha: config.alpha,
      minRelativeEffect: info.key === 'cls' ? 0 : config.minRelativeEffect,
      minAbsoluteEffect: info.minAbsoluteEffect,
    });
    metrics.push({ ...result, key: info.key, label: info.label, primary: info.primary, baselineN: b.length, candidateN: c.length });
  }

  const primary = metrics.filter((m) => m.primary);
  const regressed = primary.filter((m) => m.verdict === 'regressed');
  const improved = primary.filter((m) => m.verdict === 'improved');
  let verdict: Verdict = 'unchanged';
  if (regressed.length > 0) verdict = 'regressed';
  else if (improved.length > 0) verdict = 'improved';

  const describe = (list: MetricComparison[]) => list.map((m) => m.label).join(', ');
  const summary =
    verdict === 'regressed'
      ? `Regressed: ${describe(regressed)}`
      : verdict === 'improved'
        ? `Improved: ${describe(improved)}`
        : 'No statistically reliable change in the main metrics';

  return { baselineUrl: baseline.url, candidateUrl: candidate.url, metrics, verdict, summary };
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

export function formatComparison(c: Comparison): string {
  const lines: string[] = [];
  lines.push(`Baseline:  ${c.baselineUrl}`);
  lines.push(`Candidate: ${c.candidateUrl}`);
  lines.push('');
  lines.push(`${pad('Metric', 28)}${pad('Baseline', 12)}${pad('Candidate', 12)}${pad('Change', 10)}${pad('p', 8)}Verdict`);
  lines.push('-'.repeat(82));
  for (const m of c.metrics) {
    const change = Number.isNaN(m.relativeChange) ? '' : `${m.relativeChange > 0 ? '+' : ''}${(m.relativeChange * 100).toFixed(0)}%`;
    const p = Math.min(m.pBetter, m.pWorse).toFixed(3);
    lines.push(
      `${pad(m.label + (m.primary ? ' *' : ''), 28)}${pad(formatMetric(m.key, m.baselineMedian), 12)}${pad(
        formatMetric(m.key, m.candidateMedian),
        12,
      )}${pad(change, 10)}${pad(p, 8)}${m.verdict}`,
    );
  }
  lines.push('');
  lines.push(`Overall: ${c.verdict.toUpperCase()}. ${c.summary}`);
  lines.push('(* = primary metric used for the keep/revert decision)');
  return lines.join('\n');
}
