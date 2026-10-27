import { chromium } from 'playwright';

export interface LayoutShiftSource {
  selector?: string;
  previousRect?: { width?: number; height?: number; top?: number; y?: number };
  currentRect?: { width?: number; height?: number; top?: number; y?: number };
}

export interface LayoutShiftEntry {
  value?: number;
  hadRecentInput?: boolean;
  startTime?: number;
  sources?: LayoutShiftSource[];
}

export interface LayoutCulprit {
  selector: string;
  beforeWidth: number;
  beforeHeight: number;
  afterWidth: number;
  afterHeight: number;
  cls: number;
}

/** An element node added after DOMContentLoaded. */
export interface InsertedElement {
  selector: string;
  parentSelector: string;
  index: number;
  tag: string;
  classList: string[];
  outerHtml: string;
  top: number;
  height: number;
  position: string;
  insertedAt: number;
}

/** A node that a layout-shift entry moved. */
export interface ShiftVictim {
  selector: string;
  top: number;
  height: number;
  cls: number;
}

export interface LayoutShiftReport {
  totalCls: number;
  culprits: LayoutCulprit[];
  causes: InsertedElement[];
  victims: ShiftVictim[];
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function rectTop(rect: { top?: number; y?: number } | undefined): number {
  if (!rect) return 0;
  if (typeof rect.top === 'number' && Number.isFinite(rect.top)) return rect.top;
  if (typeof rect.y === 'number' && Number.isFinite(rect.y)) return rect.y;
  return 0;
}

/** Turns PerformanceObserver layout-shift entries into culprit rows. Recent-input shifts are ignored. */
export function parseLayoutShifts(entries: unknown): { totalCls: number; culprits: LayoutCulprit[] } {
  const list = Array.isArray(entries) ? entries : [];
  const bySelector = new Map<string, LayoutCulprit>();
  let totalCls = 0;
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as LayoutShiftEntry;
    if (entry.hadRecentInput) continue;
    const value = num(entry.value);
    totalCls += value;
    for (const source of entry.sources ?? []) {
      const selector = typeof source?.selector === 'string' && source.selector.trim() ? source.selector.trim() : '(unknown)';
      const previous = bySelector.get(selector);
      const beforeWidth = num(source.previousRect?.width);
      const beforeHeight = num(source.previousRect?.height);
      const afterWidth = num(source.currentRect?.width);
      const afterHeight = num(source.currentRect?.height);
      if (previous) {
        previous.cls += value;
        previous.afterWidth = afterWidth;
        previous.afterHeight = afterHeight;
      } else {
        bySelector.set(selector, { selector, beforeWidth, beforeHeight, afterWidth, afterHeight, cls: value });
      }
    }
  }
  const culprits = [...bySelector.values()].sort((a, b) => b.cls - a.cls);
  return { totalCls, culprits };
}

function asInsertion(raw: unknown): InsertedElement | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Partial<InsertedElement>;
  const selector = text(row.selector).trim();
  if (!selector) return null;
  const classList = Array.isArray(row.classList) ? row.classList.map((item) => text(item)).filter(Boolean).slice(0, 8) : [];
  return {
    selector,
    parentSelector: text(row.parentSelector).trim() || '(unknown)',
    index: Number.isInteger(row.index) ? Number(row.index) : num(row.index),
    tag: text(row.tag).toLowerCase() || 'div',
    classList,
    outerHtml: text(row.outerHtml).slice(0, 300),
    top: num(row.top),
    height: num(row.height),
    position: text(row.position) || 'static',
    insertedAt: num(row.insertedAt),
  };
}

function victimBox(source: LayoutShiftSource): { top: number; height: number } {
  const current = source.currentRect;
  const previous = source.previousRect;
  const rect = current && (current.height || current.top != null || current.y != null) ? current : previous;
  return { top: rectTop(rect), height: num(rect?.height) };
}

/** The inserted box ends above the victim, or the two vertical ranges meet or overlap. */
export function sitsAboveOrBeside(cause: { top: number; height: number }, victim: { top: number; height: number }): boolean {
  const causeBottom = cause.top + Math.max(cause.height, 0);
  const victimBottom = victim.top + Math.max(victim.height, 0);
  const above = cause.top <= victim.top && causeBottom <= victim.top + 2;
  const overlap = cause.top < victimBottom + 2 && victim.top < causeBottom + 2;
  return above || overlap;
}

/**
 * Causes are late insertions that happened within 300 ms before a shift and sit above or beside
 * a shifted node. Victims are the shifted nodes. Recent-input shifts are ignored.
 */
export function classifyLayoutShift(insertions: unknown, shifts: unknown): { causes: InsertedElement[]; victims: ShiftVictim[] } {
  const added = (Array.isArray(insertions) ? insertions : []).map(asInsertion).filter((item): item is InsertedElement => item !== null);
  const list = Array.isArray(shifts) ? shifts : [];
  const victims = new Map<string, ShiftVictim>();
  const causeKeys = new Set<string>();
  const causes: InsertedElement[] = [];

  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as LayoutShiftEntry;
    if (entry.hadRecentInput) continue;
    const value = num(entry.value);
    const start = num(entry.startTime);
    const sources = entry.sources ?? [];
    for (const source of sources) {
      const selector = text(source?.selector).trim() || '(unknown)';
      const box = victimBox(source);
      const previous = victims.get(selector);
      if (previous) {
        previous.cls += value;
        previous.top = box.top;
        previous.height = box.height;
      } else {
        victims.set(selector, { selector, top: box.top, height: box.height, cls: value });
      }
    }
    for (const insertion of added) {
      const delta = start - insertion.insertedAt;
      if (delta < 0 || delta > 300) continue;
      const related = sources.some((source) => sitsAboveOrBeside(insertion, victimBox(source)));
      if (!related) continue;
      const key = `${insertion.selector}|${insertion.insertedAt}|${insertion.index}`;
      if (causeKeys.has(key)) continue;
      causeKeys.add(key);
      causes.push(insertion);
    }
  }

  return {
    causes,
    victims: [...victims.values()].sort((a, b) => b.cls - a.cls),
  };
}

export function isBodyFirstChild(cause: InsertedElement): boolean {
  const parent = cause.parentSelector.toLowerCase().replace(/\s+/g, ' ').trim();
  const body = parent === 'body' || parent.endsWith('> body') || parent.endsWith(' body');
  return body && cause.index === 0 && cause.height > 0 && cause.tag !== 'script' && cause.tag !== 'style';
}

/** The late insertion a deterministic slot should reserve, when the pattern matches. */
export function bodyBannerCause(report: Pick<LayoutShiftReport, 'causes'>): InsertedElement | null {
  const matches = (report.causes ?? []).filter(isBodyFirstChild).sort((a, b) => b.height - a.height);
  return matches[0] ?? null;
}

export function manualFixSuggestion(report: Pick<LayoutShiftReport, 'causes' | 'culprits'> | null): string {
  if (!report) return '';
  const cause = [...(report.causes ?? [])].sort((a, b) => b.height - a.height)[0];
  const culprit = report.culprits?.[0];
  const selector = cause?.selector || culprit?.selector;
  const height = cause?.height || culprit?.afterHeight || 0;
  if (!selector || height <= 0) return '';
  return `Manual fix suggested: ${selector}, measured height ${Math.ceil(height)} px, reserve this space or make it out-of-flow`;
}

const PROBE = `(() => {
  const shifts = [];
  const insertions = [];
  let domReadyAt = document.readyState === 'loading' ? null : performance.now();
  function selectorFor(node) {
    if (!node || node.nodeType !== 1) return '';
    const parts = [];
    let el = node;
    while (el && el.nodeType === 1 && parts.length < 4) {
      if (el.id) {
        parts.unshift('#' + CSS.escape(el.id));
        break;
      }
      let part = el.tagName.toLowerCase();
      const cls = typeof el.className === 'string' ? el.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2) : [];
      if (cls.length) part += cls.map((name) => '.' + CSS.escape(name)).join('');
      parts.unshift(part);
      el = el.parentElement;
    }
    return parts.join(' > ');
  }
  function remember(el) {
    if (!el || el.nodeType !== 1) return;
    const insertedAt = performance.now();
    const parent = el.parentElement;
    const index = parent ? Array.prototype.indexOf.call(parent.children, el) : 0;
    const classes = typeof el.className === 'string' ? el.className.trim().split(/\\s+/).filter(Boolean).slice(0, 8) : [];
    const outer = (el.outerHTML || '').slice(0, 300);
    const snap = () => {
      if (!el.isConnected) return;
      const rect = el.getBoundingClientRect();
      let position = 'static';
      try { position = getComputedStyle(el).position || 'static'; } catch (err) { position = 'static'; }
      insertions.push({
        selector: selectorFor(el),
        parentSelector: selectorFor(parent),
        index,
        tag: el.tagName.toLowerCase(),
        classList: classes,
        outerHtml: outer,
        top: rect.top,
        height: rect.height,
        position,
        insertedAt,
      });
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(snap);
    else snap();
  }
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const sources = (entry.sources || []).map((source) => ({
          selector: selectorFor(source.node),
          previousRect: source.previousRect ? { width: source.previousRect.width, height: source.previousRect.height, top: source.previousRect.y } : undefined,
          currentRect: source.currentRect ? { width: source.currentRect.width, height: source.currentRect.height, top: source.currentRect.y } : undefined,
        }));
        shifts.push({ value: entry.value, hadRecentInput: entry.hadRecentInput, startTime: entry.startTime, sources });
      }
    });
    observer.observe({ type: 'layout-shift', buffered: true });
  } catch (err) { /* the browser has no layout-shift observer */ }
  try {
    const mo = new MutationObserver((mutations) => {
      if (domReadyAt == null) return;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!node || node.nodeType !== 1) continue;
          if (performance.now() < domReadyAt) continue;
          remember(node);
          if (node.querySelectorAll) node.querySelectorAll('*').forEach(remember);
        }
      }
    });
    const root = document.documentElement || document;
    mo.observe(root, { childList: true, subtree: true });
  } catch (err) { /* mutations are not observable */ }
  if (domReadyAt == null) {
    document.addEventListener('DOMContentLoaded', () => { domReadyAt = performance.now(); }, { once: true });
  }
  window.__perfpilotShifts = shifts;
  window.__perfpilotInsertions = insertions;
})();`;

/** Loads the URL, waits 3 seconds, and does not scroll. */
export async function probeLayoutShifts(url: string): Promise<LayoutShiftReport> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 412, height: 823 } });
    await page.addInitScript(PROBE);
    await page.goto(url, { waitUntil: 'load', timeout: 20_000 });
    await page.waitForTimeout(3000);
    const raw = await page.evaluate(() => {
      const view = window as unknown as { __perfpilotShifts?: unknown; __perfpilotInsertions?: unknown };
      return { shifts: view.__perfpilotShifts ?? [], insertions: view.__perfpilotInsertions ?? [] };
    });
    const parsed = parseLayoutShifts(raw.shifts);
    const classified = classifyLayoutShift(raw.insertions, raw.shifts);
    return { ...parsed, causes: classified.causes, victims: classified.victims };
  } finally {
    await browser.close();
  }
}
