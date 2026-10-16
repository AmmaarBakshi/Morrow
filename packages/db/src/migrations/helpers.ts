import type { ColumnDefinitionBuilder, CreateTableBuilder, Kysely } from 'kysely';

/**
 * Column helpers that keep migrations portable: every type used here maps to
 * the same semantics on SQLite and PostgreSQL.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyDb = Kysely<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Table = CreateTableBuilder<any, any>;

export const notNull = (c: ColumnDefinitionBuilder) => c.notNull();

export function id(t: Table): Table {
  return t.addColumn('id', 'text', (c) => c.primaryKey());
}

export function workspaceRef(t: Table): Table {
  return t.addColumn('workspace_id', 'text', (c) => c.notNull().references('workspaces.id').onDelete('cascade'));
}

export function timestamps(t: Table): Table {
  return t.addColumn('created_at', 'text', notNull).addColumn('updated_at', 'text', notNull);
}

export async function index(db: AnyDb, name: string, table: string, columns: string[], unique = false): Promise<void> {
  let b = db.schema.createIndex(name).on(table).columns(columns);
  if (unique) b = b.unique();
  await b.execute();
}
