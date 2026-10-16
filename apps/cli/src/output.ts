import pc from 'picocolors';

export interface Column<T> {
  label: string;
  value: (row: T) => unknown;
  /** Maximum width before truncation (default 40). */
  max?: number;
  align?: 'left' | 'right';
}

export interface Writer {
  out(text: string): void;
  err(text: string): void;
}

export const processWriter: Writer = {
  out: (t) => process.stdout.write(t.endsWith('\n') ? t : `${t}\n`),
  err: (t) => process.stderr.write(t.endsWith('\n') ? t : `${t}\n`),
};

function cell(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
const visible = (s: string) => s.replace(ANSI, '').length;

function truncate(s: string, max: number): string {
  if (visible(s) <= max) return s;
  const plain = s.replace(ANSI, '');
  return `${plain.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * Human output for terminals, JSON for scripts. Every command prints through
 * this, so `--json` always yields exactly one JSON document on stdout.
 */
export class Output {
  constructor(
    readonly json: boolean,
    private readonly w: Writer = processWriter,
  ) {}

  /** Print `data` as JSON, or run the human renderer. */
  result(data: unknown, human?: () => void): void {
    if (this.json) this.w.out(JSON.stringify(data, null, 2));
    else if (human) human();
    else this.w.out(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  }

  table<T>(rows: T[], columns: Column<T>[], empty = 'Nothing to show.'): void {
    if (!rows.length) {
      this.w.out(pc.dim(empty));
      return;
    }
    const matrix = rows.map((r) => columns.map((c) => truncate(cell(c.value(r)), c.max ?? 40)));
    const widths = columns.map((c, i) => Math.max(visible(c.label), ...matrix.map((m) => visible(m[i]!))));
    const pad = (s: string, i: number) => {
      const gap = ' '.repeat(Math.max(0, widths[i]! - visible(s)));
      return columns[i]!.align === 'right' ? gap + s : s + gap;
    };
    this.w.out(columns.map((c, i) => pc.bold(pad(c.label, i))).join('  '));
    for (const m of matrix) this.w.out(m.map((v, i) => pad(v, i)).join('  '));
  }

  /** Aligned "key  value" pairs. */
  fields(pairs: Array<[string, unknown]>): void {
    const width = Math.max(...pairs.map(([k]) => k.length));
    for (const [k, v] of pairs) this.w.out(`${pc.dim(k.padEnd(width))}  ${cell(v)}`);
  }

  heading(text: string): void {
    if (!this.json) this.w.out(`\n${pc.bold(text)}`);
  }

  line(text = ''): void {
    if (!this.json) this.w.out(text);
  }

  success(text: string): void {
    if (!this.json) this.w.out(`${pc.green('✔')} ${text}`);
  }

  info(text: string): void {
    if (!this.json) this.w.out(`${pc.cyan('ℹ')} ${text}`);
  }

  /** Warnings and errors go to stderr so they never corrupt JSON output. */
  warn(text: string): void {
    this.w.err(`${pc.yellow('⚠')} ${text}`);
  }

  error(text: string): void {
    this.w.err(`${pc.red('✖')} ${text}`);
  }
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return iso.length > 10 ? iso.replace('T', ' ').slice(0, 16) : iso;
}

export function formatPercent(rate: number | null | undefined): string {
  return rate === null || rate === undefined ? '—' : `${(rate * 100).toFixed(1)}%`;
}

export function statusColor(status: string): string {
  if (['active', 'sent', 'delivered', 'completed', 'published', 'ok', 'succeeded', 'granted', 'verified'].includes(status)) return pc.green(status);
  if (['failed', 'bounced', 'dead', 'error', 'cancelled', 'rejected', 'withdrawn', 'complained'].includes(status)) return pc.red(status);
  if (['paused', 'pending_approval', 'waiting', 'scheduled', 'queued', 'draft', 'review', 'uncertain'].includes(status)) return pc.yellow(status);
  return status;
}
