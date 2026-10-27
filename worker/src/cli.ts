#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { compareMeasurements, formatComparison } from './compare.js';
import { extractFindings, FIX_CATALOG } from './diagnose.js';
import { planFixes } from './gemini.js';
import { PROFILES, runLighthouseOnce, type ProfileName } from './lighthouse-runner.js';
import { aggregate, measureInterleaved, measureUrl, type Measurement } from './measure.js';
import { METRICS, formatMetric } from './metrics.js';

const HELP = `PerfPilot worker

Usage:
  perfpilot-worker measure <url> [--runs 5] [--profile mobile] [--out measurement.json]
  perfpilot-worker ab <baselineUrl> <candidateUrl> [--runs 5] [--profile mobile] [--out result.json]
  perfpilot-worker compare <baseline.json> <candidate.json> [--out result.json]
  perfpilot-worker diagnose <url> [--profile mobile] [--no-ai] [--out diagnosis.json]

Profiles: ${Object.keys(PROFILES).join(', ')}
Set PERFPILOT_CHROME to use a specific Chrome/Chromium binary.
`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    runs: { type: 'string', default: '5' },
    profile: { type: 'string', default: 'mobile' },
    out: { type: 'string' },
    json: { type: 'boolean', default: false },
    'no-ai': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

function parseProfile(): ProfileName {
  const p = flags.profile as string;
  if (!(p in PROFILES)) throw new Error(`Unknown profile "${p}". Choose one of: ${Object.keys(PROFILES).join(', ')}`);
  return p as ProfileName;
}

function parseRuns(): number {
  const n = Number(flags.runs);
  if (!Number.isInteger(n) || n < 3 || n > 25) throw new Error('--runs must be a whole number from 3 to 25');
  return n;
}

const progress = (message: string) => process.stderr.write(`  ${message}\n`);

function printMeasurement(m: Measurement): void {
  const agg = aggregate(m);
  console.log(`${m.url}  (${m.samples.length}/${m.requestedRuns} runs, profile ${m.profile})`);
  for (const info of METRICS) {
    const s = agg[info.key];
    if (!s) continue;
    console.log(`  ${info.label.padEnd(28)} median ${formatMetric(info.key, s.median).padEnd(10)} range ${formatMetric(info.key, s.min)} to ${formatMetric(info.key, s.max)}`);
  }
}

async function loadMeasurement(path: string): Promise<Measurement> {
  return JSON.parse(await readFile(path, 'utf8')) as Measurement;
}

async function main(): Promise<void> {
  const [command, ...args] = positionals;
  if (flags.help || !command) {
    console.log(HELP);
    return;
  }

  if (command === 'measure') {
    if (!args[0]) throw new Error('measure needs a URL');
    const m = await measureUrl({ url: args[0], runs: parseRuns(), profile: parseProfile(), onProgress: progress });
    if (flags.out) await writeFile(flags.out, JSON.stringify(m, null, 2));
    if (flags.json) console.log(JSON.stringify(m, null, 2));
    else printMeasurement(m);
    return;
  }

  if (command === 'ab') {
    if (!args[0] || !args[1]) throw new Error('ab needs a baseline URL and a candidate URL');
    const [a, b] = await measureInterleaved(args[0], args[1], { runs: parseRuns(), profile: parseProfile(), onProgress: progress });
    const result = compareMeasurements(a, b);
    if (flags.out) await writeFile(flags.out, JSON.stringify({ baseline: a, candidate: b, comparison: result }, null, 2));
    console.log(flags.json ? JSON.stringify(result, null, 2) : formatComparison(result));
    return;
  }

  if (command === 'compare') {
    if (!args[0] || !args[1]) throw new Error('compare needs two measurement files');
    const result = compareMeasurements(await loadMeasurement(args[0]), await loadMeasurement(args[1]));
    if (flags.out) await writeFile(flags.out, JSON.stringify(result, null, 2));
    console.log(flags.json ? JSON.stringify(result, null, 2) : formatComparison(result));
    return;
  }

  if (command === 'diagnose') {
    if (!args[0]) throw new Error('diagnose needs a URL');
    progress(`${args[0]}  running Lighthouse`);
    const lhr = await runLighthouseOnce({ url: args[0], profile: parseProfile() });
    const findings = extractFindings(lhr);
    const plan = flags['no-ai']
      ? { source: 'heuristic' as const, steps: (await planFixes(findings, { apiKey: '' })).steps, note: 'AI disabled with --no-ai.' }
      : await planFixes(findings);
    const result = { url: args[0], findings, plan };
    if (flags.out) await writeFile(flags.out, JSON.stringify(result, null, 2));
    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`Found ${findings.length} fixable issues. Plan source: ${plan.source}${plan.note ? ` (${plan.note})` : ''}\n`);
    for (const step of plan.steps) {
      const f = findings.find((x) => x.fix === step.fix);
      const info = FIX_CATALOG[step.fix];
      console.log(`${step.order}. ${info.title}  [risk: ${info.risk}${info.runtimeTestable ? ', testable without repo' : ''}]`);
      console.log(`   ${step.rationale}`);
      if (step.expectedImpact) console.log(`   ${step.expectedImpact}`);
      for (const item of f?.items.slice(0, 2) ?? []) {
        const label = item.url ?? item.detail;
        if (label) console.log(`   - ${label}`);
      }
    }
    return;
  }

  throw new Error(`Unknown command "${command}"\n\n${HELP}`);
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
