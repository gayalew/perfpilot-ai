import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { changedFiles, commitAll, git, headSha, prepareWorkdir, resetHard } from '../src/repo.js';

async function fixture(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'perfpilot-repo-'));
  await mkdir(path.join(dir, 'public'), { recursive: true });
  await mkdir(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
  await mkdir(path.join(dir, 'runs'), { recursive: true });
  await writeFile(path.join(dir, 'public', 'index.html'), '<p>hi</p>', 'utf8');
  await writeFile(path.join(dir, 'node_modules', 'pkg', 'skip.txt'), 'nope', 'utf8');
  await writeFile(path.join(dir, 'runs', 'old.txt'), 'nope', 'utf8');
  return dir;
}

test('prepareWorkdir copies into a fresh repo and leaves the original alone', async () => {
  const source = await fixture();
  const runDir = await mkdtemp(path.join(tmpdir(), 'perfpilot-run-'));
  const prepared = await prepareWorkdir(source, runDir);
  assert.equal(prepared.workDir, path.join(runDir, 'work'));
  assert.match(prepared.branch, /^perfpilot\/optimize-/);
  await assert.rejects(access(path.join(source, '.git')));
  const html = await readFile(path.join(prepared.workDir, 'public', 'index.html'), 'utf8');
  assert.equal(html, '<p>hi</p>');
  await assert.rejects(access(path.join(prepared.workDir, 'node_modules', 'pkg', 'skip.txt')));
  await assert.rejects(access(path.join(prepared.workDir, 'runs', 'old.txt')));
  const name = await git(prepared.workDir, ['config', '--local', '--get', 'user.name']);
  assert.equal(name.stdout.trim(), 'PerfPilot');
  const email = await git(prepared.workDir, ['config', '--local', '--get', 'user.email']);
  assert.equal(email.stdout.trim(), 'perfpilot@users.noreply.github.com');
});

test('commitAll, resetHard, and changedFiles round-trip', async () => {
  const source = await fixture();
  const runDir = await mkdtemp(path.join(tmpdir(), 'perfpilot-run-'));
  const { workDir } = await prepareWorkdir(source, runDir);
  const before = await headSha(workDir);
  await writeFile(path.join(workDir, 'public', 'index.html'), '<p>next</p>', 'utf8');
  await writeFile(path.join(workDir, 'extra.txt'), 'new', 'utf8');
  const dirty = await changedFiles(workDir);
  assert.ok(dirty.some((file) => file.includes('index.html')));
  assert.ok(dirty.some((file) => file.includes('extra.txt')));
  const sha = await commitAll(workDir, 'perfpilot: test\n\nkept');
  assert.notEqual(sha, before);
  await writeFile(path.join(workDir, 'public', 'index.html'), '<p>bad</p>', 'utf8');
  await writeFile(path.join(workDir, 'junk.txt'), 'junk', 'utf8');
  await resetHard(workDir);
  assert.equal(await readFile(path.join(workDir, 'public', 'index.html'), 'utf8'), '<p>next</p>');
  await assert.rejects(access(path.join(workDir, 'junk.txt')));
  assert.deepEqual(await changedFiles(workDir), []);
});
