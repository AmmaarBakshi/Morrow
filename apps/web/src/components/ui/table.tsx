import clsx from 'clsx';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { formatNumber } from '../../lib/format';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
  align?: 'left' | 'right';
}

/** Responsive data table: scrolls horizontally on small screens instead of overflowing the page. */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  onRowClick,
  empty,
  selected,
  onSelect,
  dim,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  empty?: ReactNode;
  selected?: Set<string>;
  onSelect?: (ids: Set<string>) => void;
  dim?: boolean;
}) {
  if (!rows.length && empty) return <>{empty}</>;
  const allSelected = Boolean(selected && rows.length && rows.every((r) => selected.has(rowKey(r))));
  return (
    <div className={clsx('overflow-x-auto transition-opacity', dim && 'opacity-60')}>
      <table className="w-full min-w-[640px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs font-medium uppercase tracking-wide text-muted">
            {onSelect ? (
              <th className="w-10 px-4 py-2.5">
                <input
                  type="checkbox"
                  aria-label="Select all"
                  className="size-4 accent-[var(--accent)]"
                  checked={allSelected}
                  onChange={(e) => onSelect(new Set(e.target.checked ? rows.map(rowKey) : []))}
                />
              </th>
            ) : null}
            {columns.map((c) => (
              <th key={c.key} className={clsx('px-4 py-2.5 font-medium', c.align === 'right' && 'text-right', c.className)}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const id = rowKey(row);
            return (
              <tr
                key={id}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={clsx('border-b border-line last:border-0', onRowClick && 'cursor-pointer hover:bg-surface-2', selected?.has(id) && 'bg-accent-soft/50')}
              >
                {onSelect ? (
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label="Select row"
                      className="size-4 accent-[var(--accent)]"
                      checked={selected?.has(id) ?? false}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(id);
                        else next.delete(id);
                        onSelect(next);
                      }}
                    />
                  </td>
                ) : null}
                {columns.map((c) => (
                  <td key={c.key} className={clsx('px-4 py-3 align-middle text-ink', c.align === 'right' && 'tabular text-right', c.className)}>
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage(p: number): void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="flex items-center justify-between gap-4 border-t border-line px-4 py-3 text-sm text-muted">
      <span className="tabular">
        {formatNumber(from)}–{formatNumber(to)} of {formatNumber(total)}
      </span>
      <div className="flex items-center gap-1">
        <button className="rounded-md p-1.5 hover:bg-surface-2 disabled:opacity-40" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
          <ChevronLeft className="size-4" />
        </button>
        <span className="tabular px-2">
          {page} / {pages}
        </span>
        <button className="rounded-md p-1.5 hover:bg-surface-2 disabled:opacity-40" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page">
          <ChevronRight className="size-4" />
        </button>
      </div>
    </div>
  );
}
