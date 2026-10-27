import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getProjectSummary, listJobs, listProjects, type Job, type Project, type ProjectSummary } from '../api.ts';
import { Badge } from '../components/Badge.tsx';
import { Button } from '../components/Button.tsx';
import { Card } from '../components/Card.tsx';
import { GithubLink } from '../components/GithubLink.tsx';
import { LoadGate } from '../components/QueryState.tsx';
import { StatusIcon } from '../components/StatusIcon.tsx';
import { formatDuration, formatRelativeTime } from '../format.ts';
import { monitorStatusLabel } from '../monitor.ts';

interface DashboardData {
  projects: Project[];
  summaries: ProjectSummary[];
  jobs: Job[];
}

function durationOf(job: Job): string {
  if (!job.startedAt) return 'n/a';
  const end = job.finishedAt ? Date.parse(job.finishedAt) : Date.now();
  return formatDuration(end - Date.parse(job.startedAt));
}

export function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    listProjects()
      .then(async (projects) => {
        const [jobs, summaries] = await Promise.all([listJobs(20), Promise.all(projects.map((project) => getProjectSummary(project.id)))]);
        setData({ projects, jobs, summaries });
      })
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : 'Could not load the dashboard'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-medium tracking-tight">Projects</h1>
        <Button href="/projects/new">New project</Button>
      </div>
      <LoadGate loading={loading} error={error} onRetry={load}>
        {data && data.projects.length === 0 ? (
          <Card>
            <h2 className="text-lg font-medium">No projects yet</h2>
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">Create your first project to measure a URL or optimize a repository.</p>
            <Button className="mt-4" href="/projects/new">Create your first project</Button>
          </Card>
        ) : data && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              {data.projects.map((project, index) => {
                const summary = data.summaries[index];
                const last = summary?.lastJob;
                return (
                  <Card key={project.id} testId="project-card">
                    <div className="flex items-start justify-between gap-3">
                      <h2 className="text-lg font-medium">{project.name}</h2>
                      <span className="flex flex-wrap justify-end gap-2">
                        <Badge tone="accent">{project.mode === 'repo' ? 'Repo' : 'URL'}</Badge>
                        {summary?.monitor && (
                          <Badge tone={summary.monitor.incidentOpen ? 'bad' : summary.monitor.latestStatus === 'breach' ? 'warn' : summary.monitor.latestStatus === 'ok' ? 'good' : 'neutral'}>
                            {monitorStatusLabel({
                              minHistory: summary.monitor.minHistory,
                              baselineCount: summary.monitor.baselineCount,
                              latestStatus: summary.monitor.latestStatus,
                              incidentOpen: summary.monitor.incidentOpen,
                            })}
                          </Badge>
                        )}
                      </span>
                    </div>
                    <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-300">
                      {last ? (
                        <span className="inline-flex flex-wrap items-center gap-2">
                          <StatusIcon status={last.status} />
                          <span className="tabular-nums text-zinc-500">{formatRelativeTime(last.createdAt)}</span>
                        </span>
                      ) : 'No runs yet'}
                    </p>
                    <div className="mt-4 flex items-center justify-between gap-3">
                      {summary?.lastPrUrl ? <GithubLink url={summary.lastPrUrl}>Last pull request</GithubLink> : <span className="text-sm text-zinc-400">No pull request</span>}
                      <Button href={`/projects/${project.id}`} variant="ghost">Open</Button>
                    </div>
                  </Card>
                );
              })}
            </div>
            <h2 className="mb-3 mt-10 text-lg font-medium">Recent runs</h2>
            {data.jobs.length === 0 ? <p className="text-sm text-zinc-500">No runs yet.</p> : (
              <div className="overflow-x-auto rounded-xl bg-white ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs uppercase tracking-wide text-zinc-500">
                    <tr>
                      <th className="px-4 py-3 font-medium">Project</th>
                      <th className="px-4 py-3 font-medium">Type</th>
                      <th className="px-4 py-3 font-medium">Status</th>
                      <th className="px-4 py-3 font-medium">Duration</th>
                      <th className="px-4 py-3 font-medium">When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.jobs.map((job) => (
                      <tr key={job.id} className="border-t border-zinc-100 dark:border-zinc-800">
                        <td className="px-4 py-3"><Link className="hover:underline" to={`/jobs/${job.id}`}>{job.projectName || 'Project'}</Link></td>
                        <td className="px-4 py-3 capitalize">{job.type}</td>
                        <td className="px-4 py-3"><StatusIcon status={job.status} /></td>
                        <td className="px-4 py-3 tabular-nums">{durationOf(job)}</td>
                        <td className="px-4 py-3 tabular-nums text-zinc-500">{formatRelativeTime(job.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </LoadGate>
    </div>
  );
}
