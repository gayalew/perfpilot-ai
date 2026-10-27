import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, cancelJob, getJob, getLedger, getProject, listNotifications, reportPdfUrl, summaryMarkdownUrl, type FieldReport, type Job, type NotificationRow } from '../api.ts';
import { watchJob } from '../events.ts';
import { formatDuration, formatMetric, formatPercentChange, formatRelativeTime, formatRunTitle, isQuietChange, resultHeadline, safeGithubUrl } from '../format.ts';
import type { MonitorStatus } from '../api.ts';
import { applyLedger, emptyJobState, reduceJob, type Experiment, type GateName, type JobView, type MetricChange, type MetricSnapshot } from '../jobState.ts';
import { Badge } from '../components/Badge.tsx';
import { FieldCard } from '../components/FieldCard.tsx';
import { Button } from '../components/Button.tsx';
import { Card } from '../components/Card.tsx';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { MetricBar } from '../components/MetricBar.tsx';
import { LoadGate } from '../components/QueryState.tsx';
import { Spinner } from '../components/Spinner.tsx';
import { StatusIcon } from '../components/StatusIcon.tsx';

const RESULT_ROWS: Array<[keyof MetricSnapshot, string]> = [
  ['score', 'Score'],
  ['lcp', 'LCP'],
  ['fcp', 'FCP'],
  ['tbt', 'TBT'],
  ['cls', 'CLS'],
  ['speedIndex', 'Speed Index'],
  ['weight', 'Page weight'],
  ['requests', 'Requests'],
];

const GATE_LABEL: Record<GateName, string> = { build: 'Build', smoke: 'Smoke', visual: 'Visual', performance: 'Performance' };

function metricKey(key: keyof MetricSnapshot): string {
  return key === 'weight' ? 'weight' : key;
}

function headlineRows(view: JobView): Array<{ key: string; before: number; after: number; verdict?: string }> {
  if (!view.baseline || !view.final) return [];
  return RESULT_ROWS.flatMap(([key]) => {
    const before = view.baseline?.[key];
    const after = view.final?.[key];
    if (before == null || after == null) return [];
    const comparisonKey = key === 'weight' ? 'totalBytes' : key;
    return [{ key: comparisonKey, before, after, verdict: verdictFor(view.finalMetrics, key) }];
  });
}

function verdictFor(metrics: MetricChange[], key: keyof MetricSnapshot): string {
  const wanted = key === 'weight' ? 'totalBytes' : key;
  const found = metrics.find((item) => item.key === wanted);
  if (found?.verdict === 'improved' || found?.verdict === 'regressed' || found?.verdict === 'unchanged') return found.verdict;
  return 'unchanged';
}

interface MonitorResult {
  status?: MonitorStatus;
  comparisons?: Array<{ key: string; label: string; baselineMedian: number; candidateMedian: number; relativeChange: number; verdict: string; breach?: boolean }>;
  suspects?: Array<{ sha: string; message: string; author: string; date: string; url: string }>;
  suspectText?: string;
}

function monitorOf(job: Job | null): MonitorResult | null {
  const result = job?.result;
  if (!result || typeof result !== 'object' || !('monitor' in result)) return null;
  const monitor = (result as { monitor?: MonitorResult }).monitor;
  return monitor ?? null;
}

function fieldOf(result: unknown): FieldReport | null {
  if (!result || typeof result !== 'object' || !('field' in result)) return null;
  const field = (result as { field?: unknown }).field;
  if (!field || typeof field !== 'object' || !('notes' in field)) return null;
  return field as FieldReport;
}

function GateMark({ state }: { state: Experiment['gates'][number]['state'] }) {
  if (state === 'running') return <span className="inline-flex items-center gap-1 text-indigo-700 dark:text-indigo-200"><Spinner /> Running</span>;
  if (state === 'passed') return <span className="text-emerald-700 dark:text-emerald-300">Passed</span>;
  if (state === 'failed') return <span className="text-red-700 dark:text-red-300">Failed</span>;
  if (state === 'not-run') return <span className="text-zinc-400">Not run</span>;
  return <span className="text-zinc-400">Pending</span>;
}

function ExperimentCard({ experiment, running }: { experiment: Experiment; running: boolean }) {
  const riskTone = experiment.risk === 'high' ? 'bad' : experiment.risk === 'medium' ? 'warn' : 'good';
  return (
    <article data-running={running ? 'true' : 'false'} className="rise">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h3 className="text-base font-medium">{experiment.title}</h3>
          <Badge tone={riskTone}>{experiment.risk} risk</Badge>
        </div>
        {experiment.rationale && <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">{experiment.rationale}</p>}
        <div className="mt-3"><StatusIcon status={experiment.status} /></div>
        {experiment.attempts >= 2 && <p className="mt-2 text-sm text-zinc-500">Attempt 2 of 2</p>}
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {experiment.gates.map((gate) => (
            <div key={gate.name} className="rounded-md bg-zinc-50 px-2 py-2 text-xs dark:bg-zinc-950">
              <div className="font-medium text-zinc-500">{GATE_LABEL[gate.name]}</div>
              <div className="mt-1"><GateMark state={gate.state} /></div>
            </div>
          ))}
        </div>
        {experiment.reason && <p className="mt-3 text-sm">{experiment.reason}</p>}
        {experiment.metrics.length > 0 && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="py-1 pr-3 font-medium">Metric</th>
                  <th className="py-1 pr-3 font-medium">Before</th>
                  <th className="py-1 pr-3 font-medium">After</th>
                  <th className="py-1 pr-3 font-medium">Change</th>
                  <th className="py-1 font-medium">p-value</th>
                </tr>
              </thead>
              <tbody>
                {experiment.metrics.map((row) => {
                  const tone = row.verdict === 'improved' ? 'text-emerald-700 dark:text-emerald-300' : row.verdict === 'regressed' ? 'text-red-700 dark:text-red-300' : '';
                  return (
                    <tr key={row.key} className={tone}>
                      <td className="py-1 pr-3">{row.label}{row.verdict === 'improved' ? ' · improved' : row.verdict === 'regressed' ? ' · regressed' : ''}{row.countedAsHarm ? ' · counted as harm' : ''}</td>
                      <td className="py-1 pr-3 tabular-nums">{formatMetric(row.key, row.before)}</td>
                      <td className="py-1 pr-3 tabular-nums">{formatMetric(row.key, row.after)}</td>
                      <td className="py-1 pr-3 tabular-nums">{formatPercentChange(row.before, row.after)}</td>
                      <td className="py-1 tabular-nums">{row.p.toFixed(3)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </article>
  );
}

export function JobPage() {
  const { id = '' } = useParams();
  const [job, setJob] = useState<Job | null>(null);
  const [projectName, setProjectName] = useState('');
  const [view, setView] = useState<JobView>(emptyJobState);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [confirming, setConfirming] = useState(false);
  const [notices, setNotices] = useState<NotificationRow[]>([]);
  const pinned = useRef(true);

  useEffect(() => {
    const onScroll = () => {
      const gap = document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
      pinned.current = gap < 140;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    let dropped = false;
    let current = emptyJobState();
    const publish = (next: JobView) => {
      current = next;
      if (!dropped) setView(next);
    };
    setLoading(true);
    setError(null);
    setView(emptyJobState());
    getJob(id)
      .then((next) => {
        if (dropped) return;
        setJob(next);
        getProject(next.projectId).then((project) => {
          if (!dropped) setProjectName(project.name);
        }).catch(() => {});
        const terminal = next.status === 'succeeded' || next.status === 'failed' || next.status === 'cancelled';
        if (terminal) {
          getLedger(id)
            .then((ledger) => {
              if (!dropped && (current.finished || terminal)) publish(applyLedger(current, ledger));
            })
            .catch((caught: unknown) => {
              if (caught instanceof ApiError && caught.status === 404) return;
            });
        }
      })
      .catch((caught: unknown) => {
        if (!dropped) setError(caught instanceof Error ? caught.message : 'Could not load the run');
      })
      .finally(() => {
        if (!dropped) setLoading(false);
      });
    listNotifications(id).then((rows) => {
      if (!dropped) setNotices(rows);
    }).catch(() => {});
    const stop = watchJob(
      id,
      (event) => {
        const next = reduceJob(current, event);
        publish(next);
        if (event.type === 'job-start') {
          setJob((currentJob) => currentJob ? { ...currentJob, status: 'running', startedAt: currentJob.startedAt ?? new Date().toISOString() } : currentJob);
        }
        if (event.type === 'job-end') {
          const payload = event.payload;
          const ok = !!payload && typeof payload === 'object' && !Array.isArray(payload) && (payload as { ok?: unknown }).ok === true;
          const failed = !!payload && typeof payload === 'object' && !Array.isArray(payload) && (payload as { ok?: unknown }).ok === false;
          const message = !!payload && typeof payload === 'object' && !Array.isArray(payload) && typeof (payload as { error?: unknown }).error === 'string'
            ? (payload as { error: string }).error
            : null;
          setJob((currentJob) => currentJob ? {
            ...currentJob,
            status: ok ? 'succeeded' : failed ? 'failed' : currentJob.status,
            finishedAt: currentJob.finishedAt ?? new Date().toISOString(),
            error: message ?? currentJob.error,
          } : currentJob);
        }
      },
      (polled) => {
        if (!dropped) setJob(polled);
        if ((polled.status === 'succeeded' || polled.status === 'failed' || polled.status === 'cancelled') && polled.result && !current.finished) {
          publish(reduceJob(current, { type: 'job-end', payload: polled.result }));
        }
      },
    );
    return () => {
      dropped = true;
      stop();
    };
  }, [id, reloadKey]);

  useEffect(() => {
    if (!view.finished) return;
    listNotifications(id).then(setNotices).catch(() => {});
  }, [id, view.finished]);

  const live = job?.status === 'queued' || job?.status === 'running' || view.running;
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);

  useEffect(() => {
    if (!pinned.current) return;
    const node = document.querySelector('[data-running="true"]');
    node?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [view.experiments]);

  const monitor = monitorOf(job);
  useEffect(() => {
    if (job?.type !== 'monitor' || job.status !== 'succeeded' || monitor) return;
    const timer = window.setInterval(() => {
      getJob(id).then((next) => {
        setJob(next);
        listNotifications(id).then(setNotices).catch(() => {});
      }).catch(() => {});
    }, 1500);
    return () => window.clearInterval(timer);
  }, [id, job?.type, job?.status, monitor]);

  const elapsed = job?.startedAt ? (job.finishedAt ? Date.parse(job.finishedAt) : now) - Date.parse(job.startedAt) : null;
  const runningOrder = [...view.experiments].reverse().find((item) => item.status === 'running')?.order;
  const pr = safeGithubUrl(view.prUrl || job?.prUrl);

  return (
    <LoadGate loading={loading && !job} error={error} onRetry={() => setReloadKey((value) => value + 1)}>
      {job && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm text-zinc-500">{projectName || 'Project'}</p>
              <h1 className="text-2xl font-medium tracking-tight">{formatRunTitle(job.type, job.startedAt)}</h1>
              <p className="mt-2" aria-live="polite" data-testid="job-status">
                <span className="inline-flex flex-wrap items-center gap-3">
                  <StatusIcon status={view.finished && view.ok === false ? 'failed' : job.status} />
                  <span className="tabular-nums text-sm text-zinc-500">{elapsed == null ? 'Waiting to start' : formatDuration(elapsed)}</span>
                </span>
              </p>
              <Link className="mt-2 inline-block text-sm text-indigo-700 dark:text-indigo-300" to={`/projects/${job.projectId}`}>Back to project</Link>
            </div>
            {(job.status === 'queued' || job.status === 'running') && <Button variant="danger" onClick={() => setConfirming(true)}>Cancel</Button>}
          </div>

          {fieldOf(job.result) && <FieldCard report={fieldOf(job.result)} />}
          {job.type === 'monitor' && (
            <Card testId="monitor-result">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-medium">Check</h2>
                <Badge tone={monitor?.status === 'regression' ? 'bad' : monitor?.status === 'breach' ? 'warn' : monitor?.status === 'ok' ? 'good' : 'neutral'}>{monitor?.status ?? job.status}</Badge>
              </div>
              {monitor?.comparisons && monitor.comparisons.length > 0 ? (
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="text-xs uppercase tracking-wide text-zinc-500">
                      <tr>
                        <th className="py-2 pr-3 font-medium">Metric</th>
                        <th className="py-2 pr-3 font-medium">Reference</th>
                        <th className="py-2 pr-3 font-medium">Now</th>
                        <th className="py-2 pr-3 font-medium">Change</th>
                        <th className="py-2 font-medium">Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {monitor.comparisons.map((row) => {
                        const quiet = row.verdict === 'unchanged';
                        const tone = row.breach ? 'text-red-700 dark:text-red-300' : row.verdict === 'regressed' ? 'text-amber-700 dark:text-amber-300' : quiet ? 'text-zinc-400' : '';
                        return (
                          <tr key={row.key} className={tone}>
                            <td className="py-2 pr-3">{row.label}</td>
                            <td className="py-2 pr-3 tabular-nums">{formatMetric(row.key, row.baselineMedian)}</td>
                            <td className="py-2 pr-3 tabular-nums">{formatMetric(row.key, row.candidateMedian)}</td>
                            <td className="py-2 pr-3 tabular-nums">{formatPercentChange(row.baselineMedian, row.candidateMedian)}</td>
                            <td className="py-2">{row.verdict}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="mt-3 text-sm text-zinc-500">{job.status === 'succeeded' ? 'Waiting for the comparison.' : 'The check has not finished.'}</p>
              )}
              <div className="mt-4 text-sm">
                <h3 className="font-medium">Suspects</h3>
                <p className="mt-1 text-zinc-600 dark:text-zinc-300">{monitor?.suspectText || 'No suspects recorded.'}</p>
                {monitor?.suspects && monitor.suspects.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {monitor.suspects.map((commit) => {
                      const href = safeGithubUrl(commit.url);
                      return <li key={commit.sha}>{href ? <a className="text-indigo-700 underline dark:text-indigo-300" href={href}>{commit.sha}</a> : <span>{commit.sha}</span>} {commit.message}</li>;
                    })}
                  </ul>
                )}
              </div>
            </Card>
          )}

          {job.type === 'audit' && !view.baseline && (job.status === 'queued' || job.status === 'running') && (
            <Card>
              <div className="flex items-center gap-2 text-sm"><Spinner /> Measuring the page and writing a plan.</div>
            </Card>
          )}

          {view.baseline && (
            <Card testId="baseline-card">
              <h2 className="text-lg font-medium">Baseline</h2>
              <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-5">
                {([['score', 'Score', view.baseline.score], ['lcp', 'LCP', view.baseline.lcp], ['tbt', 'TBT', view.baseline.tbt], ['cls', 'CLS', view.baseline.cls], ['weight', 'Weight', view.baseline.weight]] as const).map(([key, label, value]) => (
                  <div key={key}>
                    <dt className="text-xs uppercase tracking-wide text-zinc-500">{label}</dt>
                    <dd className="mt-1 tabular-nums text-lg">{formatMetric(key, value)}</dd>
                  </div>
                ))}
              </dl>
            </Card>
          )}

          {view.plan.length > 0 && (
            <Card testId="plan-card">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-medium">Plan</h2>
                <Badge tone="accent">{view.planSource === 'gemini' ? 'Gemini' : 'Built-in ranking'}</Badge>
              </div>
              {view.planNote && <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">{view.planNote}</p>}
              <ol className="mt-4 space-y-3">
                {view.plan.map((step) => (
                  <li key={`${step.order}-${step.fix}`} className="flex gap-3 text-sm">
                    <span className="tabular-nums text-zinc-400">{step.order}</span>
                    <span>
                      <span className="font-medium">{step.title}</span>
                      {step.rationale && <span className="mt-1 block text-zinc-600 dark:text-zinc-300">{step.rationale}</span>}
                    </span>
                  </li>
                ))}
              </ol>
            </Card>
          )}

          {view.experiments.length > 0 && (
            <div className="space-y-4">
              <h2 className="text-lg font-medium">Experiments</h2>
              {view.experiments.map((experiment) => (
                <ExperimentCard key={experiment.order} experiment={experiment} running={experiment.order === runningOrder} />
              ))}
            </div>
          )}

          {view.finished && (
            <Card id="result" testId="result-card">
              <h2 className="text-lg font-medium">Result</h2>
              {view.ok === false && (
                <div className="mt-3">
                  <p role="alert" className="text-sm text-red-700 dark:text-red-300">{view.error || job.error || 'The run failed.'}</p>
                  <Button className="mt-3" href={`/projects/${job.projectId}`}>Run again</Button>
                </div>
              )}
              {job.type === 'experiment' && view.ok !== false && (
                <p className="mt-3 text-sm font-medium">{view.counts?.kept ?? 0} proven runtime improvements</p>
              )}
              {view.counts && (
                <p className="mt-3 text-sm">
                  <span className="text-emerald-700 dark:text-emerald-300">{view.counts.kept} kept</span>
                  <span className="mx-2 text-zinc-300">·</span>
                  <span className="text-amber-700 dark:text-amber-300">{view.counts.reverted} reverted</span>
                  <span className="mx-2 text-zinc-300">·</span>
                  <span className="text-zinc-500">{view.counts.skipped} skipped</span>
                </p>
              )}
              {view.resultNote && <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">{view.resultNote}</p>}
              {view.baseline && view.final && (
                <div className="mt-4">
                  <p className="text-sm font-medium" data-testid="result-headline">{resultHeadline(headlineRows(view))}</p>
                  <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
                    <span className="inline-flex items-center gap-1.5"><span className="inline-block h-1.5 w-6 rounded-full bg-zinc-300 dark:bg-zinc-600" /> Before</span>
                    <span className="inline-flex items-center gap-1.5"><span className="inline-block h-1.5 w-6 rounded-full bg-emerald-600" /> After, improved</span>
                    <span className="inline-flex items-center gap-1.5"><span className="inline-block h-1.5 w-6 rounded-full bg-slate-400" /> After, unchanged</span>
                    <span className="inline-flex items-center gap-1.5"><span className="inline-block h-1.5 w-6 rounded-full bg-amber-500" /> After, regressed</span>
                  </div>
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="text-xs uppercase tracking-wide text-zinc-500">
                        <tr>
                          <th className="py-2 pr-3 font-medium">Metric</th>
                          <th className="py-2 pr-3 font-medium">Before</th>
                          <th className="py-2 pr-3 font-medium">After</th>
                          <th className="py-2 pr-3 font-medium">Change</th>
                          <th className="py-2 pr-3 font-medium"> </th>
                          <th className="py-2 font-medium">Result</th>
                        </tr>
                      </thead>
                      <tbody>
                        {RESULT_ROWS.map(([key, label]) => {
                          const before = view.baseline?.[key] ?? null;
                          const after = view.final?.[key] ?? null;
                          const verdict = verdictFor(view.finalMetrics, key);
                          const quiet = isQuietChange(before, after, verdict);
                          return (
                            <tr key={key} className={`border-t border-zinc-100 dark:border-zinc-800 ${quiet ? 'text-zinc-500' : ''}`}>
                              <td className="py-2 pr-3">{label}</td>
                              <td className="py-2 pr-3 tabular-nums">{formatMetric(metricKey(key), before)}</td>
                              <td className="py-2 pr-3 tabular-nums">{formatMetric(metricKey(key), after)}</td>
                              <td className="py-2 pr-3 tabular-nums">{before == null || after == null ? 'n/a' : formatPercentChange(before, after)}</td>
                              <td className="py-2 pr-3">{before != null && after != null ? <MetricBar before={before} after={after} verdict={verdict} /> : null}</td>
                              <td className="py-2">{verdict}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <p className="mt-2 text-xs text-zinc-500">Higher is better for score. Lower is better for LCP, FCP, TBT, CLS, Speed Index, page weight, and requests.</p>
                </div>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                {pr && <Button href={pr} target="_blank" rel="noopener noreferrer">View pull request</Button>}
                {view.ok !== false && <Button href={summaryMarkdownUrl(id)} variant="ghost">Download report (.md)</Button>}
                {view.ok !== false && <Button href={reportPdfUrl(id)} variant="ghost">Download PDF report</Button>}
              </div>
            </Card>
          )}

          <Card>
            <h2 className="text-lg font-medium">Notifications</h2>
            {notices.length === 0 ? <p className="mt-2 text-sm text-zinc-500">None yet.</p> : (
              <ul className="mt-3 space-y-2 text-sm">
                {notices.map((notice) => (
                  <li key={notice.id} className="flex flex-wrap gap-x-3 gap-y-1">
                    <span className="capitalize">{notice.channel}</span>
                    <span>{notice.kind}</span>
                    <span>{notice.status}</span>
                    <span className="tabular-nums text-zinc-500">{formatRelativeTime(notice.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <details className="rounded-xl bg-white p-4 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
            <summary className="cursor-pointer text-sm font-medium">Log</summary>
            <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap font-mono text-xs text-zinc-600 dark:text-zinc-300">{view.logs.slice(-300).join('\n') || 'No log lines yet.'}</pre>
          </details>

          <ConfirmDialog
            open={confirming}
            title="Cancel this run?"
            body="The worker stops and the run is marked cancelled."
            confirmLabel="Cancel run"
            danger
            onClose={() => setConfirming(false)}
            onConfirm={() => {
              cancelJob(id)
                .then((next) => setJob(next))
                .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : 'Could not cancel'))
                .finally(() => setConfirming(false));
            }}
          />
        </div>
      )}
    </LoadGate>
  );
}
