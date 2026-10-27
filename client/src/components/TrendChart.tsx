import { useState } from 'react';
import { chartScale } from '../monitor.ts';

export interface TrendRow {
  takenAt: string;
  status: string;
  value: number | null;
}

function marker(status: string): string {
  if (status === 'regression') return '#b45309';
  if (status === 'breach') return '#b91c1c';
  return '#4f46e5';
}

export function TrendChart({ title, rows, reference, noise, format }: {
  title: string;
  rows: TrendRow[];
  reference: number | null;
  noise: number | null;
  format: (value: number) => string;
}) {
  const width = 320;
  const height = 120;
  const values = rows.map((row) => row.value);
  const extras = reference == null ? [] : [reference - (noise ?? 0), reference + (noise ?? 0)];
  const scaled = chartScale(values, width, height, 12, extras);
  const line = scaled.points.filter((point): point is NonNullable<typeof point> => point !== null);
  const path = line.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ');
  const band = reference == null ? null : {
    top: scaled.yFor(reference + (noise ?? 0)),
    bottom: scaled.yFor(reference - (noise ?? 0)),
  };
  const [active, setActive] = useState<number | null>(null);
  const current = active == null ? null : rows[active];
  const point = active == null ? null : scaled.points[active];

  return (
    <figure className="min-w-0">
      <figcaption className="mb-1 text-sm font-medium">{title}</figcaption>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title} className="w-full rounded-md bg-zinc-50 dark:bg-zinc-950">
        {band && (
          <rect x="12" y={Math.min(band.top, band.bottom)} width={width - 24} height={Math.max(2, Math.abs(band.bottom - band.top))} fill="#a1a1aa" opacity="0.25" />
        )}
        {path && <path d={path} fill="none" stroke="#71717a" strokeWidth="2" />}
        {scaled.points.map((item, index) => item && (
          <circle
            key={`${rows[index]?.takenAt}-${index}`}
            cx={item.x}
            cy={item.y}
            r={active === index ? 5 : 3.5}
            fill={marker(rows[index]?.status ?? 'ok')}
            tabIndex={0}
            role="button"
            aria-label={`${rows[index]?.takenAt ?? ''} ${rows[index]?.status ?? ''} ${rows[index]?.value == null ? 'n/a' : format(rows[index].value)}`}
            onMouseEnter={() => setActive(index)}
            onMouseLeave={() => setActive(null)}
            onFocus={() => setActive(index)}
            onBlur={() => setActive(null)}
          />
        ))}
      </svg>
      {current && point && current.value != null && (
        <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-300" role="status">
          {current.takenAt} · {current.status} · {format(current.value)}
        </p>
      )}
      <table className="sr-only">
        <caption>{title}</caption>
        <thead><tr><th>When</th><th>Status</th><th>Value</th></tr></thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.takenAt}-${index}`}>
              <td>{row.takenAt}</td>
              <td>{row.status}</td>
              <td>{row.value == null ? 'n/a' : format(row.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
