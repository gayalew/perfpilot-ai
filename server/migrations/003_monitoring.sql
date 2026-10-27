ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_type_check CHECK (type IN ('audit', 'optimize', 'monitor'));

ALTER TABLE measurements ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ok';
ALTER TABLE measurements DROP CONSTRAINT IF EXISTS measurements_status_check;
ALTER TABLE measurements ADD CONSTRAINT measurements_status_check CHECK (status IN ('ok', 'learning', 'breach', 'regression'));
ALTER TABLE measurements ADD COLUMN IF NOT EXISTS compared jsonb;
ALTER TABLE measurements ADD COLUMN IF NOT EXISTS samples jsonb;
ALTER TABLE measurements ADD COLUMN IF NOT EXISTS medians jsonb;

CREATE TABLE IF NOT EXISTS incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  first_measurement_id bigint REFERENCES measurements(id) ON DELETE SET NULL,
  last_measurement_id bigint REFERENCES measurements(id) ON DELETE SET NULL,
  alert_sent_at timestamptz,
  recovery_sent_at timestamptz,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS incidents_project_id_idx ON incidents (project_id, opened_at);
