import type { EventBus } from './events.js';
import type { Stores } from './repo/types.js';
import type { Job, JobStatus, Project } from './types.js';

export interface IngestDeps {
  stores: Stores;
  bus: EventBus;
  redact?: (text: string) => string;
  runs?: { get(jobId: string): number | undefined; set(jobId: string, runId: number): void };
  onSettled?: (info: { job: Job; project: Project; status: JobStatus; payload: unknown }) => Promise<void>;
}

function psiMetrics(field: unknown): Record<string, number | null> {
  if (!field || typeof field !== 'object') return {};
  const psi = (field as { psi?: unknown }).psi;
  if (!psi || typeof psi !== 'object') return {};
  const row = psi as Record<string, unknown>;
  const read = (key: string) => (typeof row[key] === 'number' ? row[key] as number : null);
  return { score: read('score'), lcp: read('lcp'), fcp: read('fcp'), tbt: read('tbt'), cls: read('cls'), speedIndex: read('speedIndex') };
}

/** Records one worker event from a GitHub Actions callback. A finished job ignores later events. */
export async function ingestWorkerEvent(deps: IngestDeps, jobId: string, type: string, payload: unknown): Promise<'ok' | 'missing' | 'closed' | 'duplicate'> {
  const job = await deps.stores.jobs.get(jobId);
  if (!job) return 'missing';
  const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  if (type === 'actions-run') {
    const runId = Number(body.runId);
    const current = deps.runs?.get(jobId);
    if (Number.isInteger(runId) && runId > 0 && current && current !== runId) return 'duplicate';
  }
  if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') return 'closed';
  const redact = deps.redact ?? ((text: string) => text);
  if (job.status === 'queued') {
    await deps.stores.jobs.update(job.id, { status: 'running', startedAt: new Date().toISOString(), error: null });
  }
  if (type === 'actions-run') {
    const runId = Number(body.runId);
    if (Number.isInteger(runId) && runId > 0) deps.runs?.set(jobId, runId);
  }
  if (type === 'job-end') {
    const ok = body.ok !== false;
    const error = ok ? null : redact(String(body.error ?? 'job failed'));
    const status: JobStatus = ok ? 'succeeded' : 'failed';
    await deps.stores.jobs.update(job.id, {
      status,
      error,
      result: body,
      prUrl: typeof body.prUrl === 'string' ? body.prUrl : null,
      finishedAt: new Date().toISOString(),
    });
    if (body.baseline) {
      await deps.stores.measurements.insert({ projectId: job.projectId, jobId: job.id, profile: 'mobile', metrics: body.baseline }).catch(() => undefined);
    }
    if (body.field) {
      await deps.stores.measurements.insert({
        projectId: job.projectId,
        jobId: job.id,
        profile: 'field',
        metrics: psiMetrics(body.field),
        field: body.field,
      }).catch(() => undefined);
    }
    const event = await deps.stores.events.append(job.id, 'job-end', body);
    deps.bus.publish(event);
    const project = await deps.stores.projects.get(job.projectId).catch(() => null);
    if (project && deps.onSettled) {
      try {
        await deps.onSettled({ job, project, status, payload: body });
      } catch {
        /* a notification must not change the job */
      }
    }
    return 'ok';
  }
  const event = await deps.stores.events.append(job.id, type, body);
  deps.bus.publish(event);
  return 'ok';
}
