import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
rl.once('line', () => {
  process.stdout.write(`${JSON.stringify({ type: 'job-start', payload: { ok: true } })}\n`);
  setInterval(() => undefined, 1000);
});
