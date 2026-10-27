import type { Job, JobEvent, JobPatch, JobStatus, JobType, JobWithProject, Measurement, Project, ProjectInput } from '../types.js';

export interface ProjectStore {
  list(): Promise<Project[]>;
  get(id: string): Promise<Project | null>;
  findByName(name: string): Promise<Project | null>;
  create(input: ProjectInput): Promise<Project>;
  update(id: string, patch: Partial<ProjectInput>): Promise<Project | null>;
  delete(id: string): Promise<boolean>;
}

export interface JobStore {
  create(input: { projectId: string; type: JobType; params: Record<string, unknown> }): Promise<Job>;
  get(id: string): Promise<Job | null>;
  listByProject(projectId: string): Promise<Job[]>;
  listByStatus(status: JobStatus): Promise<Job[]>;
  listRecent(limit: number): Promise<JobWithProject[]>;
  update(id: string, patch: JobPatch): Promise<Job | null>;
}

export interface EventStore {
  append(jobId: string, type: string, payload: unknown): Promise<JobEvent>;
  list(jobId: string, afterId?: number): Promise<JobEvent[]>;
}

export interface MeasurementStore {
  insert(input: { projectId: string; jobId?: string | null; profile: string; metrics: unknown }): Promise<Measurement>;
  listByProject(projectId: string): Promise<Measurement[]>;
}

export interface Stores {
  projects: ProjectStore;
  jobs: JobStore;
  events: EventStore;
  measurements: MeasurementStore;
}
