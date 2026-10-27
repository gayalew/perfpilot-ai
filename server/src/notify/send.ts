export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 15_000;

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Telegram HTML parse mode. Only &, <, and > are escaped. */
export function escapeTelegramHtml(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function safeFailure(status: number | null): Error {
  return new Error(status == null ? 'network error' : `HTTP ${status}`);
}

/** One extra try on 429, 5xx, or a network error. The thrown message is only "HTTP n" or "network error". */
export async function withRetry(run: () => Promise<Response>): Promise<void> {
  let failure = safeFailure(null);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await run();
      if (res.ok) return;
      failure = safeFailure(res.status);
      if (res.status !== 429 && res.status < 500) throw failure;
    } catch (err) {
      if (err instanceof Error && /^HTTP \d+$/.test(err.message)) throw err;
      failure = safeFailure(null);
    }
    if (attempt === 0) continue;
  }
  throw failure;
}

export interface MailInput {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  pdf?: Buffer;
  fetchImpl: FetchLike;
}

export async function sendEmail(input: MailInput): Promise<void> {
  const body: Record<string, unknown> = {
    from: input.from,
    to: [input.to],
    subject: input.subject,
    html: input.html,
    text: input.text,
  };
  if (input.pdf) {
    body.attachments = [{ filename: 'report.pdf', content: input.pdf.toString('base64') }];
  }
  await withRetry(() => input.fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }));
}

export interface TelegramInput {
  token: string;
  chatId: string;
  html: string;
  pdf?: Buffer;
  fetchImpl: FetchLike;
}

export async function sendTelegram(input: TelegramInput): Promise<void> {
  const base = `https://api.telegram.org/bot${input.token}`;
  await withRetry(() => input.fetchImpl(`${base}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: input.chatId, text: input.html, parse_mode: 'HTML' }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }));
  if (!input.pdf) return;
  const form = new FormData();
  form.set('chat_id', input.chatId);
  form.set('caption', input.html.slice(0, 1000));
  form.set('parse_mode', 'HTML');
  form.set('document', new Blob([Uint8Array.from(input.pdf)], { type: 'application/pdf' }), 'report.pdf');
  await withRetry(() => input.fetchImpl(`${base}/sendDocument`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }));
}
