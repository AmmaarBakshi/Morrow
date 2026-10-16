/** Clean, human axis ticks: 0, 5, 10… or 0, 2K, 4K… */
export function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(Math.round(v * 1000) / 1000);
  if (ticks[ticks.length - 1]! < max) ticks.push(ticks[ticks.length - 1]! + step);
  return ticks;
}

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
export function tickLabel(v: number): string {
  return v >= 1000 ? compact.format(v) : String(v);
}

/** Short date for axes: "7 Mar". */
export function shortDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** Pick ~n evenly spaced indexes for x-axis labels, always including the ends. */
export function labelIndexes(length: number, n = 6): number[] {
  if (length <= n) return Array.from({ length }, (_, i) => i);
  const out = new Set<number>([0, length - 1]);
  const step = (length - 1) / (n - 1);
  for (let i = 1; i < n - 1; i++) out.add(Math.round(i * step));
  return [...out].sort((a, b) => a - b);
}
