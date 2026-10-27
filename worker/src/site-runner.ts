import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { SiteConfig } from './config.js';

export interface RunningSite {
  url: string;
  stop: () => Promise<void>;
}

export interface CommandResult {
  code: number;
  output: string;
}

/** Runs a shell command in `cwd`. Output is truncated and is not an environment dump. */
export function runCommand(command: string, cwd: string, extraEnv: Record<string, string> = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      env: { ...process.env, ...extraEnv },
    });
    let output = '';
    const take = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-2000);
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, output: output.trim() }));
  });
}

function killTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { shell: true, windowsHide: true });
      killer.on('exit', () => resolve());
      killer.on('error', () => resolve());
    });
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // The process has already exited.
  }
  return Promise.resolve();
}

async function waitForOk(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = 'no response';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: 'manual' });
      if (res.status === 200) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : 'connection failed';
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`site did not return 200 within ${timeoutMs} ms (${last})`);
}

/**
 * Installs, builds, and starts a site with PORT set. stop() kills the process tree.
 * Polls the home URL for up to 15 seconds.
 */
export async function startSite(dir: string, config: SiteConfig, port: number): Promise<RunningSite> {
  const cwd = path.resolve(dir);
  if (config.installCommand.trim()) {
    const installed = await runCommand(config.installCommand, cwd);
    if (installed.code !== 0) throw new Error(`install failed (exit ${installed.code}): ${installed.output.slice(0, 400)}`);
  }
  if (config.buildCommand.trim()) {
    const built = await runCommand(config.buildCommand, cwd);
    if (built.code !== 0) throw new Error(`build failed (exit ${built.code}): ${built.output.slice(0, 400)}`);
  }
  if (!config.startCommand.trim()) throw new Error('startCommand is empty');

  const child = spawn(config.startCommand, {
    cwd,
    shell: true,
    windowsHide: true,
    env: { ...process.env, PORT: String(port) },
  });
  let output = '';
  const take = (chunk: Buffer) => {
    output = (output + chunk.toString('utf8')).slice(-1500);
  };
  child.stdout?.on('data', take);
  child.stderr?.on('data', take);

  const url = `http://127.0.0.1:${port}/`;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await killTree(child);
  };

  try {
    await waitForOk(url, 15_000);
  } catch (err) {
    await stop();
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(`${why}. ${output.slice(-300)}`);
  }

  child.on('exit', () => {
    stopped = true;
  });
  return { url, stop };
}
