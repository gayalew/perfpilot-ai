import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createPool, createPgStores } from './repo/postgres.js';
import type { ProjectInput } from './types.js';

async function upsert(stores: ReturnType<typeof createPgStores>, input: ProjectInput): Promise<void> {
  const existing = await stores.projects.findByName(input.name);
  if (existing) {
    const updated = await stores.projects.update(existing.id, input);
    console.log(updated?.id ?? existing.id);
    return;
  }
  const created = await stores.projects.create(input);
  console.log(created.id);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const stores = createPgStores(pool);
  try {
    await upsert(stores, {
      name: 'Demo site (repo mode)',
      mode: 'repo',
      repoOwner: config.demoRepoOwner,
      repoName: config.demoRepoName,
      baseBranch: 'main',
      rootDir: 'demo-site',
    });
    await upsert(stores, {
      name: 'Demo site (URL mode)',
      mode: 'url',
      url: 'http://localhost:4200/',
    });
  } finally {
    await pool.end();
  }
}

const isDirect = process.argv[1] ? path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)) : false;
if (isDirect) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : 'seed failed';
    console.error(message);
    process.exit(1);
  });
}
