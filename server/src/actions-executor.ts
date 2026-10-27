import type { EventBus } from './events.js';
import type { Executor } from './executor.js';
import { ingestWorkerEvent } from './job-ingest.js';
import type { Stores } from './repo/types.js';
import type { Job, JobStatus, Project } from './types.js';
import { cancelRequest, dispatchRequest, scrubToken } from './actions.js';

export class RunRegistry {
  private readonly ids = new Map<string, number>();

  set(jobId: string, runId: number): void {
    this.ids.set(jobId, runId);
  }

  get(jobId: string): number | undefined {
    return this.ids.get(jobId);
  }
}

export interface ActionsExecutorOptions {
  stores: Stores;
  bus: EventBus;
  owner: string;
  repo: string;
  token: string;
  callbackUrl: string;
  ref?: string;
  specFor: (job: Job, project: Project) => unknown;
  runs: RunRegistry;
  fetchImpl?: typeof fetch;
  onSettled?: (info: { job: Job; project: Project; status: JobStatus; payload: unknown }) => Promise<void>;
}

/** Dispatches perfpilot-job.yml and records events that the workflow posts back. */
export class GithubActionsExecutor implements Executor {
  private readonly dispatched = new Set<string>();

  constructor(private readonly options: ActionsExecutorOptions) {}

  async start(job: Job): Promise<void> {
    if (this.dispatched.has(job.id)) return;
    this.dispatched.add(job.id);
    const project = await this.options.stores.projects.get(job.projectId);
    if (!project) {
      await this.fail(job.id, 'project not found');
      return;
    }
    if (!this.options.token) {
      await this.fail(job.id, 'GITHUB_TOKEN is not set');
      return;
    }
    if (!this.options.callbackUrl) {
      await this.fail(job.id, 'PERFPILOT_URL is not set');
      return;
    }
    let request: { url: string; init: RequestInit };
    try {
      request = dispatchRequest({
        owner: this.options.owner,
        repo: this.options.repo,
        ref: this.options.ref || project.baseBranch || 'main',
        jobId: job.id,
        callbackUrl: this.options.callbackUrl,
        token: this.options.token,
      });
    } catch (err) {
      await this.fail(job.id, err instanceof Error ? err.message : 'could not dispatch the workflow');
      return;
    }
    const doFetch = this.options.fetchImpl ?? fetch;
    try {
      const res = await doFetch(request.url, request.init);
      if (!res.ok && res.status !== 204) {
        await this.fail(job.id, `GitHub Actions HTTP ${res.status}`);
        return;
      }
    } catch (err) {
      await this.fail(job.id, scrubToken(err instanceof Error ? err.message : 'GitHub Actions request failed', this.options.token));
      return;
    }
    await this.options.stores.jobs.update(job.id, { status: 'running', startedAt: new Date().toISOString(), error: null });
    const event = await this.options.stores.events.append(job.id, 'log', { line: 'dispatched perfpilot-job.yml' });
    this.options.bus.publish(event);
  }

  async cancel(jobId: string): Promise<void> {
    const runId = this.options.runs.get(jobId);
    if (runId && this.options.token) {
      try {
        const request = cancelRequest(this.options.owner, this.options.repo, runId, this.options.token);
        await (this.options.fetchImpl ?? fetch)(request.url, request.init);
      } catch {
        /* the job is still marked cancelled */
      }
    }
    const job = await this.options.stores.jobs.get(jobId);
    if (job && (job.status === 'queued' || job.status === 'running')) {
      await this.options.stores.jobs.update(jobId, { status: 'cancelled', error: null, result: { ok: false, error: 'cancelled' }, finishedAt: new Date().toISOString() });
      const event = await this.options.stores.events.append(jobId, 'job-end', { ok: false, error: 'cancelled' });
      this.options.bus.publish(event);
    }
  }

  async recover(): Promise<void> {
    const running = await this.options.stores.jobs.listByStatus('running');
    for (const job of running) await this.fail(job.id, 'server restarted');
    const queued = await this.options.stores.jobs.listByStatus('queued');
    for (const job of queued) await this.start(job);
  }

  spec(job: Job, project: Project): unknown {
    return this.options.specFor(job, project);
  }

  async ingest(jobId: string, type: string, payload: unknown): Promise<'ok' | 'missing' | 'closed'> {
    return ingestWorkerEvent({
      stores: this.options.stores,
      bus: this.options.bus,
      runs: this.options.runs,
      onSettled: this.options.onSettled,
      redact: (text) => scrubToken(text, this.options.token),
    }, jobId, type, payload);
  }

  private async fail(jobId: string, error: string): Promise<void> {
    await this.options.stores.jobs.update(jobId, { status: 'failed', error, finishedAt: new Date().toISOString() });
    const event = await this.options.stores.events.append(jobId, 'job-end', { ok: false, error });
    this.options.bus.publish(event);
  }
}
