export function MetricBar({ before, after }: { before: number; after: number }) {
  const max = Math.max(Math.abs(before), Math.abs(after), 0.0001);
  const beforeWidth = Math.max(4, (Math.abs(before) / max) * 100);
  const afterWidth = Math.max(4, (Math.abs(after) / max) * 100);
  return (
    <div className="flex w-28 flex-col gap-1" aria-hidden="true">
      <div className="h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-700" style={{ width: `${beforeWidth}%` }} />
      <div className="h-1.5 rounded-full bg-indigo-500" style={{ width: `${afterWidth}%` }} />
    </div>
  );
}
