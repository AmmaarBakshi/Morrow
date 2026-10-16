import { id, index, notNull, timestamps, workspaceRef, type AnyDb } from './helpers';

/** Users, workspaces, memberships, invitations, sessions, API keys and the audit log. */
export async function up(db: AnyDb): Promise<void> {
  await timestamps(
    id(db.schema.createTable('users'))
      .addColumn('email', 'text', (c) => c.notNull().unique())
      .addColumn('name', 'text', notNull)
      .addColumn('password_hash', 'text'),
  )
    .addColumn('last_login_at', 'text')
    .execute();

  await timestamps(
    id(db.schema.createTable('workspaces'))
      .addColumn('name', 'text', notNull)
      .addColumn('slug', 'text', (c) => c.notNull().unique())
      .addColumn('timezone', 'text', notNull)
      .addColumn('settings', 'text', notNull),
  ).execute();

  await workspaceRef(id(db.schema.createTable('memberships')))
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('role', 'text', notNull)
    .addColumn('created_at', 'text', notNull)
    .addUniqueConstraint('memberships_workspace_user_unique', ['workspace_id', 'user_id'])
    .execute();
  await index(db, 'memberships_user_idx', 'memberships', ['user_id']);

  await workspaceRef(id(db.schema.createTable('invitations')))
    .addColumn('email', 'text', notNull)
    .addColumn('role', 'text', notNull)
    .addColumn('token_hash', 'text', (c) => c.notNull().unique())
    .addColumn('invited_by', 'text', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('expires_at', 'text', notNull)
    .addColumn('accepted_at', 'text')
    .addColumn('revoked_at', 'text')
    .addColumn('created_at', 'text', notNull)
    .execute();
  await index(db, 'invitations_workspace_idx', 'invitations', ['workspace_id']);

  await id(db.schema.createTable('sessions'))
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('token_hash', 'text', (c) => c.notNull().unique())
    .addColumn('csrf_token', 'text', notNull)
    .addColumn('workspace_id', 'text', (c) => c.references('workspaces.id').onDelete('set null'))
    .addColumn('ip', 'text')
    .addColumn('user_agent', 'text')
    .addColumn('created_at', 'text', notNull)
    .addColumn('last_seen_at', 'text', notNull)
    .addColumn('expires_at', 'text', notNull)
    .execute();
  await index(db, 'sessions_user_idx', 'sessions', ['user_id']);
  await index(db, 'sessions_expires_idx', 'sessions', ['expires_at']);

  await workspaceRef(id(db.schema.createTable('api_keys')))
    .addColumn('name', 'text', notNull)
    .addColumn('prefix', 'text', notNull)
    .addColumn('key_hash', 'text', (c) => c.notNull().unique())
    .addColumn('role', 'text', notNull)
    .addColumn('created_by', 'text', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('last_used_at', 'text')
    .addColumn('expires_at', 'text')
    .addColumn('revoked_at', 'text')
    .addColumn('created_at', 'text', notNull)
    .execute();
  await index(db, 'api_keys_workspace_idx', 'api_keys', ['workspace_id']);

  await workspaceRef(id(db.schema.createTable('audit_logs')))
    .addColumn('actor_type', 'text', notNull)
    .addColumn('actor_id', 'text')
    .addColumn('actor_label', 'text')
    .addColumn('action', 'text', notNull)
    .addColumn('entity_type', 'text')
    .addColumn('entity_id', 'text')
    .addColumn('metadata', 'text', notNull)
    .addColumn('ip', 'text')
    .addColumn('created_at', 'text', notNull)
    .execute();
  await index(db, 'audit_logs_workspace_created_idx', 'audit_logs', ['workspace_id', 'created_at']);
  await index(db, 'audit_logs_entity_idx', 'audit_logs', ['workspace_id', 'entity_type', 'entity_id']);
}

export async function down(db: AnyDb): Promise<void> {
  for (const t of ['audit_logs', 'api_keys', 'sessions', 'invitations', 'memberships', 'workspaces', 'users']) {
    await db.schema.dropTable(t).ifExists().execute();
  }
}
