import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchField, parseCrux, parsePsi } from '../src/field.js';

test('parsePsi reads the Lighthouse category and audits', () => {
  const parsed = parsePsi({
    lighthouseResult: {
      categories: { performance: { score: 0.54 } },
      audits: {
        'largest-contentful-paint': { numericValue: 2500 },
        'total-blocking-time': { numericValue: 180 },
        'cumulative-layout-shift': { numericValue: 0.02 },
      },
    },
  });
  assert.equal(parsed?.score, 54);
  assert.equal(parsed?.lcp, 2500);
  assert.equal(parsed?.tbt, 180);
  assert.equal(parsed?.cls, 0.02);
  assert.equal(parsed?.fcp, null);
});

test('parseCrux reads p75 and the histogram', () => {
  const parsed = parseCrux({
    record: {
      metrics: {
        largest_contentful_paint_ms: { percentiles: { p75: 2100 }, histogram: [{ density: 0.7 }, { density: 0.2 }, { density: 0.1 }] },
        interaction_to_next_paint: { percentiles: { p75: 180 }, histogram: [] },
        cumulative_layout_shift: { percentiles: { p75: 0.04 }, histogram: [{ density: 0.9 }, { density: 0.08 }, { density: 0.02 }] },
      },
    },
  });
  assert.equal(parsed?.metrics.largest_contentful_paint_ms?.p75, 2100);
  assert.equal(parsed?.metrics.largest_contentful_paint_ms?.good, 0.7);
  assert.equal(parsed?.metrics.cumulative_layout_shift?.p75, 0.04);
});

test('fetchField records real API bodies and scrubs the key', async () => {
  const calls: string[] = [];
  const report = await fetchField('https://web.dev/learn', {
    apiKey: 'secret-key',
    fetchImpl: async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('pagespeedonline')) {
        return new Response(JSON.stringify({ lighthouseResult: { categories: { performance: { score: 0.9 } }, audits: {} } }));
      }
      return new Response('', { status: 404 });
    },
  });
  assert.equal(report.psi?.score, 90);
  assert.equal(report.crux, null);
  assert.match(report.notes.join(' '), /No Chrome UX Report data/);
  assert.equal(calls.some((url) => url.includes('secret-key')), true);
  assert.equal(JSON.stringify(report).includes('secret-key'), false);
});

test('a missing key stores no numbers', async () => {
  const report = await fetchField('https://example.com/', { apiKey: '', fetchImpl: async () => { throw new Error('should not be called'); } });
  assert.equal(report.psi, null);
  assert.match(report.notes[0] ?? '', /GOOGLE_API_KEY is not set/);
});
