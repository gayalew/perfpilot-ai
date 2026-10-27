import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { EventBus } from './events.js';
import type { Stores } from './repo/types.js';
import { redactSecrets } from './redact.js';
import type { Job, JobStatus, Project } from './types.js';

export interface Executor {
  start(job: Job): Promise<void>;
  cancel(jobId: string): Promise<void>;
  recover(): Promise<void>;
}

export interface ChildCommand {
  command: string;
  args: string[];
  cwd: string;
  shell: boolean;
}

export interface LocalExecutorOptions {
  stores: Stores;
  bus: EventBus;
  commandFor: (job: Job) => ChildCommand;
  envFor: (job: Job) => NodeJS.ProcessEnv;
  specFor: (job: Job, project: Project) => unknown;
  redact?: (text: string) => string;
  timeoutMs?: number;
}

interface Active {
  job: Job;
  child: ChildProcess;
  done: boolean;
  cancelled: boolean;
  timer?: NodeJS.Timeout;
  stderr: string;
  resolve: () => void;
}

export class LocalExecutor implements Executor {
  private queue: Job[] = [];
  private active: Active | null = null;
  private launching = false;
  private readonly timeoutMs: number;
  private readonly redact: (text: string) => string;

  constructor(private readonly options: LocalExecutorOptions) {
    this.timeoutMs = options.timeoutMs ?? 90 * 60 * 1000;
    this.redact = options.redact ?? ((text) => redactSecrets(text, []));
  }

  activePid(): number | null {
    return this.active?.child.pid ?? null;
  }

  async start(job: Job): Promise<void> {
    this.queue.push(job);
    this.kick();
  }

  async cancel(jobId: string): Promise<void> {
    const index = this.queue.findIndex((job) => job.id === jobId);
    if (index >= 0) {
      this.queue.splice(index, 1);
      await this.mark(jobId, 'cancelled', { error: null, result: { ok: false, error: 'cancelled' } });
      await this.emit(jobId, 'job-end', { ok: false, error: 'cancelled' });
      return;
    }
    const active = this.active;
    if (active && active.job.id === jobId && !active.done) {
      active.cancelled = true;
      active.done = true;
      if (active.timer) clearTimeout(active.timer);
      await killTree(active.child.pid);
      await this.mark(jobId, 'cancelled', { error: null, result: { ok: false, error: 'cancelled' } });
      await this.emit(jobId, 'job-end', { ok: false, error: 'cancelled' });
      this.active = null;
      active.resolve();
      this.kick();
      return;
    }
    const job = await this.options.stores.jobs.get(jobId);
    if (job && (job.status === 'queued' || job.status === 'running')) {
      await this.mark(jobId, 'cancelled', { error: null, result: { ok: false, error: 'cancelled' } });
    }
  }

  async recover(): Promise<void> {
    const running = await this.options.stores.jobs.listByStatus('running');
    for (const job of running) {
      await this.mark(job.id, 'failed', { error: 'server restarted' });
    }
    const queued = await this.options.stores.jobs.listByStatus('queued');
    for (const job of queued) await this.start(job);
  }

  private kick(): void {
    if (this.launching || this.active || this.queue.length === 0) return;
    const job = this.queue.shift();
    if (!job) return;
    this.launching = true;
    void this.launch(job).finally(() => {
      this.launching = false;
      this.kick();
    });
  }

  private launch(job: Job): Promise<void> {
    return new Promise((resolve) => {
      void this.spawnJob(job, resolve);
    });
  }

  private async spawnJob(job: Job, resolve: () => void): Promise<void> {
    const project = await this.options.stores.projects.get(job.projectId);
    if (!project) {
      await this.mark(job.id, 'failed', { error: 'project not found' });
      await this.emit(job.id, 'job-end', { ok: false, error: 'project not found' });
      resolve();
      return;
    }
    await this.options.stores.jobs.update(job.id, { status: 'running', startedAt: new Date().toISOString(), error: null });
    const command = this.options.commandFor(job);
    const child = spawn(command.command, command.args, {
      cwd: command.cwd,
      shell: command.shell,
      env: this.options.envFor(job),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const active: Active = { job, child, done: false, cancelled: false, stderr: '', resolve };
    this.active = active;
    active.timer = setTimeout(() => {
      if (active.done) return;
      active.done = true;
      void killTree(child.pid).then(async () => {
        await this.mark(job.id, 'failed', { error: 'timed out after 90 minutes' });
        await this.emit(job.id, 'job-end', { ok: false, error: 'timed out after 90 minutes' });
        if (this.active === active) this.active = null;
        resolve();
        this.kick();
      });
    }, this.timeoutMs);
    active.timer.unref();

    child.stdin?.write(`${JSON.stringify(this.options.specFor(job, project))}\n`);
    child.stdin?.end();

    const stdout = createInterface({ input: child.stdout! });
    stdout.on('line', (line) => {
      void this.onStdout(active, line).catch((err) => logStoreFailure(err));
    });
    const stderr = createInterface({ input: child.stderr! });
    stderr.on('line', (line) => {
      const text = this.redact(line);
      active.stderr = `${active.stderr}\n${text}`.slice(-2000);
      void this.emit(job.id, 'log', { line: text }).catch((err) => logStoreFailure(err));
    });
    child.on('error', (err) => {
      if (active.done) return;
      active.done = true;
      if (active.timer) clearTimeout(active.timer);
      void this.mark(job.id, 'failed', { error: this.redact(err.message) }).then(async () => {
        await this.emit(job.id, 'job-end', { ok: false, error: this.redact(err.message) });
        if (this.active === active) this.active = null;
        resolve();
        this.kick();
      }).catch((storeErr) => logStoreFailure(storeErr));
    });
    child.on('exit', (code) => {
      if (active.done) return;
      active.done = true;
      if (active.timer) clearTimeout(active.timer);
      const failed = code !== 0;
      const error = failed ? active.stderr.trim() || `exit ${code}` : null;
      void this.mark(job.id, failed ? 'failed' : 'succeeded', { error, result: failed ? { ok: false, error } : { ok: true } }).then(async () => {
        await this.emit(job.id, 'job-end', { ok: !failed, error });
        if (this.active === active) this.active = null;
        resolve();
        this.kick();
      }).catch((storeErr) => logStoreFailure(storeErr));
    });
  }

  private async onStdout(active: Active, line: string): Promise<void> {
    if (active.done) return;
    let parsed: { type: string; payload: unknown } | undefined;
    try {
      const raw = JSON.parse(line) as { type?: unknown; payload?: unknown };
      if (typeof raw.type === 'string') parsed = { type: raw.type, payload: raw.payload ?? {} };
    } catch {
      parsed = undefined;
    }
    if (!parsed) {
      await this.emit(active.job.id, 'log', { line: this.redact(line) });
      return;
    }
    if (parsed.type === 'job-end') {
      if (active.done) return;
      active.done = true;
      if (active.timer) clearTimeout(active.timer);
      const payload = (parsed.payload ?? {}) as { ok?: boolean; error?: string; prUrl?: string | null; baseline?: unknown };
      const ok = payload.ok !== false && !active.cancelled;
      await this.mark(active.job.id, active.cancelled ? 'cancelled' : ok ? 'succeeded' : 'failed', {
        error: active.cancelled ? null : ok ? null : this.redact(String(payload.error ?? 'job failed')),
        result: payload,
        prUrl: active.cancelled ? null : payload.prUrl ?? null,
      });
      if (active.cancelled) {
        await this.mark(active.job.id, 'cancelled', { error: null, result: { ok: false, error: 'cancelled' }, prUrl: null });
      }
      if (payload.baseline) {
        await this.options.stores.measurements.insert({
          projectId: active.job.projectId,
          jobId: active.job.id,
          profile: 'mobile',
          metrics: payload.baseline,
        }).catch(() => undefined);
      }
      await this.emit(active.job.id, 'job-end', payload);
      if (this.active === active) this.active = null;
      active.resolve();
      this.kick();
      return;
    }
    await this.emit(active.job.id, parsed.type, parsed.payload);
  }

  private async mark(jobId: string, status: JobStatus, extra: { error?: string | null; result?: unknown; prUrl?: string | null }): Promise<void> {
    await withDbRetry(() => this.options.stores.jobs.update(jobId, {
      status,
      error: extra.error,
      result: extra.result,
      prUrl: extra.prUrl,
      finishedAt: new Date().toISOString(),
    }));
  }

  private async emit(jobId: string, type: string, payload: unknown): Promise<void> {
    const event = await withDbRetry(() => this.options.stores.events.append(jobId, type, payload ?? {}));
    this.options.bus.publish(event);
  }
}

const TRANSIENT_DB = /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|Connection terminated|timeout|too many clients/i;

async function withDbRetry<T>(op: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await op();
    } catch (err) {
      last = err;
      const code = typeof err === 'object' && err && 'code' in err ? String((err as { code?: unknown }).code ?? '') : '';
      const message = err instanceof Error ? err.message : '';
      if (!TRANSIENT_DB.test(code) && !TRANSIENT_DB.test(message)) throw err;
      await new Promise((resolve) => setTimeout(resolve, [400, 800, 1600, 3200, 6400, 8000][attempt] ?? 8000));
    }
  }
  throw last;
}

function logStoreFailure(err: unknown): void {
  const code = typeof err === 'object' && err && 'code' in err ? String((err as { code?: unknown }).code ?? '') : '';
  console.error(`event store failed (${code || 'error'})`);
}

function killTree(pid: number | undefined): Promise<void> {
  if (!pid) return Promise.resolve();
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { shell: true, windowsHide: true });
      killer.on('exit', () => resolve());
      killer.on('error', () => resolve());
      return;
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    resolve();
  });
}
