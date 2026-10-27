import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { applyMigrations } from './migrate.js';
import { createPool } from './repo/postgres.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  try {
    await pool.query('SELECT 1');
    await applyMigrations(pool);
    console.log('OK');
  } finally {
    await pool.end();
  }
}

const isDirect = process.argv[1] ? path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)) : false;
if (isDirect) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : 'database check failed';
    console.error(message);
    process.exit(1);
  });
}
