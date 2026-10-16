import { id, index, notNull, timestamps, workspaceRef, type AnyDb } from './helpers';

/** One-time campaigns and their recipient lists. */
export async function up(db: AnyDb): Promise<void> {
  await timestamps(
    workspaceRef(id(db.schema.createTable('campaigns')))
      .addColumn('name', 'text', notNull)
      .addColumn('description', 'text')
      .addColumn('status', 'text', notNull)
      .addColumn('category', 'text', notNull)
      .addColumn('segment_id', 'text', (c) => c.references('segments.id').onDelete('set null'))
      .addColumn('template_id', 'text', (c) => c.references('templates.id').onDelete('set null'))
      .addColumn('template_version_id', 'text')
      .addColumn('subject', 'text')
      .addColumn('preview_text', 'text')
      .addColumn('sender_id', 'text', (c) => c.references('senders.id').onDelete('set null'))
      .addColumn('reply_to', 'text')
      .addColumn('scheduled_at', 'text')
      .addColumn('timezone', 'text')
      .addColumn('requires_approval', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('approval_status', 'text', notNull)
      .addColumn('approval_note', 'text')
      .addColumn('submitted_by', 'text')
      .addColumn('approved_by', 'text')
      .addColumn('approved_at', 'text')
      .addColumn('launched_at', 'text')
      .addColumn('paused_at', 'text')
      .addColumn('completed_at', 'text')
      .addColumn('cancelled_at', 'text')
      .addColumn('dispatch_cursor', 'text')
      .addColumn('recipient_count', 'integer')
      .addColumn('created_by', 'text'),
  ).execute();
  await index(db, 'campaigns_workspace_status_idx', 'campaigns', ['workspace_id', 'status']);
  await index(db, 'campaigns_scheduled_idx', 'campaigns', ['status', 'scheduled_at']);

  await db.schema
    .createTable('campaign_recipients')
    .addColumn('workspace_id', 'text', (c) => c.notNull().references('workspaces.id').onDelete('cascade'))
    .addColumn('campaign_id', 'text', (c) => c.notNull().references('campaigns.id').onDelete('cascade'))
    .addColumn('contact_id', 'text', (c) => c.notNull().references('contacts.id').onDelete('cascade'))
    .addColumn('status', 'text', notNull)
    .addColumn('skip_reason', 'text')
    .addColumn('message_id', 'text')
    .addColumn('created_at', 'text', notNull)
    .addPrimaryKeyConstraint('campaign_recipients_pk', ['campaign_id', 'contact_id'])
    .execute();
  await index(db, 'campaign_recipients_status_idx', 'campaign_recipients', ['campaign_id', 'status']);
}

export async function down(db: AnyDb): Promise<void> {
  await db.schema.dropTable('campaign_recipients').ifExists().execute();
  await db.schema.dropTable('campaigns').ifExists().execute();
}
