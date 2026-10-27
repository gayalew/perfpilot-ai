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

test('parseCrux reads the current LCP name and a string percentile', () => {
  const parsed = parseCrux({
    record: {
      metrics: {
        largest_contentful_paint: { percentiles: { p75: 3105 }, histogram: [{ density: 0.65 }, { density: 0.2 }, { density: 0.15 }] },
        cumulative_layout_shift: { percentiles: { p75: '0.05' }, histogram: [{ density: 0.79 }, { density: 0.11 }, { density: 0.1 }] },
        interaction_to_next_paint: { percentiles: { p75: 204 }, histogram: [{ density: 0.74 }, { density: 0.2 }, { density: 0.06 }] },
      },
    },
  });
  assert.equal(parsed?.metrics.largest_contentful_paint?.p75, 3105);
  assert.equal(parsed?.metrics.largest_contentful_paint_ms, undefined);
  assert.equal(parsed?.metrics.cumulative_layout_shift?.p75, 0.05);
  assert.equal(parsed?.metrics.interaction_to_next_paint?.p75, 204);
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

test('fetchField keeps a bad status, a timeout, and malformed JSON on the report', async () => {
  const report = await fetchField('https://example.com/', {
    apiKey: 'bad-key',
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.includes('pagespeedonline')) return new Response('nope', { status: 429 });
      if (url.includes('chromeuxreport')) return new Response('{', { status: 200 });
      throw new Error('unexpected');
    },
  });
  assert.match(report.notes.join(' '), /PageSpeed Insights HTTP 429/);
  assert.match(report.notes.join(' '), /JSON/);
  assert.equal(JSON.stringify(report).includes('bad-key'), false);
  assert.equal(report.psi, null);
  assert.equal(report.crux, null);
});

test('fetchField records an HTTP 500 and scrubs a key embedded in a timeout', async () => {
  const report = await fetchField('http://localhost:4200/', {
    apiKey: 'bad-key',
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.includes('pagespeedonline')) throw new Error('timeout calling key=bad-key');
      return new Response('upstream', { status: 503 });
    },
  });
  assert.match(report.notes.join(' '), /key=<redacted>/);
  assert.match(report.notes.join(' '), /Chrome UX Report HTTP 503/);
  assert.equal(JSON.stringify(report).includes('bad-key'), false);
});

test('a missing key stores no numbers', async () => {
  const report = await fetchField('https://example.com/', { apiKey: '', fetchImpl: async () => { throw new Error('should not be called'); } });
  assert.equal(report.psi, null);
  assert.match(report.notes[0] ?? '', /GOOGLE_API_KEY is not set/);
});
