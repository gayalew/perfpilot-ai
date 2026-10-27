import pg from 'pg';
import type { Incident, Job, JobEvent, JobPatch, JobStatus, JobType, JobWithProject, Measurement, MeasurementStatus, Project, ProjectInput, ProjectMode } from '../types.js';
import type { Stores } from './types.js';

const { Pool } = pg;

function sslFor(url: string): pg.ConnectionConfig['ssl'] {
  if (/localhost|127\.0\.0\.1/i.test(url)) return undefined;
  return { rejectUnauthorized: false };
}

export function createPool(databaseUrl: string): pg.Pool {
  const pool = new Pool({ connectionString: databaseUrl, ssl: sslFor(databaseUrl) });
  pool.on('error', (err) => {
    const code = 'code' in err && err.code ? String(err.code) : 'error';
    console.error(`database pool error (${code})`);
  });
  return pool;
}

function projectRow(row: Record<string, unknown>): Project {
  return {
    id: String(row.id),
    name: String(row.name),
    mode: row.mode as ProjectMode,
    url: (row.url as string | null) ?? null,
    repoOwner: (row.repo_owner as string | null) ?? null,
    repoName: (row.repo_name as string | null) ?? null,
    baseBranch: String(row.base_branch ?? 'main'),
    rootDir: String(row.root_dir ?? ''),
    notifyEmail: (row.notify_email as string | null) ?? null,
    telegramChatId: (row.telegram_chat_id as string | null) ?? null,
    scheduleCron: (row.schedule_cron as string | null) ?? null,
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

function jobRow(row: Record<string, unknown>): Job {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    type: row.type as JobType,
    status: row.status as JobStatus,
    params: (row.params as Record<string, unknown>) ?? {},
    result: row.result ?? null,
    prUrl: (row.pr_url as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    createdAt: new Date(String(row.created_at)).toISOString(),
    startedAt: row.started_at ? new Date(String(row.started_at)).toISOString() : null,
    finishedAt: row.finished_at ? new Date(String(row.finished_at)).toISOString() : null,
  };
}

export function createPgStores(pool: pg.Pool): Stores {
  return {
    projects: {
      async list() {
        const result = await pool.query('SELECT * FROM projects ORDER BY created_at');
        return result.rows.map((row) => projectRow(row));
      },
      async get(id) {
        const result = await pool.query('SELECT * FROM projects WHERE id = $1', [id]);
        return result.rows[0] ? projectRow(result.rows[0]) : null;
      },
      async findByName(name) {
        const result = await pool.query('SELECT * FROM projects WHERE name = $1 LIMIT 1', [name]);
        return result.rows[0] ? projectRow(result.rows[0]) : null;
      },
      async create(input: ProjectInput) {
        const result = await pool.query(
          `INSERT INTO projects (name, mode, url, repo_owner, repo_name, base_branch, root_dir, notify_email, telegram_chat_id, schedule_cron)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [
            input.name,
            input.mode,
            input.url ?? null,
            input.repoOwner ?? null,
            input.repoName ?? null,
            input.baseBranch || 'main',
            input.rootDir ?? '',
            input.notifyEmail ?? null,
            input.telegramChatId ?? null,
            input.scheduleCron ?? null,
          ],
        );
        return projectRow(result.rows[0]);
      },
      async update(id, patch) {
        const current = await pool.query('SELECT * FROM projects WHERE id = $1', [id]);
        if (!current.rows[0]) return null;
        const merged = { ...projectRow(current.rows[0]), ...patch };
        const result = await pool.query(
          `UPDATE projects SET name=$2, mode=$3, url=$4, repo_owner=$5, repo_name=$6, base_branch=$7, root_dir=$8,
             notify_email=$9, telegram_chat_id=$10, schedule_cron=$11 WHERE id=$1 RETURNING *`,
          [
            id,
            merged.name,
            merged.mode,
            merged.url ?? null,
            merged.repoOwner ?? null,
            merged.repoName ?? null,
            merged.baseBranch || 'main',
            merged.rootDir ?? '',
            merged.notifyEmail ?? null,
            merged.telegramChatId ?? null,
            merged.scheduleCron ?? null,
          ],
        );
        return projectRow(result.rows[0]);
      },
      async delete(id) {
        const result = await pool.query('DELETE FROM projects WHERE id = $1', [id]);
        return (result.rowCount ?? 0) > 0;
      },
    },
    jobs: {
      async create(input) {
        const result = await pool.query(
          `INSERT INTO jobs (project_id, type, status, params) VALUES ($1,$2,'queued',$3::jsonb) RETURNING *`,
          [input.projectId, input.type, JSON.stringify(input.params)],
        );
        return jobRow(result.rows[0]);
      },
      async get(id) {
        const result = await pool.query('SELECT * FROM jobs WHERE id = $1', [id]);
        return result.rows[0] ? jobRow(result.rows[0]) : null;
      },
      async listByProject(projectId) {
        const result = await pool.query('SELECT * FROM jobs WHERE project_id = $1 ORDER BY created_at', [projectId]);
        return result.rows.map((row) => jobRow(row));
      },
      async listByStatus(status) {
        const result = await pool.query('SELECT * FROM jobs WHERE status = $1 ORDER BY created_at', [status]);
        return result.rows.map((row) => jobRow(row));
      },
      async listRecent(limit: number): Promise<JobWithProject[]> {
        const result = await pool.query(
          `SELECT j.*, p.name AS project_name FROM jobs j JOIN projects p ON p.id = j.project_id ORDER BY j.created_at DESC LIMIT $1`,
          [limit],
        );
        return result.rows.map((row) => ({ ...jobRow(row), projectName: String(row.project_name ?? '') }));
      },
      async update(id, patch: JobPatch) {
        const current = await pool.query('SELECT * FROM jobs WHERE id = $1', [id]);
        if (!current.rows[0]) return null;
        const job = jobRow(current.rows[0]);
        const next = { ...job, ...patch };
        const result = await pool.query(
          `UPDATE jobs SET status=$2, params=$3::jsonb, result=$4::jsonb, pr_url=$5, error=$6, started_at=$7, finished_at=$8
           WHERE id=$1 RETURNING *`,
          [
            id,
            next.status,
            JSON.stringify(next.params),
            next.result === null || next.result === undefined ? null : JSON.stringify(next.result),
            next.prUrl,
            next.error,
            next.startedAt,
            next.finishedAt,
          ],
        );
        return jobRow(result.rows[0]);
      },
    },
    events: {
      async append(jobId, type, payload) {
        const result = await pool.query(
          `INSERT INTO job_events (job_id, type, payload) VALUES ($1,$2,$3::jsonb) RETURNING *`,
          [jobId, type, JSON.stringify(payload ?? {})],
        );
        const row = result.rows[0];
        return {
          id: Number(row.id),
          jobId: String(row.job_id),
          ts: new Date(String(row.ts)).toISOString(),
          type: String(row.type),
          payload: row.payload,
        } satisfies JobEvent;
      },
      async list(jobId, afterId = 0) {
        const result = await pool.query('SELECT * FROM job_events WHERE job_id = $1 AND id > $2 ORDER BY id', [jobId, afterId]);
        return result.rows.map((row) => ({
          id: Number(row.id),
          jobId: String(row.job_id),
          ts: new Date(String(row.ts)).toISOString(),
          type: String(row.type),
          payload: row.payload,
        }));
      },
    },
    measurements: {
      async insert(input) {
        const result = await pool.query(
          `INSERT INTO measurements (project_id, job_id, profile, metrics, status, compared, samples, medians, field)
           VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb) RETURNING *`,
          [
            input.projectId,
            input.jobId ?? null,
            input.profile,
            JSON.stringify(input.metrics ?? {}),
            input.status ?? 'ok',
            input.compared == null ? null : JSON.stringify(input.compared),
            input.samples == null ? null : JSON.stringify(input.samples),
            input.medians == null ? null : JSON.stringify(input.medians),
            input.field == null ? null : JSON.stringify(input.field),
          ],
        );
        return mapMeasurement(result.rows[0]);
      },
      async listByProject(projectId) {
        const result = await pool.query('SELECT * FROM measurements WHERE project_id = $1 ORDER BY id', [projectId]);
        return result.rows.map((row) => mapMeasurement(row));
      },
    },
    incidents: {
      async insert(input) {
        const result = await pool.query(
          `INSERT INTO incidents (project_id, first_measurement_id, last_measurement_id, details)
           VALUES ($1,$2,$3,$4::jsonb) RETURNING *`,
          [input.projectId, input.firstMeasurementId, input.lastMeasurementId, JSON.stringify(input.details ?? {})],
        );
        return mapIncident(result.rows[0]);
      },
      async update(id, patch) {
        const current = await pool.query('SELECT * FROM incidents WHERE id = $1', [id]);
        if (!current.rows[0]) return null;
        const row = current.rows[0] as Record<string, unknown>;
        const result = await pool.query(
          `UPDATE incidents SET closed_at = $2, last_measurement_id = $3, alert_sent_at = $4, recovery_sent_at = $5, details = $6::jsonb WHERE id = $1 RETURNING *`,
          [
            id,
            patch.closedAt === undefined ? row.closed_at : patch.closedAt,
            patch.lastMeasurementId === undefined ? row.last_measurement_id : patch.lastMeasurementId,
            patch.alertSentAt === undefined ? row.alert_sent_at : patch.alertSentAt,
            patch.recoverySentAt === undefined ? row.recovery_sent_at : patch.recoverySentAt,
            JSON.stringify(patch.details === undefined ? row.details ?? {} : patch.details),
          ],
        );
        return mapIncident(result.rows[0]);
      },
      async listByProject(projectId) {
        const result = await pool.query('SELECT * FROM incidents WHERE project_id = $1 ORDER BY opened_at', [projectId]);
        return result.rows.map((row) => mapIncident(row));
      },
      async openForProject(projectId) {
        const result = await pool.query('SELECT * FROM incidents WHERE project_id = $1 AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1', [projectId]);
        return result.rows[0] ? mapIncident(result.rows[0]) : null;
      },
    },
    notifications: {
      async insert(input) {
        const result = await pool.query(
          `INSERT INTO notifications (project_id, job_id, channel, kind, status, error) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [input.projectId, input.jobId ?? null, input.channel, input.kind, input.status, input.error ?? null],
        );
        return mapNotification(result.rows[0]);
      },
      async listByJob(jobId) {
        const result = await pool.query('SELECT * FROM notifications WHERE job_id = $1 ORDER BY id', [jobId]);
        return result.rows.map((row) => mapNotification(row));
      },
    },
  };
}

function mapMeasurement(row: Record<string, unknown>): Measurement {
  const status = String(row.status ?? 'ok') as MeasurementStatus;
  return {
    id: Number(row.id),
    projectId: String(row.project_id),
    jobId: row.job_id ? String(row.job_id) : null,
    takenAt: new Date(String(row.taken_at)).toISOString(),
    profile: String(row.profile),
    metrics: row.metrics,
    status,
    compared: row.compared ?? null,
    samples: row.samples ?? null,
    medians: row.medians ?? null,
    field: row.field ?? null,
  };
}

function mapIncident(row: Record<string, unknown>): Incident {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    openedAt: new Date(String(row.opened_at)).toISOString(),
    closedAt: row.closed_at ? new Date(String(row.closed_at)).toISOString() : null,
    firstMeasurementId: row.first_measurement_id == null ? null : Number(row.first_measurement_id),
    lastMeasurementId: row.last_measurement_id == null ? null : Number(row.last_measurement_id),
    alertSentAt: row.alert_sent_at ? new Date(String(row.alert_sent_at)).toISOString() : null,
    recoverySentAt: row.recovery_sent_at ? new Date(String(row.recovery_sent_at)).toISOString() : null,
    details: row.details ?? {},
  };
}

function mapNotification(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    projectId: String(row.project_id),
    jobId: row.job_id ? String(row.job_id) : null,
    channel: String(row.channel) as 'email' | 'telegram',
    kind: String(row.kind),
    status: String(row.status) as 'sent' | 'failed' | 'dry-run',
    error: row.error ? String(row.error) : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}
