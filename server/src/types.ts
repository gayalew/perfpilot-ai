export type ProjectMode = 'url' | 'repo';
export type JobType = 'audit' | 'optimize';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

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

export interface Job {
  id: string;
  projectId: string;
  type: JobType;
  status: JobStatus;
  params: Record<string, unknown>;
  result: unknown;
  prUrl: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface JobWithProject extends Job {
  projectName: string;
}

export interface JobPatch {
  status?: JobStatus;
  result?: unknown;
  prUrl?: string | null;
  error?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface JobEvent {
  id: number;
  jobId: string;
  ts: string;
  type: string;
  payload: unknown;
}

export interface Measurement {
  id: number;
  projectId: string;
  jobId: string | null;
  takenAt: string;
  profile: string;
  metrics: unknown;
}

export interface Notification {
  id: number;
  projectId: string;
  jobId: string | null;
  channel: 'email' | 'telegram';
  kind: string;
  status: 'sent' | 'failed' | 'dry-run';
  error: string | null;
  createdAt: string;
}

export interface NotificationInput {
  projectId: string;
  jobId?: string | null;
  channel: 'email' | 'telegram';
  kind: string;
  status: 'sent' | 'failed' | 'dry-run';
  error?: string | null;
}
