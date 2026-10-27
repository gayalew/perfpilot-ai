import { existsSync } from 'node:fs';
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import { chromium } from 'playwright';
import type { LhrLike } from './metrics.js';

/**
 * Device and network profiles. All of them use Lighthouse's simulated throttling, which is
 * much more repeatable than real network throttling.
 */
export type ProfileName = 'mobile' | 'slow-mobile' | 'desktop';

export const PROFILES: Record<ProfileName, { description: string; settings: Record<string, unknown> }> = {
  mobile: {
    description: 'Mobile, simulated slow 4G, 4x CPU slowdown (Lighthouse default)',
    settings: {
      formFactor: 'mobile',
      throttlingMethod: 'simulate',
      throttling: { rttMs: 150, throughputKbps: 1638.4, requestLatencyMs: 562.5, downloadThroughputKbps: 1474.56, uploadThroughputKbps: 675, cpuSlowdownMultiplier: 4 },
    },
  },
  'slow-mobile': {
    description: 'Mobile, simulated slow 3G, 6x CPU slowdown (low-end phone on a weak connection)',
    settings: {
      formFactor: 'mobile',
      throttlingMethod: 'simulate',
      throttling: { rttMs: 300, throughputKbps: 700, requestLatencyMs: 1125, downloadThroughputKbps: 630, uploadThroughputKbps: 630, cpuSlowdownMultiplier: 6 },
    },
  },
  desktop: {
    description: 'Desktop, fast connection, no CPU slowdown',
    settings: {
      formFactor: 'desktop',
      throttlingMethod: 'simulate',
      screenEmulation: { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false },
      throttling: { rttMs: 40, throughputKbps: 10 * 1024, cpuSlowdownMultiplier: 1, requestLatencyMs: 0, downloadThroughputKbps: 0, uploadThroughputKbps: 0 },
    },
  },
};

export interface RunOptions {
  url: string;
  profile?: ProfileName;
  /** Path to a Chrome or Chromium binary. Defaults to PERFPILOT_CHROME, then Playwright's Chromium, then any installed Chrome. */
  chromePath?: string;
  /** Maximum time for one Lighthouse run. Default 90 seconds. */
  timeoutMs?: number;
}

/** Finds a Chrome binary: explicit option, environment variable, Playwright's Chromium, or undefined (let chrome-launcher search). */
export function resolveChromePath(explicit?: string): string | undefined {
  if (explicit) return explicit;
  if (process.env.PERFPILOT_CHROME) return process.env.PERFPILOT_CHROME;
  try {
    const p = chromium.executablePath();
    if (p && existsSync(p)) return p;
  } catch {
    // Playwright's browsers are not installed; fall through.
  }
  return undefined;
}

/** Runs Lighthouse once, in a fresh Chrome instance, and returns the raw result. */
export async function runLighthouseOnce(options: RunOptions): Promise<LhrLike> {
  const profile = PROFILES[options.profile ?? 'mobile'];
  const chrome = await chromeLauncher.launch({
    chromePath: resolveChromePath(options.chromePath),
    chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run'],
    logLevel: 'silent',
  });

  const timeoutMs = options.timeoutMs ?? 90_000;
  let timer: NodeJS.Timeout | undefined;
  try {
    const run = lighthouse(options.url, {
      port: chrome.port,
      output: 'json',
      logLevel: 'error',
      onlyCategories: ['performance'],
      maxWaitForLoad: 45_000,
      ...profile.settings,
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Lighthouse timed out after ${timeoutMs} ms`)), timeoutMs);
    });
    const result = await Promise.race([run, timeout]);
    const lhr = result?.lhr as unknown as LhrLike | undefined;
    if (!lhr) throw new Error('Lighthouse returned no result');
    if (lhr.runtimeError) {
      throw new Error(`Lighthouse runtime error ${lhr.runtimeError.code ?? ''}: ${lhr.runtimeError.message ?? ''}`.trim());
    }
    return lhr;
  } finally {
    if (timer) clearTimeout(timer);
    try {
      await chrome.kill();
    } catch {
      // On Windows the temp profile can be locked for a moment; this is harmless.
    }
  }
}
