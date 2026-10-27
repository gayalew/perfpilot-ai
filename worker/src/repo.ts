import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

const SKIP = new Set(['node_modules', '.git', 'runs']);

/** Runs git in `cwd`. Does not use the caller's global identity. */
export function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function gitOk(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  if (result.code !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`);
  }
  return result.stdout.trim();
}

/**
 * Copies a site into runDir/work, then makes a fresh git repo there.
 * The original tree is never modified, even when it is already a git root.
 */
export async function prepareWorkdir(repoPath: string, runDir: string): Promise<{ workDir: string; branch: string; baselineSha: string }> {
  const source = path.resolve(repoPath);
  const workDir = path.join(path.resolve(runDir), 'work');
  await rm(workDir, { recursive: true, force: true });
  await mkdir(path.dirname(workDir), { recursive: true });
  await cp(source, workDir, {
    recursive: true,
    filter: (src) => !SKIP.has(path.basename(src)) || path.resolve(src) === source,
  });

  const branch = `perfpilot/optimize-${Date.now()}`;
  await gitOk(workDir, ['init', '-b', 'master']);
  await gitOk(workDir, ['config', 'user.name', 'PerfPilot']);
  await gitOk(workDir, ['config', 'user.email', 'perfpilot@users.noreply.github.com']);
  await gitOk(workDir, ['add', '-A']);
  await gitOk(workDir, ['commit', '-m', 'baseline']);
  const baselineSha = await gitOk(workDir, ['rev-parse', 'HEAD']);
  await gitOk(workDir, ['checkout', '-b', branch]);
  return { workDir, branch, baselineSha };
}

export async function commitAll(workDir: string, message: string): Promise<string> {
  await gitOk(workDir, ['add', '-A']);
  const staged = await git(workDir, ['diff', '--cached', '--quiet']);
  if (staged.code === 0) throw new Error('nothing to commit');
  const paragraphs = message.split(/\n\n/);
  const args = ['commit'];
  for (const part of paragraphs) args.push('-m', part);
  await gitOk(workDir, args);
  return headSha(workDir);
}

/** Drops uncommitted edits and untracked files created by a rejected fix. */
export async function resetHard(workDir: string): Promise<void> {
  await gitOk(workDir, ['reset', '--hard', 'HEAD']);
  await gitOk(workDir, ['clean', '-fd']);
}

export async function headSha(workDir: string): Promise<string> {
  return gitOk(workDir, ['rev-parse', 'HEAD']);
}

export async function diffStat(workDir: string): Promise<string> {
  const result = await git(workDir, ['diff', 'HEAD', '--stat']);
  if (result.code !== 0) throw new Error(result.stderr.trim() || 'git diff failed');
  return result.stdout.trim();
}

export async function changedFiles(workDir: string): Promise<string[]> {
  const result = await git(workDir, ['status', '--porcelain']);
  if (result.code !== 0) throw new Error(result.stderr.trim() || 'git status failed');
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

/** Detached worktree of a commit. Caller must remove it after stopping anything using the files. */
export async function addWorktree(workDir: string, target: string, sha: string): Promise<void> {
  await rm(target, { recursive: true, force: true });
  await gitOk(workDir, ['worktree', 'add', '--detach', target, sha]);
}

export async function removeWorktree(workDir: string, target: string): Promise<void> {
  const result = await git(workDir, ['worktree', 'remove', '--force', target]);
  if (result.code !== 0) await rm(target, { recursive: true, force: true });
}
