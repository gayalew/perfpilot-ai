import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** How to install, build, and start one local site. */
export interface SiteConfig {
  installCommand: string;
  buildCommand: string;
  startCommand: string;
  port: number;
  paths: string[];
  publicDir: string;
  serverFile: string;
}

export const CONFIG_FILENAME = 'perfpilot.config.json';

const DEFAULTS: SiteConfig = {
  installCommand: '',
  buildCommand: '',
  startCommand: '',
  port: 4200,
  paths: ['/'],
  publicDir: 'public',
  serverFile: 'server.mjs',
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function relativePath(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty relative path`);
  const trimmed = value.trim().replace(/\\/g, '/');
  if (path.isAbsolute(trimmed) || trimmed.split('/').includes('..')) throw new Error(`${field} must stay inside the repo`);
  return trimmed;
}

function command(value: unknown, field: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
}

/** Checks a parsed config object. Missing optional fields use the defaults. */
export function validateSiteConfig(raw: unknown): SiteConfig {
  if (raw === undefined) return { ...DEFAULTS, paths: [...DEFAULTS.paths] };
  if (!isObject(raw)) throw new Error('perfpilot.config.json must be a JSON object');

  const portValue = raw.port === undefined ? DEFAULTS.port : raw.port;
  if (typeof portValue !== 'number' || !Number.isInteger(portValue) || portValue < 1 || portValue > 65535) {
    throw new Error('port must be an integer from 1 to 65535');
  }

  let paths = DEFAULTS.paths;
  if (raw.paths !== undefined) {
    if (!Array.isArray(raw.paths) || raw.paths.length === 0 || raw.paths.some((p) => typeof p !== 'string' || !p.startsWith('/'))) {
      throw new Error('paths must be a non-empty array of absolute URL paths');
    }
    paths = raw.paths as string[];
  }

  return {
    installCommand: command(raw.installCommand, 'installCommand', DEFAULTS.installCommand),
    buildCommand: command(raw.buildCommand, 'buildCommand', DEFAULTS.buildCommand),
    startCommand: command(raw.startCommand, 'startCommand', DEFAULTS.startCommand),
    port: portValue,
    paths: [...paths],
    publicDir: raw.publicDir === undefined ? DEFAULTS.publicDir : relativePath(raw.publicDir, 'publicDir'),
    serverFile: raw.serverFile === undefined ? DEFAULTS.serverFile : relativePath(raw.serverFile, 'serverFile'),
  };
}

/** Reads perfpilot.config.json from a site repo. A missing file uses the defaults. */
export async function loadSiteConfig(repoPath: string): Promise<SiteConfig> {
  const file = path.join(repoPath, CONFIG_FILENAME);
  try {
    const text = await readFile(file, 'utf8');
    return validateSiteConfig(JSON.parse(text) as unknown);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return validateSiteConfig(undefined);
    if (err instanceof SyntaxError) throw new Error(`perfpilot.config.json is not valid JSON`);
    throw err;
  }
}
