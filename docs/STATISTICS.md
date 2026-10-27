# Statistics

The gate code is `compareSamples` in `worker/src/stats.ts`, `compareMeasurements` in `worker/src/compare.ts`, and `judgePerformance` in `worker/src/optimize.ts`. Monitoring calls those same functions from `server/src/monitor/evaluate.ts`.

## Why runs are interleaved

`measureInterleaved` takes one Lighthouse run of the baseline, then one of the candidate, and repeats. Alternating spreads machine noise (CPU, thermals, other processes) across both sides. A block of "all before, then all after" would credit a quiet or busy stretch to one side.

## Mann-Whitney U

For each metric, the candidate sample is compared with the baseline sample. The test is one-sided: "less" when lower is better, "greater" when higher is better. Ties use midranks.

- Pooled size `n1 + n2` of 16 or less uses the exact permutation distribution of the rank sum. There are C(8, 4) = 70 splits at 4 and 4, and C(16, 8) = 12,870 at the cutoff.
- Larger samples use a normal approximation with a tie correction and a continuity correction of 0.5.

The significance level is `alpha = 0.05`. A result counts only when `p < 0.05`.

## Why 4 runs per side is the minimum

With 3 and 3, there are C(6, 3) = 20 equally likely rank assignments. The most extreme one-sided outcome is 1 of those 20, so the smallest p is 0.05. The comparison requires `p < 0.05`, so 3 versus 3 can never pass, even with complete separation. With 4 and 4 the most extreme p is 1/70, about 0.014, which is below 0.05. The API therefore rejects audit, optimize, and experiment jobs with `runs` below 4. The CLI still allows 3 for a raw measurement. Monitor jobs allow 3 because they are pooled with earlier checks before the test runs.

## Effect size and noise

A significant p-value is not enough. The absolute median change must also be:

- at least the metric's `minAbsoluteEffect`, and
- strictly greater than `noiseMultiplier * scaledMad(baseline)` (`noiseMultiplier` defaults to 1), and
- at least 5% of the baseline median, unless the baseline median is 0 (the relative term is skipped) or the metric is CLS.

`scaledMad` is `1.4826 * MAD`, the usual normal-consistent scale. CLS uses `minRelativeEffect: 0` inside `compareMeasurements` and in the monitor comparison, because a baseline of 0 makes a relative change undefined and a small CLS move is judged by the absolute floor of 0.01.

Absolute floors from `METRICS`:

| Metric | Floor | Primary |
| --- | --- | --- |
| score | 3 points | yes |
| LCP | 100 ms | yes |
| TBT | 50 ms | yes |
| CLS | 0.01 | yes |
| FCP | 100 ms | no |
| Speed Index | 150 ms | no |
| TTI | 200 ms | no |
| TTFB | 50 ms | no |
| page weight | 10,000 bytes | no |
| requests | 1 | no |

Primary metrics are score, LCP, TBT, and CLS. `compareMeasurements` calls the set regressed if any primary metric is `regressed`, improved if at least one primary is `improved` and none are `regressed`, otherwise unchanged.

## Harm policy

`judgePerformance` keeps a fix only when at least one primary metric is `improved` and no regression counts as harm. Statistical thresholds stay in `compareSamples`. Harm is separate:

- A regressed performance score is always harm.
- LCP, TBT, and CLS are harm when the median moves from the "good" side of the ceiling to the other side, or when it was already worse than the ceiling and gets more than 10% worse.
- Any other metric, including a primary metric that regresses while staying inside the ceiling, does not by itself block the fix.

Ceilings in `CWV_GOOD`: LCP 2500 ms, TBT 200 ms, CLS 0.1. FCP is not in that set.

## Monitoring rule

`evaluateMonitor` does not score the new check until at least `MONITOR_MIN_HISTORY` earlier checks (default 3) have status `ok` or `learning`. Until then the new row is `learning` and nothing is sent.

The reference sample for each of score, LCP, TBT, and CLS is the per-run values pooled from the last three `ok` checks. If there are fewer than three `ok` checks, the pool is the last three `ok` or `learning` checks. Breach and regression rows are left out of the pool.

A metric is a breach when `compareSamples` says `regressed` and `regressionCountsAsHarm` agrees, with the same alpha, absolute floors, and the CLS relative exception. One breach sets the row to `breach` and does not alert. A second breach in a row, or a breach while an incident is already open, sets `regression`. The alert is sent only when that streak reaches two and no incident is open, so each incident sends one alert. Later bad checks update `last_measurement_id` and do not send again. The next check that is not a breach, while an incident is open, sets `ok`, closes the incident, and sends one recovery message.

## Limitations

- Profiles use Lighthouse simulated throttling (`throttlingMethod: "simulate"`), not a real slow network. The mobile profile is simulated slow 4G and a 4× CPU slowdown. That is more repeatable and is not a field trace.
- Gate decisions are lab measurements on one machine. PSI and CrUX are stored separately and are not inputs to `judgePerformance`.
- One laptop's background load still moves the medians. Interleaving and the noise floor reduce that; they do not remove it. Close other heavy apps before a demo run.
