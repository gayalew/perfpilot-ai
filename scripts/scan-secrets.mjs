import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const patterns = [
  new RegExp('AI' + 'za[0-9A-Za-z\\-_]{35,}'),
  new RegExp('gh' + 'p_[0-9A-Za-z]{20,}'),
  new RegExp('github' + '_pat_[0-9A-Za-z_]{22,}'),
  new RegExp('re' + '_[0-9A-Za-z]{20,}'),
  new RegExp('\\d{8,10}:[A-Za-z0-9_\\-]{30,}'),
  new RegExp('postgres(?:ql)?:\\/\\/[^:\\s\\/"]+:[^@\\s\\/"]+@'),
  new RegExp(`${'-'.repeat(5)}BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY${'-'.repeat(5)}`),
];

const skip = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.zip', '.woff', '.woff2', '.ico']);

function hits(text) {
  return patterns.some((pattern) => pattern.test(text));
}

function scanText(text) {
  const lines = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (hits(line)) lines.push(index + 1);
  });
  return lines;
}

function git(args) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd: root });
    const out = [];
    const err = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
  });
}

const listed = await git(['ls-files', '-z']);
if (listed.code !== 0) {
  console.error('secret scan could not list tracked files');
  process.exit(1);
}
const files = listed.stdout.split('\0').filter(Boolean);
const locations = [];
for (const file of files) {
  if (skip.has(path.extname(file).toLowerCase())) continue;
  const absolute = path.join(root, file);
  if (!existsSync(absolute)) continue;
  let text = '';
  try {
    text = readFileSync(absolute, 'utf8');
  } catch {
    continue;
  }
  if (text.includes('\0')) continue;
  for (const line of scanText(text)) locations.push(`${file}:${line}`);
}

let history = 0;
if (existsSync(path.join(root, '.git'))) {
  history = await new Promise((resolve) => {
    const child = spawn('git', ['log', '-p', '--all'], { cwd: root });
    let carry = '';
    let count = 0;
    child.stdout.on('data', (chunk) => {
      const text = carry + chunk.toString('utf8');
      const lines = text.split(/\n/);
      carry = lines.pop() ?? '';
      for (const line of lines) {
        if (hits(line)) count += 1;
      }
    });
    child.on('close', () => {
      if (carry && hits(carry)) count += 1;
      resolve(count);
    });
  });
}

for (const location of locations) console.log(location);
console.log(`tracked: ${locations.length}`);
console.log(`history: ${history}`);
if (locations.length || history) process.exit(1);
