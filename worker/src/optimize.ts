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
import { addWorktree, changedFiles, commitAll, git, headSha, prepareInplace, prepareWorkdir, removeWorktree, resetHard } from './repo.js';
import { startSite, type RunningSite } from './site-runner.js';

export type StepStatus = 'kept' | 'reverted' | 'skipped' | 'error';

export interface StepMetric {
  key: MetricKey;
  before: number;
  after: number;
  change: number;
  p: number;
}

export interface RegressionNote {
  key: MetricKey;
  before: number;
  after: number;
  harm: boolean;
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
  /** 1, or 2 when an AI edit was repaired once. */
  attempts?: number;
  regressions?: RegressionNote[];
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
  runs?: number;
  finalRuns?: number;
  branch?: string;
}

/** Core Web Vitals "good" ceilings. A regression counts as harm only in the cases documented on judgePerformance. */
export const CWV_GOOD = { lcp: 2500, tbt: 200, cls: 0.1 } as const;

const HARM_KEYS = new Set<MetricKey>(['lcp', 'tbt', 'cls']);

/** Whether a statistically regressed metric is harmful enough to reject the fix. */
export function regressionCountsAsHarm(metric: MetricComparison): boolean {
  if (metric.verdict !== 'regressed') return false;
  if (metric.key === 'score') return true;
  if (!HARM_KEYS.has(metric.key)) return false;
  const limit = CWV_GOOD[metric.key as keyof typeof CWV_GOOD];
  const before = metric.baselineMedian;
  const after = metric.candidateMedian;
  if (before <= limit && after > limit) return true;
  if (before > limit) {
    const base = Math.abs(before);
    if (base === 0) return after > before;
    return (after - before) / base > 0.1;
  }
  return false;
}

export interface PerformanceDecision {
  passed: boolean;
  details: string;
  regressions: RegressionNote[];
}

/**
 * The performance gate passes when at least one primary metric improved and no regression counts as harm.
 * Statistical thresholds stay in compare.ts. This only decides which regressions block a keep.
 */
export function judgePerformance(comparison: Comparison): PerformanceDecision {
  const regressions = comparison.metrics
    .filter((metric) => metric.verdict === 'regressed')
    .map((metric) => ({
      key: metric.key,
      before: metric.baselineMedian,
      after: metric.candidateMedian,
      harm: regressionCountsAsHarm(metric),
    }));
  const improved = comparison.metrics.some((metric) => metric.primary && metric.verdict === 'improved');
  const harms = regressions.filter((metric) => metric.harm);
  const passed = improved && harms.length === 0;
  const ignored = regressions.filter((metric) => !metric.harm).map((metric) => metric.key);
  let details = comparison.summary;
  if (passed && ignored.length) details = `${comparison.summary} (ignored regressions: ${ignored.join(', ')})`;
  if (!passed && harms.length) details = `harm: ${harms.map((metric) => metric.key).join(', ')} (${comparison.summary})`;
  if (!passed && !improved) details = `${comparison.verdict}: ${comparison.summary}`;
  return { passed, details, regressions };
}

export interface LiveComparisonMetric {
  key: string;
  label: string;
  baselineMedian: number;
  candidateMedian: number;
  relativeChange: number;
  pBetter: number;
  pWorse: number;
  verdict: string;
  countedAsHarm: boolean;
}

export interface MetricSummaryRow {
  key: string;
  label: string;
  before: number;
  after: number;
  relativeChange: number;
  p: number;
  verdict: string;
}

export type OptimizeEvent =
  | { type: 'baseline'; aggregate: Record<string, { median: number; n: number } | null>; findingsCount: number }
  | { type: 'plan'; source: 'gemini' | 'heuristic'; note?: string; steps: Array<{ order: number; fix: string; title: string; risk: 'low' | 'medium' | 'high'; rationale: string; expectedImpact: string }> }
  | { type: 'step-start'; order: number; fix: string }
  | { type: 'gate-start'; order: number; fix: string; gate: string }
  | { type: 'gate-end'; order: number; fix: string; gate: string; passed: boolean; details: string; ms: number; comparison?: { verdict: string; metrics: LiveComparisonMetric[] }; runsPerSide?: number }
  | { type: 'step-end'; order: number; fix: string; status: StepStatus; reason: string; attempts?: number; metricsSummary?: MetricSummaryRow[] }
  | { type: 'run-end'; kept: number; reverted: number; skipped: number; errored: number };

export function baselineEvent(aggregate: Aggregate, findingsCount: number): OptimizeEvent {
  const slim: Record<string, { median: number; n: number } | null> = {};
  for (const [key, summary] of Object.entries(aggregate)) {
    slim[key] = summary ? { median: summary.median, n: summary.n } : null;
  }
  return { type: 'baseline', aggregate: slim, findingsCount };
}

export function planEvent(plan: Plan): OptimizeEvent {
  return {
    type: 'plan',
    source: plan.source,
    note: plan.note,
    steps: plan.steps.map((step) => ({
      order: step.order,
      fix: step.fix,
      title: FIX_CATALOG[step.fix].title,
      risk: FIX_CATALOG[step.fix].risk,
      rationale: step.rationale,
      expectedImpact: step.expectedImpact,
    })),
  };
}

function liveComparison(result: GateResult, runsPerSide: number): Pick<Extract<OptimizeEvent, { type: 'gate-end' }>, 'comparison' | 'runsPerSide'> {
  if (result.name !== 'performance' || !result.comparison) return {};
  const harms = new Set(judgePerformance(result.comparison).regressions.filter((item) => item.harm).map((item) => item.key));
  return {
    runsPerSide,
    comparison: {
      verdict: result.comparison.verdict,
      metrics: result.comparison.metrics.map((metric) => ({
        key: metric.key,
        label: metric.label,
        baselineMedian: metric.baselineMedian,
        candidateMedian: metric.candidateMedian,
        relativeChange: metric.relativeChange,
        pBetter: metric.pBetter,
        pWorse: metric.pWorse,
        verdict: metric.verdict,
        countedAsHarm: harms.has(metric.key),
      })),
    },
  };
}

function summaryRows(step: LedgerStep): MetricSummaryRow[] {
  const comparison = step.gates.find((gate) => gate.name === 'performance')?.comparison;
  if (!comparison) return [];
  return comparison.metrics.map((metric) => ({
    key: metric.key,
    label: metric.label,
    before: metric.baselineMedian,
    after: metric.candidateMedian,
    relativeChange: metric.relativeChange,
    p: Math.min(metric.pBetter, metric.pWorse),
    verdict: metric.verdict,
  }));
}

export interface OptimizeOptions {
  repoPath: string;
  runs?: number;
  finalRuns?: number;
  maxSteps?: number;
  useAi?: boolean;
  /** Use repoPath itself, keeping its git history, instead of copying into a fresh repo. */
  inplace?: boolean;
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
  branch: string;
  workDir: string;
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

const REPORT_ROWS: { key: MetricKey; label: string }[] = [
  { key: 'score', label: 'score' },
  { key: 'lcp', label: 'LCP' },
  { key: 'fcp', label: 'FCP' },
  { key: 'tbt', label: 'TBT' },
  { key: 'cls', label: 'CLS' },
  { key: 'speedIndex', label: 'Speed Index' },
  { key: 'totalBytes', label: 'page weight' },
  { key: 'requests', label: 'requests' },
];

function changePct(before: number, after: number): string {
  if (!Number.isFinite(before) || before === 0) return 'n/a';
  const pct = ((after - before) / Math.abs(before)) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
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
  lines.push('## Before and after');
  lines.push('');
  lines.push('| Metric | Before | After | Change |');
  lines.push('| --- | --- | --- | --- |');
  for (const { key, label } of REPORT_ROWS) {
    const before = ledger.baseline?.[key]?.median;
    const after = ledger.final?.[key]?.median;
    if (before === undefined || after === undefined || before === null || after === null) {
      lines.push(`| ${label} | n/a | n/a | n/a |`);
    } else {
      lines.push(`| ${label} | ${formatMetric(key, before)} | ${formatMetric(key, after)} | ${changePct(before, after)} |`);
    }
  }
  lines.push('');
  const kept = ledger.steps.filter((step) => step.status === 'kept');
  if (kept.length) {
    lines.push('## Kept changes');
    lines.push('');
    for (const step of kept) {
      const comparison = step.gates.find((gate) => gate.name === 'performance')?.comparison;
      const improved = comparison?.metrics.filter((metric) => metric.verdict === 'improved') ?? [];
      const runs = comparison?.metrics[0];
      lines.push(`### ${step.fix}`);
      lines.push('');
      if (!improved.length) {
        lines.push('No metric was marked improved.');
      }
      for (const metric of improved) {
        const p = Math.min(metric.pBetter, metric.pWorse);
        lines.push(`- ${metric.label}: ${formatMetric(metric.key, metric.baselineMedian)} -> ${formatMetric(metric.key, metric.candidateMedian)} (p=${p.toFixed(3)}, ${metric.baselineN} runs per side)`);
      }
      if (runs) lines.push(`- Runs per side: ${runs.baselineN}`);
      lines.push('');
    }
  }
  if (ledger.finalComparison) {
    lines.push('## Final comparison');
    lines.push('');
    lines.push(ledger.finalComparison.summary);
    lines.push('');
  }
  lines.push('## Methodology');
  lines.push('');
  lines.push('Runs are interleaved. Each metric is compared with a one-sided Mann-Whitney U test and must also clear a minimum effect size and the baseline noise floor.');
  lines.push(`Performance checks used ${ledger.runs ?? 4} runs per side. The final comparison used ${ledger.finalRuns ?? 5} runs per side.`);
  lines.push('The tool never merges.');
  lines.push('');
  return lines.join('\n');
}

/** Pull request body. Same numbers as summary.md, plus the keep/revert evidence. */
export function buildPrBody(ledger: Ledger): string {
  const kept = ledger.steps.filter((step) => step.status === 'kept');
  const reverted = ledger.steps.filter((step) => step.status === 'reverted' || step.status === 'error');
  const lines = [
    `# PerfPilot: ${kept.length} proven performance improvement${kept.length === 1 ? '' : 's'}`,
    '',
    formatSummary(ledger),
    '## Reverted changes',
    '',
  ];
  if (!reverted.length) lines.push('None.');
  for (const step of reverted) {
    const harm = (step.regressions ?? []).filter((metric) => metric.harm).map((metric) => metric.key).join(', ');
    lines.push(`- ${step.fix}: ${step.reason.replace(/\n/g, ' ')}${harm ? ` (harm: ${harm})` : ''}`);
  }
  lines.push('');
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
  const config = await deps.loadSiteConfig(options.inplace ? repoPath : repoPath);
  const prepared = options.inplace ? await prepareInplace(repoPath) : await deps.prepareWorkdir(repoPath, runDir);
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
    await emit(options, eventsFile, baselineEvent(baselineAggregate, findings.length));
    await emit(options, eventsFile, planEvent(plan));
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
      await emit(options, eventsFile, {
        type: 'step-end',
        order: step.order,
        fix: step.fix,
        status: recorded.status,
        reason: recorded.reason,
        attempts: recorded.attempts ?? 1,
        metricsSummary: summaryRows(recorded),
      });
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
    runs,
    finalRuns,
    branch: prepared.branch,
  };
  const summary = formatSummary(ledger) + (finalError ? `\nFinal comparison failed: ${finalError}\n` : '');
  await writeFile(path.join(runDir, 'ledger.json'), JSON.stringify(ledger, null, 2));
  await writeFile(path.join(runDir, 'summary.md'), summary);
  const kept = steps.filter((step) => step.status === 'kept').length;
  const reverted = steps.filter((step) => step.status === 'reverted').length;
  const skipped = steps.filter((step) => step.status === 'skipped').length;
  const errored = steps.filter((step) => step.status === 'error').length;
  await emit(options, eventsFile, { type: 'run-end', kept, reverted, skipped, errored });
  return { runDir, ledger, summary, elapsedMs: Date.now() - started, branch: prepared.branch, workDir };
}

/** A worktree of the git root, plus the site directory inside it when the site is not the repo root. */
async function locateSite(workDir: string, folder: string): Promise<{ gitDir: string; treeRoot: string; siteDir: string }> {
  const shown = await git(workDir, ['rev-parse', '--show-toplevel']);
  if (shown.code !== 0) throw new Error(shown.stderr.trim() || 'git root not found');
  const gitDir = path.resolve(shown.stdout.trim());
  const rel = path.relative(gitDir, path.resolve(workDir));
  const treeRoot = path.join(path.dirname(gitDir), folder);
  return { gitDir, treeRoot, siteDir: rel ? path.join(treeRoot, rel) : treeRoot };
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
  const located = await locateSite(workDir, 'original');
  await addWorktree(located.gitDir, located.treeRoot, baselineSha);
  const sites: RunningSite[] = [];
  try {
    const base = await deps.startSite(located.siteDir, config, baselinePort);
    sites.push(base);
    const candidate = await deps.startSite(workDir, config, candidatePort);
    sites.push(candidate);
    return await deps.measureInterleaved(base.url, candidate.url, { runs, profile: 'mobile', onProgress: () => undefined });
  } finally {
    await stopAll(sites);
    await removeWorktree(located.gitDir, located.treeRoot);
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

function siteFailureMessage(err: unknown): string | undefined {
  const message = err instanceof Error ? err.message : String(err);
  if (/site did not return|install failed|build failed|startCommand is empty|EADDRINUSE/i.test(message)) return message;
  return undefined;
}

function applyPerformancePolicy(result: GateResult): void {
  if (result.name !== 'performance' || !result.comparison) return;
  const decision = judgePerformance(result.comparison);
  result.passed = decision.passed;
  result.details = decision.details;
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

  type Outcome =
    | { kind: 'skipped'; reason: string; files: string[]; note?: string }
    | { kind: 'gates'; files: string[]; gates: GateResult[]; note?: string }
    | { kind: 'site'; files: string[]; message: string; note?: string };

  const finish = async (outcome: Outcome, attempts: number): Promise<LedgerStep> => {
    if (outcome.kind === 'skipped') return blank('skipped', outcome.reason, { files: outcome.files, attempts });
    const gates = outcome.kind === 'site'
      ? [{ name: 'smoke' as const, passed: false, details: outcome.message.slice(0, 1500), ms: 0 }]
      : outcome.gates;
    const failed = gates.find((gate) => !gate.passed && gate.details !== 'not run');
    const performance = gates.find((gate) => gate.name === 'performance');
    const regressions = performance?.comparison ? judgePerformance(performance.comparison).regressions : [];
    if (!failed) {
      const message = `perfpilot: ${input.title}\n\n${evidence(input.title, gates)}`;
      const commit = await commitAll(input.workDir, message);
      return blank('kept', performance?.comparison?.summary ?? 'all gates passed', {
        files: outcome.files,
        commit,
        gates,
        metrics: metricsOf(performance?.comparison),
        attempts,
        regressions,
      });
    }
    let evidenceNote = outcome.note ? ` ${outcome.note}` : '';
    if (input.fix === 'reserve-space') {
      const diff = await git(input.workDir, ['diff', '--']).catch(() => ({ stdout: '', stderr: '', code: 1 }));
      const snippet = diff.stdout.trim().slice(0, 1200);
      if (snippet) evidenceNote = `${evidenceNote}\nLast edit:\n${snippet}`;
    }
    await resetHard(input.workDir);
    return blank('reverted', `${failed.name}: ${failed.details}${evidenceNote}`, {
      files: outcome.files,
      gates,
      metrics: metricsOf(performance?.comparison),
      attempts,
      regressions,
    });
  };

  const attempt = async (repairReason?: string): Promise<Outcome> => {
    let files: string[] = [];
    const applied = await applier.apply({
      dir: input.workDir,
      config: input.config,
      finding: input.finding!,
      ai: input.ai,
      repairReason,
    });
    files = applied.changedFiles.length ? applied.changedFiles : await changedFiles(input.workDir).catch(() => []);
    const note = applied.note;
    if (!applied.applied) return { kind: 'skipped', reason: applied.skippedReason ?? 'not applied', files, note };

    const located = await locateSite(input.workDir, 'baseline');
    const sites: RunningSite[] = [];
    try {
      const sha = await headSha(input.workDir);
      await addWorktree(located.gitDir, located.treeRoot, sha);
      const base = await input.deps.startSite(located.siteDir, input.config, input.baselinePort);
      sites.push(base);
      const candidate = await input.deps.startSite(input.workDir, input.config, input.candidatePort);
      sites.push(candidate);
      const gateCtx: GateContext = {
        baselineUrl: base.url,
        candidateUrl: candidate.url,
        candidateDir: input.workDir,
        config: input.config,
        fix: input.finding!.fix,
        runs: input.runs,
        measureInterleaved: input.deps.measureInterleaved,
        onGate: async (phase, name, result) => {
          if (result) applyPerformancePolicy(result);
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
              ...liveComparison(result, input.runs),
            });
          }
        },
      };
      const gates = await input.deps.runGates(gateCtx);
      for (const gate of gates) applyPerformancePolicy(gate);
      return { kind: 'gates', files, gates, note };
    } catch (err) {
      const site = siteFailureMessage(err);
      if (site) return { kind: 'site', files, message: site, note };
      throw err;
    } finally {
      await stopAll(sites);
      await removeWorktree(located.gitDir, located.treeRoot).catch(() => undefined);
    }
  };

  try {
    const first = await attempt();
    if (first.kind === 'skipped') return blank('skipped', first.reason, { files: first.files, attempts: 1 });
    const failed = first.kind === 'site' || first.gates.some((gate) => !gate.passed && gate.details !== 'not run');
    if (failed && applier.kind === 'ai') {
      await resetHard(input.workDir);
      const gateText = (first.kind === 'site' ? first.message : first.gates.find((gate) => !gate.passed && gate.details !== 'not run')?.details ?? 'gate failed').slice(0, 900);
      const reason = `${first.note ? `${first.note}\n` : ''}${gateText}`.slice(0, 1500);
      const second = await attempt(reason);
      if (second.kind === 'skipped') {
        return blank('reverted', `${second.reason}${second.note ? ` ${second.note}` : ''}`, { files: second.files, attempts: 2 });
      }
      return await finish(second, 2);
    }
    return await finish(first, 1);
  } catch (err) {
    await resetHard(input.workDir).catch(() => undefined);
    return blank('error', err instanceof Error ? err.message : String(err));
  }
}
