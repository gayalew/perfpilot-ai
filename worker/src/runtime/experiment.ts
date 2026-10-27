import { compareMeasurements } from '../compare.js';
import { FIX_CATALOG, type Finding, type Plan, type PlanStep } from '../diagnose.js';
import { aggregate, type Measurement } from '../measure.js';
import { baselineEvent, judgePerformance, planEvent, regressionCountsAsHarm } from '../optimize.js';
import { isRuntimeFix, type RuntimeItem } from './rewrite.js';
import { startRuntimeProxy, type RuntimeProxy } from './proxy.js';

export interface RuntimeStep {
  order: number;
  fix: string;
  title: string;
  status: 'kept' | 'reverted' | 'skipped';
  reason: string;
  gates: Array<{ name: string; passed: boolean; details: string; comparison?: unknown }>;
}

export interface RuntimeReport {
  url: string;
  plan: Plan;
  findings: Finding[];
  baseline: ReturnType<typeof aggregate> | null;
  steps: RuntimeStep[];
}

export interface RuntimeEvent {
  type: string;
  [key: string]: unknown;
}

export interface RuntimeOptions {
  url: string;
  runs?: number;
  maxSteps?: number;
  onlyFixes?: string[];
  findings: Finding[];
  plan: Plan;
  measure: (url: string) => Promise<Measurement>;
  /** When set, each step is measured as an interleaved pair: raw URL, then the proxy URL. */
  measurePair?: (baselineUrl: string, candidateUrl: string) => Promise<[Measurement, Measurement]>;
  openProxy?: (options: { target: string; fix: string; items: RuntimeItem[] }) => Promise<RuntimeProxy>;
  onEvent?: (event: RuntimeEvent) => void;
}

function itemsFor(findings: Finding[], fix: string): RuntimeItem[] {
  const finding = findings.find((item) => item.fix === fix);
  return (finding?.items ?? []).map((item) => ({
    url: item.url,
    width: typeof (item as { width?: unknown }).width === 'number' ? (item as { width: number }).width : undefined,
    height: typeof (item as { height?: unknown }).height === 'number' ? (item as { height: number }).height : undefined,
  }));
}

function title(fix: string): string {
  return Object.prototype.hasOwnProperty.call(FIX_CATALOG, fix) ? FIX_CATALOG[fix as keyof typeof FIX_CATALOG].title : fix;
}

/**
 * Measures a URL, then each runtime-testable plan step through a local proxy.
 * A step is kept only when judgePerformance says the proxied page improved.
 */
export async function runRuntimeExperiments(options: RuntimeOptions): Promise<RuntimeReport> {
  const emit = options.onEvent ?? (() => undefined);
  const openProxy = options.openProxy ?? startRuntimeProxy;
  const steps = options.plan.steps
    .filter((step) => !options.onlyFixes?.length || options.onlyFixes.includes(step.fix))
    .slice(0, options.maxSteps ?? 12);
  emit({ type: 'job-start', jobType: 'experiment' });
  emit(planEvent(options.plan));
  const holder: { baseline: Measurement | null } = { baseline: null };
  if (!options.measurePair) {
    holder.baseline = await options.measure(options.url);
    emit(baselineEvent(aggregate(holder.baseline), options.findings.length));
  }
  const recorded: RuntimeStep[] = [];
  for (const step of steps) {
    recorded.push(await runStep(step, options, holder, openProxy, emit));
  }
  const kept = recorded.filter((step) => step.status === 'kept').length;
  emit({ type: 'run-end', kept, reverted: recorded.filter((step) => step.status === 'reverted').length, skipped: recorded.filter((step) => step.status === 'skipped').length });
  return { url: options.url, plan: options.plan, findings: options.findings, baseline: holder.baseline ? aggregate(holder.baseline) : null, steps: recorded };
}

async function runStep(
  step: PlanStep,
  options: RuntimeOptions,
  holder: { baseline: Measurement | null },
  openProxy: NonNullable<RuntimeOptions['openProxy']>,
  emit: (event: RuntimeEvent) => void,
): Promise<RuntimeStep> {
  emit({ type: 'step-start', order: step.order, fix: step.fix });
  if (!isRuntimeFix(step.fix)) {
    const reason = 'needs a repository';
    emit({ type: 'step-end', order: step.order, fix: step.fix, status: 'skipped', reason });
    return { order: step.order, fix: step.fix, title: title(step.fix), status: 'skipped', reason, gates: [] };
  }
  const items = itemsFor(options.findings, step.fix);
  let proxy: RuntimeProxy | null = null;
  try {
    proxy = await openProxy({ target: options.url, fix: step.fix, items });
    emit({ type: 'gate-start', order: step.order, fix: step.fix, gate: 'performance' });
    let baseline = holder.baseline;
    let candidate: Measurement;
    if (options.measurePair) {
      const pair = await options.measurePair(options.url, proxy.url);
      if (!holder.baseline) {
        holder.baseline = pair[0];
        emit(baselineEvent(aggregate(pair[0]), options.findings.length));
      }
      baseline = pair[0];
      candidate = pair[1];
    } else {
      candidate = await options.measure(proxy.url);
    }
    if (!baseline) throw new Error('the baseline measurement is missing');
    const comparison = compareMeasurements(baseline, candidate);
    const judged = judgePerformance(comparison);
    const metrics = comparison.metrics.map((metric) => ({ ...metric, countedAsHarm: regressionCountsAsHarm(metric) }));
    const gate = { name: 'performance', passed: judged.passed, details: judged.details, comparison: { ...comparison, metrics } };
    emit({
      type: 'gate-end',
      order: step.order,
      fix: step.fix,
      gate: 'performance',
      passed: judged.passed,
      details: judged.details,
      ms: 0,
      runsPerSide: options.runs ?? 4,
      comparison: { verdict: comparison.verdict, metrics },
    });
    const status = judged.passed ? 'kept' : 'reverted';
    const reason = judged.passed ? judged.details : judged.details || 'the proxied page did not improve';
    emit({ type: 'step-end', order: step.order, fix: step.fix, status, reason });
    return { order: step.order, fix: step.fix, title: title(step.fix), status, reason, gates: [gate] };
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'the runtime experiment failed';
    emit({ type: 'step-end', order: step.order, fix: step.fix, status: 'reverted', reason });
    return { order: step.order, fix: step.fix, title: title(step.fix), status: 'reverted', reason, gates: [{ name: 'performance', passed: false, details: reason }] };
  } finally {
    await proxy?.close();
  }
}
