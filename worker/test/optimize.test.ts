import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Comparison } from '../src/compare.js';
import { validateSiteConfig } from '../src/config.js';
import type { Finding, FixId, Plan } from '../src/diagnose.js';
import type { GateResult } from '../src/gates.js';
import type { Measurement } from '../src/measure.js';
import type { Sample } from '../src/metrics.js';
import { optimize } from '../src/optimize.js';
import { applierFor } from '../src/fixes/index.js';
import type { FixApplier } from '../src/fixes/types.js';

function measurement(url: string): Measurement {
  const samples: Sample[] = [1, 2, 3, 4, 5].map(() => ({
    metrics: { score: 40, fcp: 1000, lcp: 4000, tbt: 200, cls: 0.1, speedIndex: 2000, tti: 4000, ttfb: 20, totalBytes: 1000, requests: 4 },
    warnings: [],
  }));
  return { url, profile: 'mobile', requestedRuns: 5, samples, failures: [], startedAt: '', finishedAt: '' };
}

const improved: Comparison = {
  baselineUrl: 'http://127.0.0.1:1/',
  candidateUrl: 'http://127.0.0.1:2/',
  verdict: 'improved',
  summary: 'Improved: Largest Contentful Paint',
  metrics: [
    {
      key: 'lcp',
      label: 'Largest Contentful Paint',
      primary: true,
      verdict: 'improved',
      baselineMedian: 4000,
      candidateMedian: 2000,
      absoluteChange: -2000,
      relativeChange: -0.5,
      pBetter: 0.02,
      pWorse: 0.9,
      method: 'exact',
      noise: 50,
      reason: 'improved',
      baselineN: 4,
      candidateN: 4,
    },
  ],
};

function gates(passed: boolean): GateResult[] {
  if (!passed) {
    return [
      { name: 'build', passed: false, details: 'build exited 1', ms: 3 },
      { name: 'smoke', passed: false, details: 'not run', ms: 0 },
      { name: 'visual', passed: false, details: 'not run', ms: 0 },
      { name: 'performance', passed: false, details: 'not run', ms: 0 },
    ];
  }
  return [
    { name: 'build', passed: true, details: 'no build command', ms: 1 },
    { name: 'smoke', passed: true, details: 'ok', ms: 1 },
    { name: 'visual', passed: true, details: 'ok', ms: 1 },
    { name: 'performance', passed: true, details: improved.summary, ms: 4, comparison: improved },
  ];
}

function finding(fix: FixId): Finding {
  return {
    auditId: fix,
    title: fix,
    fix,
    savingsMs: 10,
    savingsBytes: 0,
    metrics: ['lcp'],
    items: [{ url: 'http://local/js/app.js' }, { url: 'http://local/css/app.css' }],
    priority: 1,
  };
}

test('optimize keeps, reverts, skips, and records an error without stopping', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'perfpilot-opt-src-'));
  await mkdir(path.join(repo, 'public', 'js'), { recursive: true });
  await mkdir(path.join(repo, 'public', 'css'), { recursive: true });
  await writeFile(
    path.join(repo, 'public', 'index.html'),
    '<!doctype html><html><head><script src="/js/app.js"></script><link rel="stylesheet" href="/css/app.css"></head><body>Hi</body></html>',
    'utf8',
  );
  await writeFile(path.join(repo, 'public', 'js', 'app.js'), '/* comment */\nfunction hello() { return 1; }\n', 'utf8');
  await writeFile(path.join(repo, 'public', 'css', 'app.css'), '/* comment */\nbody { color: red; }\n', 'utf8');
  await writeFile(
    path.join(repo, 'perfpilot.config.json'),
    JSON.stringify({ startCommand: 'node server.mjs', port: 4782, paths: ['/'], publicDir: 'public', serverFile: 'server.mjs' }),
    'utf8',
  );
  const findings = [finding('defer-scripts'), finding('minify-assets'), finding('remove-unused-code'), finding('image-dimensions')];
  const plan: Plan = {
    source: 'heuristic',
    note: 'AI disabled with --no-ai.',
    steps: findings.map((item, index) => ({
      fix: item.fix,
      auditId: item.auditId,
      rationale: item.title,
      expectedImpact: 'test',
      order: index + 1,
    })),
  };
  const runDir = await mkdtemp(path.join(tmpdir(), 'perfpilot-opt-run-'));
  const throwing: FixApplier = {
    id: 'image-dimensions',
    kind: 'deterministic',
    apply: async () => {
      throw new Error('boom');
    },
  };
  const result = await optimize({
    repoPath: repo,
    runs: 4,
    finalRuns: 5,
    maxSteps: 12,
    useAi: false,
    runDir,
    deps: {
      measureUrl: async () => measurement('http://127.0.0.1:4782/'),
      measureInterleaved: async () => [measurement('http://127.0.0.1:4782/'), measurement('http://127.0.0.1:4783/')],
      runLighthouseOnce: async () => ({}) as never,
      extractFindings: () => findings,
      planFixes: async () => plan,
      startSite: async (_dir, _config, port) => ({ url: `http://127.0.0.1:${port}/`, stop: async () => undefined }),
      runGates: async (ctx) => {
        const passed = ctx.fix === 'defer-scripts';
        const results = gates(passed);
        for (const gate of results) {
          if (gate.details === 'not run') continue;
          await ctx.onGate?.('start', gate.name);
          await ctx.onGate?.('end', gate.name, gate);
        }
        return results;
      },
      loadSiteConfig: async () => validateSiteConfig({ startCommand: 'node server.mjs', port: 4782, paths: ['/'], publicDir: 'public', serverFile: 'server.mjs' }),
      applierFor: (id) => (id === 'image-dimensions' ? throwing : applierFor(id)),
    },
  });

  assert.deepEqual(
    result.ledger.steps.map((step) => [step.fix, step.status]),
    [
      ['defer-scripts', 'kept'],
      ['minify-assets', 'reverted'],
      ['remove-unused-code', 'skipped'],
      ['image-dimensions', 'error'],
    ],
  );
  assert.match(result.ledger.steps[1]?.reason ?? '', /build/);
  assert.equal(result.ledger.steps[2]?.reason, 'not auto-fixable; reported only');
  assert.match(result.ledger.steps[3]?.reason ?? '', /boom/);
  assert.equal(result.ledger.finalComparison?.verdict, 'unchanged');
  const html = await readFile(path.join(runDir, 'work', 'public', 'index.html'), 'utf8');
  assert.match(html, /defer/);
  const js = await readFile(path.join(runDir, 'work', 'public', 'js', 'app.js'), 'utf8');
  assert.match(js, /comment/);
  const events = await readFile(path.join(runDir, 'events.jsonl'), 'utf8');
  assert.match(events, /step-start/);
  assert.match(events, /gate-end/);
  assert.match(events, /run-end/);
  const summary = await readFile(path.join(runDir, 'summary.md'), 'utf8');
  assert.match(summary, /defer-scripts/);
  assert.match(summary, /kept/);
  assert.match(summary, /Before and after/);
});

test('an AI edit gets one repair, and a crashed candidate is a reverted smoke gate', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'perfpilot-repair-src-'));
  await mkdir(path.join(repo, 'public'), { recursive: true });
  await writeFile(path.join(repo, 'public', 'index.html'), '<!doctype html><html><body>Hi</body></html>', 'utf8');
  const findings = [finding('compress-text')];
  const plan: Plan = {
    source: 'gemini',
    steps: [{ fix: 'compress-text', auditId: 'compress-text', rationale: 'compress', expectedImpact: 'bytes', order: 1 }],
  };
  let applies = 0;
  const aiApplier: FixApplier = {
    id: 'compress-text',
    kind: 'ai',
    apply: async ({ dir, repairReason }) => {
      applies += 1;
      if (applies === 2) assert.match(repairReason ?? '', /site did not return 200/);
      await writeFile(path.join(dir, 'public', 'index.html'), `<!doctype html><html><body>try ${applies}</body></html>`, 'utf8');
      return { applied: true, changedFiles: ['public/index.html'] };
    },
  };
  const runDir = await mkdtemp(path.join(tmpdir(), 'perfpilot-repair-run-'));
  const result = await optimize({
    repoPath: repo,
    runs: 4,
    finalRuns: 5,
    maxSteps: 1,
    useAi: true,
    runDir,
    deps: {
      measureUrl: async () => measurement('http://127.0.0.1:4782/'),
      measureInterleaved: async () => [measurement('http://127.0.0.1:4782/'), measurement('http://127.0.0.1:4783/')],
      runLighthouseOnce: async () => ({}) as never,
      extractFindings: () => findings,
      planFixes: async () => plan,
      startSite: async (_dir, _config, port) => {
        if (port === 4783 && applies === 1) throw new Error('site did not return 200');
        return { url: `http://127.0.0.1:${port}/`, stop: async () => undefined };
      },
      runGates: async (ctx) => {
        const results = gates(true);
        for (const gate of results) {
          await ctx.onGate?.('start', gate.name);
          await ctx.onGate?.('end', gate.name, gate);
        }
        return results;
      },
      loadSiteConfig: async () => validateSiteConfig({ startCommand: 'node server.mjs', port: 4782, paths: ['/'], publicDir: 'public', serverFile: 'server.mjs' }),
      applierFor: () => aiApplier,
    },
  });
  assert.equal(applies, 2);
  assert.equal(result.ledger.steps[0]?.status, 'kept');
  assert.equal(result.ledger.steps[0]?.attempts, 2);
});
