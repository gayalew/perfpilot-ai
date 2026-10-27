export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const base = import.meta.env.VITE_API_URL ?? '';

export type ProjectMode = 'url' | 'repo';
export type JobType = 'audit' | 'optimize';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface Project {
  id: string;
  name: string;
  mode: ProjectMode;
  url: string | null;
  repoOwner: string | null;
  repoName: string | null;
  baseBranch: string;
  rootDir: string;
  notifyEmail: string | null;
  telegramChatId: string | null;
  scheduleCron: string | null;
  createdAt: string;
}

export interface ProjectInput {
  name: string;
  mode: ProjectMode;
  url?: string | null;
  repoOwner?: string | null;
  repoName?: string | null;
  baseBranch?: string;
  rootDir?: string;
  notifyEmail?: string | null;
  telegramChatId?: string | null;
  scheduleCron?: string | null;
}

export interface Job {
  id: string;
  projectId: string;
  projectName?: string;
  type: JobType;
  status: JobStatus;
  params: { runs?: number; maxSteps?: number; useAi?: boolean };
  result: unknown;
  prUrl: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ProjectSummary {
  lastJob: Job | null;
  lastSucceededOptimize: Job | null;
  lastPrUrl: string | null;
  jobCount: number;
}

async function request<T>(path: string, init?: RequestInit, redirect401 = true): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const res = await fetch(`${base}${path}`, { ...init, headers, credentials: 'include' });
  if (res.status === 401 && redirect401 && location.pathname !== '/login') {
    location.assign('/login');
  }
  if (!res.ok) {
    let message = res.statusText || 'request failed';
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === 'string' && body.error) message = body.error;
    } catch {
      /* the body was not JSON */
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export function login(password: string): Promise<{ ok: boolean }> {
  return request('/api/login', { method: 'POST', body: JSON.stringify({ password }) }, false);
}

export function logout(): Promise<{ ok: boolean }> {
  return request('/api/logout', { method: 'POST' });
}

export function me(): Promise<{ ok: boolean }> {
  return request('/api/me');
}

export function listProjects(): Promise<Project[]> {
  return request('/api/projects');
}

export function getProject(id: string): Promise<Project> {
  return request(`/api/projects/${id}`);
}

export function createProject(input: ProjectInput): Promise<Project> {
  return request('/api/projects', { method: 'POST', body: JSON.stringify(input) });
}

export function updateProject(id: string, input: ProjectInput): Promise<Project> {
  return request(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export function deleteProject(id: string): Promise<{ ok: boolean }> {
  return request(`/api/projects/${id}`, { method: 'DELETE' });
}

export function getProjectSummary(id: string): Promise<ProjectSummary> {
  return request(`/api/projects/${id}/summary`);
}

export function createJob(projectId: string, input: { type: JobType; runs: number; maxSteps: number; useAi: boolean }): Promise<Job> {
  return request(`/api/projects/${projectId}/jobs`, { method: 'POST', body: JSON.stringify(input) });
}

export function listProjectJobs(projectId: string): Promise<Job[]> {
  return request(`/api/projects/${projectId}/jobs`);
}

export function listJobs(limit = 20): Promise<Job[]> {
  return request(`/api/jobs?limit=${limit}`);
}

export function getJob(id: string): Promise<Job> {
  return request(`/api/jobs/${id}`);
}

export function cancelJob(id: string): Promise<Job> {
  return request(`/api/jobs/${id}/cancel`, { method: 'POST' });
}

export function getLedger(id: string): Promise<unknown> {
  return request(`/api/jobs/${id}/ledger`);
}

export function summaryMarkdownUrl(id: string): string {
  return `${base}/api/jobs/${id}/summary.md`;
}

export function eventsUrl(id: string): string {
  return `${base}/api/jobs/${id}/events`;
}
