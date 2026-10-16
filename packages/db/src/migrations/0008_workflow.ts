import { id, index, notNull, timestamps, workspaceRef, type AnyDb } from './helpers';

/** Follow-up tasks, in-app notifications and scheduler cursors/leases. */
export async function up(db: AnyDb): Promise<void> {
  await timestamps(
    workspaceRef(id(db.schema.createTable('tasks')))
      .addColumn('contact_id', 'text', (c) => c.references('contacts.id').onDelete('set null'))
      .addColumn('title', 'text', notNull)
      .addColumn('description', 'text')
      .addColumn('status', 'text', notNull)
      .addColumn('due_at', 'text')
      .addColumn('assignee_id', 'text', (c) => c.references('users.id').onDelete('set null'))
      .addColumn('source', 'text', notNull)
      .addColumn('automation_run_id', 'text')
      .addColumn('dedupe_key', 'text')
      .addColumn('created_by', 'text'),
  )
    .addColumn('completed_at', 'text')
    .execute();
  await index(db, 'tasks_workspace_status_idx', 'tasks', ['workspace_id', 'status', 'due_at']);
  await index(db, 'tasks_contact_idx', 'tasks', ['contact_id']);
  await index(db, 'tasks_dedupe_unique', 'tasks', ['workspace_id', 'dedupe_key'], true);

  await workspaceRef(id(db.schema.createTable('notifications')))
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('kind', 'text', notNull)
    .addColumn('title', 'text', notNull)
    .addColumn('body', 'text')
    .addColumn('link', 'text')
    .addColumn('dedupe_key', 'text')
    .addColumn('read_at', 'text')
    .addColumn('created_at', 'text', notNull)
    .execute();
  await index(db, 'notifications_user_idx', 'notifications', ['workspace_id', 'user_id', 'read_at', 'created_at']);
  await index(db, 'notifications_dedupe_unique', 'notifications', ['user_id', 'dedupe_key'], true);

  await db.schema
    .createTable('scheduler_state')
    .addColumn('key', 'text', (c) => c.primaryKey())
    .addColumn('value', 'text', notNull)
    .addColumn('updated_at', 'text', notNull)
    .execute();
}

export async function down(db: AnyDb): Promise<void> {
  for (const t of ['scheduler_state', 'notifications', 'tasks']) {
    await db.schema.dropTable(t).ifExists().execute();
  }
}
