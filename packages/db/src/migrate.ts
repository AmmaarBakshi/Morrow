import { Migrator, type Kysely, type MigrationProvider, type MigrationResult } from 'kysely';
import { MIGRATIONS } from './migrations';

class StaticMigrationProvider implements MigrationProvider {
  async getMigrations() {
    return MIGRATIONS;
  }
}

function migrator(db: Kysely<any>): Migrator {
  return new Migrator({
    db,
    provider: new StaticMigrationProvider(),
    migrationTableName: 'morrow_migrations',
    migrationLockTableName: 'morrow_migration_lock',
  });
}

export interface MigrationReport {
  applied: string[];
  failed: string | null;
  error: Error | null;
}

function report(results: MigrationResult[] | undefined, error: unknown): MigrationReport {
  const applied = (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName);
  const failed = (results ?? []).find((r) => r.status === 'Error')?.migrationName ?? null;
  return { applied, failed, error: error ? (error instanceof Error ? error : new Error(String(error))) : null };
}

/** Apply all pending migrations. Throws if any migration fails. */
export async function migrateToLatest(db: Kysely<any>): Promise<MigrationReport> {
  const { results, error } = await migrator(db).migrateToLatest();
  const r = report(results, error);
  if (r.error) throw new Error(`Migration ${r.failed ?? ''} failed: ${r.error.message}`);
  return r;
}

/** Roll back the most recent migration (development use). */
export async function migrateDown(db: Kysely<any>): Promise<MigrationReport> {
  const { results, error } = await migrator(db).migrateDown();
  const r = report(results, error);
  if (r.error) throw r.error;
  return r;
}

export interface MigrationStatus {
  name: string;
  executedAt: Date | null;
}

export async function migrationStatus(db: Kysely<any>): Promise<MigrationStatus[]> {
  const list = await migrator(db).getMigrations();
  return list.map((m) => ({ name: m.name, executedAt: m.executedAt ?? null }));
}
