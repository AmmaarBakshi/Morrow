import { useState } from 'react';
import { formatNumber } from '../../lib/format';

export interface BarItem {
  key: string;
  label: string;
  value: number;
  /** Optional formatted value (e.g. a percentage). */
  display?: string;
  detail?: string;
}

/**
 * Horizontal bars for a single measure (no legend: the card title names it).
 * 16px bars with a rounded data end, value at the tip in text ink, and the
 * whole row as the hover/focus target.
 */
export function BarList({ items, max, color = 'var(--series-1)', label }: { items: BarItem[]; max?: number; color?: string; label: string }) {
  const [active, setActive] = useState<string | null>(null);
  const top = max ?? Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="flex flex-col gap-2.5" aria-label={label}>
      {items.map((item) => {
        const pct = Math.max(item.value > 0 ? 1.5 : 0, (item.value / top) * 100);
        return (
          <li
            key={item.key}
            tabIndex={0}
            onPointerEnter={() => setActive(item.key)}
            onPointerLeave={() => setActive(null)}
            onFocus={() => setActive(item.key)}
            onBlur={() => setActive(null)}
            className="group rounded-md outline-none"
            title={item.detail}
          >
            <div className="mb-1 flex items-baseline justify-between gap-3 text-[13px]">
              <span className="truncate text-ink-2">{item.label}</span>
              <span className="tabular shrink-0 font-medium text-ink">{item.display ?? formatNumber(item.value)}</span>
            </div>
            <div className="h-4 w-full">
              <div
                className="h-4 transition-opacity"
                style={{ width: `${pct}%`, background: color, borderRadius: '0 4px 4px 0', opacity: active && active !== item.key ? 0.45 : 1 }}
              />
            </div>
            {active === item.key && item.detail ? <p className="mt-1 text-xs text-muted">{item.detail}</p> : null}
          </li>
        );
      })}
    </ul>
  );
}
