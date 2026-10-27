import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createJob, getProjectSummary, listIncidents, listMeasurements, type IncidentRow, type MeasurementRow, type Project } from '../api.ts';
import { formatMetric, formatRelativeTime, safeGithubUrl } from '../format.ts';
import { monitorStatusLabel, scheduleWords } from '../monitor.ts';
import { Badge } from './Badge.tsx';
import { Button } from './Button.tsx';
import { Card } from './Card.tsx';
import { TrendChart, type TrendRow } from './TrendChart.tsx';

function median(row: MeasurementRow, key: string): number | null {
  const value = row.medians?.[key];
  return typeof value === 'number' ? value : null;
}

function referenceFor(rows: MeasurementRow[], key: string): { median: number | null; noise: number | null } {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    const comparison = row?.compared?.comparisons?.find((item) => item.key === key);
    const reference = row?.compared?.reference?.[key];
    if (comparison || typeof reference === 'number') {
      return { median: typeof reference === 'number' ? reference : comparison?.baselineMedian ?? null, noise: comparison?.noise ?? null };
    }
  }
  return { median: null, noise: null };
}

function series(rows: MeasurementRow[], key: string): TrendRow[] {
  return rows.map((row) => ({ takenAt: row.takenAt, status: row.status, value: median(row, key) }));
}

export function MonitoringCard({ project }: { project: Project }) {
  const navigate = useNavigate();
  const [rows, setRows] = useState<MeasurementRow[]>([]);
  const [incidents, setIncidents] = useState<IncidentRow[]>([]);
  const [minHistory, setMinHistory] = useState(3);
  const [runs, setRuns] = useState(5);
  const [extra, setExtra] = useState<'tbt' | 'cls'>('tbt');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    Promise.all([listMeasurements(project.id), listIncidents(project.id), getProjectSummary(project.id)])
      .then(([measurements, nextIncidents, summary]) => {
        setRows(measurements);
        setIncidents(nextIncidents);
        if (summary.monitor) setMinHistory(summary.monitor.minHistory);
      })
      .catch(() => undefined);
  }, [project.id]);

  useEffect(() => {
    load();
  }, [load]);

  const latest = rows.at(-1) ?? null;
  const open = incidents.find((item) => !item.closedAt) ?? null;
  const baselineCount = rows.filter((row) => row.status === 'ok' || row.status === 'learning').length;
  const label = monitorStatusLabel({
    minHistory,
    baselineCount,
    latestStatus: latest?.status ?? null,
    incidentOpen: Boolean(open),
  });
  const tone = open || latest?.status === 'regression' ? 'bad' : latest?.status === 'breach' ? 'warn' : latest?.status === 'ok' ? 'good' : 'neutral';
  const scoreRef = referenceFor(rows, 'score');
  const lcpRef = referenceFor(rows, 'lcp');
  const extraRef = referenceFor(rows, extra);

  async function runCheck() {
    setBusy(true);
    setError('');
    try {
      const job = await createJob(project.id, { type: 'monitor', runs });
      navigate(`/jobs/${job.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not start the check');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card testId="monitoring-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-medium">Monitoring</h2>
        <Badge tone={tone}>{label}</Badge>
      </div>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
        Schedule: {scheduleWords(project.scheduleCron)}
        {scheduleWords(project.scheduleCron) === 'custom cron' && project.scheduleCron ? ` (${project.scheduleCron})` : ''}
      </p>
      <p className="mt-1 text-sm text-zinc-500">Last check: {latest ? formatRelativeTime(latest.takenAt) : 'none yet'}</p>
      {open && (
        <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-900 dark:bg-red-950 dark:text-red-100" role="status">
          <p className="font-medium">Regression open since {open.details?.since ? formatRelativeTime(open.details.since) : formatRelativeTime(open.openedAt)}</p>
          <p className="mt-1">{open.details?.suspects || 'No suspects recorded.'}</p>
          {open.details?.commits && open.details.commits.length > 0 && (
            <ul className="mt-2 space-y-1">
              {open.details.commits.map((commit) => {
                const href = safeGithubUrl(commit.url);
                return (
                  <li key={commit.sha}>
                    {href ? <a className="underline" href={href}>{commit.sha}</a> : commit.sha} {commit.message}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="text-sm">
          Runs
          <select className="mt-1 block rounded-md border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950" value={runs} onChange={(event) => setRuns(Number(event.target.value))}>
            {[3, 4, 5, 6, 7, 8, 9, 10].map((count) => <option key={count} value={count}>{count}</option>)}
          </select>
        </label>
        <Button disabled={busy} onClick={() => void runCheck()}>{busy ? 'Starting…' : 'Run check now'}</Button>
        <div className="flex gap-2 text-sm">
          <button type="button" className={extra === 'tbt' ? 'font-medium' : 'text-zinc-500'} onClick={() => setExtra('tbt')}>TBT</button>
          <button type="button" className={extra === 'cls' ? 'font-medium' : 'text-zinc-500'} onClick={() => setExtra('cls')}>CLS</button>
        </div>
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
      {rows.length > 0 && (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <TrendChart title="Score" rows={series(rows, 'score')} reference={scoreRef.median} noise={scoreRef.noise} format={(value) => formatMetric('score', value)} />
          <TrendChart title="LCP" rows={series(rows, 'lcp')} reference={lcpRef.median} noise={lcpRef.noise} format={(value) => formatMetric('lcp', value)} />
          <TrendChart title={extra === 'tbt' ? 'TBT' : 'CLS'} rows={series(rows, extra)} reference={extraRef.median} noise={extraRef.noise} format={(value) => formatMetric(extra, value)} />
        </div>
      )}
    </Card>
  );
}
