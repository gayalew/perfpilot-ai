import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { chromium, type Browser, type Page } from 'playwright';
import * as cheerio from 'cheerio';
import type { FixId } from './diagnose.js';
import type { SiteConfig } from './config.js';
import { compareMeasurements, type Comparison } from './compare.js';
import { measureInterleaved, type Measurement } from './measure.js';
import { resolveChromePath } from './lighthouse-runner.js';
import { runCommand } from './site-runner.js';

export interface GateResult {
  name: 'build' | 'smoke' | 'visual' | 'performance';
  passed: boolean;
  details: string;
  ms: number;
  comparison?: Comparison;
}

export interface GateContext {
  baselineUrl: string;
  candidateUrl: string;
  candidateDir: string;
  config: SiteConfig;
  fix: FixId;
  runs: number;
  measureInterleaved?: typeof measureInterleaved;
  onGate?: (phase: 'start' | 'end', gate: GateResult['name'], result?: GateResult) => Promise<void> | void;
}

const ORDER: GateResult['name'][] = ['build', 'smoke', 'visual', 'performance'];

export function visualLimit(fix: FixId): number {
  if (fix === 'optimize-images') return 0.06;
  if (fix === 'reserve-space') return 0.1;
  return 0.03;
}

/** Pixel diff of the overlapping area, plus the relative height difference. */
export function screenshotDiffRatio(a: Buffer, b: Buffer): number {
  const left = PNG.sync.read(a);
  const right = PNG.sync.read(b);
  const width = Math.min(left.width, right.width);
  const height = Math.min(left.height, right.height);
  if (width === 0 || height === 0) return 1;
  const crop = (png: PNG) => {
    if (png.width === width && png.height === height) return png.data;
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      out.set(png.data.subarray(y * png.width * 4, y * png.width * 4 + width * 4), y * width * 4);
    }
    return out;
  };
  const mismatched = pixelmatch(crop(left), crop(right), null, width, height, { threshold: 0.1 });
  const pixelRatio = mismatched / (width * height);
  const heightRatio = Math.abs(left.height - right.height) / Math.max(left.height, right.height);
  return pixelRatio + heightRatio;
}

function notRun(name: GateResult['name']): GateResult {
  return { name, passed: false, details: 'not run', ms: 0 };
}

async function timed(name: GateResult['name'], fn: () => Promise<Omit<GateResult, 'name' | 'ms'>>): Promise<GateResult> {
  const started = Date.now();
  try {
    const result = await fn();
    return { name, ms: Date.now() - started, ...result };
  } catch (err) {
    return { name, passed: false, details: err instanceof Error ? err.message : String(err), ms: Date.now() - started };
  }
}

export async function runGates(ctx: GateContext): Promise<GateResult[]> {
  const results: GateResult[] = [];
  for (const name of ORDER) {
    await ctx.onGate?.('start', name);
    const result =
      name === 'build'
        ? await timed(name, () => buildGate(ctx))
        : name === 'smoke'
          ? await timed(name, () => smokeGate(ctx))
          : name === 'visual'
            ? await timed(name, () => visualGate(ctx))
            : await timed(name, () => performanceGate(ctx));
    results.push(result);
    await ctx.onGate?.('end', name, result);
    if (!result.passed) {
      for (const later of ORDER.slice(ORDER.indexOf(name) + 1)) results.push(notRun(later));
      break;
    }
  }
  return results;
}

async function buildGate(ctx: GateContext): Promise<Omit<GateResult, 'name' | 'ms'>> {
  if (!ctx.config.buildCommand.trim()) return { passed: true, details: 'no build command' };
  const built = await runCommand(ctx.config.buildCommand, ctx.candidateDir);
  if (built.code !== 0) return { passed: false, details: `build exited ${built.code}: ${built.output.slice(0, 300)}` };
  return { passed: true, details: 'build exited 0' };
}

function sameOriginRefs(html: string, pageUrl: string): string[] {
  const $ = cheerio.load(html);
  const origin = new URL(pageUrl).origin;
  const urls = new Set<string>();
  $('img[src], script[src], link[href], source[src]').each((_, element) => {
    const value = $(element).attr('src') ?? $(element).attr('href');
    if (!value || value.startsWith('data:') || value.startsWith('mailto:') || value.startsWith('#')) return;
    try {
      const absolute = new URL(value, pageUrl);
      if (absolute.origin === origin) urls.add(absolute.href);
    } catch {
      // Ignore unparseable references.
    }
  });
  return [...urls];
}

async function pageErrorCount(browser: Browser, url: string): Promise<number> {
  const page = await browser.newPage();
  let errors = 0;
  page.on('console', (message) => {
    if (message.type() === 'error') errors += 1;
  });
  page.on('pageerror', () => {
    errors += 1;
  });
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
  } finally {
    await page.close();
  }
  return errors;
}

async function smokeGate(ctx: GateContext): Promise<Omit<GateResult, 'name' | 'ms'>> {
  const failures: string[] = [];
  for (const entry of ctx.config.paths) {
    const url = new URL(entry, ctx.candidateUrl).href;
    const res = await fetch(url);
    if (res.status !== 200) {
      failures.push(`${entry} returned HTTP ${res.status}`);
      continue;
    }
    const html = await res.text();
    for (const asset of sameOriginRefs(html, url)) {
      const assetRes = await fetch(asset);
      if (assetRes.status !== 200 && assetRes.status !== 304) failures.push(`${asset} returned HTTP ${assetRes.status}`);
    }
  }
  if (failures.length) return { passed: false, details: failures.slice(0, 4).join('; ') };

  const executablePath = resolveChromePath();
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    ...(executablePath ? { executablePath } : {}),
  });
  try {
    const baselineErrors = await pageErrorCount(browser, new URL(ctx.config.paths[0] ?? '/', ctx.baselineUrl).href);
    const candidateErrors = await pageErrorCount(browser, new URL(ctx.config.paths[0] ?? '/', ctx.candidateUrl).href);
    if (candidateErrors > baselineErrors) {
      return { passed: false, details: `console errors ${candidateErrors} vs baseline ${baselineErrors}` };
    }
    return { passed: true, details: `pages and assets responded; console errors ${candidateErrors}` };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

const VIEWPORTS = [
  { name: '390x844', width: 390, height: 844 },
  { name: '1350x940', width: 1350, height: 940 },
];

async function prepare(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    for (let y = 0; y < height; y += window.innerHeight) {
      window.scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    window.scrollTo(0, 0);
    await Promise.all(
      [...document.images].map(async (img) => {
        if (!img.complete) {
          await new Promise<void>((resolve) => {
            img.addEventListener('load', () => resolve(), { once: true });
            img.addEventListener('error', () => resolve(), { once: true });
          });
        }
        if (img.naturalWidth > 0) {
          try {
            await img.decode();
          } catch {
            // A broken image has no pixels to wait for.
          }
        }
      }),
    );
    await document.fonts.ready;
  });
  await page.waitForTimeout(1500);
  await page.addStyleTag({
    content: '*,*::before,*::after{animation:none !important;transition:none !important;caret-color:transparent !important}',
  });
}

async function shoot(browser: Browser, url: string, width: number, height: number): Promise<Buffer> {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 45_000 });
    await prepare(page);
    return await page.screenshot({ fullPage: true, type: 'png', animations: 'disabled', timeout: 60_000 });
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function visualGate(ctx: GateContext): Promise<Omit<GateResult, 'name' | 'ms'>> {
  const limit = visualLimit(ctx.fix);
  const executablePath = resolveChromePath();
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    ...(executablePath ? { executablePath } : {}),
  });
  try {
    const notes: string[] = [];
    for (const viewport of VIEWPORTS) {
      const base = await shoot(browser, ctx.baselineUrl, viewport.width, viewport.height);
      const next = await shoot(browser, ctx.candidateUrl, viewport.width, viewport.height);
      const ratio = screenshotDiffRatio(base, next);
      notes.push(`${viewport.name} ${(ratio * 100).toFixed(2)}%`);
      if (ratio > limit) return { passed: false, details: `${notes.join(', ')} (limit ${(limit * 100).toFixed(0)}%)` };
    }
    return { passed: true, details: notes.join(', ') };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/** Passes only when the comparison verdict is improved. Unchanged is a failure. */
export function evaluatePerformance(baseline: Measurement, candidate: Measurement): Omit<GateResult, 'name' | 'ms'> {
  const comparison = compareMeasurements(baseline, candidate);
  const passed = comparison.verdict === 'improved';
  const details = passed ? comparison.summary : `${comparison.verdict}: ${comparison.summary}`;
  return { passed, details, comparison };
}

async function performanceGate(ctx: GateContext): Promise<Omit<GateResult, 'name' | 'ms'>> {
  const measure = ctx.measureInterleaved ?? measureInterleaved;
  try {
    const pair = await measure(ctx.baselineUrl, ctx.candidateUrl, { runs: ctx.runs, profile: 'mobile' });
    return evaluatePerformance(pair[0], pair[1]);
  } catch (err) {
    return { passed: false, details: err instanceof Error ? err.message : String(err) };
  }
}
