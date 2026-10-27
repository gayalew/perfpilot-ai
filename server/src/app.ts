import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { ZodError, z } from 'zod';
import { LoginLimiter, SESSION_COOKIE, passwordsMatch, readCookie, signSession, verifySession } from './auth.js';
import type { Config } from './config.js';
import type { EventBus } from './events.js';
import type { Executor } from './executor.js';
import type { Stores } from './repo/types.js';
import type { ProjectInput } from './types.js';

const NAME = /^[A-Za-z0-9_.-]+$/;

function badRoot(value: string): boolean {
  if (!value) return false;
  if (value.startsWith('/') || value.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(value)) return true;
  return value.split(/[\\/]/).includes('..');
}

function normalizeProject(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  const raw = body as Record<string, unknown>;
  const pick = (camel: string, snake: string) => (raw[camel] !== undefined ? raw[camel] : raw[snake]);
  return {
    name: raw.name,
    mode: raw.mode,
    url: pick('url', 'url'),
    repoOwner: pick('repoOwner', 'repo_owner'),
    repoName: pick('repoName', 'repo_name'),
    baseBranch: pick('baseBranch', 'base_branch'),
    rootDir: pick('rootDir', 'root_dir'),
    notifyEmail: pick('notifyEmail', 'notify_email'),
    telegramChatId: pick('telegramChatId', 'telegram_chat_id'),
    scheduleCron: pick('scheduleCron', 'schedule_cron'),
  };
}

const projectObject = z.object({
  name: z.string().min(1),
  mode: z.enum(['url', 'repo']),
  url: z.string().nullable().optional(),
  repoOwner: z.string().nullable().optional(),
  repoName: z.string().nullable().optional(),
  baseBranch: z.string().min(1).optional(),
  rootDir: z.string().optional(),
  notifyEmail: z.string().nullable().optional(),
  telegramChatId: z.string().nullable().optional(),
  scheduleCron: z.string().nullable().optional(),
});

function refineProject(value: z.infer<typeof projectObject>, ctx: z.RefinementCtx, partial: boolean): void {
  if (!partial && value.mode === 'url' && !value.url) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['url'], message: 'url is required' });
  if (!partial && value.mode === 'repo') {
    if (!value.repoOwner || !NAME.test(value.repoOwner)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['repoOwner'], message: 'repo_owner is invalid' });
    if (!value.repoName || !NAME.test(value.repoName)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['repoName'], message: 'repo_name is invalid' });
  }
  if (value.repoOwner && !NAME.test(value.repoOwner)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['repoOwner'], message: 'repo_owner is invalid' });
  if (value.repoName && !NAME.test(value.repoName)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['repoName'], message: 'repo_name is invalid' });
  if (value.rootDir !== undefined && badRoot(value.rootDir)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rootDir'], message: 'root_dir must stay inside the repo' });
}

const projectSchema = projectObject.superRefine((value, ctx) => refineProject(value, ctx, false));
const patchSchema = projectObject.partial().superRefine((value, ctx) => refineProject(value as z.infer<typeof projectObject>, ctx, true));

const jobSchema = z.object({
  type: z.enum(['audit', 'optimize']),
  runs: z.number().int().min(4).max(10).optional(),
  maxSteps: z.number().int().min(1).max(12).optional(),
  useAi: z.boolean().optional(),
});

export interface AppDeps {
  config: Pick<Config, 'sessionSecret' | 'adminPassword' | 'clientOrigin' | 'nodeEnv'>;
  stores: Stores;
  bus: EventBus;
  executor: Executor;
}

function asyncRoute(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

function toInput(value: z.infer<typeof projectObject>): ProjectInput {
  return {
    name: value.name,
    mode: value.mode,
    url: value.url ?? null,
    repoOwner: value.repoOwner ?? null,
    repoName: value.repoName ?? null,
    baseBranch: value.baseBranch,
    rootDir: value.rootDir,
    notifyEmail: value.notifyEmail ?? null,
    telegramChatId: value.telegramChatId ?? null,
    scheduleCron: value.scheduleCron ?? null,
  };
}

export function createApp(deps: AppDeps): express.Express {
  const { config, stores, bus, executor } = deps;
  const limiter = new LoginLimiter();
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: config.clientOrigin, credentials: true }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.post('/api/login', (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (limiter.blocked(ip)) {
      res.status(429).json({ error: 'too many attempts' });
      return;
    }
    const parsed = z.object({ password: z.string() }).safeParse(req.body);
    if (!parsed.success || !passwordsMatch(parsed.data.password, config.adminPassword)) {
      limiter.fail(ip);
      res.status(401).json({ error: 'invalid password' });
      return;
    }
    res.cookie(SESSION_COOKIE, signSession(config.sessionSecret), {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.nodeEnv === 'production',
      maxAge: 12 * 60 * 60 * 1000,
      path: '/',
    });
    res.json({ ok: true });
  });

  app.use('/api', (req, res, next) => {
    if (req.path === '/health' || req.path === '/login') return next();
    const token = readCookie(req.header('cookie'), SESSION_COOKIE);
    if (!token || !verifySession(token, config.sessionSecret)) {
      res.status(401).json({ error: 'authentication required' });
      return;
    }
    next();
  });

  app.post('/api/logout', (_req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  app.get('/api/me', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/projects', asyncRoute(async (_req, res) => {
    res.json(await stores.projects.list());
  }));

  app.post('/api/projects', asyncRoute(async (req, res) => {
    const parsed = projectSchema.parse(normalizeProject(req.body));
    const project = await stores.projects.create(toInput(parsed));
    res.status(201).json(project);
  }));

  app.get('/api/projects/:id', asyncRoute(async (req, res) => {
    const project = await stores.projects.get(String(req.params.id));
    if (!project) {
      res.status(404).json({ error: 'project not found' });
      return;
    }
    res.json(project);
  }));

  app.patch('/api/projects/:id', asyncRoute(async (req, res) => {
    const existing = await stores.projects.get(String(req.params.id));
    if (!existing) {
      res.status(404).json({ error: 'project not found' });
      return;
    }
    const parsed = patchSchema.parse(normalizeProject({ ...existing, ...((req.body ?? {}) as object) }));
    const project = await stores.projects.update(existing.id, toInput({ ...existing, ...parsed, name: parsed.name ?? existing.name, mode: parsed.mode ?? existing.mode }));
    res.json(project);
  }));

  app.delete('/api/projects/:id', asyncRoute(async (req, res) => {
    const removed = await stores.projects.delete(String(req.params.id));
    if (!removed) {
      res.status(404).json({ error: 'project not found' });
      return;
    }
    res.status(204).end();
  }));

  app.post('/api/projects/:id/jobs', asyncRoute(async (req, res) => {
    const project = await stores.projects.get(String(req.params.id));
    if (!project) {
      res.status(404).json({ error: 'project not found' });
      return;
    }
    const parsed = jobSchema.parse(req.body);
    if (parsed.type === 'optimize' && project.mode !== 'repo') {
      res.status(400).json({ error: 'optimize requires a repo project' });
      return;
    }
    const job = await stores.jobs.create({
      projectId: project.id,
      type: parsed.type,
      params: { runs: parsed.runs ?? 4, maxSteps: parsed.maxSteps ?? 12, useAi: parsed.useAi ?? true },
    });
    await executor.start(job);
    res.status(202).json({ id: job.id });
  }));

  app.get('/api/projects/:id/jobs', asyncRoute(async (req, res) => {
    res.json(await stores.jobs.listByProject(String(req.params.id)));
  }));

  app.get('/api/jobs/:id', asyncRoute(async (req, res) => {
    const job = await stores.jobs.get(String(req.params.id));
    if (!job) {
      res.status(404).json({ error: 'job not found' });
      return;
    }
    res.json(job);
  }));

  app.post('/api/jobs/:id/cancel', asyncRoute(async (req, res) => {
    const job = await stores.jobs.get(String(req.params.id));
    if (!job) {
      res.status(404).json({ error: 'job not found' });
      return;
    }
    if (job.status !== 'queued' && job.status !== 'running') {
      res.status(409).json({ error: `job is ${job.status}` });
      return;
    }
    await executor.cancel(job.id);
    res.json(await stores.jobs.get(job.id));
  }));

  app.get('/api/jobs/:id/events', asyncRoute(async (req, res) => {
    const job = await stores.jobs.get(String(req.params.id));
    if (!job) {
      res.status(404).json({ error: 'job not found' });
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const last = Number(req.header('last-event-id') ?? 0);
    const write = (id: number, payload: unknown) => {
      res.write(`id: ${id}\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    const stored = await stores.events.list(job.id, Number.isFinite(last) ? last : 0);
    for (const event of stored) write(event.id, { type: event.type, payload: event.payload });
    const finished = stored.some((event) => event.type === 'job-end') || job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled';
    if (finished) {
      res.end();
      return;
    }
    let closed = false;
    const unsubscribe = bus.subscribe(job.id, (event) => {
      if (closed) return;
      write(event.id, { type: event.type, payload: event.payload });
      if (event.type === 'job-end') {
        closed = true;
        clearInterval(beat);
        unsubscribe();
        res.end();
      }
    });
    const beat = setInterval(() => {
      if (!closed) res.write(': heartbeat\n\n');
    }, 15_000);
    beat.unref();
    req.on('close', () => {
      closed = true;
      clearInterval(beat);
      unsubscribe();
    });
  }));

  app.get('/api/jobs/:id/ledger', asyncRoute(async (req, res) => {
    const job = await stores.jobs.get(String(req.params.id));
    if (!job) {
      res.status(404).json({ error: 'job not found' });
      return;
    }
    const ledger = (job.result as { ledger?: unknown } | null)?.ledger;
    if (!ledger) {
      res.status(404).json({ error: 'ledger not ready' });
      return;
    }
    res.json(ledger);
  }));

  app.get('/api/jobs/:id/summary.md', asyncRoute(async (req, res) => {
    const job = await stores.jobs.get(String(req.params.id));
    if (!job) {
      res.status(404).json({ error: 'job not found' });
      return;
    }
    const summary = (job.result as { summary?: unknown } | null)?.summary;
    if (typeof summary !== 'string') {
      res.status(404).json({ error: 'summary not ready' });
      return;
    }
    res.type('text/markdown').send(summary);
  }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({ error: err.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ') });
      return;
    }
    const message = err instanceof Error ? err.message : 'internal error';
    res.status(500).json({ error: message });
  });

  return app;
}
