import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { validateSiteConfig } from '../src/config.js';
import { evaluatePerformance, runGates, screenshotDiffRatio, visualLimit } from '../src/gates.js';
import type { Measurement } from '../src/measure.js';
import type { Sample } from '../src/metrics.js';

function png(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const image = new PNG({ width, height });
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = rgba[0];
    image.data[i + 1] = rgba[1];
    image.data[i + 2] = rgba[2];
    image.data[i + 3] = rgba[3];
  }
  return PNG.sync.write(image);
}

function measurement(url: string, score: number[], lcp: number[]): Measurement {
  const samples: Sample[] = score.map((value, i) => ({
    metrics: {
      score: value,
      fcp: 1000,
      lcp: lcp[i] ?? 3000,
      tbt: 100,
      cls: 0.01,
      speedIndex: 2000,
      tti: 4000,
      ttfb: 50,
      totalBytes: 100_000,
      requests: 10,
    },
    warnings: [],
  }));
  return { url, profile: 'mobile', requestedRuns: score.length, samples, failures: [], startedAt: '', finishedAt: '' };
}

test('screenshotDiffRatio counts pixel and height differences', () => {
  const red = png(4, 4, [255, 0, 0, 255]);
  assert.equal(screenshotDiffRatio(red, png(4, 4, [255, 0, 0, 255])), 0);
  const mixed = screenshotDiffRatio(red, png(4, 4, [0, 0, 255, 255]));
  assert.ok(mixed > 0.5);
  const shorter = screenshotDiffRatio(red, png(4, 2, [255, 0, 0, 255]));
  assert.ok(shorter >= 0.5);
});

test('visual limits follow the fix', () => {
  assert.equal(visualLimit('optimize-images'), 0.06);
  assert.equal(visualLimit('reserve-space'), 0.1);
  assert.equal(visualLimit('defer-scripts'), 0.03);
});

test('evaluatePerformance accepts only an improved verdict', () => {
  const base = measurement('base', [40, 41, 42, 43], [5000, 5100, 4900, 5050]);
  const better = measurement('better', [80, 81, 82, 83], [2000, 1900, 2100, 2050]);
  const same = measurement('same', [40, 41, 42, 43], [5000, 5100, 4900, 5050]);
  const worse = measurement('worse', [10, 11, 12, 13], [8000, 8100, 7900, 8050]);
  assert.equal(evaluatePerformance(base, better).passed, true);
  assert.equal(evaluatePerformance(base, same).passed, false);
  assert.match(evaluatePerformance(base, same).details, /unchanged/);
  assert.equal(evaluatePerformance(base, worse).passed, false);
  assert.match(evaluatePerformance(base, worse).details, /regressed/);
});

test('runGates stops at the first failing gate', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'perfpilot-gate-'));
  const config = validateSiteConfig({ buildCommand: 'node -e "process.exit(2)"', startCommand: 'node server.mjs' });
  const results = await runGates({
    baselineUrl: 'http://127.0.0.1:9/',
    candidateUrl: 'http://127.0.0.1:9/',
    candidateDir: dir,
    config,
    fix: 'defer-scripts',
    runs: 4,
    measureInterleaved: async () => {
      throw new Error('performance should not run');
    },
  });
  assert.deepEqual(results.map((gate) => gate.name), ['build', 'smoke', 'visual', 'performance']);
  assert.equal(results[0]?.passed, false);
  assert.match(results[0]?.details ?? '', /exited 2/);
  assert.equal(results[1]?.details, 'not run');
  assert.equal(results[3]?.details, 'not run');
});
