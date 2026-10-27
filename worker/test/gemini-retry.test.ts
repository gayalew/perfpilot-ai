import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { geminiGenerate, retryDelayMs } from '../src/gemini.js';
import { AiEditor } from '../src/ai-edit.js';

const ok = (text: string, status = 200, headers?: Record<string, string>) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status, headers });

test('retryDelayMs uses Retry-After seconds, then 1s and 3s', () => {
  assert.equal(retryDelayMs(0, { get: () => '2' }), 2000);
  assert.equal(retryDelayMs(0, { get: () => null }), 1000);
  assert.equal(retryDelayMs(1, { get: () => null }), 3000);
});

test('geminiGenerate retries 503 and 429 and then succeeds', async () => {
  const waits: number[] = [];
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (calls === 1) return new Response('no', { status: 503, headers: { 'retry-after': '0' } });
    if (calls === 2) return new Response('no', { status: 429 });
    return ok('{"ok":true}');
  }) as typeof fetch;
  const text = await geminiGenerate('sys', 'user', {
    apiKey: 'k',
    model: 'm',
    fetchImpl,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  assert.equal(text, '{"ok":true}');
  assert.equal(calls, 3);
  assert.deepEqual(waits, [0, 3000]);
});

test('geminiGenerate stops after three network failures', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    throw new Error('socket hang up');
  }) as typeof fetch;
  await assert.rejects(
    geminiGenerate('sys', 'user', { apiKey: 'k', model: 'm', fetchImpl, sleep: async () => undefined }),
    /socket hang up/,
  );
  assert.equal(calls, 3);
});

test('a retried edit counts as one budget call', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'perfpilot-retry-'));
  await mkdir(path.join(dir, 'public'), { recursive: true });
  const file = path.join(dir, 'public', 'app.js');
  await writeFile(file, 'const n = 1;\n', 'utf8');
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (calls === 1) return new Response('busy', { status: 503 });
    return ok(JSON.stringify({ content: 'const n = 2;\n' }));
  }) as typeof fetch;
  const ai = new AiEditor({ apiKey: 'k', model: 'm', fetchImpl, sleep: async () => undefined, maxCalls: 12 });
  const result = await ai.editFile({
    filePath: file,
    instruction: 'increment',
    findingData: '{}',
    allowedFiles: [file],
    publicDirAbs: path.join(dir, 'public'),
  });
  assert.equal(result.ok, true);
  assert.equal(ai.calls, 1);
  assert.equal(calls, 2);
});
