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

export function estimateMinutes(type: 'audit' | 'optimize', runs: number, maxSteps: number): number {
  if (type === 'audit') return Math.max(2, Math.round(runs * 0.8));
  return Math.max(8, Math.round(4 + runs * 1.5 + maxSteps * 1.2));
}
