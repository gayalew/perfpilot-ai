import type { ReactNode } from 'react';

const tones = {
  neutral: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200',
  accent: 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-200',
  good: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  warn: 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
  bad: 'bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200',
};

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: keyof typeof tones }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}
