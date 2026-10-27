import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Finding } from '../diagnose.js';
import type { SiteConfig } from '../config.js';

export function publicRoot(dir: string, config: SiteConfig): string {
  return path.resolve(dir, config.publicDir);
}

export async function walkFiles(root: string, extensions: string[]): Promise<string[]> {
  const out: string[] = [];
  async function rec(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await rec(full);
      else if (extensions.includes(path.extname(entry.name).toLowerCase())) out.push(full);
    }
  }
  await rec(root);
  return out;
}

/** URL pathname such as /img/hero.png, or undefined for anything that is not a local path. */
export function pathnameOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = url.includes('://') ? new URL(url) : new URL(url, 'http://local.invalid');
    const pathname = decodeURIComponent(parsed.pathname);
    if (!pathname.startsWith('/') || pathname.includes('..')) return undefined;
    return pathname;
  } catch {
    return undefined;
  }
}

export function findingPaths(finding: Finding): string[] {
  const paths = new Set<string>();
  for (const item of finding.items) {
    const pathname = pathnameOf(item.url);
    if (pathname) paths.add(pathname);
  }
  return [...paths];
}

export function localFile(dir: string, config: SiteConfig, pathname: string): string {
  const rel = pathname.replace(/^\/+/, '');
  const root = publicRoot(dir, config);
  const full = path.resolve(root, rel);
  const relative = path.relative(root, full);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('path escapes publicDir');
  return full;
}

/** Replaces a public pathname in HTML and CSS, including the form without the leading slash. */
export function rewritePath(text: string, pathname: string, nextPathname: string): string {
  const from = pathname.replace(/^\/+/, '');
  const to = nextPathname.replace(/^\/+/, '');
  if (!from || from === to) return text;
  return text.split(from).join(to);
}

export async function writeIfChanged(file: string, before: string, after: string): Promise<boolean> {
  if (before === after) return false;
  await writeFile(file, after);
  return true;
}

export async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

export function relativeTo(dir: string, file: string): string {
  return path.relative(dir, file).split(path.sep).join('/');
}
