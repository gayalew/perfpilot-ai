import path from 'node:path';
import type { SiteConfig } from '../config.js';
import { publicRoot, readText, relativeTo, walkFiles, writeIfChanged } from './files.js';
import type { InsertedElement } from './layout-shift.js';
import type { ApplyResult } from './types.js';

function slotHtml(height: number): string {
  return `<div class="pp-slot" aria-hidden="true" style="height:${height}px"></div>`;
}

/** Inserts the reserved slot as the first child of body. Leaves every other node alone. */
export function insertBodySlot(html: string, height: number): string {
  if (/class=["']pp-slot["']/.test(html)) return html;
  const match = /<body\b[^>]*>/i.exec(html);
  if (!match || match.index == null) return html;
  const at = match.index + match[0].length;
  return `${html.slice(0, at)}${slotHtml(height)}${html.slice(at)}`;
}

export function appendSlotRule(css: string, selector: string, height: number): string {
  const rule = `${selector} { position:absolute; top:0; left:0; right:0; height:${height}px; }`;
  if (css.includes(rule)) return css;
  const trimmed = css.replace(/\s*$/, '');
  return `${trimmed}\n${rule}\n`;
}

function safeSelector(selector: string): boolean {
  return Boolean(selector) && !/[{}<>]/.test(selector) && selector.length <= 180;
}

function firstStylesheetHref(html: string): string | null {
  const pattern = /<link\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    const tag = match[0];
    if (!/rel\s*=\s*["']stylesheet["']/i.test(tag)) continue;
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag);
    const value = href?.[1] ?? '';
    if (!value || value.startsWith('http:') || value.startsWith('https:') || value.startsWith('//')) continue;
    return value;
  }
  return null;
}

function linkFixes(html: string): string {
  if (html.includes('perfpilot-fixes.css')) return html;
  const link = '<link rel="stylesheet" href="/perfpilot-fixes.css">';
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${link}</head>`);
  return html;
}

/**
 * Reserves the measured height of a banner that is inserted as the first child of body,
 * and takes that banner out of flow so the rest of the page stays where the slot put it.
 */
export async function applyBodyBannerSlot(dir: string, config: SiteConfig, cause: InsertedElement): Promise<ApplyResult> {
  if (!safeSelector(cause.selector)) {
    return { applied: false, changedFiles: [], description: '', skippedReason: 'culprit selector is not safe to write into CSS' };
  }
  const height = Math.ceil(cause.height);
  const root = publicRoot(dir, config);
  const htmlFiles = await walkFiles(root, ['.html']);
  if (htmlFiles.length === 0) {
    return { applied: false, changedFiles: [], description: '', skippedReason: 'no HTML file serves the page' };
  }
  const changed: string[] = [];
  let stylesheet: string | null = null;
  for (const file of htmlFiles) {
    const before = await readText(file);
    if (before === undefined || !/<body\b/i.test(before)) continue;
    const href = firstStylesheetHref(before);
    if (!stylesheet && href) {
      const rel = href.replace(/^\/+/, '');
      const full = path.resolve(root, rel);
      const relative = path.relative(root, full);
      if (!relative.startsWith('..') && !path.isAbsolute(relative)) stylesheet = full;
    }
    const next = insertBodySlot(before, height);
    if (await writeIfChanged(file, before, next)) changed.push(relativeTo(dir, file));
  }
  if (!stylesheet) {
    const created = path.join(root, 'perfpilot-fixes.css');
    stylesheet = created;
    for (const file of htmlFiles) {
      const before = await readText(file);
      if (before === undefined || !/<body\b/i.test(before)) continue;
      const next = linkFixes(before);
      if (await writeIfChanged(file, before, next)) {
        const rel = relativeTo(dir, file);
        if (!changed.includes(rel)) changed.push(rel);
      }
    }
  }
  const cssBefore = (await readText(stylesheet)) ?? '';
  const cssNext = appendSlotRule(cssBefore, cause.selector, height);
  if (await writeIfChanged(stylesheet, cssBefore, cssNext)) changed.push(relativeTo(dir, stylesheet));
  if (changed.length === 0) {
    return { applied: false, changedFiles: [], description: '', skippedReason: 'slot was already reserved' };
  }
  return {
    applied: true,
    changedFiles: changed,
    description: `Reserved ${height}px for ${cause.selector} and took it out of flow`,
  };
}
