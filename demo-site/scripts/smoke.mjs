// Smoke test: starts the server, requests the page and every asset it references, expects HTTP 200.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('..', import.meta.url));
const port = 4299;
const server = spawn(process.execPath, ['server.mjs'], { cwd: dir, env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
const base = `http://localhost:${port}`;
const fail = (m) => { console.error('FAIL', m); server.kill(); process.exit(1); };

await new Promise((r) => setTimeout(r, 800));
try {
  const html = await (await fetch(base + '/')).text();
  if (!html.includes('Trailhead Coffee')) fail('home page missing title');
  const refs = [...html.matchAll(/(?:src|href)="(\/[^"#]+)"/g)].map((m) => m[1]);
  for (const ref of refs) {
    const res = await fetch(base + ref);
    if (res.status !== 200) fail(`${ref} returned ${res.status}`);
  }
  console.log(`smoke ok: ${refs.length} assets`);
  server.kill();
} catch (e) {
  fail(String(e));
}
