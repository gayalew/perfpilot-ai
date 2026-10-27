import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const password = process.env.ADMIN_PASSWORD;
if (!password) {
  console.error('ADMIN_PASSWORD is not set');
  process.exit(1);
}

const out = path.resolve('docs/screenshots');
const base = process.env.SCREENSHOT_BASE ?? 'http://localhost:5173';
await mkdir(out, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
page.setDefaultTimeout(30000);
await page.addInitScript(() => {
  try {
    localStorage.setItem('perfpilot-theme', 'light');
  } catch (e) {
    /* the page still renders in the default theme */
  }
});

const saved = [];
async function shot(name) {
  const file = path.join(out, name);
  await page.screenshot({ path: file });
  saved.push(name);
  console.log('saved', name);
}

const onlyAudit = process.env.SCREENSHOT_FROM === 'audit';

try {
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.getByLabel('Password').waitFor();
  if (!onlyAudit) await shot('login.png');
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Projects' }).waitFor();
  await page.getByTestId('project-card').first().waitFor();
  if (onlyAudit) {
    /* login only, then the audit flow below */
  } else await shot('dashboard.png');

  if (!onlyAudit) {
    const repo = page.getByTestId('project-card').filter({ hasText: 'Demo site (repo mode)' });
    await repo.getByRole('link', { name: 'Open' }).click();
    await page.getByRole('heading', { name: 'Run history' }).waitFor();
    await page.getByTestId('history-view').first().waitFor();
    await page.getByRole('heading', { name: 'Run history' }).scrollIntoViewIfNeeded();
    await shot('project.png');

    const succeeded = page.locator('tbody tr').filter({ hasText: /optimize/i }).filter({ hasText: 'Succeeded' }).first();
    await succeeded.getByTestId('history-view').click();
    await page.getByTestId('result-card').waitFor({ timeout: 20000 });
    await page.getByTestId('baseline-card').waitFor();
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot('job-live.png');
    await page.locator('#result').scrollIntoViewIfNeeded();
    await shot('job-result.png');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400);
    await shot('job-live-dark.png');

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole('button', { name: 'Switch to light theme' }).click();
    await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  }
  const urlProject = page.getByTestId('project-card').filter({ hasText: 'Demo site (URL mode)' });
  await urlProject.getByRole('link', { name: 'Open' }).click();
  await page.getByRole('button', { name: 'Start' }).waitFor();
  const active = page.getByRole('link', { name: 'Open it' });
  if (await active.count()) {
    await active.click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'Cancel run' }).click();
    await page.getByText('Cancelled').waitFor({ timeout: 20000 });
    await page.getByRole('link', { name: 'Back to project' }).click();
    await page.getByRole('button', { name: 'Start' }).waitFor();
  }
  await page.getByRole('button', { name: 'Start' }).click();
  await page.waitForURL(/\/jobs\//);
  await page.getByTestId('job-status').waitFor();

  await page.getByTestId('job-status').getByText('Running').waitFor({ timeout: 90000 });
  await page.waitForTimeout(1000);
  await shot('job-running.png');
  let baselineWhileRunning = false;
  const started = Date.now();
  while (Date.now() - started < 45000) {
    const status = await page.getByTestId('job-status').innerText();
    const baseline = await page.getByTestId('baseline-card').count();
    const plan = await page.getByTestId('plan-card').count();
    if (status.includes('Running') && baseline > 0 && plan > 0) {
      baselineWhileRunning = true;
      break;
    }
    if (!status.includes('Running') && !status.includes('Queued')) break;
    await page.waitForTimeout(2000);
  }
  console.log('baseline and plan visible while the audit was still running:', baselineWhileRunning);
  console.log('files', saved.join(', '));
} finally {
  await browser.close();
}
