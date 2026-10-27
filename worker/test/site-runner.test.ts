import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateSiteConfig } from '../src/config.js';
import { startSite } from '../src/site-runner.js';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

test('startSite serves the command and stop kills the process tree', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'perfpilot-site-'));
  const port = await freePort();
  await writeFile(
    path.join(dir, 'server.mjs'),
    `import http from 'node:http';
const port = Number(process.env.PORT);
http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); }).listen(port, '127.0.0.1');
`,
    'utf8',
  );
  const config = validateSiteConfig({ startCommand: 'node server.mjs', port, paths: ['/'], publicDir: '.', serverFile: 'server.mjs' });
  const site = await startSite(dir, config, port);
  assert.equal(site.url, `http://127.0.0.1:${port}/`);
  const body = await (await fetch(site.url)).text();
  assert.equal(body, 'ok');
  await site.stop();
  await assert.rejects(fetch(site.url, { signal: AbortSignal.timeout(1500) }));
});
