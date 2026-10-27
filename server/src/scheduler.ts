import cron from 'node-cron';
import type { Executor } from './executor.js';
import { enqueueDueMonitors } from './monitor/due.js';
import { digestMessage, sendNotification, type NotifyEnv } from './notify/dispatch.js';
import type { Stores } from './repo/types.js';
import type { Project } from './types.js';

export class Scheduler {
  private tasks = new Map<string, cron.ScheduledTask>();
  private digest: cron.ScheduledTask | null = null;

  constructor(private readonly deps: { stores: Stores; executor: Executor; env: NotifyEnv; digestCron: string }) {}

  start(): void {
    void this.deps.stores.projects.list().then((projects) => {
      for (const project of projects) this.sync(project);
    }).catch(() => undefined);
    if (cron.validate(this.deps.digestCron)) {
      this.digest = cron.schedule(this.deps.digestCron, () => {
        void this.sendDigests();
      });
    }
  }

  sync(project: Project): void {
    this.tasks.get(project.id)?.stop();
    this.tasks.delete(project.id);
    if (!project.scheduleCron || !cron.validate(project.scheduleCron)) return;
    const task = cron.schedule(project.scheduleCron, () => {
      void this.enqueue(project.id);
    });
    this.tasks.set(project.id, task);
  }

  remove(projectId: string): void {
    this.tasks.get(projectId)?.stop();
    this.tasks.delete(projectId);
  }

  async enqueue(projectId: string): Promise<void> {
    const jobs = await this.deps.stores.jobs.listByProject(projectId);
    if (jobs.some((job) => job.type === 'monitor' && (job.status === 'queued' || job.status === 'running'))) return;
    const job = await this.deps.stores.jobs.create({ projectId, type: 'monitor', params: { runs: 5 } });
    await this.deps.executor.start(job);
  }

  async sendDigests(now = Date.now()): Promise<void> {
    const since = now - 7 * 24 * 60 * 60 * 1000;
    for (const project of await this.deps.stores.projects.list()) {
      if (!project.notifyEmail) continue;
      try {
        const measurements = (await this.deps.stores.measurements.listByProject(project.id)).filter((row) => row.samples && Date.parse(row.takenAt) >= since);
        const incidents = await this.deps.stores.incidents.listByProject(project.id);
        const opened = incidents.filter((row) => Date.parse(row.openedAt) >= since);
        const closed = incidents.filter((row) => row.closedAt && Date.parse(row.closedAt) >= since);
        const pulls = (await this.deps.stores.jobs.listByProject(project.id)).filter((job) => job.prUrl && Date.parse(job.createdAt) >= since);
        if (measurements.length === 0 && opened.length === 0 && closed.length === 0 && pulls.length === 0) continue;
        const first = measurements[0];
        const last = measurements[measurements.length - 1];
        const median = (row: typeof first, key: string) => {
          const value = row?.medians && typeof row.medians === 'object' ? (row.medians as Record<string, unknown>)[key] : null;
          return typeof value === 'number' ? String(Math.round(value * 100) / 100) : 'n/a';
        };
        const text = [
          `Checks run: ${measurements.length}`,
          `Score ${median(first, 'score')} to ${median(last, 'score')}`,
          `LCP ${median(first, 'lcp')} to ${median(last, 'lcp')}`,
          `Incidents opened: ${opened.length}`,
          `Incidents closed: ${closed.length}`,
          `Pull requests opened: ${pulls.length}`,
        ].join('\n');
        const html = `<p>${text.replace(/\n/g, '<br>')}</p>`;
        await sendNotification(this.deps.env, this.deps.stores, project, null, digestMessage(project, text, html), ['email']);
      } catch {
        /* a digest must not stop the scheduler */
      }
    }
  }
}

export async function runDue(stores: Stores, executor: Executor, now = new Date()): Promise<string[]> {
  return enqueueDueMonitors(stores, executor, now);
}
