import type { Job, Project } from '../types.js';
import type { Stores } from '../repo/types.js';
import { escapeHtml, escapeTelegramHtml, sendEmail, sendTelegram, type FetchLike } from './send.js';

export interface NotifyEnv {
  resendApiKey: string;
  emailFrom: string;
  notifyEmailDefault: string;
  telegramBotToken: string;
  telegramChatId: string;
  dryRun: boolean;
  clientOrigin: string;
  fetchImpl?: FetchLike;
  log?: (line: string) => void;
}

export interface ChannelResult {
  status: 'sent' | 'failed' | 'dry-run' | 'skipped';
  error?: string;
}

export interface Outbound {
  kind: string;
  subject: string;
  text: string;
  html: string;
  telegramHtml: string;
  pdf?: Buffer;
}

const skippedLogged = new Set<string>();

export function resetNotifySkipLog(): void {
  skippedLogged.clear();
}

export function notifyEnvFrom(env: NodeJS.ProcessEnv, clientOrigin: string): NotifyEnv {
  return {
    resendApiKey: (env.RESEND_API_KEY ?? '').trim(),
    emailFrom: (env.EMAIL_FROM ?? '').trim(),
    notifyEmailDefault: (env.NOTIFY_EMAIL_DEFAULT ?? '').trim(),
    telegramBotToken: (env.TELEGRAM_BOT_TOKEN ?? '').trim(),
    telegramChatId: (env.TELEGRAM_CHAT_ID ?? '').trim(),
    dryRun: (env.NOTIFY_DRY_RUN ?? '').trim() === '1',
    clientOrigin,
  };
}

function jobLink(origin: string, jobId: string): string {
  return `${origin.replace(/\/$/, '')}/jobs/${jobId}`;
}

function metricLine(label: string, before: unknown, after: unknown): string {
  const read = (value: unknown) => {
    if (!value || typeof value !== 'object' || !('median' in value)) return 'n/a';
    const median = (value as { median?: unknown }).median;
    return typeof median === 'number' ? String(Math.round(median * 100) / 100) : 'n/a';
  };
  return `${label} ${read(before)} to ${read(after)}`;
}

export function prMessage(project: Project, kept: number, ledger: unknown, prUrl: string): Outbound {
  const record = ledger && typeof ledger === 'object' ? ledger as { baseline?: Record<string, unknown>; final?: Record<string, unknown> } : {};
  const before = record.baseline ?? {};
  const after = record.final ?? {};
  const summary = [
    metricLine('Score', before.score, after.score),
    metricLine('LCP', before.lcp, after.lcp),
    metricLine('TBT', before.tbt, after.tbt),
    metricLine('Weight', before.totalBytes, after.totalBytes),
  ].join('\n');
  const subject = `PerfPilot opened a PR: ${kept} proven improvements on ${project.name}`;
  const text = `${subject}\n\n${summary}\n\n${prUrl}`;
  const html = `<div style="font-family:Segoe UI,sans-serif;color:#18181b;line-height:1.5">
    <p style="font-size:16px">${escapeHtml(subject)}</p>
    <p>${escapeHtml(summary).replace(/\n/g, '<br>')}</p>
    <p><a href="${escapeHtml(prUrl)}">${escapeHtml(prUrl)}</a></p>
  </div>`;
  const telegramHtml = `<b>${escapeTelegramHtml(subject)}</b>\n${escapeTelegramHtml(summary)}\n<a href="${escapeTelegramHtml(prUrl)}">${escapeTelegramHtml(prUrl)}</a>`;
  return { kind: 'pr', subject, text, html, telegramHtml };
}

export function failureMessage(project: Project, jobId: string, error: string, origin: string): Outbound {
  const link = jobLink(origin, jobId);
  const subject = `PerfPilot job failed on ${project.name}`;
  const text = `${subject}\n\n${error}\n\n${link}`;
  const html = `<div style="font-family:Segoe UI,sans-serif;color:#18181b;line-height:1.5">
    <p>${escapeHtml(subject)}</p>
    <p>${escapeHtml(error)}</p>
    <p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>
  </div>`;
  const telegramHtml = `<b>${escapeTelegramHtml(subject)}</b>\n${escapeTelegramHtml(error)}\n<a href="${escapeTelegramHtml(link)}">${escapeTelegramHtml(link)}</a>`;
  return { kind: 'failed', subject, text, html, telegramHtml };
}

export function testMessage(project: Project): Outbound {
  const subject = `PerfPilot test notification for ${project.name}`;
  const text = `This is a test message from PerfPilot. No job was run.`;
  const html = `<div style="font-family:Segoe UI,sans-serif;color:#18181b"><p>${escapeHtml(subject)}</p><p>${escapeHtml(text)}</p></div>`;
  const telegramHtml = `<b>${escapeTelegramHtml(subject)}</b>\n${escapeTelegramHtml(text)}`;
  return { kind: 'test', subject, text, html, telegramHtml };
}

async function record(stores: Stores, projectId: string, jobId: string | null, channel: 'email' | 'telegram', kind: string, status: 'sent' | 'failed' | 'dry-run', error: string | null): Promise<void> {
  await stores.notifications.insert({ projectId, jobId, channel, kind, status, error });
}

function skip(env: NotifyEnv, channel: 'email' | 'telegram', reason: string): ChannelResult {
  const key = `${channel}:${reason}`;
  if (!skippedLogged.has(key)) {
    skippedLogged.add(key);
    (env.log ?? console.log)(`notify skip ${channel}: ${reason}`);
  }
  return { status: 'skipped', error: reason };
}

async function deliver(env: NotifyEnv, stores: Stores, project: Project, jobId: string | null, message: Outbound): Promise<{ email: ChannelResult; telegram: ChannelResult }> {
  const log = env.log ?? console.log;
  const fetchImpl = env.fetchImpl ?? fetch;
  const emailTo = (project.notifyEmail ?? '').trim() || env.notifyEmailDefault;
  const chat = (project.telegramChatId ?? '').trim() || env.telegramChatId;

  const email = await (async (): Promise<ChannelResult> => {
    if (!emailTo) return skip(env, 'email', 'recipient missing');
    if (!env.dryRun && !env.resendApiKey) return skip(env, 'email', 'RESEND_API_KEY missing');
    if (!env.dryRun && !env.emailFrom) return skip(env, 'email', 'EMAIL_FROM missing');
    if (env.dryRun) {
      log(`notify dry-run channel=email kind=${message.kind} subject=${JSON.stringify(message.subject)} attachment=${message.pdf ? 'yes' : 'no'}`);
      await record(stores, project.id, jobId, 'email', message.kind, 'dry-run', null);
      return { status: 'dry-run' };
    }
    try {
      await sendEmail({ apiKey: env.resendApiKey, from: env.emailFrom, to: emailTo, subject: message.subject, html: message.html, text: message.text, pdf: message.pdf, fetchImpl });
      await record(stores, project.id, jobId, 'email', message.kind, 'sent', null);
      return { status: 'sent' };
    } catch (err) {
      const error = err instanceof Error && (/^HTTP \d+$/.test(err.message) || err.message === 'network error') ? err.message : 'network error';
      await record(stores, project.id, jobId, 'email', message.kind, 'failed', error);
      return { status: 'failed', error };
    }
  })();

  const telegram = await (async (): Promise<ChannelResult> => {
    if (!chat) return skip(env, 'telegram', 'recipient missing');
    if (!env.dryRun && !env.telegramBotToken) return skip(env, 'telegram', 'TELEGRAM_BOT_TOKEN missing');
    if (env.dryRun) {
      log(`notify dry-run channel=telegram kind=${message.kind} subject=${JSON.stringify(message.subject)} attachment=${message.pdf ? 'yes' : 'no'}`);
      await record(stores, project.id, jobId, 'telegram', message.kind, 'dry-run', null);
      return { status: 'dry-run' };
    }
    try {
      await sendTelegram({ token: env.telegramBotToken, chatId: chat, html: message.telegramHtml, pdf: message.pdf, fetchImpl });
      await record(stores, project.id, jobId, 'telegram', message.kind, 'sent', null);
      return { status: 'sent' };
    } catch (err) {
      const error = err instanceof Error && (/^HTTP \d+$/.test(err.message) || err.message === 'network error') ? err.message : 'network error';
      await record(stores, project.id, jobId, 'telegram', message.kind, 'failed', error);
      return { status: 'failed', error };
    }
  })();

  return { email, telegram };
}

export async function sendNotification(env: NotifyEnv, stores: Stores, project: Project, jobId: string | null, message: Outbound): Promise<{ email: ChannelResult; telegram: ChannelResult }> {
  try {
    return await deliver(env, stores, project, jobId, message);
  } catch (err) {
    const error = err instanceof Error ? 'notification failed' : 'notification failed';
    return { email: { status: 'failed', error }, telegram: { status: 'failed', error } };
  }
}

function keptCount(payload: unknown): number {
  const ledger = payload && typeof payload === 'object' ? (payload as { ledger?: { steps?: Array<{ status?: string }> } }).ledger : undefined;
  return (ledger?.steps ?? []).filter((step) => step.status === 'kept').length;
}

export async function notifyJobOutcome(env: NotifyEnv, stores: Stores, input: { project: Project; job: Job; status: string; payload: unknown; pdf?: Buffer | null }): Promise<void> {
  try {
    if (input.status === 'cancelled') return;
    const payload = input.payload && typeof input.payload === 'object' ? input.payload as { ok?: boolean; error?: unknown; prUrl?: unknown; ledger?: unknown } : {};
    if (input.status === 'failed' || payload.ok === false) {
      const raw = typeof payload.error === 'string' ? payload.error : input.job.error ?? 'job failed';
      await deliver(env, stores, input.project, input.job.id, failureMessage(input.project, input.job.id, raw.slice(0, 500), env.clientOrigin));
      return;
    }
    const prUrl = typeof payload.prUrl === 'string' ? payload.prUrl : '';
    if (input.job.type === 'optimize' && input.status === 'succeeded' && prUrl.startsWith('https://')) {
      const message = prMessage(input.project, keptCount(payload), payload.ledger, prUrl);
      if (input.pdf) message.pdf = input.pdf;
      await deliver(env, stores, input.project, input.job.id, message);
    }
  } catch {
    /* a notification must not change the job */
  }
}
