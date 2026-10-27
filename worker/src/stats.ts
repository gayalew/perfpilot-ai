/**
 * Statistics used to decide whether a change really improved (or hurt) a metric.
 *
 * Lighthouse results are noisy, so a single before/after pair proves nothing.
 * PerfPilot measures each variant several times and only keeps a change when
 *   1. a one-sided Mann-Whitney U test says the improvement is unlikely to be chance, and
 *   2. the improvement is bigger than a minimum effect size, and
 *   3. the improvement is bigger than the run-to-run noise of the baseline.
 */

export type Alternative = 'less' | 'greater' | 'two-sided';
export type Direction = 'lower' | 'higher';

export interface Summary {
  n: number;
  median: number;
  mad: number;
  mean: number;
  min: number;
  max: number;
}

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Median absolute deviation (unscaled). */
export function mad(values: number[]): number {
  if (values.length === 0) return NaN;
  const m = median(values);
  return median(values.map((v) => Math.abs(v - m)));
}

/** MAD scaled so it estimates the standard deviation for roughly normal data. */
export function scaledMad(values: number[]): number {
  return 1.4826 * mad(values);
}

export function summarize(values: number[]): Summary {
  const n = values.length;
  return {
    n,
    median: median(values),
    mad: mad(values),
    mean: n ? values.reduce((a, b) => a + b, 0) / n : NaN,
    min: n ? Math.min(...values) : NaN,
    max: n ? Math.max(...values) : NaN,
  };
}

/** Midranks (ties share the average rank), 1-based. */
function midranks(values: number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1].v === indexed[i].v) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[indexed[k].i] = rank;
    i = j + 1;
  }
  return ranks;
}

/** Standard normal CDF (Numerical Recipes erfc approximation, error < 1.2e-7). */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.5 * x);
  const erfc =
    t *
    Math.exp(
      -x * x -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))))
    );
  const cdf = 1 - 0.5 * erfc;
  return z >= 0 ? cdf : 1 - cdf;
}

/** Largest pooled sample size for which we enumerate every possible split (C(16, 8) = 12,870). */
const EXACT_LIMIT = 16;
const EPS = 1e-9;

export interface MannWhitneyResult {
  /** U statistic of the first sample. */
  u: number;
  /** p-value for the chosen alternative. */
  p: number;
  method: 'exact' | 'normal';
  n1: number;
  n2: number;
}

/**
 * Mann-Whitney U test (Wilcoxon rank-sum).
 *
 * alternative 'less'      : x tends to be smaller than y
 * alternative 'greater'   : x tends to be larger than y
 * alternative 'two-sided' : x and y differ
 *
 * Small samples (pooled size <= 16) use the exact permutation distribution of the
 * rank sum, which stays valid with ties. Larger samples use the normal approximation
 * with tie and continuity corrections.
 */
export function mannWhitneyU(x: number[], y: number[], alternative: Alternative = 'two-sided'): MannWhitneyResult {
  const n1 = x.length;
  const n2 = y.length;
  if (n1 === 0 || n2 === 0) throw new Error('mannWhitneyU needs at least one value in each sample');

  const pooled = [...x, ...y];
  const ranks = midranks(pooled);
  const rankSumX = ranks.slice(0, n1).reduce((a, b) => a + b, 0);
  const u = rankSumX - (n1 * (n1 + 1)) / 2;
  const N = n1 + n2;

  let pLess: number; // P(R <= observed)
  let pGreater: number; // P(R >= observed)
  let method: 'exact' | 'normal';

  if (N <= EXACT_LIMIT) {
    method = 'exact';
    let total = 0;
    let le = 0;
    let ge = 0;
    const choose = (start: number, left: number, sum: number): void => {
      if (left === 0) {
        total++;
        if (sum <= rankSumX + EPS) le++;
        if (sum >= rankSumX - EPS) ge++;
        return;
      }
      for (let i = start; i <= N - left; i++) choose(i + 1, left - 1, sum + ranks[i]);
    };
    choose(0, n1, 0);
    pLess = le / total;
    pGreater = ge / total;
  } else {
    method = 'normal';
    const counts = new Map<number, number>();
    for (const v of pooled) counts.set(v, (counts.get(v) ?? 0) + 1);
    let tieTerm = 0;
    for (const t of counts.values()) tieTerm += t ** 3 - t;
    const mu = (n1 * n2) / 2;
    const variance = ((n1 * n2) / 12) * (N + 1 - tieTerm / (N * (N - 1)));
    if (variance <= 0) {
      pLess = 1;
      pGreater = 1;
    } else {
      const sd = Math.sqrt(variance);
      pLess = normalCdf((u + 0.5 - mu) / sd);
      pGreater = 1 - normalCdf((u - 0.5 - mu) / sd);
    }
  }

  const p =
    alternative === 'less' ? pLess : alternative === 'greater' ? pGreater : Math.min(1, 2 * Math.min(pLess, pGreater));
  return { u, p: Math.min(1, Math.max(0, p)), method, n1, n2 };
}

export interface CompareOptions {
  /** Whether a lower or a higher value is better for this metric. */
  direction: Direction;
  /** Significance level for the one-sided test. Default 0.05. */
  alpha?: number;
  /** Smallest relative change that counts, for example 0.05 = 5 percent. Default 0.05. */
  minRelativeEffect?: number;
  /** Smallest absolute change that counts, in the metric's own unit. Default 0. */
  minAbsoluteEffect?: number;
  /** The change must also exceed this many scaled MADs of the baseline noise. Default 1. */
  noiseMultiplier?: number;
}

export type Verdict = 'improved' | 'regressed' | 'unchanged';

export interface CompareResult {
  verdict: Verdict;
  baselineMedian: number;
  candidateMedian: number;
  /** candidate - baseline, in the metric's unit. */
  absoluteChange: number;
  /** (candidate - baseline) / |baseline|; NaN when the baseline median is 0. */
  relativeChange: number;
  /** p-value that the candidate is better than the baseline. */
  pBetter: number;
  /** p-value that the candidate is worse than the baseline. */
  pWorse: number;
  method: 'exact' | 'normal';
  noise: number;
  reason: string;
}

/**
 * Decide whether `candidate` is a real improvement or a real regression compared
 * with `baseline`, taking the metric's direction into account.
 */
export function compareSamples(baseline: number[], candidate: number[], options: CompareOptions): CompareResult {
  const alpha = options.alpha ?? 0.05;
  const minRel = options.minRelativeEffect ?? 0.05;
  const minAbs = options.minAbsoluteEffect ?? 0;
  const noiseMult = options.noiseMultiplier ?? 1;

  const baselineMedian = median(baseline);
  const candidateMedian = median(candidate);
  const absoluteChange = candidateMedian - baselineMedian;
  const relativeChange = baselineMedian === 0 ? NaN : absoluteChange / Math.abs(baselineMedian);
  const noise = scaledMad(baseline);

  // Direction-aware tests: "better" means smaller for 'lower', larger for 'higher'.
  const betterAlt: Alternative = options.direction === 'lower' ? 'less' : 'greater';
  const worseAlt: Alternative = options.direction === 'lower' ? 'greater' : 'less';
  const better = mannWhitneyU(candidate, baseline, betterAlt);
  const worse = mannWhitneyU(candidate, baseline, worseAlt);

  const size = Math.abs(absoluteChange);
  const bigEnough =
    size >= minAbs && size > noiseMult * noise && (Number.isNaN(relativeChange) || Math.abs(relativeChange) >= minRel);
  const movedBetter = options.direction === 'lower' ? absoluteChange < 0 : absoluteChange > 0;

  let verdict: Verdict = 'unchanged';
  let reason: string;
  if (bigEnough && movedBetter && better.p < alpha) {
    verdict = 'improved';
    reason = `improved: p=${better.p.toFixed(4)} < ${alpha} and the change is larger than the noise`;
  } else if (bigEnough && !movedBetter && worse.p < alpha) {
    verdict = 'regressed';
    reason = `regressed: p=${worse.p.toFixed(4)} < ${alpha} and the change is larger than the noise`;
  } else if (!bigEnough) {
    reason = 'change is smaller than the minimum effect size or the run-to-run noise';
  } else {
    reason = `not significant: p=${(movedBetter ? better.p : worse.p).toFixed(4)} >= ${alpha}`;
  }

  return {
    verdict,
    baselineMedian,
    candidateMedian,
    absoluteChange,
    relativeChange,
    pBetter: better.p,
    pWorse: worse.p,
    method: better.method,
    noise,
    reason,
  };
}
