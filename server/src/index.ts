import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { EventBus } from './events.js';
import { GithubActionsExecutor, RunRegistry } from './actions-executor.js';
import { LocalExecutor } from './executor.js';
import { recordMonitorResult } from './monitor/record.js';
import { notifyEnvFrom, notifyJobOutcome, sendNotification, testMessage } from './notify/dispatch.js';
import { createPool, createPgStores } from './repo/postgres.js';
import { redactSecrets } from './redact.js';
import { runDue, Scheduler } from './scheduler.js';
import type { Job, Project } from './types.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const config = loadConfig();
const pool = createPool(config.databaseUrl);
const stores = createPgStores(pool);
const bus = new EventBus();
const notify = notifyEnvFrom(process.env, config.clientOrigin);
const jobSecret = (process.env.JOB_SECRET ?? '').trim();
const secrets = [config.githubToken, config.geminiApiKey, config.sessionSecret, config.adminPassword, notify.resendApiKey, notify.telegramBotToken, jobSecret, (process.env.GOOGLE_API_KEY ?? '').trim()].filter((value) => value.length >= 4);

function monitorMinHistory(): number {
  const raw = Number(process.env.MONITOR_MIN_HISTORY ?? 3);
  return Number.isInteger(raw) && raw >= 1 ? raw : 3;
}

const runs = new RunRegistry();
const localExecutor = new LocalExecutor({
  stores,
  bus,
  redact: (text) => redactSecrets(text, secrets),
  envFor: () => ({
    ...process.env,
    GITHUB_TOKEN: config.githubToken,
    GEMINI_API_KEY: config.geminiApiKey,
    GEMINI_MODEL: config.geminiModel,
  }),
  commandFor: () => ({
    // tsx.cmd does not forward stdin on Windows, so launch the same CLI the shim runs.
    command: process.execPath,
    args: [path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(root, 'worker', 'src', 'job-runner.ts')],
    cwd: root,
    shell: false,
  }),
  specFor: (job: Job, project: Project) => ({
    jobId: job.id,
    type: job.type,
    runs: typeof job.params.runs === 'number' ? job.params.runs : job.type === 'monitor' ? 5 : 4,
    maxSteps: job.params.maxSteps ?? 12,
    useAi: job.params.useAi ?? true,
    onlyFixes: Array.isArray(job.params.onlyFixes) ? job.params.onlyFixes : undefined,
    runDir: path.join(root, 'runs', job.id),
    project: {
      mode: project.mode,
      url: project.url,
      repoOwner: project.repoOwner,
      repoName: project.repoName,
      baseBranch: project.baseBranch,
      rootDir: project.rootDir,
    },
  }),
  onSettled: async ({ job, project, status, payload }) => {
    if (job.type === 'monitor' && status === 'succeeded') {
      await recordMonitorResult({
        env: notify,
        stores,
        project,
        job,
        payload,
        runDir: path.join(root, 'runs', job.id),
        githubToken: config.githubToken,
        minHistory: monitorMinHistory(),
      });
      return;
    }
    let pdf: Buffer | null = null;
    try {
      pdf = await readFile(path.join(root, 'runs', job.id, 'report.pdf'));
    } catch {
      pdf = null;
    }
    await notifyJobOutcome(notify, stores, { project, job, status, payload, pdf });
  },
});

const actions = new GithubActionsExecutor({
  stores,
  bus,
  owner: (process.env.GITHUB_OWNER ?? '').trim() || config.demoRepoOwner,
  repo: (process.env.GITHUB_REPO ?? '').trim() || config.demoRepoName,
  token: config.githubToken,
  callbackUrl: (process.env.PERFPILOT_URL ?? '').trim() || config.clientOrigin,
  specFor: (job, project) => ({
    jobId: job.id,
    type: job.type,
    runs: typeof job.params.runs === 'number' ? job.params.runs : job.type === 'monitor' ? 5 : 4,
    maxSteps: job.params.maxSteps ?? 12,
    useAi: job.params.useAi ?? true,
    onlyFixes: Array.isArray(job.params.onlyFixes) ? job.params.onlyFixes : undefined,
    runDir: path.join(root, 'runs', job.id),
    project: {
      mode: project.mode,
      url: project.url,
      repoOwner: project.repoOwner,
      repoName: project.repoName,
      baseBranch: project.baseBranch,
      rootDir: project.rootDir,
    },
  }),
  runs,
  onSettled: async ({ job, project, status, payload }) => {
    if (job.type === 'monitor' && status === 'succeeded') {
      await recordMonitorResult({
        env: notify,
        stores,
        project,
        job,
        payload,
        runDir: path.join(root, 'runs', job.id),
        githubToken: config.githubToken,
        minHistory: monitorMinHistory(),
      });
      return;
    }
    let pdf: Buffer | null = null;
    try {
      pdf = await readFile(path.join(root, 'runs', job.id, 'report.pdf'));
    } catch {
      pdf = null;
    }
    await notifyJobOutcome(notify, stores, { project, job, status, payload, pdf });
  },
});
const executor = (process.env.EXECUTOR ?? '').trim() === 'github' ? actions : localExecutor;
await executor.recover();
const scheduler = (process.env.SCHEDULER_ENABLED ?? 'true') === '0'
  ? null
  : new Scheduler({ stores, executor, env: notify, digestCron: (process.env.DIGEST_CRON ?? '0 8 * * 1').trim() || '0 8 * * 1' });
scheduler?.start();
const app = createApp({
  config,
  stores,
  bus,
  executor,
  reportFile: (jobId) => path.join(root, 'runs', jobId, 'report.pdf'),
  notifyTest: (project) => sendNotification(notify, stores, project, null, testMessage(project)),
  scheduler: scheduler ?? undefined,
  runDue: () => runDue(stores, executor),
  jobSecret,
  monitorMinHistory: monitorMinHistory(),
  actions,
});
app.listen(config.port, () => {
  console.log(`listening on ${config.port}`);
});
