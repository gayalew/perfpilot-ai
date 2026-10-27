import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { createJob, deleteProject, getProject, listProjectJobs, notifyTest, type Job, type JobType, type Project } from '../api.ts';
import { Badge } from '../components/Badge.tsx';
import { Button } from '../components/Button.tsx';
import { Card } from '../components/Card.tsx';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { GithubLink } from '../components/GithubLink.tsx';
import { LoadGate } from '../components/QueryState.tsx';
import { StatusIcon } from '../components/StatusIcon.tsx';
import { useToast } from '../components/Toast.tsx';
import { estimateMinutes, formatDuration, formatRelativeTime } from '../format.ts';

function targetOf(project: Project): string {
  if (project.mode === 'url') return project.url || 'No URL';
  const repo = `${project.repoOwner ?? ''}/${project.repoName ?? ''}`;
  return project.rootDir ? `${repo} · ${project.rootDir}` : repo;
}

export function ProjectPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [project, setProject] = useState<Project | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [type, setType] = useState<JobType>('audit');
  const [runs, setRuns] = useState(4);
  const [maxSteps, setMaxSteps] = useState(8);
  const [useAi, setUseAi] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [runError, setRunError] = useState('');
  const [notifyBusy, setNotifyBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([getProject(id), listProjectJobs(id)])
      .then(([nextProject, nextJobs]) => {
        setProject(nextProject);
        setJobs([...nextJobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
        if (nextProject.mode === 'url') setType('audit');
      })
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : 'Could not load the project'))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const active = jobs.find((job) => job.status === 'queued' || job.status === 'running');
  const minutes = estimateMinutes(type, runs, maxSteps);

  async function start() {
    setBusy(true);
    setRunError('');
    try {
      const job = await createJob(id, { type, runs, maxSteps, useAi });
      navigate(`/jobs/${job.id}`);
    } catch (caught) {
      setRunError(caught instanceof Error ? caught.message : 'Could not start the run');
    } finally {
      setBusy(false);
    }
  }

  return (
    <LoadGate loading={loading} error={error} onRetry={load}>
      {project && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-medium tracking-tight">{project.name}</h1>
                <Badge tone="accent">{project.mode === 'repo' ? 'Repo' : 'URL'}</Badge>
              </div>
              <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">{targetOf(project)}</p>
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" disabled={notifyBusy} onClick={() => {
                setNotifyBusy(true);
                notifyTest(project.id)
                  .then((result) => {
                    const line = (name: string, row: { status: string; error?: string }) => `${name}: ${row.status}${row.error ? ` (${row.error})` : ''}`;
                    toast(`${line('Email', result.email)}. ${line('Telegram', result.telegram)}.`);
                  })
                  .catch((caught: unknown) => toast(caught instanceof Error ? caught.message : 'Could not send the test'))
                  .finally(() => setNotifyBusy(false));
              }}>{notifyBusy ? 'Sending…' : 'Send test notification'}</Button>
              <Button href={`/projects/${project.id}/edit`} variant="ghost">Edit</Button>
              <Button variant="danger" onClick={() => setConfirming(true)}>Delete</Button>
            </div>
          </div>
          <Card>
            <h2 className="text-lg font-medium">Run</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <fieldset>
                <legend className="text-sm font-medium">Type</legend>
                <label className="mt-2 flex items-start gap-2 text-sm">
                  <input type="radio" name="type" checked={type === 'audit'} onChange={() => setType('audit')} />
                  <span><span className="font-medium">Audit</span> — measure and diagnose</span>
                </label>
                <label className={`mt-2 flex items-start gap-2 text-sm ${project.mode === 'url' ? 'opacity-60' : ''}`}>
                  <input type="radio" name="type" checked={type === 'optimize'} disabled={project.mode === 'url'} onChange={() => setType('optimize')} />
                  <span><span className="font-medium">Optimize</span> — apply and prove fixes. Repo mode only.</span>
                </label>
              </fieldset>
              <div>
                <label htmlFor="runs" className="text-sm font-medium">Runs per side: <span className="tabular-nums">{runs}</span></label>
                <input id="runs" className="mt-2 w-full accent-indigo-600" type="range" min={4} max={10} value={runs} onChange={(event) => setRuns(Number(event.target.value))} />
                <p className="mt-1 text-sm text-zinc-500">About {minutes} minutes</p>
                <label htmlFor="steps" className="mt-4 block text-sm font-medium">Max steps: <span className="tabular-nums">{maxSteps}</span></label>
                <input id="steps" className="mt-2 w-full accent-indigo-600" type="range" min={1} max={12} value={maxSteps} onChange={(event) => setMaxSteps(Number(event.target.value))} />
                <label className="mt-4 flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={useAi} onChange={(event) => setUseAi(event.target.checked)} />
                  Use AI fixes
                </label>
              </div>
            </div>
            {active && (
              <p className="mt-4 text-sm">
                A run is already {active.status}. <Link className="text-indigo-700 underline dark:text-indigo-300" to={`/jobs/${active.id}`}>Open it</Link>
              </p>
            )}
            {runError && <p role="alert" className="mt-3 text-sm text-red-700">{runError}</p>}
            <Button className="mt-4" data-testid="run-start" disabled={busy} onClick={() => void start()}>{busy ? 'Starting…' : 'Start'}</Button>
          </Card>
          <div>
            <h2 className="mb-3 text-lg font-medium">Run history</h2>
            {jobs.length === 0 ? <p className="text-sm text-zinc-500">No runs yet.</p> : (
              <div className="overflow-x-auto rounded-xl bg-white ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
                <table className="w-full min-w-[40rem] text-left text-sm">
                  <thead className="text-xs uppercase tracking-wide text-zinc-500">
                    <tr>
                      <th className="px-4 py-3 font-medium">Type</th>
                      <th className="px-4 py-3 font-medium">Status</th>
                      <th className="px-4 py-3 font-medium">Started</th>
                      <th className="px-4 py-3 font-medium">Duration</th>
                      <th className="px-4 py-3 font-medium">Pull request</th>
                      <th className="px-4 py-3 font-medium"> </th>
                    </tr>
                  </thead>
                  <tbody>
                    {jobs.map((job) => {
                      const duration = job.startedAt ? formatDuration((job.finishedAt ? Date.parse(job.finishedAt) : Date.now()) - Date.parse(job.startedAt)) : 'n/a';
                      return (
                        <tr key={job.id} className="border-t border-zinc-100 dark:border-zinc-800">
                          <td className="px-4 py-3 capitalize">{job.type}</td>
                          <td className="px-4 py-3"><StatusIcon status={job.status} /></td>
                          <td className="px-4 py-3 tabular-nums">{job.startedAt ? formatRelativeTime(job.startedAt) : formatRelativeTime(job.createdAt)}</td>
                          <td className="px-4 py-3 tabular-nums">{duration}</td>
                          <td className="px-4 py-3">{job.prUrl ? <GithubLink url={job.prUrl}>View</GithubLink> : '—'}</td>
                          <td className="px-4 py-3"><Link className="text-indigo-700 dark:text-indigo-300" data-testid="history-view" to={`/jobs/${job.id}`}>View</Link></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <ConfirmDialog
            open={confirming}
            title="Delete this project?"
            body="Runs already recorded stay in the database, and the project disappears from the dashboard."
            confirmLabel="Delete"
            danger
            onClose={() => setConfirming(false)}
            onConfirm={() => {
              deleteProject(project.id)
                .then(() => navigate('/'))
                .catch((caught: unknown) => toast(caught instanceof Error ? caught.message : 'Could not delete the project'))
                .finally(() => setConfirming(false));
            }}
          />
        </div>
      )}
    </LoadGate>
  );
}
