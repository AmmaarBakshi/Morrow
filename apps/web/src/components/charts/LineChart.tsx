import clsx from 'clsx';
import { Table2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { formatNumber } from '../../lib/format';
import { labelIndexes, niceTicks, shortDate, tickLabel } from './scale';

export interface Series {
  key: string;
  label: string;
  /** A CSS color, normally var(--series-n) in fixed slot order. */
  color: string;
}

export interface LineChartProps {
  data: Array<{ date: string } & Record<string, number | string>>;
  series: Series[];
  height?: number;
  /** Accessible summary of what the chart shows. */
  title: string;
  dim?: boolean;
}

const M = { top: 12, right: 64, bottom: 28, left: 40 };

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setW(Math.max(280, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/**
 * Multi-series line chart: 2px lines, ringed end markers, recessive grid,
 * a crosshair that snaps to the nearest date with one tooltip for every
 * series, a legend, end labels when they don't collide, and a table view.
 */
export function LineChart({ data, series, height = 240, title, dim }: LineChartProps) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const innerW = width - M.left - M.right;
  const innerH = height - M.top - M.bottom;

  const { ticks, yMax } = useMemo(() => {
    const max = Math.max(0, ...data.flatMap((d) => series.map((s) => Number(d[s.key]) || 0)));
    const t = niceTicks(max);
    return { ticks: t, yMax: t[t.length - 1]! };
  }, [data, series]);

  const x = (i: number) => (data.length <= 1 ? innerW / 2 : (i / (data.length - 1)) * innerW);
  const y = (v: number) => innerH - (v / yMax) * innerH;
  const paths = series.map((s) => data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(Number(d[s.key]) || 0).toFixed(1)}`).join(''));

  // End labels only when their vertical positions are at least 14px apart.
  const last = data.length - 1;
  const ends = series.map((s) => ({ s, py: last >= 0 ? y(Number(data[last]![s.key]) || 0) : 0 })).sort((a, b) => a.py - b.py);
  const endLabels = ends.every((e, i) => i === 0 || e.py - ends[i - 1]!.py >= 14);

  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const i = data.length <= 1 ? 0 : Math.round((px / innerW) * (data.length - 1));
    setHover(Math.min(last, Math.max(0, i)));
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === 'ArrowRight') setHover((h) => Math.min(last, (h ?? -1) + 1));
    else if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? last + 1) - 1));
    else if (e.key === 'Escape') setHover(null);
    else return;
    e.preventDefault();
  };

  const hovered = hover !== null ? data[hover] : null;
  const tipLeft = hover !== null ? M.left + x(hover) : 0;

  return (
    <div className={clsx('transition-opacity', dim && 'opacity-60')}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        {series.length > 1 ? (
          <ul className="flex flex-wrap items-center gap-4 text-xs text-ink-2" aria-label="Legend">
            {series.map((s) => (
              <li key={s.key} className="flex items-center gap-1.5">
                <span className="inline-block h-0.5 w-3.5 rounded-full" style={{ background: s.color }} />
                {s.label}
              </li>
            ))}
          </ul>
        ) : (
          <span />
        )}
        <button onClick={() => setTable((t) => !t)} className="inline-flex items-center gap-1 text-xs text-muted hover:text-ink" aria-pressed={table}>
          <Table2 className="size-3.5" /> {table ? 'Chart' : 'Table'}
        </button>
      </div>

      {table ? (
        <div className="max-h-72 overflow-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <caption className="sr-only">{title}</caption>
            <thead className="sticky top-0 bg-surface-2 text-xs text-muted">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Date</th>
                {series.map((s) => (
                  <th key={s.key} className="px-3 py-2 text-right font-medium">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.date} className="border-t border-line">
                  <td className="px-3 py-1.5 text-ink-2">{shortDate(d.date)}</td>
                  {series.map((s) => (
                    <td key={s.key} className="tabular px-3 py-1.5 text-right">
                      {formatNumber(Number(d[s.key]) || 0)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={wrapRef} className="relative">
          <svg width={width} height={height} role="img" aria-label={title} tabIndex={0} onKeyDown={onKey} onBlur={() => setHover(null)} className="block overflow-visible focus-visible:outline-offset-4">
            <g transform={`translate(${M.left},${M.top})`}>
              {ticks.map((t) => (
                <g key={t}>
                  <line x1={0} x2={innerW} y1={y(t)} y2={y(t)} stroke={t === 0 ? 'var(--axis)' : 'var(--grid)'} strokeWidth={1} />
                  <text x={-8} y={y(t)} dy="0.32em" textAnchor="end" className="tabular fill-[var(--muted)] text-[11px]">
                    {tickLabel(t)}
                  </text>
                </g>
              ))}
              {labelIndexes(data.length, Math.max(2, Math.floor(innerW / 90))).map((i) => (
                <text key={i} x={x(i)} y={innerH + 18} textAnchor={i === 0 ? 'start' : i === last ? 'end' : 'middle'} className="fill-[var(--muted)] text-[11px]">
                  {shortDate(data[i]!.date)}
                </text>
              ))}
              {hover !== null ? <line x1={x(hover)} x2={x(hover)} y1={0} y2={innerH} stroke="var(--axis)" strokeWidth={1} /> : null}
              {series.map((s, si) => (
                <path key={s.key} d={paths[si]} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              ))}
              {series.map((s) => {
                const i = hover ?? last;
                if (i < 0) return null;
                const v = Number(data[i]![s.key]) || 0;
                return <circle key={s.key} cx={x(i)} cy={y(v)} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} />;
              })}
              {endLabels && hover === null && last >= 0
                ? ends.map(({ s, py }) => (
                    <text key={s.key} x={innerW + 8} y={py} dy="0.32em" className="fill-[var(--ink-2)] text-[11px]">
                      {s.label}
                    </text>
                  ))
                : null}
              <rect x={0} y={0} width={innerW} height={innerH} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
            </g>
          </svg>
          {hovered ? (
            <div
              className="pointer-events-none absolute top-2 z-10 min-w-36 rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-card"
              style={{ left: Math.min(Math.max(tipLeft - 72, 0), width - 160) }}
              role="status"
            >
              <p className="mb-1 text-muted">{shortDate(hovered.date)}</p>
              {series.map((s) => (
                <p key={s.key} className="flex items-center justify-between gap-4">
                  <span className="flex items-center gap-1.5 text-ink-2">
                    <span className="inline-block h-0.5 w-3 rounded-full" style={{ background: s.color }} />
                    {s.label}
                  </span>
                  <strong className="tabular font-semibold text-ink">{formatNumber(Number(hovered[s.key]) || 0)}</strong>
                </p>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
