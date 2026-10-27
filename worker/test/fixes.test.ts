import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { validateSiteConfig, type SiteConfig } from '../src/config.js';
import type { Finding, FixId } from '../src/diagnose.js';
import { AiEditor } from '../src/ai-edit.js';
import { compressText, reportOnly } from '../src/fixes/ai.js';
import { deferScripts, imageDimensions, lazyLoadImages, minifyAssets, optimizeImages, preloadLcpImage } from '../src/fixes/deterministic.js';
import type { ApplyContext } from '../src/fixes/types.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function finding(fix: FixId, items: Finding['items']): Finding {
  return { auditId: fix, title: fix, fix, savingsMs: 10, savingsBytes: 0, metrics: ['lcp'], items, priority: 1 };
}

async function site(files: Record<string, string | Buffer>): Promise<{ dir: string; config: SiteConfig; ctx: (fix: Finding) => ApplyContext }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'perfpilot-fix-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body);
  }
  const config = validateSiteConfig({ startCommand: 'node server.mjs', publicDir: 'public', serverFile: 'server.mjs', paths: ['/'] });
  return { dir, config, ctx: (item) => ({ dir, config, finding: item }) };
}

test('defer-scripts adds defer only to classic head scripts and is idempotent', async () => {
  const html = `<!doctype html><html><head>
<script src="/js/vendor.js"></script>
<script src="/js/mod.js" type="module"></script>
<script src="/js/async.js" async></script>
<script>if (a < b) console.log('ok')</script>
</head><body><script src="/js/app.js"></script></body></html>`;
  const fixture = await site({ 'public/index.html': html });
  const item = finding('defer-scripts', [{ url: 'http://local/js/vendor.js' }]);
  const first = await deferScripts.apply(fixture.ctx(item));
  assert.equal(first.applied, true);
  const $ = cheerio.load(await readFile(path.join(fixture.dir, 'public/index.html'), 'utf8'));
  assert.equal($('script[src="/js/vendor.js"]').attr('defer') !== undefined, true);
  assert.equal($('script[src="/js/mod.js"]').attr('defer'), undefined);
  assert.equal($('script[src="/js/async.js"]').attr('defer'), undefined);
  assert.equal($('script[src="/js/app.js"]').attr('defer'), undefined);
  assert.match($('script:not([src])').text(), /a < b/);
  const second = await deferScripts.apply(fixture.ctx(item));
  assert.equal(second.applied, false);
});

test('lazy-load-images marks finding images and skips the hero', async () => {
  const html = `<!doctype html><html><body>
<section class="hero"><img src="/img/hero.png"></section>
<img src="/img/g1.png"><img src="/img/other.png">
</body></html>`;
  const fixture = await site({ 'public/index.html': html });
  const item = finding('lazy-load-images', [{ url: 'http://local/img/g1.png' }, { url: 'http://local/img/hero.png' }]);
  const result = await lazyLoadImages.apply(fixture.ctx(item));
  assert.equal(result.applied, true);
  const $ = cheerio.load(await readFile(path.join(fixture.dir, 'public/index.html'), 'utf8'));
  assert.equal($('.hero img').attr('loading'), undefined);
  assert.equal($('img[src="/img/g1.png"]').attr('loading'), 'lazy');
  assert.equal($('img[src="/img/g1.png"]').attr('decoding'), 'async');
  assert.equal($('img[src="/img/other.png"]').attr('loading'), undefined);
  assert.equal((await lazyLoadImages.apply(fixture.ctx(item))).applied, false);
});

test('preload-lcp-image removes lazy, sets fetchpriority, and adds one preload', async () => {
  const html = `<!doctype html><html><head></head><body>
<section class="hero"><img src="/img/hero.png" loading="lazy"></section>
</body></html>`;
  const fixture = await site({ 'public/index.html': html });
  const item = finding('preload-lcp-image', [{ detail: 'body > section.hero > img' }]);
  const result = await preloadLcpImage.apply(fixture.ctx(item));
  assert.equal(result.applied, true);
  const $ = cheerio.load(await readFile(path.join(fixture.dir, 'public/index.html'), 'utf8'));
  assert.equal($('.hero img').attr('loading'), undefined);
  assert.equal($('.hero img').attr('fetchpriority'), 'high');
  assert.equal($('head link[rel="preload"][as="image"]').length, 1);
  assert.equal($('head link[rel="preload"]').attr('href'), '/img/hero.png');
  assert.equal((await preloadLcpImage.apply(fixture.ctx(item))).applied, false);
});

test('image-dimensions sets intrinsic size and skips images that already have both', async () => {
  const html = `<!doctype html><html><body>
<img src="/img/photo.png"><img src="/img/photo.png" width="9" height="9"><img src="https://cdn.example/a.png">
</body></html>`;
  const fixture = await site({ 'public/index.html': html, 'public/img/photo.png': PNG });
  const result = await imageDimensions.apply(fixture.ctx(finding('image-dimensions', [])));
  assert.equal(result.applied, true);
  const $ = cheerio.load(await readFile(path.join(fixture.dir, 'public/index.html'), 'utf8'));
  const imgs = $('img').toArray();
  assert.equal($(imgs[0]).attr('width'), '1');
  assert.equal($(imgs[0]).attr('height'), '1');
  assert.match($(imgs[0]).attr('style') ?? '', /height:\s*auto/);
  assert.equal($(imgs[1]).attr('width'), '9');
  assert.equal($(imgs[2]).attr('src'), 'https://cdn.example/a.png');
  assert.equal((await imageDimensions.apply(fixture.ctx(finding('image-dimensions', [])))).applied, false);
});

test('optimize-images writes WebP beside the original and rewrites references', async () => {
  const fixture = await site({
    'public/index.html': '<!doctype html><html><body><img src="/img/photo.png"></body></html>',
    'public/css/app.css': 'body { background: url(/img/photo.png); }',
    'public/img/photo.png': PNG,
    'server.mjs': "const types = {\n  '.png': 'image/png',\n};\n",
  });
  const result = await optimizeImages.apply(fixture.ctx(finding('optimize-images', [{ url: 'http://local/img/photo.png' }])));
  assert.equal(result.applied, true);
  const html = await readFile(path.join(fixture.dir, 'public/index.html'), 'utf8');
  const css = await readFile(path.join(fixture.dir, 'public/css/app.css'), 'utf8');
  assert.match(html, /photo\.webp/);
  assert.doesNotMatch(html, /photo\.png/);
  assert.match(css, /photo\.webp/);
  await readFile(path.join(fixture.dir, 'public/img/photo.png'));
  const webp = await readFile(path.join(fixture.dir, 'public/img/photo.webp'));
  assert.ok(webp.byteLength > 0);
  const server = await readFile(path.join(fixture.dir, 'server.mjs'), 'utf8');
  assert.match(server, /\.webp/);
  assert.equal((await optimizeImages.apply(fixture.ctx(finding('optimize-images', [{ url: 'http://local/img/photo.png' }])))).applied, false);
});

test('minify-assets minifies the finding files in place', async () => {
  const fixture = await site({
    'public/js/app.js': '/* comment */\nfunction hello() { return 1; }\n',
    'public/css/app.css': '/* comment */\nbody { color: red; }\n',
  });
  const result = await minifyAssets.apply(
    fixture.ctx(finding('minify-assets', [{ url: 'http://local/js/app.js' }, { url: 'http://local/css/app.css' }])),
  );
  assert.equal(result.applied, true);
  const js = await readFile(path.join(fixture.dir, 'public/js/app.js'), 'utf8');
  const css = await readFile(path.join(fixture.dir, 'public/css/app.css'), 'utf8');
  assert.equal(js.includes('comment'), false);
  assert.equal(css.includes('comment'), false);
  assert.match(js, /hello/);
  assert.equal((await minifyAssets.apply(fixture.ctx(finding('minify-assets', [{ url: 'http://local/js/app.js' }])))).applied, false);
});

test('report-only and disabled AI fixes do not change files', async () => {
  const fixture = await site({ 'server.mjs': 'export {};\n' });
  const reported = await reportOnly('preconnect').apply(fixture.ctx(finding('preconnect', [])));
  assert.equal(reported.applied, false);
  assert.equal(reported.skippedReason, 'not auto-fixable; reported only');
  const ai = await compressText.apply({ ...fixture.ctx(finding('compress-text', [])), ai: new AiEditor({ disabled: true }) });
  assert.equal(ai.applied, false);
  assert.equal(ai.skippedReason, 'needs AI');
});
