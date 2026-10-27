const ALLOWED = ['Demo site (URL mode)', 'Monitor localhost'];

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--confirm')) {
  console.error('Refusing to reset. The only accepted flag is --confirm.');
  process.exit(1);
}
if (!args.includes('--confirm')) {
  console.error('Refusing to reset. Re-run with --confirm.');
  process.exit(1);
}

const url = (process.env.DATABASE_URL ?? '').trim();
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const pg = await import('pg');
const Client = pg.default?.Client ?? pg.Client;
const client = new Client({ connectionString: url });
await client.connect();
try {
  const found = await client.query('select id, name from projects where name = any($1::text[])', [ALLOWED]);
  if (found.rowCount === 0) {
    console.error('No allowed demo project was found.');
    process.exitCode = 1;
  } else {
  await client.query('begin');
  for (const project of found.rows) {
    if (!ALLOWED.includes(project.name)) throw new Error('refusing an unexpected project');
    const jobs = await client.query(
      `update jobs set status = 'cancelled', finished_at = now(), error = null
       where project_id = $1 and status in ('queued', 'running')`,
      [project.id],
    );
    const incidents = await client.query('delete from incidents where project_id = $1', [project.id]);
    const measurements = await client.query('delete from measurements where project_id = $1', [project.id]);
    console.log(`${project.name}: cancelled ${jobs.rowCount} jobs, deleted ${measurements.rowCount} measurements, deleted ${incidents.rowCount} incidents`);
  }
  await client.query('commit');
  }
} catch (err) {
  await client.query('rollback').catch(() => undefined);
  console.error(err instanceof Error ? 'reset failed' : 'reset failed');
  process.exitCode = 1;
} finally {
  await client.end();
}
