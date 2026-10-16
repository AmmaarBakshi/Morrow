/**
 * Kysely dialect for PGlite (PostgreSQL compiled to WebAssembly).
 *
 * Used to run the test suite against real PostgreSQL semantics without a
 * server, and available as an experimental embedded mode (`pglite:` URLs).
 * Connections are serialised with a mutex because PGlite has a single session;
 * that keeps transaction semantics correct when several queries run at once.
 */
import {
  CompiledQuery,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type Kysely,
  type QueryResult,
} from 'kysely';

interface PgliteLike {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[]; affectedRows?: number }>;
  close(): Promise<void>;
}

class Mutex {
  private tail: Promise<void> = Promise.resolve();
  lock(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const acquired = this.tail.then(() => release);
    this.tail = this.tail.then(() => next);
    return acquired;
  }
}

class PgliteConnection implements DatabaseConnection {
  constructor(private readonly client: PgliteLike) {}

  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const result = await this.client.query<R>(compiled.sql, [...compiled.parameters]);
    return {
      rows: result.rows,
      numAffectedRows: result.affectedRows !== undefined ? BigInt(result.affectedRows) : undefined,
    };
  }

  // eslint-disable-next-line require-yield
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('Streaming is not supported by the PGlite driver');
  }
}

class PgliteDriver implements Driver {
  private client: PgliteLike | null = null;
  private readonly mutex = new Mutex();
  private release: (() => void) | null = null;

  constructor(private readonly factory: () => Promise<PgliteLike>) {}

  async init(): Promise<void> {
    this.client = await this.factory();
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    const release = await this.mutex.lock();
    this.release = release;
    return new PgliteConnection(this.client!);
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('begin'));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('commit'));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('rollback'));
  }

  async releaseConnection(): Promise<void> {
    const release = this.release;
    this.release = null;
    release?.();
  }

  async destroy(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }
}

export class PgliteDialect implements Dialect {
  constructor(private readonly dataDir?: string) {}

  createAdapter() {
    return new PostgresAdapter();
  }

  createDriver(): Driver {
    return new PgliteDriver(async () => {
      const mod = (await import('@electric-sql/pglite')) as unknown as {
        PGlite: new (dataDir?: string, options?: Record<string, unknown>) => PgliteLike;
      };
      return new mod.PGlite(this.dataDir, {
        parsers: {
          20: (v: string) => Number.parseInt(v, 10), // int8 (COUNT) → number
          1700: (v: string) => Number.parseFloat(v), // numeric → number
        },
      });
    });
  }

  createIntrospector(db: Kysely<any>) {
    return new PostgresIntrospector(db);
  }

  createQueryCompiler() {
    return new PostgresQueryCompiler();
  }
}
