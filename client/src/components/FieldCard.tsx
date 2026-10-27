import type { FieldReport } from '../api.ts';
import { formatMs } from '../format.ts';
import { Button } from './Button.tsx';
import { Card } from './Card.tsx';

const CRUX_LABELS: Record<string, string> = {
  largest_contentful_paint: 'LCP',
  largest_contentful_paint_ms: 'LCP',
  interaction_to_next_paint: 'INP',
  cumulative_layout_shift: 'CLS',
};

function cls(value: number | null): string {
  if (value == null) return 'n/a';
  return value.toFixed(3);
}

function rating(value: number | null): string {
  if (value == null) return 'n/a';
  return `${Math.round(value * 100)}%`;
}

function p75Rating(key: string, value: number | null): string {
  if (value == null) return 'n/a';
  const bands = key === 'cumulative_layout_shift'
    ? [0.1, 0.25]
    : key === 'interaction_to_next_paint'
      ? [200, 500]
      : [2500, 4000];
  if (value <= bands[0]) return 'good';
  if (value <= bands[1]) return 'needs improvement';
  return 'poor';
}

export function FieldCard({ report, onRefresh, busy = false }: { report: FieldReport | null; onRefresh?: () => void; busy?: boolean }) {
  const crux = report?.crux?.metrics ?? {};
  return (
    <Card testId="field-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-medium">Field data</h2>
        {onRefresh && <Button disabled={busy} onClick={onRefresh}>{busy ? 'Starting…' : 'Refresh field data'}</Button>}
      </div>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">PageSpeed Insights is one mobile lab run. Chrome UX Report numbers are real user data for the origin.</p>
      {!report && <p className="mt-3 text-sm text-zinc-500">No field data yet.</p>}
      {report && (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <h3 className="text-sm font-medium">PageSpeed Insights</h3>
            {report.psi ? (
              <dl className="mt-2 space-y-1 text-sm">
                <div className="flex justify-between gap-3"><dt>Score</dt><dd className="tabular-nums">{report.psi.score ?? 'n/a'}</dd></div>
                <div className="flex justify-between gap-3"><dt>LCP</dt><dd className="tabular-nums">{formatMs(report.psi.lcp)}</dd></div>
                <div className="flex justify-between gap-3"><dt>TBT</dt><dd className="tabular-nums">{formatMs(report.psi.tbt)}</dd></div>
                <div className="flex justify-between gap-3"><dt>CLS</dt><dd className="tabular-nums">{cls(report.psi.cls)}</dd></div>
              </dl>
            ) : <p className="mt-2 text-sm text-zinc-500">No lab result in this response.</p>}
          </div>
          <div>
            <h3 className="text-sm font-medium">Chrome UX Report</h3>
            {report.crux ? (
              <dl className="mt-2 space-y-1 text-sm">
                {Object.entries(crux).map(([key, metric]) => (
                  <div key={key} className="flex justify-between gap-3">
                    <dt>{CRUX_LABELS[key] ?? key} p75</dt>
                    <dd className="text-right tabular-nums">
                      {key === 'cumulative_layout_shift' ? cls(metric.p75) : formatMs(metric.p75)}
                      <span className="ml-2">· {p75Rating(key, metric.p75)}</span>
                      <span className="ml-2 text-zinc-500">good {rating(metric.good)} · ni {rating(metric.ni)} · poor {rating(metric.poor)}</span>
                    </dd>
                  </div>
                ))}
              </dl>
            ) : <p className="mt-2 text-sm text-zinc-500">No field data for this origin.</p>}
          </div>
        </div>
      )}
      {report && report.notes.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm text-zinc-500">
          {report.notes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      )}
    </Card>
  );
}
