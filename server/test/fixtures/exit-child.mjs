import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
rl.once('line', (line) => {
  const spec = JSON.parse(line);
  if (process.env.ORDER_FILE) appendFileSync(process.env.ORDER_FILE, `${spec.jobId}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'job-start', payload: { jobId: spec.jobId } })}\n`);
  process.stdout.write('token is SECRET_VALUE\n');
  process.stdout.write(`${JSON.stringify({ type: 'job-end', payload: { ok: true, jobId: spec.jobId } })}\n`);
  process.exit(0);
});
