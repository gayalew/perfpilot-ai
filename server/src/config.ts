export interface Config {
  databaseUrl: string;
  sessionSecret: string;
  adminPassword: string;
  clientOrigin: string;
  githubToken: string;
  demoRepoOwner: string;
  demoRepoName: string;
  geminiApiKey: string;
  geminiModel: string;
  port: number;
  nodeEnv: string;
  cookieSameSite: 'lax' | 'none';
}

const REQUIRED = [
  'DATABASE_URL',
  'SESSION_SECRET',
  'ADMIN_PASSWORD',
  'CLIENT_ORIGIN',
  'GITHUB_TOKEN',
  'DEMO_REPO_OWNER',
  'DEMO_REPO_NAME',
  'GEMINI_API_KEY',
  'GEMINI_MODEL',
] as const;

function present(env: NodeJS.ProcessEnv, name: string): string {
  return (env[name] ?? '').trim();
}

/** Reads process env and throws a message that lists missing names, never values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const demoRepoOwner = present(env, 'DEMO_REPO_OWNER') || present(env, 'GITHUB_OWNER');
  const demoRepoName = present(env, 'DEMO_REPO_NAME') || present(env, 'GITHUB_REPO');
  const values: Record<(typeof REQUIRED)[number], string> = {
    DATABASE_URL: present(env, 'DATABASE_URL'),
    SESSION_SECRET: present(env, 'SESSION_SECRET'),
    ADMIN_PASSWORD: present(env, 'ADMIN_PASSWORD'),
    CLIENT_ORIGIN: present(env, 'CLIENT_ORIGIN'),
    GITHUB_TOKEN: present(env, 'GITHUB_TOKEN'),
    DEMO_REPO_OWNER: demoRepoOwner,
    DEMO_REPO_NAME: demoRepoName,
    GEMINI_API_KEY: present(env, 'GEMINI_API_KEY'),
    GEMINI_MODEL: present(env, 'GEMINI_MODEL'),
  };
  const missing = REQUIRED.filter((name) => !values[name]);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  const port = present(env, 'PORT') ? Number(present(env, 'PORT')) : 8080;
  if (!Number.isInteger(port) || port <= 0) throw new Error('PORT must be a positive integer');
  const cookieSameSite = (present(env, 'COOKIE_SAMESITE') || 'lax').toLowerCase();
  if (cookieSameSite !== 'lax' && cookieSameSite !== 'none') throw new Error('COOKIE_SAMESITE must be lax or none');
  return {
    databaseUrl: values.DATABASE_URL,
    sessionSecret: values.SESSION_SECRET,
    adminPassword: values.ADMIN_PASSWORD,
    clientOrigin: values.CLIENT_ORIGIN,
    githubToken: values.GITHUB_TOKEN,
    demoRepoOwner: values.DEMO_REPO_OWNER,
    demoRepoName: values.DEMO_REPO_NAME,
    geminiApiKey: values.GEMINI_API_KEY,
    geminiModel: values.GEMINI_MODEL,
    port,
    nodeEnv: present(env, 'NODE_ENV') || 'development',
    cookieSameSite: cookieSameSite as 'lax' | 'none',
  };
}
