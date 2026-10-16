import { connectDatabase, type DatabaseHandle } from './connection';
import { migrateToLatest } from './migrate';

/**
 * Create a fresh, fully migrated in-memory database for tests.
 *
 * The dialect follows MORROW_TEST_DB: `sqlite` (default) or `postgres`
 * (embedded PGlite), so the whole suite can be run against both engines.
 */
export async function createTestDatabase(dialect = process.env.MORROW_TEST_DB ?? 'sqlite'): Promise<DatabaseHandle> {
  const url = dialect === 'postgres' ? 'pglite:memory' : 'sqlite::memory:';
  const handle = await connectDatabase(url);
  await migrateToLatest(handle.db);
  return handle;
}

export const TEST_DIALECT = (process.env.MORROW_TEST_DB ?? 'sqlite') as 'sqlite' | 'postgres';
