export function MetricBar({ before, after, verdict = 'unchanged' }: { before: number; after: number; verdict?: string }) {
  const max = Math.max(Math.abs(before), Math.abs(after), 0.0001);
  const beforeWidth = Math.max(4, (Math.abs(before) / max) * 100);
  const afterWidth = Math.max(4, (Math.abs(after) / max) * 100);
  const afterColor = verdict === 'improved' ? 'bg-emerald-600' : verdict === 'regressed' ? 'bg-amber-500' : 'bg-slate-400';
  return (
    <div className="flex w-28 flex-col gap-1" aria-hidden="true">
      <div className="h-1.5 rounded-full bg-zinc-300 dark:bg-zinc-600" style={{ width: `${beforeWidth}%` }} />
      <div className={`h-1.5 rounded-full ${afterColor}`} style={{ width: `${afterWidth}%` }} />
    </div>
  );
}
