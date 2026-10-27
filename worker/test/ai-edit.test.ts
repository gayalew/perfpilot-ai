import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AiEditor } from '../src/ai-edit.js';

function reply(text: string, status = 200): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    const body = String(init?.body ?? '');
    assert.equal(href.includes('SECRET123'), false);
    assert.equal(body.includes('SECRET123'), false);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status });
  }) as typeof fetch;
}

async function editor(text: string, fileBody: string): Promise<{ editor: AiEditor; file: string; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'perfpilot-ai-'));
  const file = path.join(dir, 'public', 'app.js');
  await writeFile(file, fileBody, 'utf8').catch(async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, fileBody, 'utf8');
  });
  return {
    dir,
    file,
    editor: new AiEditor({ apiKey: 'SECRET123', model: 'gemini-test', fetchImpl: reply(text) }),
  };
}

test('AiEditor accepts a small JSON edit', async () => {
  const { editor: ai, file, dir } = await editor('{"content":"const n = 2;\\n"}', 'const n = 1;\n');
  const result = await ai.editFile({
    filePath: file,
    instruction: 'increment',
    findingData: '{}',
    allowedFiles: [file],
    publicDirAbs: path.join(dir, 'public'),
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.content, 'const n = 2;\n');
  assert.equal(ai.calls, 1);
});

test('AiEditor rejects invalid JSON, oversized diffs, and forbidden paths', async () => {
  const bad = await editor('not-json', 'const n = 1;\n');
  const invalid = await bad.editor.editFile({
    filePath: bad.file,
    instruction: 'increment',
    findingData: '{}',
    allowedFiles: [bad.file],
    publicDirAbs: path.join(bad.dir, 'public'),
  });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.skippedReason, 'reply is not valid JSON');

  const lines = Array.from({ length: 100 }, (_, i) => `other ${i}`).join('\n');
  const huge = await editor(JSON.stringify({ content: lines }), 'const n = 1;\n');
  const oversized = await huge.editor.editFile({
    filePath: huge.file,
    instruction: 'rewrite',
    findingData: '{}',
    allowedFiles: [huge.file],
    publicDirAbs: path.join(huge.dir, 'public'),
  });
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.equal(oversized.skippedReason, 'diff exceeds 80 changed lines');

  const forbidden = await editor('{"content":"x"}', 'const n = 1;\n');
  const outside = path.join(forbidden.dir, 'secret.txt');
  await writeFile(outside, 'token\n', 'utf8');
  const rejected = await forbidden.editor.editFile({
    filePath: outside,
    instruction: 'nope',
    findingData: '{}',
    allowedFiles: [forbidden.file],
    publicDirAbs: path.join(forbidden.dir, 'public'),
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.skippedReason, 'file is not on the allowed list');
  assert.equal(forbidden.editor.calls, 0);
});

test('a disabled editor returns needs AI and does not call Gemini', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'perfpilot-ai-'));
  const file = path.join(dir, 'app.js');
  await writeFile(file, 'const n = 1;\n', 'utf8');
  let called = false;
  const ai = new AiEditor({
    disabled: true,
    apiKey: 'SECRET123',
    model: 'gemini-test',
    fetchImpl: (async () => {
      called = true;
      return new Response('{}');
    }) as typeof fetch,
  });
  const result = await ai.editFile({
    filePath: file,
    instruction: 'increment',
    findingData: '{}',
    allowedFiles: [file],
    publicDirAbs: dir,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.skippedReason, 'needs AI');
  assert.equal(called, false);
  assert.equal(ai.calls, 0);
});
