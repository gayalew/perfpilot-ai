CREATE TABLE IF NOT EXISTS notifications (
  id bigserial PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  channel text NOT NULL CHECK (channel IN ('email', 'telegram')),
  kind text NOT NULL,
  status text NOT NULL CHECK (status IN ('sent', 'failed', 'dry-run')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_job_id_idx ON notifications (job_id);
