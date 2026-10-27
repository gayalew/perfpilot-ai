import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { EventBus } from './events.js';
import { LocalExecutor } from './executor.js';
import { notifyEnvFrom, notifyJobOutcome, sendNotification, testMessage } from './notify/dispatch.js';
import { createPool, createPgStores } from './repo/postgres.js';
import { redactSecrets } from './redact.js';
import type { Job, Project } from './types.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const config = loadConfig();
const pool = createPool(config.databaseUrl);
const stores = createPgStores(pool);
const bus = new EventBus();
const notify = notifyEnvFrom(process.env, config.clientOrigin);
const secrets = [config.githubToken, config.geminiApiKey, config.sessionSecret, config.adminPassword, notify.resendApiKey, notify.telegramBotToken].filter((value) => value.length >= 4);

const executor = new LocalExecutor({
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
    runs: job.params.runs ?? 4,
    maxSteps: job.params.maxSteps ?? 12,
    useAi: job.params.useAi ?? true,
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
    let pdf: Buffer | null = null;
    try {
      pdf = await readFile(path.join(root, 'runs', job.id, 'report.pdf'));
    } catch {
      pdf = null;
    }
    await notifyJobOutcome(notify, stores, { project, job, status, payload, pdf });
  },
});

await executor.recover();
const app = createApp({
  config,
  stores,
  bus,
  executor,
  reportFile: (jobId) => path.join(root, 'runs', jobId, 'report.pdf'),
  notifyTest: (project) => sendNotification(notify, stores, project, null, testMessage(project)),
});
app.listen(config.port, () => {
  console.log(`listening on ${config.port}`);
});
