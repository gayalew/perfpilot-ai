import type { ReactNode } from 'react';

export function Card({ children, className = '', id, testId }: { children: ReactNode; className?: string; id?: string; testId?: string }) {
  return (
    <section id={id} data-testid={testId} className={`rounded-xl bg-white p-5 shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800 ${className}`}>
      {children}
    </section>
  );
}
