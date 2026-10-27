import type { ReactNode } from 'react';
import { Button } from './Button.tsx';

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="space-y-3" aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => (
        <div key={index} className="h-16 animate-pulse rounded-xl bg-zinc-200 dark:bg-zinc-800" />
      ))}
    </div>
  );
}

export function QueryError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="rounded-xl bg-white p-5 ring-1 ring-red-200 dark:bg-zinc-900 dark:ring-red-900">
      <p className="text-sm text-red-700 dark:text-red-300">{message}</p>
      <Button className="mt-3" variant="ghost" onClick={onRetry}>Retry</Button>
    </div>
  );
}

export function LoadGate({ loading, error, onRetry, children }: { loading: boolean; error: string | null; onRetry: () => void; children: ReactNode }) {
  if (loading) return <Skeleton />;
  if (error) return <QueryError message={error} onRetry={onRetry} />;
  return children;
}
