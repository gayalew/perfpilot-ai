import parser from 'cron-parser';
import type { Executor } from '../executor.js';
import type { Stores } from '../repo/types.js';

export function cronValid(expression: string): boolean {
  try {
    parser.parseExpression(expression);
    return true;
  } catch {
    return false;
  }
}

/** The scheduled instant strictly before `now`. Invalid expressions return null. */
export function previousTick(expression: string, now: Date): Date | null {
  try {
    return parser.parseExpression(expression, { currentDate: now }).prev().toDate();
  } catch {
    return null;
  }
}

export function monitorIsDue(expression: string | null, lastCreatedAt: string | null, now = new Date()): boolean {
  if (!expression) return false;
  const prev = previousTick(expression, now);
  if (!prev) return false;
  if (!lastCreatedAt) return true;
  const created = Date.parse(lastCreatedAt);
  return Number.isFinite(created) && created < prev.getTime();
}

/** Enqueue one monitor job per due project. A second call in the same tick enqueues nothing new. */
export async function enqueueDueMonitors(stores: Stores, executor: Pick<Executor, 'start'>, now = new Date()): Promise<string[]> {
  const enqueued: string[] = [];
  for (const project of await stores.projects.list()) {
    if (!project.scheduleCron || !cronValid(project.scheduleCron)) continue;
    const jobs = await stores.jobs.listByProject(project.id);
    const monitors = jobs.filter((job) => job.type === 'monitor');
    if (monitors.some((job) => job.status === 'queued' || job.status === 'running')) continue;
    const last = [...monitors].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!monitorIsDue(project.scheduleCron, last?.createdAt ?? null, now)) continue;
    const job = await stores.jobs.create({ projectId: project.id, type: 'monitor', params: { runs: 5 } });
    await executor.start(job);
    enqueued.push(project.id);
  }
  return enqueued;
}
