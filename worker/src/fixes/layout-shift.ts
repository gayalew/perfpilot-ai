import { chromium } from 'playwright';

export interface LayoutShiftSource {
  selector?: string;
  previousRect?: { width?: number; height?: number };
  currentRect?: { width?: number; height?: number };
}

export interface LayoutShiftEntry {
  value?: number;
  hadRecentInput?: boolean;
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

export interface LayoutShiftReport {
  totalCls: number;
  culprits: LayoutCulprit[];
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Turns PerformanceObserver layout-shift entries into culprit rows. Recent-input shifts are ignored. */
export function parseLayoutShifts(entries: unknown): LayoutShiftReport {
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

const PROBE = `(() => {
  const shifts = [];
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
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const sources = (entry.sources || []).map((source) => ({
          selector: selectorFor(source.node),
          previousRect: source.previousRect ? { width: source.previousRect.width, height: source.previousRect.height } : undefined,
          currentRect: source.currentRect ? { width: source.currentRect.width, height: source.currentRect.height } : undefined,
        }));
        shifts.push({ value: entry.value, hadRecentInput: entry.hadRecentInput, sources });
      }
    });
    observer.observe({ type: 'layout-shift', buffered: true });
  } catch (err) {
    /* the browser has no layout-shift observer */
  }
  window.__perfpilotShifts = shifts;
})();`;

/** Loads the URL, waits 3 seconds, and does not scroll. */
export async function probeLayoutShifts(url: string): Promise<LayoutShiftReport> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 412, height: 823 } });
    await page.addInitScript(PROBE);
    await page.goto(url, { waitUntil: 'load', timeout: 20_000 });
    await page.waitForTimeout(3000);
    const entries = await page.evaluate(() => (window as unknown as { __perfpilotShifts?: unknown }).__perfpilotShifts ?? []);
    return parseLayoutShifts(entries);
  } finally {
    await browser.close();
  }
}
