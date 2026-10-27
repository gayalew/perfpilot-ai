import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { logout } from '../api.ts';
import { applyTheme, readTheme, type Theme } from '../theme.ts';
import { Button } from './Button.tsx';
import { useToast } from './Toast.tsx';

export function Shell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [theme, setTheme] = useState<Theme>(readTheme);

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    applyTheme(next);
  }

  return (
    <div className="min-h-screen bg-zinc-100 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <Link to="/" className="text-lg font-medium tracking-tight focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-indigo-500">PerfPilot</Link>
          <div className="flex items-center gap-2">
            <Button variant="ghost" aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={toggleTheme}>
              {theme === 'dark' ? 'Light' : 'Dark'}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                logout()
                  .then(() => navigate('/login'))
                  .catch((error: unknown) => toast(error instanceof Error ? error.message : 'Could not log out'));
              }}
            >
              Log out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">{children}</main>
    </div>
  );
}
