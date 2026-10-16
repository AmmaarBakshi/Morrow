import clsx from 'clsx';
import { AlertTriangle, Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { errorMessage } from '../../lib/api';
import { humanize } from '../../lib/format';

export function Card({ children, className, padded = true }: { children: ReactNode; className?: string; padded?: boolean }) {
  return <section className={clsx('rounded-xl border border-line bg-surface shadow-card', padded && 'p-5', className)}>{children}</section>;
}

export function CardHeader({ title, description, action }: { title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-4 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
        {description ? <p className="mt-0.5 text-[13px] text-muted">{description}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function PageHeader({ title, description, actions, back }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; back?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {back ? <div className="mb-2">{back}</div> : null}
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {description ? <p className="mt-1 max-w-2xl text-sm text-ink-2">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

type Tone = 'neutral' | 'accent' | 'good' | 'warn' | 'bad';
const tones: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-ink-2 border-line',
  accent: 'bg-accent-soft text-accent-text border-transparent',
  good: 'bg-good-soft text-good border-transparent',
  warn: 'bg-warn-soft text-warn border-transparent',
  bad: 'bg-bad-soft text-bad border-transparent',
};

export function Badge({ children, tone = 'neutral', className }: { children: ReactNode; tone?: Tone; className?: string }) {
  return <span className={clsx('inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-xs font-medium', tones[tone], className)}>{children}</span>;
}

const STATUS_TONES: Record<string, Tone> = {
  active: 'good', published: 'good', sent: 'good', delivered: 'good', completed: 'good', granted: 'good', verified: 'good', ok: 'good', succeeded: 'good', approved: 'good', done: 'good', valid: 'good',
  implied: 'accent', sending: 'accent', running: 'accent', scheduled: 'accent', opened: 'accent', clicked: 'accent',
  draft: 'neutral', unknown: 'neutral', archived: 'neutral', dismissed: 'neutral', cancelled: 'neutral', skipped: 'neutral', not_required: 'neutral',
  paused: 'warn', pending_approval: 'warn', pending: 'warn', waiting: 'warn', queued: 'warn', review: 'warn', uncertain: 'warn', soft_bounce: 'warn', open: 'warn',
  failed: 'bad', bounced: 'bad', dead: 'bad', withdrawn: 'bad', rejected: 'bad', complained: 'bad', suppressed: 'bad', invalid: 'bad', error: 'bad',
};

/** Status text always shows the word, never color alone. */
export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return <Badge tone={STATUS_TONES[status] ?? 'neutral'}>{label ?? humanize(status)}</Badge>;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('size-5 animate-spin text-muted', className)} aria-label="Loading" />;
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
      <Spinner className="size-4" /> {label}
    </div>
  );
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon ? <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-surface-2 text-muted">{icon}</div> : null}
      <p className="text-[15px] font-medium text-ink">{title}</p>
      {description ? <p className="mt-1 max-w-sm text-sm text-muted">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-line bg-surface px-6 py-10 text-center">
      <AlertTriangle className="size-6 text-bad" />
      <p className="text-sm text-ink">{errorMessage(error)}</p>
      {retry ? (
        <button onClick={retry} className="text-sm font-medium text-accent-text hover:underline">
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function Notice({ tone = 'accent', title, children, icon }: { tone?: Tone; title?: ReactNode; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className={clsx('flex gap-3 rounded-lg border px-4 py-3 text-sm', tones[tone])}>
      {icon ? <span className="mt-0.5 shrink-0">{icon}</span> : null}
      <div className="min-w-0">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className={clsx(title && 'mt-0.5', 'opacity-90')}>{children}</div> : null}
      </div>
    </div>
  );
}

/** Stat tile: label, value, optional context line. */
export function Stat({ label, value, sub, icon }: { label: string; value: ReactNode; sub?: ReactNode; icon?: ReactNode }) {
  return (
    <Card>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] text-muted">{label}</p>
        {icon ? <span className="text-muted">{icon}</span> : null}
      </div>
      <p className="mt-2 text-[26px] font-semibold leading-none text-ink">{value}</p>
      {sub ? <p className="mt-2 text-xs text-muted">{sub}</p> : null}
    </Card>
  );
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange(v: T): void; items: Array<{ value: T; label: ReactNode; count?: number }> }) {
  return (
    <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-line">
      {items.map((it) => (
        <button
          key={it.value}
          role="tab"
          aria-selected={value === it.value}
          onClick={() => onChange(it.value)}
          className={clsx(
            '-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors',
            value === it.value ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink',
          )}
        >
          {it.label}
          {it.count !== undefined ? <span className="rounded bg-surface-2 px-1.5 text-xs text-muted">{it.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Avatar({ name, className }: { name: string; className?: string }) {
  const letters = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
  return <span className={clsx('inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent-text', className)}>{letters || '?'}</span>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-ink-2">{children}</kbd>;
}
