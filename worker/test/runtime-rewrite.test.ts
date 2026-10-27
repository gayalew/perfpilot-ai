import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { rewriteDocument, sameOrigin, transformResponse } from '../src/runtime/rewrite.js';
import { startRuntimeProxy } from '../src/runtime/proxy.js';

const page = `<!doctype html><html><head><script src="/vendor.js"></script><script type="module" src="/app.js"></script><link rel="stylesheet" href="/base.css"></head><body><img class="hero" src="/img/hero.png"><img src="/img/g1.png"></body></html>`;

test('defer-scripts adds defer and leaves modules alone', () => {
  const result = rewriteDocument(page, 'defer-scripts');
  assert.equal(result.changed, true);
  const vendor = result.html.match(/<script[^>]*vendor\.js[^>]*>/i)?.[0] ?? '';
  const moduleScript = result.html.match(/<script[^>]*type="module"[^>]*>/i)?.[0] ?? '';
  assert.match(vendor, /defer/);
  assert.doesNotMatch(moduleScript, /defer/);
});

test('lazy-load and dimensions only touch the named images', () => {
  const lazy = rewriteDocument(page, 'lazy-load-images', [{ url: 'https://example.com/img/g1.png' }]);
  assert.match(lazy.html, /src="\/img\/g1\.png"[^>]*loading="lazy"/);
  assert.doesNotMatch(lazy.html, /hero\.png"[^>]*loading="lazy"/);
  const sized = rewriteDocument(page, 'image-dimensions', [{ url: '/img/g1.png', width: 900, height: 600 }]);
  assert.match(sized.html, /g1\.png"[^>]*width="900"/);
  const unchanged = rewriteDocument(page, 'image-dimensions', [{ url: '/img/g1.png' }]);
  assert.equal(unchanged.changed, false);
});

test('preload and preconnect add the missing links', () => {
  const preload = rewriteDocument(page, 'preload-lcp-image');
  assert.match(preload.html, /rel="preload" as="image" href="\/img\/hero\.png"/);
  const preconnect = rewriteDocument(page, 'preconnect', [{ url: 'https://cdn.example/lib.js' }]);
  assert.match(preconnect.html, /rel="preconnect" href="https:\/\/cdn\.example"/);
});

test('sameOrigin stays on the target origin', () => {
  assert.equal(sameOrigin('http://127.0.0.1:9/slow', '/css/base.css'), 'http://127.0.0.1:9/css/base.css');
  assert.equal(sameOrigin('http://127.0.0.1:9/', 'https://evil.example/'), null);
});

test('compress-text gzips a text body and leaves images', async () => {
  const text = await transformResponse({ fix: 'compress-text', contentType: 'text/html', body: Buffer.from('hello'), accept: '' });
  assert.equal(text.encoding, 'gzip');
  assert.equal(gunzipSync(text.body).toString(), 'hello');
  const image = await transformResponse({ fix: 'compress-text', contentType: 'image/png', body: Buffer.from('png'), accept: '' });
  assert.equal(image.encoding, undefined);
});

test('the proxy applies a runtime fix to a real response', async () => {
  const origin = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page);
  });
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', () => resolve()));
  const port = (origin.address() as AddressInfo).port;
  const proxy = await startRuntimeProxy({ target: `http://127.0.0.1:${port}/`, fix: 'defer-scripts' });
  try {
    const res = await fetch(proxy.url);
    const html = await res.text();
    assert.match(html.match(/<script[^>]*vendor\.js[^>]*>/i)?.[0] ?? '', /defer/);
  } finally {
    await proxy.close();
    await new Promise((resolve) => origin.close(resolve));
  }
});
