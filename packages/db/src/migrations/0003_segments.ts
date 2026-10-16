import { id, index, notNull, timestamps, workspaceRef, type AnyDb } from './helpers';

/** Saved segments and membership snapshots (used for "enters segment" triggers). */
export async function up(db: AnyDb): Promise<void> {
  await timestamps(
    workspaceRef(id(db.schema.createTable('segments')))
      .addColumn('name', 'text', notNull)
      .addColumn('description', 'text')
      .addColumn('criteria', 'text', notNull)
      .addColumn('created_by', 'text')
      .addColumn('cached_count', 'integer')
      .addColumn('cached_at', 'text'),
  )
    .addColumn('archived_at', 'text')
    .execute();
  await index(db, 'segments_workspace_idx', 'segments', ['workspace_id', 'archived_at']);

  await db.schema
    .createTable('segment_memberships')
    .addColumn('workspace_id', 'text', (c) => c.notNull().references('workspaces.id').onDelete('cascade'))
    .addColumn('segment_id', 'text', (c) => c.notNull().references('segments.id').onDelete('cascade'))
    .addColumn('contact_id', 'text', (c) => c.notNull().references('contacts.id').onDelete('cascade'))
    .addColumn('entered_at', 'text', notNull)
    .addPrimaryKeyConstraint('segment_memberships_pk', ['segment_id', 'contact_id'])
    .execute();
  await index(db, 'segment_memberships_contact_idx', 'segment_memberships', ['contact_id']);
}

export async function down(db: AnyDb): Promise<void> {
  await db.schema.dropTable('segment_memberships').ifExists().execute();
  await db.schema.dropTable('segments').ifExists().execute();
}
