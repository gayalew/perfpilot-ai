/**
 * Pure view of a PerfPilot job, reduced from the events the worker actually emits.
 *
 * Event types (payload shapes from worker/src/job-runner.ts and worker/src/optimize.ts):
 * - job-start        { jobId, type }
 * - log              { line }
 * - step-start       { order, fix }
 * - gate-start       { order, fix, gate }            gate: build | smoke | visual | performance
 * - baseline         { aggregate, findingsCount }
 * - plan             { source, note?, steps: [{ order, fix, title, risk, rationale, expectedImpact }] }
 * - gate-end         { order, fix, gate, passed, details, ms, comparison?, runsPerSide? }
 * - step-end         { order, fix, status, reason, attempts?, metricsSummary? }
 * - run-end          { kept, reverted, skipped, errored }
 * - pr-created       { url, number }
 * - report-ready     { file }
 * - job-end          audit success: { ok:true, baseline, findings, plan }
 *                    optimize:      { ok:true, prUrl, summary, ledger, branch? }
 *                    nothing kept:  { ok:true, prUrl:null, reason, summary, ledger }
 *                    failure:       { ok:false, error }
 *
 * Baseline, plan, the performance comparison, and attempt counts also arrive as live events.
 * job-end.ledger is still applied last and remains the source of truth.
 * Unknown event types are ignored.
 */

export type GateName = 'build' | 'smoke' | 'visual' | 'performance';
export type GateState = 'pending' | 'running' | 'passed' | 'failed' | 'not-run';
export type StepStatus = 'pending' | 'running' | 'kept' | 'reverted' | 'skipped' | 'error';

export interface MetricSnapshot {
  score: number | null;
  fcp: number | null;
  lcp: number | null;
  tbt: number | null;
  cls: number | null;
  speedIndex: number | null;
  weight: number | null;
  requests: number | null;
}

export interface MetricChange {
  key: string;
  label: string;
  before: number;
  after: number;
  change: number;
  p: number;
  verdict: string;
  countedAsHarm?: boolean;
}

export interface Experiment {
  order: number;
  fix: string;
  title: string;
  risk: 'low' | 'medium' | 'high';
  rationale: string;
  status: StepStatus;
  reason: string;
  attempts: number;
  gates: Array<{ name: GateName; state: GateState }>;
  metrics: MetricChange[];
}

export interface PlanStep {
  order: number;
  fix: string;
  title: string;
  rationale: string;
  risk: 'low' | 'medium' | 'high';
}

export interface JobView {
  seenIds: number[];
  running: boolean;
  finished: boolean;
  ok: boolean | null;
  error: string | null;
  prUrl: string | null;
  resultNote: string;
  baseline: MetricSnapshot | null;
  final: MetricSnapshot | null;
  /** Final A/B comparison. Verdicts here are what cleared the noise floor. */
  finalMetrics: MetricChange[];
  planSource: 'gemini' | 'heuristic' | null;
  planNote: string;
  plan: PlanStep[];
  experiments: Experiment[];
  counts: { kept: number; reverted: number; skipped: number } | null;
  logs: string[];
}

export interface JobEventInput {
  id?: number;
  type: string;
  payload?: unknown;
}

const GATES: GateName[] = ['build', 'smoke', 'visual', 'performance'];

const FIXES: Record<string, { title: string; risk: 'low' | 'medium' | 'high'; summary: string }> = {
  'compress-text': { title: 'Enable gzip/brotli compression', risk: 'low', summary: 'Compress HTML, CSS and JS responses.' },
  'cache-headers': { title: 'Add long-lived cache headers for static assets', risk: 'low', summary: 'Serve static files with Cache-Control so repeat visits skip the network.' },
  'defer-scripts': { title: 'Defer render-blocking scripts', risk: 'medium', summary: 'Add defer (or async) to scripts in the head so they stop blocking first paint.' },
  'inline-or-async-css': { title: 'Stop stylesheets blocking render', risk: 'medium', summary: 'Merge small stylesheets and load non-critical CSS without blocking.' },
  'optimize-images': { title: 'Resize and recompress images (WebP/AVIF)', risk: 'medium', summary: 'Serve images at display size in a modern format.' },
  'lazy-load-images': { title: 'Lazy-load below-the-fold images', risk: 'low', summary: 'Add loading="lazy" to images that are not visible on first paint.' },
  'image-dimensions': { title: 'Set width and height on images', risk: 'low', summary: 'Reserve space for images so the layout does not jump.' },
  'preload-lcp-image': { title: 'Prioritize the main image', risk: 'low', summary: 'Preload the Largest Contentful Paint image and mark it fetchpriority=high.' },
  'reserve-space': { title: 'Reserve space for late-inserted content', risk: 'medium', summary: 'Give late-appearing elements a fixed slot so they do not push content.' },
  'minify-assets': { title: 'Minify JavaScript and CSS', risk: 'low', summary: 'Strip whitespace and comments from shipped assets.' },
  'remove-unused-code': { title: 'Remove or split unused code', risk: 'high', summary: 'Drop code the page never runs, or load it only when needed.' },
  'split-long-tasks': { title: 'Break up long main-thread tasks', risk: 'high', summary: 'Defer or chunk heavy startup work so the page stays responsive.' },
  preconnect: { title: 'Preconnect to required origins', risk: 'low', summary: 'Open connections early to third-party origins the page needs.' },
  'reduce-dom': { title: 'Reduce DOM size', risk: 'high', summary: 'Simplify the page structure.' },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function catalog(fix: string): { title: string; risk: 'low' | 'medium' | 'high'; summary: string } {
  return FIXES[fix] ?? { title: fix, risk: 'medium', summary: '' };
}

function freshGates(): Experiment['gates'] {
  return GATES.map((name) => ({ name, state: 'pending' }));
}

function emptySnapshot(): MetricSnapshot {
  return { score: null, fcp: null, lcp: null, tbt: null, cls: null, speedIndex: null, weight: null, requests: null };
}

export function emptyJobState(): JobView {
  return {
    seenIds: [],
    running: false,
    finished: false,
    ok: null,
    error: null,
    prUrl: null,
    resultNote: '',
    baseline: null,
    final: null,
    finalMetrics: [],
    planSource: null,
    planNote: '',
    plan: [],
    experiments: [],
    counts: null,
    logs: [],
  };
}

export function snapshotFromAggregate(aggregate: unknown): MetricSnapshot | null {
  if (!isRecord(aggregate)) return null;
  const median = (key: string) => {
    const row = aggregate[key];
    if (!isRecord(row)) return null;
    return num(row.median);
  };
  const snapshot = emptySnapshot();
  snapshot.score = median('score');
  snapshot.fcp = median('fcp');
  snapshot.lcp = median('lcp');
  snapshot.tbt = median('tbt');
  snapshot.cls = median('cls');
  snapshot.speedIndex = median('speedIndex');
  snapshot.weight = median('totalBytes');
  snapshot.requests = median('requests');
  return snapshot;
}

function ensure(experiments: Experiment[], order: number, fix: string): Experiment[] {
  const existing = experiments.find((item) => item.order === order);
  if (existing) {
    if (!fix || existing.fix === fix) return experiments;
    return experiments.map((item) => (item.order === order ? { ...item, fix } : item));
  }
  const info = catalog(fix);
  const created: Experiment = {
    order,
    fix,
    title: info.title,
    risk: info.risk,
    rationale: info.summary,
    status: 'pending',
    reason: '',
    attempts: 1,
    gates: freshGates(),
    metrics: [],
  };
  return [...experiments, created].sort((a, b) => a.order - b.order);
}

function mapExperiment(experiments: Experiment[], order: number, update: (item: Experiment) => Experiment): Experiment[] {
  return experiments.map((item) => (item.order === order ? update(item) : item));
}

function readMetrics(comparison: unknown): MetricChange[] {
  if (!isRecord(comparison) || !Array.isArray(comparison.metrics)) return [];
  const rows: MetricChange[] = [];
  for (const metric of comparison.metrics) {
    if (!isRecord(metric)) continue;
    const before = num(metric.baselineMedian);
    const after = num(metric.candidateMedian);
    if (before == null || after == null) continue;
    const relative = num(metric.relativeChange);
    const change = relative ?? (before === 0 ? 0 : (after - before) / Math.abs(before));
    const pBetter = num(metric.pBetter);
    const pWorse = num(metric.pWorse);
    const p = pBetter == null ? pWorse ?? 1 : pWorse == null ? pBetter : Math.min(pBetter, pWorse);
    rows.push({
      key: typeof metric.key === 'string' ? metric.key : '',
      label: typeof metric.label === 'string' ? metric.label : String(metric.key ?? ''),
      before,
      after,
      change,
      p,
      verdict: typeof metric.verdict === 'string' ? metric.verdict : 'unchanged',
      countedAsHarm: metric.countedAsHarm === true,
    });
  }
  return rows;
}

function readPlan(plan: unknown): { source: 'gemini' | 'heuristic' | null; note: string; steps: PlanStep[] } {
  if (!isRecord(plan)) return { source: null, note: '', steps: [] };
  const source = plan.source === 'gemini' || plan.source === 'heuristic' ? plan.source : null;
  const note = typeof plan.note === 'string' ? plan.note : '';
  const steps: PlanStep[] = [];
  if (Array.isArray(plan.steps)) {
    for (const step of plan.steps) {
      if (!isRecord(step) || typeof step.fix !== 'string') continue;
      const info = catalog(step.fix);
      const risk = step.risk === 'low' || step.risk === 'medium' || step.risk === 'high' ? step.risk : info.risk;
      steps.push({
        order: num(step.order) ?? steps.length + 1,
        fix: step.fix,
        title: typeof step.title === 'string' ? step.title : info.title,
        rationale: typeof step.rationale === 'string' ? step.rationale : info.summary,
        risk,
      });
    }
  }
  return { source, note, steps };
}

function sourceFromAi(aiSource: string): { source: 'gemini' | 'heuristic'; note: string } {
  if (aiSource.startsWith('gemini')) return { source: 'gemini', note: '' };
  if (aiSource.startsWith('heuristic')) {
    const rest = aiSource.slice('heuristic'.length).trim();
    const note = rest.startsWith('(') && rest.endsWith(')') ? rest.slice(1, -1) : rest;
    return { source: 'heuristic', note };
  }
  return { source: 'heuristic', note: aiSource };
}

function knownStatus(value: unknown): StepStatus | null {
  if (value === 'kept' || value === 'reverted' || value === 'skipped' || value === 'error') return value;
  return null;
}

export function applyLedger(state: JobView, ledger: unknown): JobView {
  if (!isRecord(ledger)) return state;
  let next: JobView = { ...state, experiments: state.experiments.map((item) => ({ ...item, gates: item.gates.map((gate) => ({ ...gate })), metrics: [...item.metrics] })) };
  const baseline = snapshotFromAggregate(ledger.baseline);
  const final = snapshotFromAggregate(ledger.final);
  if (baseline) next.baseline = baseline;
  if (final) next.final = final;
  if (isRecord(ledger.finalComparison)) {
    const compared = readMetrics(ledger.finalComparison);
    if (compared.length) next.finalMetrics = compared;
  }
  if (typeof ledger.aiSource === 'string' && ledger.aiSource) {
    const parsed = sourceFromAi(ledger.aiSource);
    if (!next.planSource) next.planSource = parsed.source;
    if (!next.planNote && parsed.note) next.planNote = parsed.note;
  }
  if (!Array.isArray(ledger.steps)) return next;
  for (const raw of ledger.steps) {
    if (!isRecord(raw) || typeof raw.fix !== 'string') continue;
    const order = num(raw.order) ?? next.experiments.length + 1;
    next = { ...next, experiments: ensure(next.experiments, order, raw.fix) };
    const info = catalog(raw.fix);
    const status = knownStatus(raw.status) ?? 'pending';
    const current = next.experiments.find((item) => item.order === order);
    const gates = (current?.gates ?? freshGates()).map((gate) => {
      const found = Array.isArray(raw.gates) ? raw.gates.find((item) => isRecord(item) && item.name === gate.name) : undefined;
      if (!isRecord(found)) {
        if (status !== 'pending' && status !== 'running' && (gate.state === 'pending' || gate.state === 'running')) {
          return { name: gate.name, state: 'not-run' as const };
        }
        return gate;
      }
      return { name: gate.name, state: found.passed === true ? 'passed' as const : 'failed' as const };
    });
    const performance = Array.isArray(raw.gates) ? raw.gates.find((item) => isRecord(item) && item.name === 'performance') : undefined;
    const metrics = isRecord(performance) ? readMetrics(performance.comparison) : [];
    next = {
      ...next,
      experiments: mapExperiment(next.experiments, order, (item) => ({
        ...item,
        fix: raw.fix as string,
        title: typeof raw.title === 'string' ? raw.title : info.title,
        risk: info.risk,
        rationale: item.rationale || info.summary,
        status,
        reason: typeof raw.reason === 'string' ? raw.reason : item.reason,
        attempts: num(raw.attempts) ?? item.attempts,
        gates,
        metrics: metrics.length ? metrics : item.metrics,
      })),
    };
  }
  if (!next.plan.length) {
    next.plan = next.experiments.map((item) => ({
      order: item.order,
      fix: item.fix,
      title: item.title,
      rationale: item.rationale,
      risk: item.risk,
    }));
  }
  if (!next.counts) {
    next.counts = {
      kept: next.experiments.filter((item) => item.status === 'kept').length,
      reverted: next.experiments.filter((item) => item.status === 'reverted').length,
      skipped: next.experiments.filter((item) => item.status === 'skipped').length,
    };
  }
  return next;
}

function readSummary(rows: unknown): MetricChange[] {
  if (!Array.isArray(rows)) return [];
  const out: MetricChange[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const before = num(row.before);
    const after = num(row.after);
    if (before == null || after == null) continue;
    out.push({
      key: typeof row.key === 'string' ? row.key : '',
      label: typeof row.label === 'string' ? row.label : String(row.key ?? ''),
      before,
      after,
      change: num(row.relativeChange) ?? (before === 0 ? 0 : (after - before) / Math.abs(before)),
      p: num(row.p) ?? 1,
      verdict: typeof row.verdict === 'string' ? row.verdict : 'unchanged',
    });
  }
  return out;
}

function apply(state: JobView, type: string, payload: unknown): JobView {
  const body = isRecord(payload) ? payload : {};
  if (type === 'job-start') return { ...state, running: true };
  if (type === 'baseline') {
    const baseline = snapshotFromAggregate(body.aggregate);
    return baseline ? { ...state, baseline } : state;
  }
  if (type === 'plan') {
    const plan = readPlan(body);
    return { ...state, plan: plan.steps, planSource: plan.source, planNote: plan.note };
  }
  if (type === 'log') {
    const line = typeof body.line === 'string' ? body.line : '';
    if (!line) return state;
    return { ...state, logs: [...state.logs, line].slice(-300) };
  }
  if (type === 'step-start') {
    const order = num(body.order);
    const fix = typeof body.fix === 'string' ? body.fix : '';
    if (order == null) return state;
    const experiments = mapExperiment(ensure(state.experiments, order, fix), order, (item) => ({ ...item, status: 'running' }));
    return { ...state, running: true, experiments };
  }
  if (type === 'gate-start' || type === 'gate-end') {
    const order = num(body.order);
    const gate = body.gate;
    if (order == null || (gate !== 'build' && gate !== 'smoke' && gate !== 'visual' && gate !== 'performance')) return state;
    const fix = typeof body.fix === 'string' ? body.fix : '';
    const nextState: GateState = type === 'gate-start' ? 'running' : body.passed === true ? 'passed' : 'failed';
    const liveMetrics = type === 'gate-end' && gate === 'performance' ? readMetrics(body.comparison) : [];
    const experiments = mapExperiment(ensure(state.experiments, order, fix), order, (item) => ({
      ...item,
      status: item.status === 'pending' ? 'running' : item.status,
      gates: item.gates.map((itemGate) => (itemGate.name === gate ? { ...itemGate, state: nextState } : itemGate)),
      metrics: liveMetrics.length ? liveMetrics : item.metrics,
    }));
    return { ...state, running: true, experiments };
  }
  if (type === 'step-end') {
    const order = num(body.order);
    const status = knownStatus(body.status);
    if (order == null || !status) return state;
    const fix = typeof body.fix === 'string' ? body.fix : '';
    const summary = readSummary(body.metricsSummary);
    const experiments = mapExperiment(ensure(state.experiments, order, fix), order, (item) => ({
      ...item,
      status,
      reason: typeof body.reason === 'string' ? body.reason : item.reason,
      attempts: num(body.attempts) ?? item.attempts,
      metrics: summary.length && item.metrics.length === 0 ? summary : item.metrics,
      gates: item.gates.map((gate) => (gate.state === 'pending' || gate.state === 'running' ? { ...gate, state: 'not-run' } : gate)),
    }));
    return { ...state, experiments };
  }
  if (type === 'run-end') {
    return {
      ...state,
      counts: {
        kept: num(body.kept) ?? 0,
        reverted: num(body.reverted) ?? 0,
        skipped: num(body.skipped) ?? 0,
      },
    };
  }
  if (type === 'pr-created') {
    return { ...state, prUrl: typeof body.url === 'string' ? body.url : state.prUrl };
  }
  if (type === 'job-end') {
    let next: JobView = { ...state, finished: true, running: false };
    if (body.ok === false) {
      return { ...next, ok: false, error: typeof body.error === 'string' ? body.error : 'The job failed.' };
    }
    next.ok = body.ok === true ? true : next.ok;
    if (typeof body.prUrl === 'string') next.prUrl = body.prUrl;
    if (typeof body.reason === 'string') next.resultNote = body.reason;
    const baseline = snapshotFromAggregate(body.baseline);
    if (baseline) next.baseline = baseline;
    if (body.plan) {
      const plan = readPlan(body.plan);
      next.plan = plan.steps;
      next.planSource = plan.source;
      next.planNote = plan.note;
      next = {
        ...next,
        experiments: next.experiments.map((item) => {
          const planned = plan.steps.find((step) => step.order === item.order || step.fix === item.fix);
          return planned ? { ...item, rationale: planned.rationale || item.rationale } : item;
        }),
      };
    }
    if (body.ledger) next = applyLedger(next, body.ledger);
    return next;
  }
  return state;
}

export function reduceJob(state: JobView, event: JobEventInput): JobView {
  if (!event || typeof event.type !== 'string') return state;
  if (typeof event.id === 'number' && state.seenIds.includes(event.id)) return state;
  const seenIds = typeof event.id === 'number' ? [...state.seenIds, event.id] : state.seenIds;
  try {
    return apply({ ...state, seenIds }, event.type, event.payload);
  } catch {
    return { ...state, seenIds };
  }
}

export function reduceEvents(events: JobEventInput[]): JobView {
  return events.reduce(reduceJob, emptyJobState());
}
