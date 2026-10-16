import { id, index, notNull, timestamps, workspaceRef, type AnyDb } from './helpers';

/** Automations, immutable definition versions, runs and per-step execution logs. */
export async function up(db: AnyDb): Promise<void> {
  await timestamps(
    workspaceRef(id(db.schema.createTable('automations')))
      .addColumn('name', 'text', notNull)
      .addColumn('description', 'text')
      .addColumn('status', 'text', notNull)
      .addColumn('trigger_type', 'text', notNull)
      .addColumn('current_version_id', 'text')
      .addColumn('delivery_mode', 'text', notNull)
      .addColumn('auto_approved_by', 'text')
      .addColumn('auto_approved_at', 'text')
      .addColumn('activated_at', 'text')
      .addColumn('last_triggered_at', 'text')
      .addColumn('created_by', 'text'),
  ).execute();
  await index(db, 'automations_workspace_status_idx', 'automations', ['workspace_id', 'status', 'trigger_type']);

  await workspaceRef(id(db.schema.createTable('automation_versions')))
    .addColumn('automation_id', 'text', (c) => c.notNull().references('automations.id').onDelete('cascade'))
    .addColumn('version', 'integer', notNull)
    .addColumn('definition', 'text', notNull)
    .addColumn('created_by', 'text')
    .addColumn('created_at', 'text', notNull)
    .addUniqueConstraint('automation_versions_unique', ['automation_id', 'version'])
    .execute();

  await workspaceRef(id(db.schema.createTable('automation_runs')))
    .addColumn('automation_id', 'text', (c) => c.notNull().references('automations.id').onDelete('cascade'))
    .addColumn('version_id', 'text', (c) => c.notNull().references('automation_versions.id').onDelete('cascade'))
    .addColumn('contact_id', 'text', (c) => c.notNull().references('contacts.id').onDelete('cascade'))
    .addColumn('event_key', 'text', notNull)
    .addColumn('event_data', 'text', notNull)
    .addColumn('status', 'text', notNull)
    .addColumn('cursor', 'text')
    .addColumn('resume_at', 'text')
    .addColumn('error', 'text')
    .addColumn('started_at', 'text', notNull)
    .addColumn('updated_at', 'text', notNull)
    .addColumn('completed_at', 'text')
    // The core duplicate guard: one run per automation, contact and event.
    .addUniqueConstraint('automation_runs_event_unique', ['automation_id', 'contact_id', 'event_key'])
    .execute();
  await index(db, 'automation_runs_automation_idx', 'automation_runs', ['automation_id', 'started_at']);
  await index(db, 'automation_runs_contact_idx', 'automation_runs', ['contact_id', 'started_at']);
  await index(db, 'automation_runs_status_idx', 'automation_runs', ['workspace_id', 'status']);

  await workspaceRef(id(db.schema.createTable('automation_run_steps')))
    .addColumn('run_id', 'text', (c) => c.notNull().references('automation_runs.id').onDelete('cascade'))
    .addColumn('step_id', 'text', notNull)
    .addColumn('step_type', 'text', notNull)
    .addColumn('status', 'text', notNull)
    .addColumn('detail', 'text')
    .addColumn('created_at', 'text', notNull)
    .execute();
  await index(db, 'automation_run_steps_run_idx', 'automation_run_steps', ['run_id', 'created_at']);
}

export async function down(db: AnyDb): Promise<void> {
  for (const t of ['automation_run_steps', 'automation_runs', 'automation_versions', 'automations']) {
    await db.schema.dropTable(t).ifExists().execute();
  }
}
