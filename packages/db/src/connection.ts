import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Kysely, PostgresDialect, SqliteDialect, type Dialect, type LogEvent } from 'kysely';
import type { Database } from './schema';

export type DialectName = 'sqlite' | 'postgres';

export interface DatabaseHandle {
  db: Kysely<Database>;
  dialect: DialectName;
  /** Connection description with credentials removed, safe to log. */
  description: string;
  close(): Promise<void>;
}

export interface ConnectOptions {
  /** Maximum PostgreSQL pool size. */
  poolSize?: number;
  /** Log every query (development only). */
  logQueries?: boolean;
  onSlowQuery?: (sql: string, ms: number) => void;
  slowQueryMs?: number;
}

export type ParsedDatabaseUrl =
  | { kind: 'sqlite'; path: string }
  | { kind: 'postgres'; url: string }
  | { kind: 'pglite'; dataDir: string | undefined };

/**
 * Supported forms:
 *   sqlite:./data/morrow.db   sqlite://./data/morrow.db   file:./morrow.db
 *   sqlite::memory:           :memory:
 *   postgres://user:pass@host:5432/db   postgresql://…
 *   pglite:memory   pglite:./data/pg   (embedded PostgreSQL, experimental)
 */
export function parseDatabaseUrl(url: string): ParsedDatabaseUrl {
  const u = url.trim();
  if (u === ':memory:' || u === 'sqlite::memory:' || u === 'sqlite://:memory:') return { kind: 'sqlite', path: ':memory:' };
  if (/^postgres(ql)?:\/\//i.test(u)) return { kind: 'postgres', url: u };
  if (/^pglite:/i.test(u)) {
    const rest = u.slice('pglite:'.length).replace(/^\/\//, '');
    return { kind: 'pglite', dataDir: rest === '' || rest === 'memory' ? undefined : rest };
  }
  const m = /^(sqlite|file):(\/\/)?(.+)$/i.exec(u);
  if (m) return { kind: 'sqlite', path: m[3]! };
  throw new Error(`Unsupported DATABASE_URL "${redactUrl(u)}". Use sqlite:<path> or postgres://…`);
}

export function redactUrl(url: string): string {
  return url.replace(/\/\/([^:/@]+):([^@]+)@/, '//$1:***@');
}

function logger(options: ConnectOptions) {
  const slow = options.slowQueryMs ?? 500;
  if (!options.logQueries && !options.onSlowQuery) return undefined;
  return (event: LogEvent) => {
    const ms = event.queryDurationMillis;
    if (options.logQueries) {
      // eslint-disable-next-line no-console
      console.debug(`[db] ${ms.toFixed(1)}ms ${event.query.sql}`);
    }
    if (options.onSlowQuery && ms >= slow) options.onSlowQuery(event.query.sql, ms);
    if (event.level === 'error' && options.logQueries) {
      // eslint-disable-next-line no-console
      console.error('[db] query failed', (event.error as Error)?.message);
    }
  };
}

export async function connectDatabase(url: string, options: ConnectOptions = {}): Promise<DatabaseHandle> {
  const parsed = parseDatabaseUrl(url);
  let dialect: Dialect;
  let name: DialectName;
  let description: string;

  if (parsed.kind === 'sqlite') {
    const { default: SQLite } = await import('better-sqlite3');
    if (parsed.path !== ':memory:') mkdirSync(dirname(resolve(parsed.path)), { recursive: true });
    const sqlite = new SQLite(parsed.path);
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma('busy_timeout = 5000');
    if (parsed.path !== ':memory:') {
      sqlite.pragma('journal_mode = WAL');
      sqlite.pragma('synchronous = NORMAL');
    }
    dialect = new SqliteDialect({ database: sqlite });
    name = 'sqlite';
    description = `sqlite:${parsed.path}`;
  } else if (parsed.kind === 'postgres') {
    const pgModule = await import('pg');
    const pg = (pgModule as unknown as { default?: typeof pgModule }).default ?? pgModule;
    pg.types.setTypeParser(20, (v: string) => Number.parseInt(v, 10));
    pg.types.setTypeParser(1700, (v: string) => Number.parseFloat(v));
    const pool = new pg.Pool({ connectionString: parsed.url, max: options.poolSize ?? 10 });
    dialect = new PostgresDialect({ pool });
    name = 'postgres';
    description = redactUrl(parsed.url);
  } else {
    const { PgliteDialect } = await import('./pglite');
    if (parsed.dataDir) mkdirSync(resolve(parsed.dataDir), { recursive: true });
    dialect = new PgliteDialect(parsed.dataDir);
    name = 'postgres';
    description = `pglite:${parsed.dataDir ?? 'memory'}`;
  }

  const db = new Kysely<Database>({ dialect, log: logger(options) });
  return {
    db,
    dialect: name,
    description,
    close: () => db.destroy(),
  };
}
