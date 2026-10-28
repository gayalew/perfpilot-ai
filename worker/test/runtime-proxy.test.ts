import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { startRuntimeProxy } from '../src/runtime/proxy.js';

function listen(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<{ server: Server; origin: string }> {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('no port');
      resolve({ server, origin: `http://127.0.0.1:${address.port}` });
    });
  });
}

test('a same-origin redirect is rewritten onto the proxy and a cross-origin redirect is blocked', async () => {
  const upstream = await listen((req, res) => {
    const path = req.url ?? '/';
    if (path.startsWith('/next')) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('arrived');
      return;
    }
    if (path.startsWith('/away')) {
      res.writeHead(302, { location: 'https://evil.example/steal' });
      res.end();
      return;
    }
    res.writeHead(302, { location: '/next' });
    res.end();
  });
  const proxy = await startRuntimeProxy({ target: `${upstream.origin}/`, fix: 'defer-scripts' });
  try {
    const same = await fetch(proxy.url, { redirect: 'manual' });
    assert.equal(same.status, 302);
    const location = same.headers.get('location') ?? '';
    const rewritten = new URL(location);
    assert.equal(rewritten.origin, new URL(proxy.url).origin);
    assert.equal(rewritten.pathname, '/next');
    assert.equal(rewritten.searchParams.get('__pp_hop'), '1');
    const followed = await fetch(location);
    assert.equal(followed.status, 200);
    assert.equal(await followed.text(), 'arrived');

    const blocked = await fetch(`${proxy.url.replace(/\/$/, '')}/away`, { redirect: 'manual' });
    assert.equal(blocked.status, 502);
    assert.equal(await blocked.text(), 'blocked redirect');
    assert.deepEqual(proxy.notes, ['blocked redirect']);
  } finally {
    await proxy.close();
    await new Promise((resolve) => upstream.server.close(resolve));
  }
});

test('the proxy stops a redirect chain at five hops', async () => {
  const upstream = await listen((_req, res) => {
    res.writeHead(302, { location: '/again' });
    res.end();
  });
  const proxy = await startRuntimeProxy({ target: `${upstream.origin}/`, fix: 'defer-scripts' });
  try {
    const capped = await fetch(`${proxy.url}?__pp_hop=5`, { redirect: 'manual' });
    assert.equal(capped.status, 502);
    assert.equal(await capped.text(), 'blocked redirect');
    const still = await fetch(`${proxy.url}?__pp_hop=4`, { redirect: 'manual' });
    assert.equal(still.status, 302);
    assert.equal(new URL(still.headers.get('location') ?? '').searchParams.get('__pp_hop'), '5');
  } finally {
    await proxy.close();
    await new Promise((resolve) => upstream.server.close(resolve));
  }
});
