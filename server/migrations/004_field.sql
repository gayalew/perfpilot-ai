ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_type_check CHECK (type IN ('audit', 'optimize', 'monitor', 'experiment', 'field'));

ALTER TABLE measurements ADD COLUMN IF NOT EXISTS field jsonb;
