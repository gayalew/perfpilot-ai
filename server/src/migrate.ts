import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { loadConfig } from './config.js';
import { createPool } from './repo/postgres.js';

export async function applyMigrations(pool: pg.Pool, dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations')): Promise<string[]> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const files = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const filename of files) {
    const seen = await pool.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [filename]);
    if (seen.rowCount) continue;
    const sql = await readFile(path.join(dir, filename), 'utf8');
    await pool.query('BEGIN');
    try {
      await pool.query(sql);
      await pool.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
      await pool.query('COMMIT');
      applied.push(filename);
    } catch (err) {
      await pool.query('ROLLBACK');
      throw err;
    }
  }
  return applied;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  try {
    const applied = await applyMigrations(pool);
    console.log(applied.length ? `applied ${applied.join(', ')}` : 'migrations up to date');
  } finally {
    await pool.end();
  }
}

const isDirect = process.argv[1] ? path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)) : false;
if (isDirect) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : 'migration failed';
    console.error(message);
    process.exit(1);
  });
}
