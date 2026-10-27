export function formatMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return 'n/a';
  if (Math.abs(ms) < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return 'n/a';
  const sign = bytes < 0 ? '-' : '';
  const abs = Math.abs(bytes);
  if (abs < 1024) return `${sign}${Math.round(abs)} B`;
  if (abs < 1024 * 1024) {
    const value = abs / 1024;
    return `${sign}${value.toFixed(value >= 10 ? 0 : 1)} KB`;
  }
  const value = abs / (1024 * 1024);
  return `${sign}${value.toFixed(value >= 10 ? 1 : 2)} MB`;
}

/** Signed percent change from before to after, one decimal. */
export function formatPercentChange(before: number, after: number): string {
  if (!Number.isFinite(before) || !Number.isFinite(after) || before === 0) return 'n/a';
  const pct = ((after - before) / Math.abs(before)) * 100;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

export function formatRelativeTime(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'n/a';
  const delta = Math.round((then - now) / 1000);
  const abs = Math.abs(delta);
  const format = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (abs < 60) return format.format(delta, 'second');
  if (abs < 3600) return format.format(Math.round(delta / 60), 'minute');
  if (abs < 86400) return format.format(Math.round(delta / 3600), 'hour');
  return format.format(Math.round(delta / 86400), 'day');
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return 'n/a';
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

export function formatMetric(key: string, value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  if (key === 'cls') return value.toFixed(3);
  if (key === 'score') return String(Math.round(value));
  if (key === 'requests') return String(Math.round(value));
  if (key === 'totalBytes' || key === 'weight') return formatBytes(value);
  return formatMs(value);
}

/** External links are rendered only for GitHub. */
export function safeGithubUrl(url: string | null | undefined): string | null {
  if (!url || !url.startsWith('https://github.com/')) return null;
  return url;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const HEADLINE_LABEL: Record<string, string> = {
  score: 'Score',
  lcp: 'LCP',
  fcp: 'FCP',
  tbt: 'TBT',
  cls: 'CLS',
  speedIndex: 'Speed Index',
  totalBytes: 'page weight',
  weight: 'page weight',
  requests: 'requests',
};

const HIGHER_IS_BETTER = new Set(['score']);

export interface HeadlineInput {
  key: string;
  before: number;
  after: number;
  verdict?: string;
}

/** "Optimize run, Oct 27, 10:14". The clock is the viewer's local time. */
export function formatRunTitle(type: string, startedAt: string | null | undefined): string {
  const name = type === 'optimize' ? 'Optimize' : type === 'audit' ? 'Audit' : type.charAt(0).toUpperCase() + type.slice(1);
  const title = `${name} run`;
  if (!startedAt) return title;
  const date = new Date(startedAt);
  if (!Number.isFinite(date.getTime())) return title;
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${title}, ${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getHours()}:${minute}`;
}

function wholePercent(relative: number): string {
  const rounded = Math.round(relative * 100);
  const sign = rounded > 0 ? '+' : '';
  return `${sign}${rounded}%`;
}

/**
 * The largest three metrics whose comparison verdict is improved.
 * Ranked by the size of the improvement in the metric's own direction.
 */
export function resultHeadline(metrics: HeadlineInput[]): string {
  const ranked = metrics.flatMap((metric) => {
    if (metric.verdict !== 'improved') return [];
    if (!Number.isFinite(metric.before) || !Number.isFinite(metric.after) || metric.before === 0) return [];
    const relative = (metric.after - metric.before) / Math.abs(metric.before);
    const gain = HIGHER_IS_BETTER.has(metric.key) ? relative : -relative;
    if (!(gain > 0)) return [];
    const label = HEADLINE_LABEL[metric.key] ?? metric.key;
    return [{ label, relative, gain }];
  }).sort((a, b) => b.gain - a.gain).slice(0, 3);
  if (ranked.length === 0) return 'No proven improvement';
  return ranked.map((item) => `${item.label} ${wholePercent(item.relative)}`).join(', ');
}

/** A row that neither moved by 0.5% nor earned a comparison verdict. */
export function isQuietChange(before: number | null, after: number | null, verdict: string): boolean {
  if (verdict !== 'unchanged') return false;
  if (before == null || after == null || !Number.isFinite(before) || !Number.isFinite(after) || before === 0) return false;
  return Math.abs((after - before) / Math.abs(before)) * 100 < 0.5;
}

export function estimateMinutes(type: 'audit' | 'optimize' | 'monitor', runs: number, maxSteps: number): number {
  if (type === 'audit' || type === 'monitor') return Math.max(2, Math.round(runs * 0.8));
  return Math.max(8, Math.round(4 + runs * 1.5 + maxSteps * 1.2));
}
