import { existsSync } from 'node:fs';

const checks = [];

function record(name, ok, detail) {
  checks.push({ name, ok, detail });
}

function present(name) {
  return (process.env[name] ?? '').trim().length > 0;
}

function requireName(name) {
  record(name, present(name), present(name) ? 'set' : 'missing');
}

const node = process.versions.node.split('.').map(Number);
const nodeOk = node[0] > 20 || (node[0] === 20 && node[1] >= 6);
record('Node.js', nodeOk, `v${process.versions.node}`);

for (const name of ['DATABASE_URL', 'SESSION_SECRET', 'ADMIN_PASSWORD', 'CLIENT_ORIGIN', 'GITHUB_TOKEN', 'GEMINI_API_KEY', 'GEMINI_MODEL', 'GOOGLE_API_KEY', 'JOB_SECRET', 'RESEND_API_KEY', 'EMAIL_FROM', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']) {
  requireName(name);
}
record('repository owner', present('DEMO_REPO_OWNER') || present('GITHUB_OWNER'), present('DEMO_REPO_OWNER') || present('GITHUB_OWNER') ? 'set' : 'missing');
record('repository name', present('DEMO_REPO_NAME') || present('GITHUB_REPO'), present('DEMO_REPO_NAME') || present('GITHUB_REPO') ? 'set' : 'missing');

async function main() {
  if (present('DATABASE_URL')) {
    try {
      const pg = await import('pg');
      const Client = pg.default?.Client ?? pg.Client;
      const client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      try {
        await client.query('select 1');
        record('database', true, 'reachable');
        const expected = ['001_init.sql', '002_notifications.sql', '003_monitoring.sql', '004_field.sql'];
        const applied = await client.query('select filename from schema_migrations');
        const names = new Set(applied.rows.map((row) => row.filename));
        const missing = expected.filter((name) => !names.has(name));
        record('migrations', missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : 'applied');
        const projects = await client.query('select name from projects where name = any($1::text[])', [['Demo site (repo mode)', 'Demo site (URL mode)']]);
        const found = new Set(projects.rows.map((row) => row.name));
        record('seed project repo mode', found.has('Demo site (repo mode)'), found.has('Demo site (repo mode)') ? 'present' : 'missing');
        record('seed project URL mode', found.has('Demo site (URL mode)'), found.has('Demo site (URL mode)') ? 'present' : 'missing');
      } finally {
        await client.end();
      }
    } catch {
      record('database', false, 'not reachable');
    }
  }

  try {
    const response = await fetch('http://localhost:4200/', { signal: AbortSignal.timeout(5000) });
    record('demo site', response.ok, response.ok ? 'http://localhost:4200/' : `HTTP ${response.status}`);
  } catch {
    record('demo site', false, 'not reachable on port 4200');
  }

  try {
    const { chromium } = await import('playwright');
    const executable = chromium.executablePath();
    record('Chromium', existsSync(executable), existsSync(executable) ? 'installed' : 'missing');
  } catch {
    record('Chromium', false, 'playwright is not installed');
  }

  if (present('GEMINI_API_KEY') && present('GEMINI_MODEL')) {
    const model = process.env.GEMINI_MODEL.trim().replace(/^models\//, '');
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'Reply with the single word ok' }] }] }),
        signal: AbortSignal.timeout(30_000),
      });
      record('Gemini', response.ok, response.ok ? 'reachable' : `HTTP ${response.status}`);
    } catch {
      record('Gemini', false, 'request failed');
    }
  }

  if (present('TELEGRAM_BOT_TOKEN')) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getMe`, { signal: AbortSignal.timeout(15_000) });
      const body = await response.json().catch(() => null);
      record('Telegram', response.ok && body?.ok === true, response.ok && body?.ok === true ? 'configured' : `HTTP ${response.status}`);
    } catch {
      record('Telegram', false, 'request failed');
    }
  }

  if (present('GOOGLE_API_KEY')) {
    const key = process.env.GOOGLE_API_KEY;
    try {
      const crux = await fetch(`https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ origin: 'https://web.dev', formFactor: 'PHONE' }),
        signal: AbortSignal.timeout(30_000),
      });
      const cruxBody = await crux.json().catch(() => null);
      const cruxData = Boolean(cruxBody && typeof cruxBody === 'object' && cruxBody.record);
      record('Chrome UX Report', crux.ok && cruxData, `HTTP ${crux.status}, data ${cruxData ? 'returned' : 'absent'}`);
    } catch {
      record('Chrome UX Report', false, 'request failed');
    }
    try {
      const psiUrl = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
      psiUrl.search = new URLSearchParams({ url: 'https://web.dev/', strategy: 'mobile', category: 'performance', key }).toString();
      const psi = await fetch(psiUrl, { signal: AbortSignal.timeout(90_000) });
      const psiBody = await psi.json().catch(() => null);
      const psiData = Boolean(psiBody && typeof psiBody === 'object' && psiBody.lighthouseResult);
      record('PageSpeed Insights', psi.ok && psiData, `HTTP ${psi.status}, data ${psiData ? 'returned' : 'absent'}`);
    } catch {
      record('PageSpeed Insights', false, 'request failed');
    }
  }

  if (present('RESEND_API_KEY')) {
    try {
      const response = await fetch('https://api.resend.com/domains', {
        headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}` },
        signal: AbortSignal.timeout(15_000),
      });
      record('Resend', response.ok, response.ok ? 'configured' : `HTTP ${response.status}`);
    } catch {
      record('Resend', false, 'request failed');
    }
  }

  let failed = 0;
  for (const check of checks) {
    const mark = check.ok ? '\x1b[32mOK\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m';
    if (!check.ok) failed += 1;
    console.log(`${mark} ${check.name}: ${check.detail}`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch(() => {
  console.log('\x1b[31mFAIL\x1b[0m demo check');
  process.exit(1);
});
