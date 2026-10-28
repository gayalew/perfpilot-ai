import { test } from 'node:test';
import assert from 'node:assert/strict';
import { privateTargetsAllowed, targetUrlError } from '../../shared/target-url.js';

const production = { NODE_ENV: 'production' };
const development = { NODE_ENV: 'development' };

test('private targets follow NODE_ENV unless ALLOW_PRIVATE_TARGETS is set', () => {
  assert.equal(privateTargetsAllowed(production), false);
  assert.equal(privateTargetsAllowed(development), true);
  assert.equal(privateTargetsAllowed({}), true);
  assert.equal(privateTargetsAllowed({ ...production, ALLOW_PRIVATE_TARGETS: '1' }), true);
  assert.equal(privateTargetsAllowed({ ...development, ALLOW_PRIVATE_TARGETS: '0' }), false);
});

test('target URLs accept public http(s) and reject credentials, schemes, and length', async () => {
  const lookup = async () => ['93.184.216.34'];
  assert.equal(await targetUrlError('https://example.com/path', { env: production, lookup }), null);
  assert.match(await targetUrlError('ftp://example.com/', { env: production, lookup }) ?? '', /only http and https/);
  assert.match(await targetUrlError('http://user:pass@example.com/', { env: production, lookup }) ?? '', /credentials/);
  assert.match(await targetUrlError(`http://example.com/${'a'.repeat(2048)}`, { env: production, lookup }) ?? '', /too long/);
  assert.match(await targetUrlError('not a url', { env: production, lookup }) ?? '', /not valid/);
});

test('link-local and cloud metadata targets are always rejected', async () => {
  const allow = { ...production, ALLOW_PRIVATE_TARGETS: '1' };
  assert.match(await targetUrlError('http://169.254.169.254/', { env: allow }) ?? '', /link-local and cloud metadata/);
  assert.match(await targetUrlError('http://[fd00:ec2::254]/', { env: allow }) ?? '', /link-local and cloud metadata/);
  assert.match(await targetUrlError('http://metadata.google.internal/', { env: allow }) ?? '', /link-local and cloud metadata/);
  assert.match(await targetUrlError('http://METADATA.GOOGLE.INTERNAL./', { env: allow }) ?? '', /link-local and cloud metadata/);
  const mapped = async () => ['::ffff:169.254.169.254'];
  assert.match(await targetUrlError('http://rebind.example/', { env: allow, lookup: mapped }) ?? '', /link-local and cloud metadata/);
});

test('private ranges are rejected only when private targets are off', async () => {
  const lookup = async () => ['10.1.2.3'];
  assert.match(await targetUrlError('http://internal.example/', { env: production, lookup }) ?? '', /private targets are not allowed/);
  assert.equal(await targetUrlError('http://internal.example/', { env: development, lookup }), null);
  assert.match(await targetUrlError('http://127.0.0.1:4200/', { env: production }) ?? '', /private targets are not allowed/);
  assert.equal(await targetUrlError('http://127.0.0.1:4200/', { env: development }), null);
  assert.match(await targetUrlError('http://[::1]/', { env: production }) ?? '', /private targets are not allowed/);
  const mixed = async () => ['93.184.216.34', '192.168.1.9'];
  assert.match(await targetUrlError('http://mixed.example/', { env: production, lookup: mixed }) ?? '', /private targets are not allowed/);
  assert.equal(await targetUrlError('http://mixed.example/', { env: development, lookup: mixed }), null);
});

test('an unresolvable host is rejected', async () => {
  const lookup = async () => {
    throw new Error('ENOTFOUND');
  };
  assert.match(await targetUrlError('http://missing.example/', { env: production, lookup }) ?? '', /did not resolve/);
});
