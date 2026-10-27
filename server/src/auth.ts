import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'pp_session';
const TWELVE_HOURS = 12 * 60 * 60 * 1000;

export function passwordsMatch(given: string, expected: string): boolean {
  const left = createHash('sha256').update(given).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}

export function signSession(secret: string, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ exp: now + TWELVE_HOURS })).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifySession(token: string, secret: string, now = Date.now()): boolean {
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return false;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { exp?: number };
    return typeof payload.exp === 'number' && payload.exp > now;
  } catch {
    return false;
  }
}

export class LoginLimiter {
  private hits = new Map<string, number[]>();

  constructor(private readonly limit = 5, private readonly windowMs = 15 * 60 * 1000) {}

  blocked(ip: string, now = Date.now()): boolean {
    const recent = (this.hits.get(ip) ?? []).filter((time) => now - time < this.windowMs);
    this.hits.set(ip, recent);
    return recent.length >= this.limit;
  }

  fail(ip: string, now = Date.now()): void {
    const recent = (this.hits.get(ip) ?? []).filter((time) => now - time < this.windowMs);
    recent.push(now);
    this.hits.set(ip, recent);
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}
