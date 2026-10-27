export type Theme = 'light' | 'dark';

const KEY = 'perfpilot-theme';

export function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    /* private mode or a blocked storage API */
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(theme: Theme, persist = true): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  if (!persist) return;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* the theme still applies for this page view */
  }
}
