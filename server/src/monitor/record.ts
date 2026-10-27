import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { NotifyEnv } from '../notify/dispatch.js';
import { recoveryMessage, regressionMessage, sendNotification } from '../notify/dispatch.js';
import type { Stores } from '../repo/types.js';
import type { Job, Measurement, Project } from '../types.js';
import { evaluateMonitor, type MonitorComparison, type MonitorPoint } from './evaluate.js';
import { suspectCommits, type SuspectCommit } from './suspects.js';

const require = createRequire(import.meta.url);

interface MeasurementPayload {
  samples: Record<string, number[]>;
  medians: Record<string, number | null>;
}

function readMeasurement(payload: unknown): MeasurementPayload | null {
  if (!payload || typeof payload !== 'object') return null;
  const measurement = (payload as { measurement?: unknown }).measurement;
  if (!measurement || typeof measurement !== 'object') return null;
  const samples = (measurement as { samples?: unknown }).samples;
  if (!samples || typeof samples !== 'object') return null;
  const medians = (measurement as { medians?: unknown }).medians;
  return {
    samples: samples as Record<string, number[]>,
    medians: medians && typeof medians === 'object' ? medians as Record<string, number | null> : {},
  };
}

function historyOf(rows: Measurement[]): MonitorPoint[] {
  return rows.filter((row) => row.samples && typeof row.samples === 'object').map((row) => ({
    id: String(row.id),
    takenAt: row.takenAt,
    status: row.status,
    samples: row.samples as MonitorPoint['samples'],
  }));
}

function round(value: number): string {
  if (!Number.isFinite(value)) return 'n/a';
  if (Math.abs(value) >= 100) return String(Math.round(value));
  return String(Math.round(value * 1000) / 1000);
}

function changeText(relative: number): string {
  if (!Number.isFinite(relative)) return 'n/a';
  return `${relative >= 0 ? '+' : ''}${Math.round(relative * 100)}%`;
}

function breachLines(rows: MonitorComparison[]): string[] {
  return rows.filter((row) => row.breach).map((row) => `${row.label}: reference ${round(row.baselineMedian)}, now ${round(row.candidateMedian)}, ${changeText(row.relativeChange)}`);
}

async function writePdf(project: Project, status: string, comparisons: MonitorComparison[], trend: Measurement[], suspects: string, runDir: string): Promise<Buffer | null> {
  try {
    const htmlMod = require('../../../worker/src/report/html.ts') as {
      renderMonitorReportHtml: (input: unknown) => string;
    };
    const pdfMod = require('../../../worker/src/report/pdf.ts') as {
      renderReportPdf: (html: string, outPath: string) => Promise<void>;
    };
    const html = htmlMod.renderMonitorReportHtml({
      projectName: project.name,
      target: project.url || `${project.repoOwner ?? ''}/${project.repoName ?? ''}`,
      generatedAt: new Date().toISOString(),
      status,
      comparisons,
      trend: trend.slice(-10).map((row) => ({
        takenAt: row.takenAt,
        status: row.status,
        medians: (row.medians && typeof row.medians === 'object' ? row.medians : {}) as Record<string, number | null>,
      })),
      suspects,
    });
    await mkdir(runDir, { recursive: true });
    const file = path.join(runDir, 'report.pdf');
    await pdfMod.renderReportPdf(html, file);
    return await readFile(file);
  } catch {
    return null;
  }
}

/** Stores one real monitor measurement, updates incidents, and notifies. Never throws. */
export async function recordMonitorResult(input: {
  env: NotifyEnv;
  stores: Stores;
  project: Project;
  job: Job;
  payload: unknown;
  runDir: string;
  githubToken: string;
  minHistory: number;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  try {
    const measured = readMeasurement(input.payload);
    if (!measured) return;
    const existing = await input.stores.measurements.listByProject(input.project.id);
    const history = historyOf(existing);
    const open = await input.stores.incidents.openForProject(input.project.id);
    const evaluation = evaluateMonitor(history, { samples: measured.samples }, {
      minHistory: input.minHistory,
      incidentOpen: Boolean(open),
    });
    const saved = await input.stores.measurements.insert({
      projectId: input.project.id,
      jobId: input.job.id,
      profile: 'mobile',
      metrics: measured.medians,
      status: evaluation.status,
      compared: { comparisons: evaluation.comparisons, reference: evaluation.reference?.medians ?? null },
      samples: measured.samples,
      medians: measured.medians,
    });

    let commits: SuspectCommit[] = [];
    let suspectText = 'No repository connected: connect one to get suspect commits.';
    if (input.project.mode === 'repo' && (evaluation.status === 'breach' || evaluation.status === 'regression')) {
      const lastOk = [...history].filter((point) => point.status === 'ok').sort((a, b) => Date.parse(a.takenAt) - Date.parse(b.takenAt)).at(-1);
      const since = lastOk?.takenAt ?? evaluation.firstBreachAt ?? saved.takenAt;
      const found = await suspectCommits(input.project, since, input.githubToken, input.fetchImpl);
      commits = found.commits;
      suspectText = found.text;
    }

    const monitor = {
      status: evaluation.status,
      comparisons: evaluation.comparisons,
      suspects: commits,
      suspectText,
      reference: evaluation.reference?.medians ?? null,
    };
    const payload = input.payload && typeof input.payload === 'object' ? input.payload as Record<string, unknown> : {};
    await input.stores.jobs.update(input.job.id, { result: { ...payload, monitor } });

    const rows = await input.stores.measurements.listByProject(input.project.id);
    if (evaluation.shouldAlert) {
      const first = history.find((point) => point.takenAt === evaluation.firstBreachAt);
      const incident = await input.stores.incidents.insert({
        projectId: input.project.id,
        firstMeasurementId: first ? Number(first.id) : saved.id,
        lastMeasurementId: saved.id,
        details: {
          suspects: suspectText,
          commits,
          since: evaluation.firstBreachAt ?? saved.takenAt,
          metrics: evaluation.comparisons.filter((row) => row.breach),
        },
      });
      const pdf = await writePdf(input.project, evaluation.status, evaluation.comparisons, rows, suspectText, input.runDir);
      const lines = breachLines(evaluation.comparisons);
      const message = regressionMessage(input.project, input.job.id, input.env.clientOrigin, lines.length ? lines : ['A primary metric regressed.'], evaluation.firstBreachAt ?? saved.takenAt, suspectText);
      if (pdf) message.pdf = pdf;
      await sendNotification(input.env, input.stores, input.project, input.job.id, message);
      await input.stores.incidents.update(incident.id, { alertSentAt: new Date().toISOString() });
      return;
    }
    if (evaluation.shouldSendRecovery && open) {
      await input.stores.incidents.update(open.id, {
        closedAt: new Date().toISOString(),
        recoverySentAt: new Date().toISOString(),
        lastMeasurementId: saved.id,
      });
      await sendNotification(input.env, input.stores, input.project, input.job.id, recoveryMessage(input.project, input.job.id, input.env.clientOrigin));
      return;
    }
    if (open && evaluation.openIncident) {
      await input.stores.incidents.update(open.id, { lastMeasurementId: saved.id });
    }
  } catch {
    /* monitoring bookkeeping must not fail the job */
  }
}
