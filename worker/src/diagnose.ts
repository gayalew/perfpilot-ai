import type { LhrLike } from './metrics.js';

/**
 * Fix catalog. Each fix is a known, reversible kind of change that PerfPilot knows how to apply
 * and verify. Diagnosis maps Lighthouse audits to these ids; Phase 3 implements the appliers.
 */
export type FixId =
  | 'compress-text'
  | 'cache-headers'
  | 'defer-scripts'
  | 'inline-or-async-css'
  | 'optimize-images'
  | 'lazy-load-images'
  | 'image-dimensions'
  | 'preload-lcp-image'
  | 'reserve-space'
  | 'minify-assets'
  | 'remove-unused-code'
  | 'split-long-tasks'
  | 'preconnect'
  | 'reduce-dom';

export interface FixInfo {
  id: FixId;
  title: string;
  /** Short description used in prompts, PR text and reports. */
  summary: string;
  /** Whether it can be tested at runtime without repo access (request interception experiment). */
  runtimeTestable: boolean;
  /** Rough risk if applied wrongly. The executor runs the visual gate on every change regardless. */
  risk: 'low' | 'medium' | 'high';
}

export const FIX_CATALOG: Record<FixId, FixInfo> = {
  'compress-text': { id: 'compress-text', title: 'Enable gzip/brotli compression', summary: 'Compress HTML, CSS and JS responses.', runtimeTestable: true, risk: 'low' },
  'cache-headers': { id: 'cache-headers', title: 'Add long-lived cache headers for static assets', summary: 'Serve static files with Cache-Control so repeat visits skip the network.', runtimeTestable: false, risk: 'low' },
  'defer-scripts': { id: 'defer-scripts', title: 'Defer render-blocking scripts', summary: 'Add defer (or async) to scripts in the head so they stop blocking first paint.', runtimeTestable: true, risk: 'medium' },
  'inline-or-async-css': { id: 'inline-or-async-css', title: 'Stop stylesheets blocking render', summary: 'Merge small stylesheets and load non-critical CSS without blocking.', runtimeTestable: true, risk: 'medium' },
  'optimize-images': { id: 'optimize-images', title: 'Resize and recompress images (WebP/AVIF)', summary: 'Serve images at display size in a modern format.', runtimeTestable: true, risk: 'medium' },
  'lazy-load-images': { id: 'lazy-load-images', title: 'Lazy-load below-the-fold images', summary: 'Add loading="lazy" to images that are not visible on first paint.', runtimeTestable: true, risk: 'low' },
  'image-dimensions': { id: 'image-dimensions', title: 'Set width and height on images', summary: 'Reserve space for images so the layout does not jump.', runtimeTestable: true, risk: 'low' },
  'preload-lcp-image': { id: 'preload-lcp-image', title: 'Prioritize the main image', summary: 'Preload the Largest Contentful Paint image and mark it fetchpriority=high.', runtimeTestable: true, risk: 'low' },
  'reserve-space': { id: 'reserve-space', title: 'Reserve space for late-inserted content', summary: 'Give late-appearing elements (banners, embeds) a fixed slot so they do not push content.', runtimeTestable: false, risk: 'medium' },
  'minify-assets': { id: 'minify-assets', title: 'Minify JavaScript and CSS', summary: 'Strip whitespace and comments from shipped assets.', runtimeTestable: false, risk: 'low' },
  'remove-unused-code': { id: 'remove-unused-code', title: 'Remove or split unused code', summary: 'Drop code the page never runs, or load it only when needed.', runtimeTestable: false, risk: 'high' },
  'split-long-tasks': { id: 'split-long-tasks', title: 'Break up long main-thread tasks', summary: 'Defer or chunk heavy startup work so the page stays responsive.', runtimeTestable: false, risk: 'high' },
  preconnect: { id: 'preconnect', title: 'Preconnect to required origins', summary: 'Open connections early to third-party origins the page needs.', runtimeTestable: true, risk: 'low' },
  'reduce-dom': { id: 'reduce-dom', title: 'Reduce DOM size', summary: 'Simplify the page structure.', runtimeTestable: false, risk: 'high' },
};

export interface FindingItem {
  url?: string;
  detail?: string;
  wastedBytes?: number;
  wastedMs?: number;
}

export interface Finding {
  auditId: string;
  title: string;
  description?: string;
  fix: FixId;
  /** Estimated time saving in ms (Lighthouse's own estimate), 0 when unknown. */
  savingsMs: number;
  /** Estimated byte saving, 0 when unknown. */
  savingsBytes: number;
  /** Which user-visible metrics this should help. */
  metrics: string[];
  items: FindingItem[];
  /** Deterministic priority used when no model is available. Higher is more important. */
  priority: number;
}

interface AuditDef {
  fix: FixId;
  metrics: string[];
  /** Extra priority weight, for audits that matter more than their raw savings suggest. */
  weight?: number;
}

/** Lighthouse audit id -> fix and affected metrics. */
const AUDITS: Record<string, AuditDef> = {
  'render-blocking-resources': { fix: 'defer-scripts', metrics: ['fcp', 'lcp'], weight: 1.2 },
  'uses-text-compression': { fix: 'compress-text', metrics: ['fcp', 'lcp'] },
  'uses-long-cache-ttl': { fix: 'cache-headers', metrics: [], weight: 0.3 },
  'uses-optimized-images': { fix: 'optimize-images', metrics: ['lcp'] },
  'modern-image-formats': { fix: 'optimize-images', metrics: ['lcp'] },
  'uses-responsive-images': { fix: 'optimize-images', metrics: ['lcp'] },
  'offscreen-images': { fix: 'lazy-load-images', metrics: ['lcp', 'speedIndex'] },
  'unsized-images': { fix: 'image-dimensions', metrics: ['cls'], weight: 1.5 },
  'layout-shifts': { fix: 'reserve-space', metrics: ['cls'], weight: 1.5 },
  'layout-shift-elements': { fix: 'reserve-space', metrics: ['cls'], weight: 1.5 },
  'prioritize-lcp-image': { fix: 'preload-lcp-image', metrics: ['lcp'], weight: 1.2 },
  'lcp-lazy-loaded': { fix: 'preload-lcp-image', metrics: ['lcp'], weight: 1.2 },
  'unminified-javascript': { fix: 'minify-assets', metrics: ['fcp', 'tbt'] },
  'unminified-css': { fix: 'minify-assets', metrics: ['fcp'] },
  'unused-javascript': { fix: 'remove-unused-code', metrics: ['lcp', 'tbt'] },
  'unused-css-rules': { fix: 'remove-unused-code', metrics: ['fcp'] },
  'long-tasks': { fix: 'split-long-tasks', metrics: ['tbt'], weight: 1.2 },
  'mainthread-work-breakdown': { fix: 'split-long-tasks', metrics: ['tbt'], weight: 0.8 },
  'bootup-time': { fix: 'split-long-tasks', metrics: ['tbt'], weight: 0.8 },
  'uses-rel-preconnect': { fix: 'preconnect', metrics: ['fcp', 'lcp'] },
  'dom-size': { fix: 'reduce-dom', metrics: ['tbt'], weight: 0.3 },
};

interface DetailsLike {
  type?: string;
  items?: Array<Record<string, unknown>>;
  overallSavingsMs?: number;
  overallSavingsBytes?: number;
}

interface AuditData {
  id?: string;
  title?: string;
  description?: string;
  score?: number | null;
  scoreDisplayMode?: string;
  numericValue?: number;
  details?: DetailsLike;
  metricSavings?: Record<string, number>;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function itemOf(raw: Record<string, unknown>): FindingItem {
  const node = raw.node as { selector?: string; snippet?: string } | undefined;
  const detail = node?.selector ?? node?.snippet ?? (typeof raw.label === 'string' ? raw.label : undefined) ?? (typeof raw.name === 'string' ? raw.name : undefined);
  return {
    url: typeof raw.url === 'string' ? raw.url : undefined,
    detail,
    wastedBytes: num(raw.wastedBytes ?? raw.totalBytes) || undefined,
    wastedMs: num(raw.wastedMs) || undefined,
  };
}

/** Plain text of a Lighthouse description, with markdown links removed. */
function cleanDescription(text?: string): string | undefined {
  return text?.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').trim();
}

/** Audits that did not pass and map to a known fix. */
export function extractFindings(lhr: LhrLike): Finding[] {
  const audits = (lhr.audits ?? {}) as Record<string, AuditData | undefined>;
  const findings: Finding[] = [];

  for (const [id, def] of Object.entries(AUDITS)) {
    const audit = audits[id];
    if (!audit) continue;
    const mode = audit.scoreDisplayMode;
    if (mode === 'notApplicable' || mode === 'manual' || mode === 'error') continue;
    // Opportunities pass with score 1; informational audits have no score, so use their details instead.
    const items = audit.details?.items ?? [];
    const failed = typeof audit.score === 'number' ? audit.score < 0.9 : items.length > 0;
    if (!failed || items.length === 0 && !audit.details?.overallSavingsMs) continue;

    const savingsMs =
      num(audit.details?.overallSavingsMs) ||
      Math.max(...Object.values(audit.metricSavings ?? { x: 0 }).map(num), 0) ||
      (mode === 'metricSavings' ? 0 : num(audit.numericValue));
    const savingsBytes = num(audit.details?.overallSavingsBytes);

    findings.push({
      auditId: id,
      title: audit.title ?? id,
      description: cleanDescription(audit.description),
      fix: def.fix,
      savingsMs: Math.round(savingsMs),
      savingsBytes: Math.round(savingsBytes),
      metrics: def.metrics,
      items: items.slice(0, 6).map(itemOf),
      priority: 0,
    });
    findings[findings.length - 1].priority = scoreFinding(findings[findings.length - 1], def.weight ?? 1);
  }
  return mergeByFix(findings).sort((a, b) => b.priority - a.priority);
}

/** Time saving counts most; bytes are a weaker signal (1 MB ~ 1 s on slow 4G). */
function scoreFinding(f: Finding, weight: number): number {
  const byteMs = f.savingsBytes / 1024 / 1.6; // ~1.6 Mbps simulated link
  const base = Math.max(f.savingsMs, byteMs * 0.5, 50);
  return Math.round(base * weight);
}

/**
 * Several audits can point at the same fix (for example three image audits all lead to
 * optimize-images). Keep one finding per fix: the one with the highest priority absorbs the others.
 */
export function mergeByFix(findings: Finding[]): Finding[] {
  const byFix = new Map<FixId, Finding>();
  for (const f of findings) {
    const existing = byFix.get(f.fix);
    if (!existing) {
      byFix.set(f.fix, { ...f, items: [...f.items] });
      continue;
    }
    const winner = f.priority > existing.priority ? f : existing;
    const merged: Finding = {
      ...winner,
      savingsMs: Math.max(existing.savingsMs, f.savingsMs),
      savingsBytes: Math.max(existing.savingsBytes, f.savingsBytes),
      metrics: [...new Set([...existing.metrics, ...f.metrics])],
      items: dedupeItems([...existing.items, ...f.items]).slice(0, 6),
      priority: Math.max(existing.priority, f.priority),
    };
    byFix.set(f.fix, merged);
  }
  return [...byFix.values()];
}

function dedupeItems(items: FindingItem[]): FindingItem[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const key = `${i.url ?? ''}|${i.detail ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface Plan {
  source: 'gemini' | 'heuristic';
  /** Ordered list of fixes to try, best first. */
  steps: PlanStep[];
  /** Why the model could not be used, when source is "heuristic" because of a failure. */
  note?: string;
}

export interface PlanStep {
  fix: FixId;
  auditId: string;
  rationale: string;
  expectedImpact: string;
  /** Position in the plan, starting at 1. */
  order: number;
}

export function heuristicPlan(findings: Finding[], limit = 12, note?: string): Plan {
  const steps = findings.slice(0, limit).map((f, i) => ({
    fix: f.fix,
    auditId: f.auditId,
    rationale: describeSavings(f),
    expectedImpact: f.metrics.length ? `Should improve ${f.metrics.join(', ')}.` : 'Mostly helps repeat visits and total load.',
    order: i + 1,
  }));
  return { source: 'heuristic', steps, note };
}

function describeSavings(f: Finding): string {
  const parts: string[] = [];
  if (f.savingsMs) parts.push(`about ${f.savingsMs} ms`);
  if (f.savingsBytes) parts.push(`${Math.round(f.savingsBytes / 1024)} KB`);
  return parts.length ? `${f.title}: Lighthouse estimates ${parts.join(' and ')} could be saved.` : `${f.title}.`;
}
