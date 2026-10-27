CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('url', 'repo')),
  url text,
  repo_owner text,
  repo_name text,
  base_branch text NOT NULL DEFAULT 'main',
  root_dir text NOT NULL DEFAULT '',
  notify_email text,
  telegram_chat_id text,
  schedule_cron text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('audit', 'optimize')),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb,
  pr_url text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);

CREATE TABLE IF NOT EXISTS job_events (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  ts timestamptz NOT NULL DEFAULT now(),
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS job_events_job_id_id_idx ON job_events (job_id, id);

CREATE TABLE IF NOT EXISTS measurements (
  id bigserial PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  taken_at timestamptz NOT NULL DEFAULT now(),
  profile text NOT NULL,
  metrics jsonb NOT NULL
);
