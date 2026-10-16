import { id, index, notNull, timestamps, workspaceRef, type AnyDb } from './helpers';

/** Snippets, templates with immutable versions, verified senders and integrations. */
export async function up(db: AnyDb): Promise<void> {
  await timestamps(
    workspaceRef(id(db.schema.createTable('snippets')))
      .addColumn('key', 'text', notNull)
      .addColumn('name', 'text', notNull)
      .addColumn('kind', 'text', notNull)
      .addColumn('html', 'text', notNull)
      .addColumn('text', 'text'),
  )
    .addUniqueConstraint('snippets_workspace_key_unique', ['workspace_id', 'key'])
    .execute();

  await timestamps(
    workspaceRef(id(db.schema.createTable('templates')))
      .addColumn('name', 'text', notNull)
      .addColumn('description', 'text')
      .addColumn('category', 'text', notNull)
      .addColumn('purpose', 'text', notNull)
      .addColumn('status', 'text', notNull)
      .addColumn('draft_version_id', 'text')
      .addColumn('published_version_id', 'text')
      .addColumn('created_by', 'text'),
  )
    .addColumn('archived_at', 'text')
    .execute();
  await index(db, 'templates_workspace_status_idx', 'templates', ['workspace_id', 'status']);

  await workspaceRef(id(db.schema.createTable('template_versions')))
    .addColumn('template_id', 'text', (c) => c.notNull().references('templates.id').onDelete('cascade'))
    .addColumn('version', 'integer', notNull)
    .addColumn('subject', 'text', notNull)
    .addColumn('preview_text', 'text')
    .addColumn('html', 'text', notNull)
    .addColumn('text', 'text')
    .addColumn('missing_policy', 'text', notNull)
    .addColumn('created_by', 'text')
    .addColumn('created_at', 'text', notNull)
    .addColumn('published_at', 'text')
    .addUniqueConstraint('template_versions_template_version_unique', ['template_id', 'version'])
    .execute();

  await timestamps(
    workspaceRef(id(db.schema.createTable('senders')))
      .addColumn('name', 'text', notNull)
      .addColumn('email', 'text', notNull)
      .addColumn('reply_to', 'text')
      .addColumn('domain', 'text', notNull)
      .addColumn('status', 'text', notNull)
      .addColumn('verification_token_hash', 'text')
      .addColumn('verification_sent_at', 'text')
      .addColumn('verified_at', 'text')
      .addColumn('is_default', 'integer', (c) => c.notNull().defaultTo(0)),
  )
    .addUniqueConstraint('senders_workspace_email_unique', ['workspace_id', 'email'])
    .execute();
  await index(db, 'senders_verification_idx', 'senders', ['verification_token_hash']);

  await timestamps(
    workspaceRef(id(db.schema.createTable('integrations')))
      .addColumn('kind', 'text', notNull)
      .addColumn('provider', 'text', notNull)
      .addColumn('config', 'text', notNull)
      .addColumn('secrets', 'text')
      .addColumn('webhook_secret', 'text')
      .addColumn('status', 'text', notNull)
      .addColumn('last_tested_at', 'text')
      .addColumn('last_test_result', 'text'),
  )
    .addUniqueConstraint('integrations_workspace_kind_unique', ['workspace_id', 'kind'])
    .execute();
}

export async function down(db: AnyDb): Promise<void> {
  for (const t of ['integrations', 'senders', 'template_versions', 'templates', 'snippets']) {
    await db.schema.dropTable(t).ifExists().execute();
  }
}
