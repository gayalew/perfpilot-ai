import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadSiteConfig, validateSiteConfig } from '../src/config.js';

test('validateSiteConfig fills defaults', () => {
  const config = validateSiteConfig(undefined);
  assert.deepEqual(config.paths, ['/']);
  assert.equal(config.buildCommand, '');
  assert.equal(config.port, 4200);
  assert.equal(config.publicDir, 'public');
});

test('validateSiteConfig accepts a site file and rejects bad values', () => {
  const config = validateSiteConfig({
    installCommand: '',
    buildCommand: '',
    startCommand: 'node server.mjs',
    port: 4200,
    paths: ['/'],
    publicDir: 'public',
    serverFile: 'server.mjs',
  });
  assert.equal(config.startCommand, 'node server.mjs');
  assert.throws(() => validateSiteConfig({ port: 0 }), /port/);
  assert.throws(() => validateSiteConfig({ paths: [] }), /paths/);
  assert.throws(() => validateSiteConfig({ publicDir: '../secret' }), /publicDir/);
  assert.throws(() => validateSiteConfig([]), /JSON object/);
});

test('loadSiteConfig uses defaults when the file is missing and rejects broken JSON', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'perfpilot-config-'));
  const missing = await loadSiteConfig(dir);
  assert.deepEqual(missing.paths, ['/']);
  await writeFile(path.join(dir, 'perfpilot.config.json'), '{', 'utf8');
  await assert.rejects(loadSiteConfig(dir), /not valid JSON/);
});
