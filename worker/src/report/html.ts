import { formatMetric, type MetricKey } from '../metrics.js';
import type { Ledger, LedgerStep } from '../optimize.js';

const ROWS: { key: MetricKey; label: string }[] = [
  { key: 'score', label: 'Score' },
  { key: 'lcp', label: 'LCP' },
  { key: 'fcp', label: 'FCP' },
  { key: 'tbt', label: 'TBT' },
  { key: 'cls', label: 'CLS' },
  { key: 'speedIndex', label: 'Speed Index' },
  { key: 'totalBytes', label: 'Page weight' },
  { key: 'requests', label: 'Requests' },
];

export interface ReportOptions {
  projectName: string;
  target: string;
  version: string;
  prUrl?: string | null;
  generatedAt?: string;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function changePct(before: number, after: number): string {
  if (!Number.isFinite(before) || before === 0) return 'n/a';
  const pct = ((after - before) / Math.abs(before)) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%`;
}

function outcome(ledger: Ledger): string {
  const before = ledger.baseline?.score?.median;
  const after = ledger.final?.score?.median;
  const lcpBefore = ledger.baseline?.lcp?.median;
  const lcpAfter = ledger.final?.lcp?.median;
  const score = before == null || after == null ? 'Score was not compared' : `Score ${Math.round(before)} to ${Math.round(after)}`;
  const lcp = lcpBefore == null || lcpAfter == null ? '' : `, LCP ${changePct(lcpBefore, lcpAfter)}`;
  return `${score}${lcp}`;
}

function median(ledger: Ledger, which: 'baseline' | 'final', key: MetricKey): number | null {
  const value = ledger[which]?.[key]?.median;
  return typeof value === 'number' ? value : null;
}

function bars(before: number | null, after: number | null): string {
  if (before == null || after == null) return '';
  const max = Math.max(Math.abs(before), Math.abs(after), 0.0001);
  const left = Math.max(4, (Math.abs(before) / max) * 100);
  const right = Math.max(4, (Math.abs(after) / max) * 100);
  return `<div class="bars" aria-hidden="true"><div class="bar before" style="width:${left.toFixed(1)}%"></div><div class="bar after" style="width:${right.toFixed(1)}%"></div></div>`;
}

function reasonText(step: LedgerStep): string {
  const harm = (step.regressions ?? []).filter((item) => item.harm).map((item) => item.key);
  let text = step.reason || 'No reason was recorded.';
  if (/no measurable|unchanged/i.test(text) && !/no measurable improvement/i.test(text)) {
    text = `${text} No measurable improvement.`;
  }
  if (harm.length && !/counted as harm/i.test(text)) text = `${text} Counted as harm: ${harm.join(', ')}.`;
  return text;
}

function fileStat(step: LedgerStep): string {
  const count = step.files.length;
  const noun = count === 1 ? '1 file changed' : `${count} files changed`;
  const names = step.files.length ? step.files.map((file) => escapeHtml(file)).join(', ') : 'no files recorded';
  const sha = step.commit ? ` Commit ${escapeHtml(step.commit.slice(0, 12))}.` : '';
  return `${escapeHtml(noun)}: ${names}.${sha}`;
}

export function renderReportHtml(ledger: Ledger, options: ReportOptions): string {
  const when = options.generatedAt ?? ledger.finishedAt;
  const kept = ledger.steps.filter((step) => step.status === 'kept');
  const reverted = ledger.steps.filter((step) => step.status === 'reverted' || step.status === 'error');
  const skipped = ledger.steps.filter((step) => step.status === 'skipped');
  const remaining = skipped.filter((step) => /not auto-fixable|reported only|no applier/i.test(step.reason));
  const pr = options.prUrl && options.prUrl.startsWith('https://github.com/') ? options.prUrl : '';

  const beforeAfter = ROWS.map(({ key, label }) => {
    const before = median(ledger, 'baseline', key);
    const after = median(ledger, 'final', key);
    return `<tr><td>${escapeHtml(label)}</td><td class="num">${escapeHtml(formatMetric(key, before))}</td><td class="num">${escapeHtml(formatMetric(key, after))}</td><td class="num">${before == null || after == null ? 'n/a' : escapeHtml(changePct(before, after))}</td><td>${bars(before, after)}</td></tr>`;
  }).join('');

  const keptHtml = kept.length
    ? kept.map((step) => {
      const comparison = step.gates.find((gate) => gate.name === 'performance')?.comparison;
      const rows = (comparison?.metrics ?? []).filter((metric) => metric.primary || metric.verdict !== 'unchanged').map((metric) => {
        const p = Math.min(metric.pBetter, metric.pWorse);
        return `<li>${escapeHtml(metric.label)}: ${escapeHtml(formatMetric(metric.key, metric.baselineMedian))} to ${escapeHtml(formatMetric(metric.key, metric.candidateMedian))} (p=${p.toFixed(3)}, ${metric.baselineN} runs per side)</li>`;
      }).join('');
      return `<section><h3>${escapeHtml(step.title)}</h3><p>${fileStat(step)}</p><ul>${rows || '<li>No metric was marked improved.</li>'}</ul></section>`;
    }).join('')
    : '<p>No change was kept.</p>';

  const revertedHtml = [...reverted, ...skipped.filter((step) => !remaining.includes(step))].map((step) =>
    `<section><h3>${escapeHtml(step.title)} <span class="muted">(${escapeHtml(step.status)})</span></h3><p>${escapeHtml(reasonText(step))}</p></section>`,
  ).join('') || '<p>None.</p>';

  const remainingHtml = remaining.length
    ? remaining.map((step) => `<li><strong>${escapeHtml(step.title)}</strong> ${escapeHtml(step.reason)}</li>`).join('')
    : '<li>None.</li>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>PerfPilot report</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Segoe UI", sans-serif; color: #18181b; font-size: 12px; line-height: 1.45; }
  h1 { font-size: 28px; font-weight: 560; margin: 0 0 8px; }
  h2 { font-size: 16px; margin: 22px 0 8px; break-after: avoid; }
  h3 { font-size: 13px; margin: 0 0 4px; }
  p, li { margin: 0 0 6px; }
  section { break-inside: avoid; margin: 0 0 12px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 4px 6px; border-bottom: 1px solid #e4e4e7; vertical-align: middle; }
  th { font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; color: #71717a; }
  .num { font-variant-numeric: tabular-nums; }
  .muted { color: #71717a; font-weight: 400; }
  .cover { min-height: 240px; }
  .bars { width: 72px; }
  .bar { height: 5px; border-radius: 3px; margin: 2px 0; }
  .bar.before { background: #d4d4d8; }
  .bar.after { background: #4f46e5; }
  a { color: #3730a3; }
  @page { size: A4; margin: 14mm; }
  @media print { body { font-size: 11px; } }
</style>
</head>
<body>
<section class="cover">
  <h1>PerfPilot</h1>
  <p>${escapeHtml(options.projectName)}</p>
  <p>Target: ${escapeHtml(options.target)}</p>
  <p>Date: ${escapeHtml(when)}</p>
  <p>Tool version: ${escapeHtml(options.version)}</p>
  <p>${escapeHtml(outcome(ledger))}</p>
  ${pr ? `<p>Pull request: <a href="${escapeHtml(pr)}">${escapeHtml(pr)}</a></p>` : ''}
</section>
<h2>Before and after</h2>
<table>
  <thead><tr><th>Metric</th><th>Before</th><th>After</th><th>Change</th><th></th></tr></thead>
  <tbody>${beforeAfter}</tbody>
</table>
<h2>Kept changes</h2>
${keptHtml}
<h2>Reverted and skipped changes</h2>
${revertedHtml}
<h2>Remaining recommendations</h2>
<ul>${remainingHtml}</ul>
<h2>Methodology</h2>
<section>
  <p>Lighthouse mobile, simulated slow 4G. Runs are interleaved A/B measurements.</p>
  <p>Each metric is compared with a one-sided Mann-Whitney U test and must also clear a minimum effect size and the baseline noise floor.</p>
  <p>Performance checks used ${ledger.runs ?? 4} runs per side. The final comparison used ${ledger.finalRuns ?? 5} runs per side.</p>
  <p>A change is kept only when the build, smoke, visual, and performance gates pass. The tool never merges.</p>
</section>
</body>
</html>`;
}

export interface MonitorReportInput {
  projectName: string;
  target: string;
  generatedAt: string;
  status: string;
  comparisons: Array<{ key: MetricKey | string; label: string; baselineMedian: number; candidateMedian: number; relativeChange: number; verdict: string }>;
  trend: Array<{ takenAt: string; status: string; medians: Record<string, number | null> }>;
  suspects: string;
}

export function renderMonitorReportHtml(input: MonitorReportInput): string {
  const rows = input.comparisons.map((row) => {
    const key = row.key as MetricKey;
    const before = formatMetric(key, row.baselineMedian);
    const after = formatMetric(key, row.candidateMedian);
    const change = Number.isFinite(row.relativeChange) ? `${row.relativeChange >= 0 ? '+' : ''}${(row.relativeChange * 100).toFixed(0)}%` : 'n/a';
    return `<tr><td>${escapeHtml(row.label)}</td><td class="num">${escapeHtml(before)}</td><td class="num">${escapeHtml(after)}</td><td class="num">${escapeHtml(change)}</td><td>${escapeHtml(row.verdict)}</td><td>${bars(row.baselineMedian, row.candidateMedian)}</td></tr>`;
  }).join('') || '<tr><td colspan="6">No comparison yet.</td></tr>';
  const trendKeys = ['score', 'lcp', 'tbt', 'cls'] as const;
  const trend = input.trend.slice(-10).map((point) => {
    const cells = trendKeys.map((key) => `<td class="num">${escapeHtml(formatMetric(key, point.medians[key] ?? null))}</td>`).join('');
    return `<tr><td>${escapeHtml(point.takenAt)}</td><td>${escapeHtml(point.status)}</td>${cells}</tr>`;
  }).join('') || '<tr><td colspan="6">No earlier checks.</td></tr>';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>PerfPilot monitor report</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Segoe UI", sans-serif; color: #18181b; font-size: 12px; line-height: 1.45; }
  h1 { font-size: 28px; font-weight: 560; margin: 0 0 8px; }
  h2 { font-size: 16px; margin: 22px 0 8px; break-after: avoid; }
  p { margin: 0 0 6px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 4px 6px; border-bottom: 1px solid #e4e4e7; vertical-align: middle; }
  th { font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; color: #71717a; }
  .num { font-variant-numeric: tabular-nums; }
  .bars { width: 72px; }
  .bar { height: 5px; border-radius: 3px; margin: 2px 0; }
  .bar.before { background: #d4d4d8; }
  .bar.after { background: #4f46e5; }
  @page { size: A4; margin: 14mm; }
</style>
</head>
<body>
<section>
  <h1>PerfPilot monitor</h1>
  <p>${escapeHtml(input.projectName)}</p>
  <p>Target: ${escapeHtml(input.target)}</p>
  <p>Date: ${escapeHtml(input.generatedAt)}</p>
  <p>Status: ${escapeHtml(input.status)}</p>
</section>
<h2>Comparison</h2>
<table>
  <thead><tr><th>Metric</th><th>Reference</th><th>Now</th><th>Change</th><th>Verdict</th><th></th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<h2>Recent checks</h2>
<table>
  <thead><tr><th>When</th><th>Status</th><th>Score</th><th>LCP</th><th>TBT</th><th>CLS</th></tr></thead>
  <tbody>${trend}</tbody>
</table>
<h2>Suspects</h2>
<p>${escapeHtml(input.suspects)}</p>
<h2>Methodology</h2>
<section>
  <p>Lighthouse mobile, simulated slow 4G. Each check is a real measurement, not a synthetic sample.</p>
  <p>Score, LCP, TBT, and CLS are compared with the pooled runs of the last healthy checks using a one-sided Mann-Whitney U test, a minimum effect size, and the reference noise floor.</p>
  <p>A metric counts only when the regression is harmful under the same Core Web Vitals harm policy as an optimize gate. Two consecutive harmful checks open one incident. A later healthy check closes it. The tool never merges.</p>
</section>
</body>
</html>`;
}
