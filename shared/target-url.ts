import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const MAX_LENGTH = 2048;

const alwaysBlocked = new BlockList();
alwaysBlocked.addSubnet('169.254.0.0', 16, 'ipv4');
alwaysBlocked.addAddress('fd00:ec2::254', 'ipv6');

const privateRanges = new BlockList();
privateRanges.addSubnet('10.0.0.0', 8, 'ipv4');
privateRanges.addSubnet('172.16.0.0', 12, 'ipv4');
privateRanges.addSubnet('192.168.0.0', 16, 'ipv4');
privateRanges.addSubnet('127.0.0.0', 8, 'ipv4');
privateRanges.addAddress('::1', 'ipv6');
privateRanges.addSubnet('fc00::', 7, 'ipv6');

export type AddressLookup = (hostname: string) => Promise<string[]>;

/** 1 allows private and loopback targets. Unset follows NODE_ENV: on outside production, off in production. */
export function privateTargetsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.ALLOW_PRIVATE_TARGETS ?? '').trim();
  if (raw === '1') return true;
  if (raw === '0') return false;
  return env.NODE_ENV !== 'production';
}

function listed(list: BlockList, ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 0) return false;
  return list.check(ip, kind === 6 ? 'ipv6' : 'ipv4');
}

function formsOf(ip: string): string[] {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return mapped?.[1] ? [ip, mapped[1]] : [ip];
}

function classOf(ip: string): 'metadata' | 'private' | 'public' {
  for (const form of formsOf(ip)) {
    if (listed(alwaysBlocked, form)) return 'metadata';
  }
  for (const form of formsOf(ip)) {
    if (listed(privateRanges, form)) return 'private';
  }
  return 'public';
}

async function defaultLookup(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

/**
 * Returns a short error, or null when the URL may be measured.
 * Link-local and cloud-metadata targets are always rejected.
 * A hostname is checked against every address from dns.lookup. A later change of that name (DNS rebinding) is not watched.
 */
export async function targetUrlError(raw: string, options: { env?: NodeJS.ProcessEnv; lookup?: AddressLookup } = {}): Promise<string | null> {
  if (raw.length > MAX_LENGTH) return 'the URL is too long';
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return 'the URL is not valid';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'only http and https URLs are allowed';
  if (parsed.username || parsed.password) return 'the URL must not include credentials';
  const host = parsed.hostname.replace(/\.$/, '').toLowerCase();
  if (!host) return 'the URL is not valid';
  if (host === 'metadata.google.internal') return 'link-local and cloud metadata targets are not allowed';

  const addresses = isIP(host) ? [host] : await (options.lookup ?? defaultLookup)(host).catch(() => null);
  if (!addresses || addresses.length === 0) return 'the host did not resolve';
  let privateHit = false;
  for (const address of addresses) {
    const kind = classOf(address);
    if (kind === 'metadata') return 'link-local and cloud metadata targets are not allowed';
    if (kind === 'private') privateHit = true;
  }
  if (privateHit && !privateTargetsAllowed(options.env ?? process.env)) return 'private targets are not allowed';
  return null;
}
