import { Spinner } from './Spinner.tsx';

export type StatusName = 'kept' | 'reverted' | 'skipped' | 'error' | 'failed' | 'running' | 'queued' | 'succeeded' | 'cancelled' | 'pending';

const label: Record<StatusName, string> = {
  kept: 'Kept',
  reverted: 'Reverted',
  skipped: 'Skipped',
  error: 'Error',
  failed: 'Failed',
  running: 'Running',
  queued: 'Queued',
  succeeded: 'Succeeded',
  cancelled: 'Cancelled',
  pending: 'Pending',
};

export function statusLabel(status: string): string {
  return status in label ? label[status as StatusName] : status;
}

export function StatusIcon({ status }: { status: string }) {
  const text = statusLabel(status);
  if (status === 'running') {
    return (
      <span className="inline-flex items-center gap-1.5 text-indigo-700 dark:text-indigo-200">
        <Spinner />
        <span>{text}</span>
      </span>
    );
  }
  const icon = status === 'kept' || status === 'succeeded' ? 'check' : status === 'reverted' ? 'undo' : status === 'error' || status === 'failed' ? 'x' : 'dash';
  const color = icon === 'check' ? 'text-emerald-700 dark:text-emerald-300' : icon === 'undo' ? 'text-amber-700 dark:text-amber-300' : icon === 'x' ? 'text-red-700 dark:text-red-300' : 'text-zinc-500';
  return (
    <span className={`inline-flex items-center gap-1.5 ${color}`}>
      <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
        {icon === 'check' && <path d="M3 8.5 6.2 12 13 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />}
        {icon === 'undo' && <path d="M6 4H3v3M3.2 7A5 5 0 1 0 4 4.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />}
        {icon === 'x' && <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />}
        {icon === 'dash' && <path d="M4 8h8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />}
      </svg>
      <span>{text}</span>
    </span>
  );
}
