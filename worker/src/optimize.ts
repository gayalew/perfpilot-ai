import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadSiteConfig, type SiteConfig } from './config.js';
import { extractFindings, FIX_CATALOG, type Finding, type FixId, type Plan } from './diagnose.js';
import { planFixes } from './gemini.js';
import { runGates, type GateContext, type GateResult } from './gates.js';
import { applierFor, type FixApplier } from './fixes/index.js';
import { AiEditor } from './ai-edit.js';
import { formatMetric, type MetricKey } from './metrics.js';
import { aggregate, measureInterleaved, measureUrl, type Aggregate, type Measurement } from './measure.js';
import { runLighthouseOnce } from './lighthouse-runner.js';
import { compareMeasurements, type Comparison, type MetricComparison } from './compare.js';
import { addWorktree, changedFiles, commitAll, headSha, prepareWorkdir, removeWorktree, resetHard } from './repo.js';
import { startSite, type RunningSite } from './site-runner.js';

export type StepStatus = 'kept' | 'reverted' | 'skipped' | 'error';

export interface StepMetric {
  key: MetricKey;
  before: number;
  after: number;
  change: number;
  p: number;
}

export interface LedgerStep {
  order: number;
  fix: string;
  title: string;
  status: StepStatus;
  reason: string;
  files: string[];
  commit?: string;
  gates: GateResult[];
  metrics: StepMetric[];
}

export interface Ledger {
  runId: string;
  repo: string;
  startedAt: string;
  finishedAt: string;
  aiSource: string;
  baseline: Aggregate | null;
  final: Aggregate | null;
  finalComparison: Comparison | null;
  steps: LedgerStep[];
}

export type OptimizeEvent =
  | { type: 'step-start'; order: number; fix: string }
  | { type: 'gate-start'; order: number; fix: string; gate: string }
  | { type: 'gate-end'; order: number; fix: string; gate: string; passed: boolean; details: string; ms: number }
  | { type: 'step-end'; order: number; fix: string; status: StepStatus; reason: string }
  | { type: 'run-end'; kept: number; reverted: number; skipped: number; errored: number };

export interface OptimizeOptions {
  repoPath: string;
  runs?: number;
  finalRuns?: number;
  maxSteps?: number;
  useAi?: boolean;
  runDir: string;
  onEvent?: (event: OptimizeEvent) => void;
  deps?: Partial<OptimizeDeps>;
}

export interface OptimizeDeps {
  measureUrl: typeof measureUrl;
  measureInterleaved: typeof measureInterleaved;
  runLighthouseOnce: typeof runLighthouseOnce;
  planFixes: typeof planFixes;
  extractFindings: typeof extractFindings;
  startSite: typeof startSite;
  runGates: typeof runGates;
  loadSiteConfig: typeof loadSiteConfig;
  prepareWorkdir: typeof prepareWorkdir;
  applierFor?: (id: FixId) => FixApplier | undefined;
}

export interface OptimizeResult {
  runDir: string;
  ledger: Ledger;
  summary: string;
  elapsedMs: number;
}

const realDeps: OptimizeDeps = {
  measureUrl,
  measureInterleaved,
  runLighthouseOnce,
  planFixes,
  extractFindings,
  startSite,
  runGates,
  loadSiteConfig,
  prepareWorkdir,
};

function metricsOf(comparison: Comparison | undefined): StepMetric[] {
  if (!comparison) return [];
  return comparison.metrics.map((metric) => ({
    key: metric.key,
    before: metric.baselineMedian,
    after: metric.candidateMedian,
    change: metric.relativeChange,
    p: Math.min(metric.pBetter, metric.pWorse),
  }));
}

export function keyMetric(metrics: StepMetric[], comparison?: Comparison): string {
  const primary = (comparison?.metrics ?? []).filter((metric) => metric.primary);
  const improved = primary.filter((metric) => metric.verdict === 'improved');
  const pick = improved.sort((a, b) => Math.abs(b.relativeChange) - Math.abs(a.relativeChange))[0] ?? primary[0];
  if (!pick) {
    const first = metrics[0];
    if (!first) return 'n/a';
    return `${first.key} ${formatMetric(first.key, first.before)} -> ${formatMetric(first.key, first.after)}`;
  }
  return `${pick.label} ${formatMetric(pick.key, pick.baselineMedian)} -> ${formatMetric(pick.key, pick.candidateMedian)}`;
}

function metricText(step: LedgerStep): string {
  const comparison = step.gates.find((gate) => gate.name === 'performance')?.comparison;
  return keyMetric(step.metrics, comparison);
}

export function formatSummary(ledger: Ledger): string {
  const lines = [
    '# PerfPilot optimize',
    '',
    `Repo: ${ledger.repo}`,
    `Run: ${ledger.runId}`,
    `AI: ${ledger.aiSource}`,
    `Started: ${ledger.startedAt}`,
    `Finished: ${ledger.finishedAt}`,
    '',
    '| Order | Fix | Status | Reason | Metric |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const step of ledger.steps) {
    const reason = step.reason.replace(/\|/g, '/').replace(/\n/g, ' ');
    lines.push(`| ${step.order} | ${step.fix} | ${step.status} | ${reason} | ${metricText(step)} |`);
  }
  lines.push('');
  if (ledger.finalComparison) {
    lines.push('## Final comparison');
    lines.push('');
    lines.push(ledger.finalComparison.summary);
    lines.push('');
  }
  return lines.join('\n');
}

export function formatTable(ledger: Ledger): string {
  const lines = [`${'Fix'.padEnd(24)}${'Status'.padEnd(12)}${'Metric'.padEnd(42)}Reason`];
  for (const step of ledger.steps) {
    lines.push(`${step.fix.padEnd(24)}${step.status.padEnd(12)}${metricText(step).padEnd(42)}${step.reason.replace(/\n/g, ' ')}`);
  }
  return lines.join('\n');
}

async function stopAll(sites: RunningSite[]): Promise<void> {
  await Promise.all(sites.map((site) => site.stop().catch(() => undefined)));
}

async function emit(options: OptimizeOptions, file: string, event: OptimizeEvent): Promise<void> {
  options.onEvent?.(event);
  await appendFile(file, `${JSON.stringify(event)}\n`);
}

function evidence(title: string, gates: GateResult[]): string {
  const performance = gates.find((gate) => gate.name === 'performance' && gate.comparison);
  const summary = performance?.comparison?.summary ?? performance?.details ?? 'all gates passed';
  const primary = (performance?.comparison?.metrics ?? []).filter((metric): metric is MetricComparison => metric.primary && metric.verdict === 'improved');
  const detail = primary
    .map((metric) => `${metric.label} ${formatMetric(metric.key, metric.baselineMedian)} -> ${formatMetric(metric.key, metric.candidateMedian)} (p=${Math.min(metric.pBetter, metric.pWorse).toFixed(3)})`)
    .join('; ');
  return detail ? `${summary}\n${detail}` : summary || title;
}

export async function optimize(options: OptimizeOptions): Promise<OptimizeResult> {
  const deps = { ...realDeps, ...options.deps };
  const started = Date.now();
  const startedAt = new Date().toISOString();
  const runDir = path.resolve(options.runDir);
  const runs = options.runs ?? 4;
  const finalRuns = options.finalRuns ?? 5;
  const maxSteps = options.maxSteps ?? 12;
  const useAi = options.useAi ?? true;
  await mkdir(runDir, { recursive: true });
  const eventsFile = path.join(runDir, 'events.jsonl');
  await writeFile(eventsFile, '');

  const repoPath = path.resolve(options.repoPath);
  const config = await deps.loadSiteConfig(repoPath);
  const prepared = await deps.prepareWorkdir(repoPath, runDir);
  const { workDir, baselineSha } = prepared;
  const baselinePort = config.port;
  const candidatePort = config.port + 1;
  const ai = new AiEditor({ disabled: !useAi, maxCalls: 12 });

  const steps: LedgerStep[] = [];
  let aiSource = useAi ? 'gemini' : 'heuristic';
  let baselineAggregate: Aggregate | null = null;
  let finalAggregate: Aggregate | null = null;
  let finalComparison: Comparison | null = null;
  let finalError = '';

  const baseline = await deps.startSite(workDir, config, baselinePort);
  try {
    const measured = await deps.measureUrl({ url: baseline.url, runs: finalRuns, profile: 'mobile', onProgress: () => undefined });
    baselineAggregate = aggregate(measured);
    const lhr = await deps.runLighthouseOnce({ url: baseline.url, profile: 'mobile' });
    const findings = deps.extractFindings(lhr);
    const plan: Plan = useAi
      ? await deps.planFixes(findings, { maxSteps })
      : await deps.planFixes(findings, { apiKey: '', maxSteps });
    aiSource = plan.note ? `${plan.source} (${plan.note})` : plan.source;
    await baseline.stop();

    for (const step of plan.steps.slice(0, maxSteps)) {
      const finding = findings.find((item) => item.fix === step.fix);
      const title = FIX_CATALOG[step.fix].title;
      await emit(options, eventsFile, { type: 'step-start', order: step.order, fix: step.fix });
      const recorded = await runStep({
        options,
        eventsFile,
        deps,
        config,
        workDir,
        baselinePort,
        candidatePort,
        finding,
        order: step.order,
        fix: step.fix,
        title,
        runs,
        ai,
      });
      steps.push(recorded);
      await emit(options, eventsFile, { type: 'step-end', order: step.order, fix: step.fix, status: recorded.status, reason: recorded.reason });
    }

    try {
      const finalPair = await compareEnds(deps, workDir, config, baselineSha, baselinePort, candidatePort, finalRuns);
      finalAggregate = aggregate(finalPair[1]);
      finalComparison = compareMeasurements(finalPair[0], finalPair[1]);
      if (!baselineAggregate) baselineAggregate = aggregate(finalPair[0]);
    } catch (err) {
      finalComparison = null;
      finalError = err instanceof Error ? err.message : String(err);
    }
  } finally {
    await baseline.stop().catch(() => undefined);
  }

  const ledger: Ledger = {
    runId: path.basename(runDir),
    repo: repoPath,
    startedAt,
    finishedAt: new Date().toISOString(),
    aiSource,
    baseline: baselineAggregate,
    final: finalAggregate,
    finalComparison,
    steps,
  };
  const summary = formatSummary(ledger) + (finalError ? `\nFinal comparison failed: ${finalError}\n` : '');
  await writeFile(path.join(runDir, 'ledger.json'), JSON.stringify(ledger, null, 2));
  await writeFile(path.join(runDir, 'summary.md'), summary);
  const kept = steps.filter((step) => step.status === 'kept').length;
  const reverted = steps.filter((step) => step.status === 'reverted').length;
  const skipped = steps.filter((step) => step.status === 'skipped').length;
  const errored = steps.filter((step) => step.status === 'error').length;
  await emit(options, eventsFile, { type: 'run-end', kept, reverted, skipped, errored });
  return { runDir, ledger, summary, elapsedMs: Date.now() - started };
}

async function compareEnds(
  deps: OptimizeDeps,
  workDir: string,
  config: SiteConfig,
  baselineSha: string,
  baselinePort: number,
  candidatePort: number,
  runs: number,
): Promise<[Measurement, Measurement]> {
  const tree = path.join(path.dirname(workDir), 'original');
  await addWorktree(workDir, tree, baselineSha);
  const sites: RunningSite[] = [];
  try {
    const base = await deps.startSite(tree, config, baselinePort);
    sites.push(base);
    const candidate = await deps.startSite(workDir, config, candidatePort);
    sites.push(candidate);
    return await deps.measureInterleaved(base.url, candidate.url, { runs, profile: 'mobile', onProgress: () => undefined });
  } finally {
    await stopAll(sites);
    await removeWorktree(workDir, tree);
  }
}

interface StepInput {
  options: OptimizeOptions;
  eventsFile: string;
  deps: OptimizeDeps;
  config: SiteConfig;
  workDir: string;
  baselinePort: number;
  candidatePort: number;
  finding?: Finding;
  order: number;
  fix: LedgerStep['fix'];
  title: string;
  runs: number;
  ai: AiEditor;
}

async function runStep(input: StepInput): Promise<LedgerStep> {
  const blank = (status: StepStatus, reason: string, extra: Partial<LedgerStep> = {}): LedgerStep => ({
    order: input.order,
    fix: input.fix,
    title: input.title,
    status,
    reason,
    files: [],
    gates: [],
    metrics: [],
    ...extra,
  });

  if (!input.finding) return blank('skipped', 'finding disappeared');
  const applier = (input.deps.applierFor ?? applierFor)(input.finding.fix);
  if (!applier) return blank('skipped', 'no applier');

  let files: string[] = [];
  try {
    const applied = await applier.apply({ dir: input.workDir, config: input.config, finding: input.finding, ai: input.ai });
    files = applied.changedFiles.length ? applied.changedFiles : await changedFiles(input.workDir).catch(() => []);
    if (!applied.applied) return blank('skipped', applied.skippedReason ?? 'not applied', { files });
  } catch (err) {
    await resetHard(input.workDir).catch(() => undefined);
    return blank('error', err instanceof Error ? err.message : String(err));
  }

  const tree = path.join(path.dirname(input.workDir), 'baseline');
  const sites: RunningSite[] = [];
  try {
    const sha = await headSha(input.workDir);
    await addWorktree(input.workDir, tree, sha);
    const base = await input.deps.startSite(tree, input.config, input.baselinePort);
    sites.push(base);
    const candidate = await input.deps.startSite(input.workDir, input.config, input.candidatePort);
    sites.push(candidate);
    const gates: GateResult[] = [];
    const gateCtx: GateContext = {
      baselineUrl: base.url,
      candidateUrl: candidate.url,
      candidateDir: input.workDir,
      config: input.config,
      fix: input.finding.fix,
      runs: input.runs,
      measureInterleaved: input.deps.measureInterleaved,
      onGate: async (phase, name, result) => {
        if (phase === 'start') {
          await emit(input.options, input.eventsFile, { type: 'gate-start', order: input.order, fix: input.fix, gate: name });
          return;
        }
        if (result) {
          await emit(input.options, input.eventsFile, {
            type: 'gate-end',
            order: input.order,
            fix: input.fix,
            gate: result.name,
            passed: result.passed,
            details: result.details,
            ms: result.ms,
          });
        }
      },
    };
    gates.push(...(await input.deps.runGates(gateCtx)));
    await stopAll(sites);
    sites.length = 0;
    await removeWorktree(input.workDir, tree);

    const failed = gates.find((gate) => !gate.passed && gate.details !== 'not run');
    const performance = gates.find((gate) => gate.name === 'performance');
    if (!failed) {
      const message = `perfpilot: ${input.title}\n\n${evidence(input.title, gates)}`;
      const commit = await commitAll(input.workDir, message);
      return blank('kept', performance?.comparison?.summary ?? 'all gates passed', {
        files,
        commit,
        gates,
        metrics: metricsOf(performance?.comparison),
      });
    }
    await resetHard(input.workDir);
    return blank('reverted', `${failed.name}: ${failed.details}`, { files, gates, metrics: metricsOf(performance?.comparison) });
  } catch (err) {
    await stopAll(sites);
    await removeWorktree(input.workDir, tree).catch(() => undefined);
    await resetHard(input.workDir).catch(() => undefined);
    return blank('error', err instanceof Error ? err.message : String(err), { files });
  }
}
