export interface PsiSummary {
  strategy: 'mobile';
  score: number | null;
  lcp: number | null;
  fcp: number | null;
  tbt: number | null;
  cls: number | null;
  speedIndex: number | null;
}

export interface CruxMetric {
  p75: number | null;
  good: number | null;
  ni: number | null;
  poor: number | null;
}

export interface FieldReport {
  fetchedAt: string;
  url: string;
  origin: string;
  psi: PsiSummary | null;
  crux: { formFactor: 'PHONE'; metrics: Record<string, CruxMetric> } | null;
  notes: string[];
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function scrub(text: string, apiKey: string): string {
  const cleaned = apiKey ? text.split(apiKey).join('<redacted>') : text;
  return cleaned.replace(/key=[^&\s]+/gi, 'key=<redacted>').slice(0, 300);
}

function auditValue(audits: Record<string, unknown>, id: string): number | null {
  const audit = audits[id];
  if (!audit || typeof audit !== 'object') return null;
  return num((audit as { numericValue?: unknown }).numericValue);
}

/** Reads a PageSpeed Insights response. Missing audits stay null. */
export function parsePsi(payload: unknown): PsiSummary | null {
  if (!payload || typeof payload !== 'object') return null;
  const lighthouse = (payload as { lighthouseResult?: unknown }).lighthouseResult;
  if (!lighthouse || typeof lighthouse !== 'object') return null;
  const categories = (lighthouse as { categories?: unknown }).categories;
  const audits = (lighthouse as { audits?: unknown }).audits;
  const performance = categories && typeof categories === 'object' ? (categories as { performance?: { score?: unknown } }).performance : undefined;
  const score = num(performance?.score);
  const table = audits && typeof audits === 'object' ? audits as Record<string, unknown> : {};
  return {
    strategy: 'mobile',
    score: score == null ? null : Math.round(score * 100),
    lcp: auditValue(table, 'largest-contentful-paint'),
    fcp: auditValue(table, 'first-contentful-paint'),
    tbt: auditValue(table, 'total-blocking-time'),
    cls: auditValue(table, 'cumulative-layout-shift'),
    speedIndex: auditValue(table, 'speed-index'),
  };
}

function histogram(metric: unknown): Pick<CruxMetric, 'good' | 'ni' | 'poor'> {
  const bins = metric && typeof metric === 'object' ? (metric as { histogram?: unknown }).histogram : undefined;
  if (!Array.isArray(bins)) return { good: null, ni: null, poor: null };
  const density = (index: number) => {
    const bin = bins[index];
    if (!bin || typeof bin !== 'object') return null;
    return num((bin as { density?: unknown }).density);
  };
  return { good: density(0), ni: density(1), poor: density(2) };
}

const CRUX_KEYS = ['largest_contentful_paint_ms', 'interaction_to_next_paint', 'cumulative_layout_shift'] as const;

/** Reads a Chrome UX Report record. A 404 payload is not a record. */
export function parseCrux(payload: unknown): FieldReport['crux'] {
  if (!payload || typeof payload !== 'object') return null;
  const record = (payload as { record?: unknown }).record;
  if (!record || typeof record !== 'object') return null;
  const metrics = (record as { metrics?: unknown }).metrics;
  if (!metrics || typeof metrics !== 'object') return null;
  const table = metrics as Record<string, unknown>;
  const out: Record<string, CruxMetric> = {};
  for (const key of CRUX_KEYS) {
    const metric = table[key];
    const percentiles = metric && typeof metric === 'object' ? (metric as { percentiles?: { p75?: unknown } }).percentiles : undefined;
    const bins = histogram(metric);
    out[key] = { p75: num(percentiles?.p75), ...bins };
  }
  return { formFactor: 'PHONE', metrics: out };
}

export async function fetchField(url: string, options: { apiKey?: string; fetchImpl?: typeof fetch } = {}): Promise<FieldReport> {
  const apiKey = (options.apiKey ?? process.env.GOOGLE_API_KEY ?? '').trim();
  const doFetch = options.fetchImpl ?? fetch;
  let origin = url;
  try {
    origin = new URL(url).origin;
  } catch {
    return { fetchedAt: new Date().toISOString(), url, origin: url, psi: null, crux: null, notes: ['The project URL is not a valid URL.'] };
  }
  const report: FieldReport = { fetchedAt: new Date().toISOString(), url, origin, psi: null, crux: null, notes: [] };
  if (!apiKey) {
    report.notes.push('GOOGLE_API_KEY is not set');
    return report;
  }
  const psiUrl = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
  psiUrl.search = new URLSearchParams({ url, strategy: 'mobile', category: 'performance', key: apiKey }).toString();
  try {
    const res = await doFetch(psiUrl, { signal: AbortSignal.timeout(90_000) });
    const text = await res.text();
    if (!res.ok) report.notes.push(`PageSpeed Insights HTTP ${res.status}`);
    else {
      report.psi = parsePsi(JSON.parse(text) as unknown);
      if (!report.psi) report.notes.push('PageSpeed Insights returned no Lighthouse result');
    }
  } catch (err) {
    report.notes.push(scrub(err instanceof Error ? err.message : 'PageSpeed Insights request failed', apiKey));
  }
  try {
    const res = await doFetch(`https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ origin, formFactor: 'PHONE' }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (res.status === 404) report.notes.push('No Chrome UX Report data for this origin');
    else if (!res.ok) report.notes.push(`Chrome UX Report HTTP ${res.status}`);
    else {
      report.crux = parseCrux(JSON.parse(text) as unknown);
      if (!report.crux) report.notes.push('Chrome UX Report returned no record');
    }
  } catch (err) {
    report.notes.push(scrub(err instanceof Error ? err.message : 'Chrome UX Report request failed', apiKey));
  }
  return report;
}
