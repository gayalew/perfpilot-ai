import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { aggregate, measureUrl, values } from './measure.js';
import { METRICS } from './metrics.js';
import { extractFindings } from './diagnose.js';
import { planFixes } from './gemini.js';
import { runLighthouseOnce } from './lighthouse-runner.js';
import { optimize, buildPrBody, baselineEvent, planEvent, type Ledger } from './optimize.js';
import { renderReportHtml } from './report/html.js';
import { renderReportPdf } from './report/pdf.js';
import { git } from './repo.js';
import { fetchField } from './field.js';
import { runRuntimeExperiments } from './runtime/experiment.js';

export interface JobSpec {
  jobId: string;
  type: 'audit' | 'optimize' | 'monitor' | 'experiment' | 'field';
  runs: number;
  maxSteps: number;
  useAi: boolean;
  onlyFixes?: string[];
  runDir: string;
  project: {
    mode: 'url' | 'repo';
    url?: string | null;
    repoOwner?: string | null;
    repoName?: string | null;
    baseBranch?: string | null;
    rootDir?: string | null;
  };
}

const NAME = /^[A-Za-z0-9_.-]+$/;

export function parseSpec(line: string): JobSpec {
  const raw = JSON.parse(line) as Partial<JobSpec>;
  if (raw.type !== 'audit' && raw.type !== 'optimize' && raw.type !== 'monitor' && raw.type !== 'experiment' && raw.type !== 'field') {
    throw new Error('type must be audit, optimize, monitor, experiment, or field');
  }
  if (!raw.jobId || !raw.runDir || !raw.project) throw new Error('job spec is missing jobId, runDir, or project');
  const onlyFixes = Array.isArray(raw.onlyFixes) ? raw.onlyFixes.map((item) => String(item)).filter(Boolean) : undefined;
  return {
    jobId: raw.jobId,
    type: raw.type,
    runs: raw.runs ?? (raw.type === 'monitor' ? 5 : 4),
    maxSteps: raw.maxSteps ?? 12,
    useAi: raw.useAi ?? true,
    onlyFixes,
    runDir: raw.runDir,
    project: raw.project,
  };
}

function emit(type: string, payload: unknown): void {
  process.stdout.write(`${JSON.stringify({ type, payload })}\n`);
}

function redact(text: string, token: string): string {
  if (!token) return text.slice(0, 2000);
  const coded = Buffer.from(`x-access-token:${token}`).toString('base64');
  return text.split(token).join('<redacted>').split(coded).join('<redacted>').slice(0, 2000);
}

async function runGit(cwd: string, args: string[], token: string): Promise<void> {
  const result = await git(cwd, args);
  if (result.code !== 0) {
    throw new Error(redact(result.stderr.trim() || result.stdout.trim() || `git failed`, token));
  }
}

function headerArg(token: string): string {
  return `http.extraheader=Authorization: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
}

async function openPullRequest(spec: JobSpec, branch: string, title: string, body: string, token: string): Promise<{ url: string; number: number }> {
  const owner = spec.project.repoOwner ?? '';
  const repo = spec.project.repoName ?? '';
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'perfpilot',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({
      title,
      head: branch,
      base: spec.project.baseBranch || 'main',
      body,
    }),
  });
  const payload = (await res.json()) as { html_url?: string; number?: number; message?: string };
  if (!res.ok || !payload.html_url || !payload.number) {
    throw new Error(redact(payload.message || `GitHub HTTP ${res.status}`, token));
  }
  return { url: payload.html_url, number: payload.number };
}

async function runAudit(spec: JobSpec): Promise<void> {
  const url = spec.project.url;
  if (!url) throw new Error('audit requires a project url');
  emit('job-start', { jobId: spec.jobId, type: 'audit' });
  const measured = await measureUrl({ url, runs: spec.runs, profile: 'mobile', onProgress: () => undefined });
  const lhr = await runLighthouseOnce({ url, profile: 'mobile' });
  const findings = extractFindings(lhr);
  const plan = spec.useAi ? await planFixes(findings, { maxSteps: spec.maxSteps }) : await planFixes(findings, { apiKey: '', maxSteps: spec.maxSteps });
  const baseline = aggregate(measured);
  emit('baseline', baselineEvent(baseline, findings.length));
  emit('plan', planEvent(plan));
  const field = await fetchField(url).catch(() => null);
  emit('job-end', { ok: true, baseline, findings, plan, ...(field ? { field } : {}) });
}

async function writeReport(spec: JobSpec, ledger: Ledger, prUrl: string | null): Promise<void> {
  try {
    const target = spec.project.mode === 'url'
      ? (spec.project.url ?? '')
      : `${spec.project.repoOwner ?? ''}/${spec.project.repoName ?? ''}${spec.project.rootDir ? `/${spec.project.rootDir}` : ''}`;
    const html = renderReportHtml(ledger, {
      projectName: spec.project.repoName || spec.project.url || 'PerfPilot',
      target,
      version: '0.1.0',
      prUrl,
      generatedAt: ledger.finishedAt,
    });
    await renderReportPdf(html, path.join(spec.runDir, 'report.pdf'));
    emit('report-ready', { file: 'report.pdf' });
  } catch {
    emit('log', { line: 'report pdf was not written' });
  }
}

async function runOptimize(spec: JobSpec): Promise<void> {
  const owner = spec.project.repoOwner ?? '';
  const repo = spec.project.repoName ?? '';
  if (!NAME.test(owner) || !NAME.test(repo)) throw new Error('repo owner or name is not allowed');
  const rootDir = (spec.project.rootDir ?? '').replace(/\\/g, '/');
  if (rootDir.split('/').includes('..') || path.isAbsolute(rootDir)) throw new Error('root_dir must stay inside the repo');
  const token = process.env.GITHUB_TOKEN ?? '';
  if (!token) throw new Error('GITHUB_TOKEN is not set');
  emit('job-start', { jobId: spec.jobId, type: 'optimize' });
  const dest = path.join(spec.runDir, 'src');
  await mkdir(path.dirname(dest), { recursive: true });
  const url = `https://github.com/${owner}/${repo}.git`;
  await runGit(spec.runDir, ['-c', headerArg(token), 'clone', '--depth', '1', '--branch', spec.project.baseBranch || 'main', url, dest], token);
  const site = rootDir ? path.join(dest, rootDir) : dest;
  const result = await optimize({
    repoPath: site,
    runDir: spec.runDir,
    runs: spec.runs,
    finalRuns: 5,
    maxSteps: spec.maxSteps,
    useAi: spec.useAi,
    onlyFixes: spec.onlyFixes,
    inplace: true,
    onEvent: (event) => emit(event.type, event),
  });
  const kept = result.ledger.steps.filter((step) => step.status === 'kept');
  if (kept.length === 0) {
    await writeReport(spec, result.ledger, null);
    emit('job-end', { ok: true, prUrl: null, reason: 'No fix was kept, so no branch was pushed.', summary: result.summary, ledger: result.ledger });
    return;
  }
  const body = buildPrBody(result.ledger);
  await runGit(site, ['-c', headerArg(token), 'push', 'origin', `HEAD:refs/heads/${result.branch}`], token);
  const pr = await openPullRequest(spec, result.branch, `PerfPilot: ${kept.length} proven performance improvements`, body, token);
  emit('pr-created', { url: pr.url, number: pr.number });
  await writeReport(spec, result.ledger, pr.url);
  emit('job-end', { ok: true, prUrl: pr.url, summary: result.summary, ledger: result.ledger, branch: result.branch });
}

async function main(): Promise<void> {
  const line = await new Promise<string>((resolve, reject) => {
    const rl = createInterface({ input: process.stdin });
    let settled = false;
    rl.once('line', (value) => {
      settled = true;
      rl.close();
      resolve(value);
    });
    rl.once('close', () => {
      if (!settled) reject(new Error('job spec was empty'));
    });
  });
  const spec = parseSpec(line);
  if (spec.type === 'audit') await runAudit(spec);
  else if (spec.type === 'monitor') await runMonitor(spec);
  else if (spec.type === 'experiment') await runExperiment(spec);
  else if (spec.type === 'field') await runField(spec);
  else await runOptimize(spec);
}

async function runField(spec: JobSpec): Promise<void> {
  const url = spec.project.url;
  if (!url) throw new Error('field data requires a project URL');
  emit('job-start', { jobId: spec.jobId, type: 'field' });
  const field = await fetchField(url);
  emit('job-end', { ok: true, field });
}

async function runExperiment(spec: JobSpec): Promise<void> {
  const url = spec.project.url;
  if (!url) throw new Error('experiment requires a project URL');
  if (spec.project.mode !== 'url') throw new Error('experiment requires a URL project');
  const lhr = await runLighthouseOnce({ url, profile: 'mobile' });
  const findings = extractFindings(lhr);
  const plan = await planFixes(findings, { apiKey: '', maxSteps: spec.maxSteps });
  const report = await runRuntimeExperiments({
    url,
    runs: spec.runs,
    maxSteps: spec.maxSteps,
    onlyFixes: spec.onlyFixes,
    findings,
    plan,
    measure: (target) => measureUrl({ url: target, runs: spec.runs, profile: 'mobile', onProgress: () => undefined }),
    onEvent: (event) => emit(event.type, event),
  });
  const ledger = {
    runId: spec.jobId,
    repo: url,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    aiSource: 'runtime',
    baseline: report.baseline,
    final: null,
    steps: report.steps,
    runs: spec.runs,
  };
  emit('job-end', {
    ok: true,
    baseline: report.baseline,
    findings,
    plan,
    ledger,
    experiments: report.steps,
  });
}

async function runMonitor(spec: JobSpec): Promise<void> {
  const url = spec.project.url;
  if (!url) throw new Error('monitor requires a project URL. Set the URL field for this project.');
  const runs = Math.min(10, Math.max(3, spec.runs || 5));
  emit('job-start', { jobId: spec.jobId, type: 'monitor' });
  const measured = await measureUrl({ url, runs, profile: 'mobile', onProgress: () => undefined });
  const agg = aggregate(measured);
  const samples: Record<string, number[]> = {};
  const medians: Record<string, number | null> = {};
  for (const info of METRICS) {
    samples[info.key] = values(measured, info.key);
    medians[info.key] = agg[info.key]?.median ?? null;
  }
  emit('job-end', { ok: true, measurement: { profile: 'mobile', samples, medians } });
}

const selfPath = path.resolve(fileURLToPath(import.meta.url));
const isDirect = process.argv.some((arg) => {
  try {
    return Boolean(arg) && path.resolve(arg) === selfPath;
  } catch {
    return false;
  }
});

if (isDirect) {
  main()
    .then(() => {
      process.stdout.write('', () => process.exit(0));
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : 'job failed';
      process.stdout.write(`${JSON.stringify({ type: 'job-end', payload: { ok: false, error: message } })}\n`, () => process.exit(1));
    });
}
