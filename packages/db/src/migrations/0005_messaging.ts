import { sql } from 'kysely';
import { id, index, notNull, timestamps, workspaceRef, type AnyDb } from './helpers';

/** Messages, provider events, raw webhooks and the durable job queue. */
export async function up(db: AnyDb): Promise<void> {
  await timestamps(
    workspaceRef(id(db.schema.createTable('messages')))
      .addColumn('contact_id', 'text', (c) => c.references('contacts.id').onDelete('set null'))
      .addColumn('campaign_id', 'text')
      .addColumn('automation_id', 'text')
      .addColumn('automation_run_id', 'text')
      .addColumn('template_id', 'text')
      .addColumn('template_version_id', 'text')
      .addColumn('kind', 'text', notNull)
      .addColumn('category', 'text', notNull)
      .addColumn('idempotency_key', 'text', notNull)
      .addColumn('to_email', 'text', notNull)
      .addColumn('from_email', 'text', notNull)
      .addColumn('from_name', 'text')
      .addColumn('reply_to', 'text')
      .addColumn('subject', 'text', notNull)
      .addColumn('html', 'text')
      .addColumn('text', 'text')
      .addColumn('headers', 'text', notNull)
      .addColumn('status', 'text', notNull)
      .addColumn('approval_status', 'text', notNull)
      .addColumn('approved_by', 'text')
      .addColumn('approved_at', 'text')
      .addColumn('provider', 'text')
      .addColumn('provider_message_id', 'text')
      .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('error_code', 'text')
      .addColumn('error_message', 'text')
      .addColumn('error_class', 'text')
      .addColumn('scheduled_for', 'text')
      .addColumn('queued_at', 'text')
      .addColumn('sent_at', 'text')
      .addColumn('delivered_at', 'text')
      .addColumn('bounced_at', 'text')
      .addColumn('bounce_type', 'text')
      .addColumn('complained_at', 'text')
      .addColumn('opened_at', 'text')
      .addColumn('clicked_at', 'text')
      .addColumn('unsubscribed_at', 'text')
      .addColumn('failed_at', 'text'),
  )
    .addUniqueConstraint('messages_workspace_idempotency_unique', ['workspace_id', 'idempotency_key'])
    .execute();
  await index(db, 'messages_workspace_created_idx', 'messages', ['workspace_id', 'created_at']);
  await index(db, 'messages_workspace_status_idx', 'messages', ['workspace_id', 'status']);
  await index(db, 'messages_campaign_idx', 'messages', ['campaign_id', 'status']);
  await index(db, 'messages_automation_idx', 'messages', ['automation_id', 'created_at']);
  await index(db, 'messages_contact_idx', 'messages', ['contact_id', 'created_at']);
  await index(db, 'messages_provider_message_idx', 'messages', ['provider', 'provider_message_id']);

  await workspaceRef(id(db.schema.createTable('message_events')))
    .addColumn('message_id', 'text', (c) => c.notNull().references('messages.id').onDelete('cascade'))
    .addColumn('type', 'text', notNull)
    .addColumn('provider', 'text')
    .addColumn('provider_event_id', 'text')
    .addColumn('occurred_at', 'text', notNull)
    .addColumn('data', 'text', notNull)
    .addColumn('created_at', 'text', notNull)
    .execute();
  await index(db, 'message_events_message_idx', 'message_events', ['message_id', 'occurred_at']);
  await index(db, 'message_events_workspace_type_idx', 'message_events', ['workspace_id', 'type', 'occurred_at']);
  // Repeated webhook deliveries of the same provider event are ignored.
  await db.schema
    .createIndex('message_events_provider_event_unique')
    .on('message_events')
    .columns(['provider', 'provider_event_id'])
    .unique()
    .where(sql.ref('provider_event_id'), 'is not', null)
    .execute();

  await id(db.schema.createTable('webhook_events'))
    .addColumn('workspace_id', 'text', (c) => c.references('workspaces.id').onDelete('cascade'))
    .addColumn('integration_id', 'text')
    .addColumn('provider', 'text', notNull)
    .addColumn('signature_valid', 'integer', notNull)
    .addColumn('payload', 'text', notNull)
    .addColumn('received_at', 'text', notNull)
    .addColumn('processed_at', 'text')
    .addColumn('error', 'text')
    .execute();
  await index(db, 'webhook_events_received_idx', 'webhook_events', ['received_at']);

  await timestamps(
    id(db.schema.createTable('jobs'))
      .addColumn('workspace_id', 'text', (c) => c.references('workspaces.id').onDelete('cascade'))
      .addColumn('type', 'text', notNull)
      .addColumn('payload', 'text', notNull)
      .addColumn('status', 'text', notNull)
      .addColumn('priority', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('run_at', 'text', notNull)
      .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('max_attempts', 'integer', notNull)
      .addColumn('dedupe_key', 'text', (c) => c.unique())
      .addColumn('locked_by', 'text')
      .addColumn('locked_until', 'text')
      .addColumn('last_error', 'text'),
  )
    .addColumn('finished_at', 'text')
    .execute();
  await index(db, 'jobs_claim_idx', 'jobs', ['status', 'run_at', 'priority']);
  await index(db, 'jobs_lease_idx', 'jobs', ['status', 'locked_until']);
  await index(db, 'jobs_workspace_idx', 'jobs', ['workspace_id', 'status']);
}

export async function down(db: AnyDb): Promise<void> {
  for (const t of ['jobs', 'webhook_events', 'message_events', 'messages']) {
    await db.schema.dropTable(t).ifExists().execute();
  }
}
