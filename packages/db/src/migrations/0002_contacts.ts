import { sql } from 'kysely';
import { id, index, notNull, timestamps, workspaceRef, type AnyDb } from './helpers';

/** Contacts, notes, events, tags, custom fields, consent history, suppressions and imports. */
export async function up(db: AnyDb): Promise<void> {
  await timestamps(
    workspaceRef(id(db.schema.createTable('contacts')))
      .addColumn('first_name', 'text')
      .addColumn('last_name', 'text')
      .addColumn('email', 'text')
      .addColumn('email_normalized', 'text')
      .addColumn('email_status', 'text', notNull)
      .addColumn('company', 'text')
      .addColumn('job_title', 'text')
      .addColumn('birthday_month', 'integer')
      .addColumn('birthday_day', 'integer')
      .addColumn('birth_year', 'integer')
      .addColumn('birthday_md', 'integer')
      .addColumn('work_anniversary', 'text')
      .addColumn('anniversary_md', 'integer')
      .addColumn('relationship_type', 'text', notNull)
      .addColumn('interests', 'text', notNull)
      .addColumn('preferences', 'text', notNull)
      .addColumn('language', 'text')
      .addColumn('timezone', 'text')
      .addColumn('source', 'text')
      .addColumn('consent_status', 'text', notNull)
      .addColumn('consent_updated_at', 'text')
      .addColumn('consent_source', 'text')
      .addColumn('status', 'text', notNull)
      .addColumn('archived_at', 'text')
      .addColumn('last_interaction_at', 'text')
      .addColumn('last_emailed_at', 'text')
      .addColumn('search_text', 'text', notNull),
  ).execute();
  // NULL e-mails are allowed (several contacts without an address); real addresses are unique per workspace.
  await index(db, 'contacts_workspace_email_unique', 'contacts', ['workspace_id', 'email_normalized'], true);
  await index(db, 'contacts_workspace_birthday_idx', 'contacts', ['workspace_id', 'birthday_md']);
  await index(db, 'contacts_workspace_anniversary_idx', 'contacts', ['workspace_id', 'anniversary_md']);
  await index(db, 'contacts_workspace_status_idx', 'contacts', ['workspace_id', 'status', 'id']);
  await index(db, 'contacts_workspace_created_idx', 'contacts', ['workspace_id', 'created_at']);
  await index(db, 'contacts_workspace_interaction_idx', 'contacts', ['workspace_id', 'last_interaction_at']);
  await index(db, 'contacts_workspace_relationship_idx', 'contacts', ['workspace_id', 'relationship_type']);

  await workspaceRef(id(db.schema.createTable('contact_notes')))
    .addColumn('contact_id', 'text', (c) => c.notNull().references('contacts.id').onDelete('cascade'))
    .addColumn('author_id', 'text', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('body', 'text', notNull)
    .addColumn('created_at', 'text', notNull)
    .execute();
  await index(db, 'contact_notes_contact_idx', 'contact_notes', ['contact_id', 'created_at']);

  await workspaceRef(id(db.schema.createTable('contact_events')))
    .addColumn('contact_id', 'text', (c) => c.notNull().references('contacts.id').onDelete('cascade'))
    .addColumn('name', 'text', notNull)
    .addColumn('properties', 'text', notNull)
    .addColumn('source', 'text')
    .addColumn('dedupe_key', 'text')
    .addColumn('occurred_at', 'text', notNull)
    .addColumn('created_at', 'text', notNull)
    .execute();
  await index(db, 'contact_events_contact_idx', 'contact_events', ['contact_id', 'occurred_at']);
  await index(db, 'contact_events_workspace_name_idx', 'contact_events', ['workspace_id', 'name', 'occurred_at']);
  await index(db, 'contact_events_dedupe_unique', 'contact_events', ['workspace_id', 'dedupe_key'], true);

  await workspaceRef(id(db.schema.createTable('tags')))
    .addColumn('name', 'text', notNull)
    .addColumn('name_normalized', 'text', notNull)
    .addColumn('color', 'text')
    .addColumn('created_at', 'text', notNull)
    .addUniqueConstraint('tags_workspace_name_unique', ['workspace_id', 'name_normalized'])
    .execute();

  await db.schema
    .createTable('contact_tags')
    .addColumn('workspace_id', 'text', (c) => c.notNull().references('workspaces.id').onDelete('cascade'))
    .addColumn('contact_id', 'text', (c) => c.notNull().references('contacts.id').onDelete('cascade'))
    .addColumn('tag_id', 'text', (c) => c.notNull().references('tags.id').onDelete('cascade'))
    .addColumn('created_at', 'text', notNull)
    .addPrimaryKeyConstraint('contact_tags_pk', ['contact_id', 'tag_id'])
    .execute();
  await index(db, 'contact_tags_tag_idx', 'contact_tags', ['tag_id', 'contact_id']);

  await workspaceRef(id(db.schema.createTable('custom_fields')))
    .addColumn('key', 'text', notNull)
    .addColumn('label', 'text', notNull)
    .addColumn('type', 'text', notNull)
    .addColumn('options', 'text')
    .addColumn('created_at', 'text', notNull)
    .addColumn('archived_at', 'text')
    .addUniqueConstraint('custom_fields_workspace_key_unique', ['workspace_id', 'key'])
    .execute();

  await db.schema
    .createTable('contact_field_values')
    .addColumn('workspace_id', 'text', (c) => c.notNull().references('workspaces.id').onDelete('cascade'))
    .addColumn('contact_id', 'text', (c) => c.notNull().references('contacts.id').onDelete('cascade'))
    .addColumn('field_id', 'text', (c) => c.notNull().references('custom_fields.id').onDelete('cascade'))
    .addColumn('value_text', 'text')
    .addColumn('value_number', 'double precision')
    .addColumn('updated_at', 'text', notNull)
    .addPrimaryKeyConstraint('contact_field_values_pk', ['contact_id', 'field_id'])
    .execute();
  await index(db, 'contact_field_values_text_idx', 'contact_field_values', ['field_id', 'value_text']);
  await index(db, 'contact_field_values_number_idx', 'contact_field_values', ['field_id', 'value_number']);

  await workspaceRef(id(db.schema.createTable('consent_events')))
    .addColumn('contact_id', 'text', (c) => c.notNull().references('contacts.id').onDelete('cascade'))
    .addColumn('from_status', 'text')
    .addColumn('to_status', 'text', notNull)
    .addColumn('source', 'text', notNull)
    .addColumn('actor_type', 'text', notNull)
    .addColumn('actor_id', 'text')
    .addColumn('ip', 'text')
    .addColumn('note', 'text')
    .addColumn('created_at', 'text', notNull)
    .execute();
  await index(db, 'consent_events_contact_idx', 'consent_events', ['contact_id', 'created_at']);

  await workspaceRef(id(db.schema.createTable('suppressions')))
    .addColumn('email_normalized', 'text', notNull)
    .addColumn('reason', 'text', notNull)
    .addColumn('scope', 'text', notNull)
    .addColumn('source', 'text')
    .addColumn('message_id', 'text')
    .addColumn('note', 'text')
    .addColumn('created_by', 'text')
    .addColumn('created_at', 'text', notNull)
    .addColumn('lifted_at', 'text')
    .addColumn('lifted_by', 'text')
    .execute();
  // At most one active suppression per address; lifted rows are kept as history.
  await db.schema
    .createIndex('suppressions_active_unique')
    .on('suppressions')
    .columns(['workspace_id', 'email_normalized'])
    .unique()
    .where(sql.ref('lifted_at'), 'is', null)
    .execute();
  await index(db, 'suppressions_workspace_created_idx', 'suppressions', ['workspace_id', 'created_at']);

  await timestamps(
    workspaceRef(id(db.schema.createTable('imports')))
      .addColumn('filename', 'text', notNull)
      .addColumn('status', 'text', notNull)
      .addColumn('headers', 'text', notNull)
      .addColumn('sample', 'text', notNull)
      .addColumn('mapping', 'text')
      .addColumn('options', 'text')
      .addColumn('row_count', 'integer', notNull)
      .addColumn('csv', 'text')
      .addColumn('summary', 'text')
      .addColumn('report', 'text')
      .addColumn('created_by', 'text'),
  )
    .addColumn('committed_at', 'text')
    .execute();
  await index(db, 'imports_workspace_created_idx', 'imports', ['workspace_id', 'created_at']);
}

export async function down(db: AnyDb): Promise<void> {
  for (const t of [
    'imports',
    'suppressions',
    'consent_events',
    'contact_field_values',
    'custom_fields',
    'contact_tags',
    'tags',
    'contact_events',
    'contact_notes',
    'contacts',
  ]) {
    await db.schema.dropTable(t).ifExists().execute();
  }
}
