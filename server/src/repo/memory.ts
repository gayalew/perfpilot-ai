import { randomUUID } from 'node:crypto';
import type { Incident, Job, JobEvent, JobPatch, JobStatus, JobWithProject, Measurement, Notification, Project, ProjectInput } from '../types.js';
import type { EventStore, IncidentStore, JobStore, MeasurementStore, NotificationStore, ProjectStore, Stores } from './types.js';

function now(): string {
  return new Date().toISOString();
}

function projectFrom(id: string, input: ProjectInput, createdAt = now()): Project {
  return {
    id,
    name: input.name,
    mode: input.mode,
    url: input.url ?? null,
    repoOwner: input.repoOwner ?? null,
    repoName: input.repoName ?? null,
    baseBranch: input.baseBranch || 'main',
    rootDir: input.rootDir ?? '',
    notifyEmail: input.notifyEmail ?? null,
    telegramChatId: input.telegramChatId ?? null,
    scheduleCron: input.scheduleCron ?? null,
    createdAt,
  };
}

export function createMemoryStores(): Stores {
  const projects: Project[] = [];
  const jobs: Job[] = [];
  const events: JobEvent[] = [];
  const measurements: Measurement[] = [];
  const incidents: Incident[] = [];
  const notifications: Notification[] = [];
  let notificationId = 1;
  let eventId = 0;
  let measurementId = 0;

  const projectStore: ProjectStore = {
    async list() {
      return projects.map((project) => ({ ...project }));
    },
    async get(id) {
      return projects.find((project) => project.id === id) ?? null;
    },
    async findByName(name) {
      return projects.find((project) => project.name === name) ?? null;
    },
    async create(input) {
      const project = projectFrom(randomUUID(), input);
      projects.push(project);
      return project;
    },
    async update(id, patch) {
      const project = projects.find((item) => item.id === id);
      if (!project) return null;
      Object.assign(project, {
        ...patch,
        url: patch.url === undefined ? project.url : patch.url,
        repoOwner: patch.repoOwner === undefined ? project.repoOwner : patch.repoOwner,
        repoName: patch.repoName === undefined ? project.repoName : patch.repoName,
        baseBranch: patch.baseBranch || project.baseBranch,
        rootDir: patch.rootDir === undefined ? project.rootDir : patch.rootDir,
      });
      return { ...project };
    },
    async delete(id) {
      const index = projects.findIndex((project) => project.id === id);
      if (index < 0) return false;
      projects.splice(index, 1);
      const removed = new Set(jobs.filter((job) => job.projectId === id).map((job) => job.id));
      for (let i = jobs.length - 1; i >= 0; i -= 1) if (jobs[i]?.projectId === id) jobs.splice(i, 1);
      for (let i = events.length - 1; i >= 0; i -= 1) if (removed.has(events[i]?.jobId ?? '')) events.splice(i, 1);
      for (let i = measurements.length - 1; i >= 0; i -= 1) if (measurements[i]?.projectId === id) measurements.splice(i, 1);
      return true;
    },
  };

  const jobStore: JobStore = {
    async create(input) {
      const job: Job = {
        id: randomUUID(),
        projectId: input.projectId,
        type: input.type,
        status: 'queued',
        params: input.params,
        result: null,
        prUrl: null,
        error: null,
        createdAt: now(),
        startedAt: null,
        finishedAt: null,
      };
      jobs.push(job);
      return job;
    },
    async get(id) {
      const job = jobs.find((item) => item.id === id);
      return job ? { ...job, params: { ...job.params } } : null;
    },
    async listByProject(projectId) {
      return jobs.filter((job) => job.projectId === projectId).map((job) => ({ ...job }));
    },
    async listByStatus(status: JobStatus) {
      return jobs.filter((job) => job.status === status).map((job) => ({ ...job }));
    },
    async listRecent(limit: number): Promise<JobWithProject[]> {
      return [...jobs]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit)
        .map((job) => ({ ...job, projectName: projects.find((project) => project.id === job.projectId)?.name ?? '' }));
    },
    async update(id, patch: JobPatch) {
      const job = jobs.find((item) => item.id === id);
      if (!job) return null;
      if (patch.status !== undefined) job.status = patch.status;
      if (patch.result !== undefined) job.result = patch.result;
      if (patch.prUrl !== undefined) job.prUrl = patch.prUrl;
      if (patch.error !== undefined) job.error = patch.error;
      if (patch.startedAt !== undefined) job.startedAt = patch.startedAt;
      if (patch.finishedAt !== undefined) job.finishedAt = patch.finishedAt;
      return { ...job };
    },
  };

  const eventStore: EventStore = {
    async append(jobId, type, payload) {
      eventId += 1;
      const event: JobEvent = { id: eventId, jobId, ts: now(), type, payload };
      events.push(event);
      return event;
    },
    async list(jobId, afterId = 0) {
      return events.filter((event) => event.jobId === jobId && event.id > afterId);
    },
  };

  const measurementStore: MeasurementStore = {
    async insert(input) {
      measurementId += 1;
      const row: Measurement = {
        id: measurementId,
        projectId: input.projectId,
        jobId: input.jobId ?? null,
        takenAt: now(),
        profile: input.profile,
        metrics: input.metrics,
        status: input.status ?? 'ok',
        compared: input.compared ?? null,
        samples: input.samples ?? null,
        medians: input.medians ?? null,
        field: input.field ?? null,
      };
      measurements.push(row);
      return row;
    },
    async listByProject(projectId) {
      return measurements.filter((row) => row.projectId === projectId);
    },
  };

  const incidentStore: IncidentStore = {
    async insert(input) {
      const row: Incident = {
        id: randomUUID(),
        projectId: input.projectId,
        openedAt: now(),
        closedAt: null,
        firstMeasurementId: input.firstMeasurementId,
        lastMeasurementId: input.lastMeasurementId,
        alertSentAt: null,
        recoverySentAt: null,
        details: input.details,
      };
      incidents.push(row);
      return { ...row };
    },
    async update(id, patch) {
      const row = incidents.find((item) => item.id === id);
      if (!row) return null;
      if (patch.closedAt !== undefined) row.closedAt = patch.closedAt;
      if (patch.lastMeasurementId !== undefined) row.lastMeasurementId = patch.lastMeasurementId;
      if (patch.alertSentAt !== undefined) row.alertSentAt = patch.alertSentAt;
      if (patch.recoverySentAt !== undefined) row.recoverySentAt = patch.recoverySentAt;
      if (patch.details !== undefined) row.details = patch.details;
      return { ...row };
    },
    async listByProject(projectId) {
      return incidents.filter((item) => item.projectId === projectId).map((item) => ({ ...item }));
    },
    async openForProject(projectId) {
      const row = incidents.find((item) => item.projectId === projectId && !item.closedAt);
      return row ? { ...row } : null;
    },
  };

  const notificationStore: NotificationStore = {
    async insert(input) {
      const row: Notification = {
        id: notificationId++,
        projectId: input.projectId,
        jobId: input.jobId ?? null,
        channel: input.channel,
        kind: input.kind,
        status: input.status,
        error: input.error ?? null,
        createdAt: now(),
      };
      notifications.push(row);
      return row;
    },
    async listByJob(jobId) {
      return notifications.filter((row) => row.jobId === jobId);
    },
  };

  return { projects: projectStore, jobs: jobStore, events: eventStore, measurements: measurementStore, incidents: incidentStore, notifications: notificationStore };
}
