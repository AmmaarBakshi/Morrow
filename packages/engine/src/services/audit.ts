import { newId, type AuditLogDTO } from '@morrow/core';
import { escapeLike, fromJson, sql, toJson, type Db, type Row } from '@morrow/db';
import { authorize, type WorkspaceContext } from '../context';
import type { Engine } from '../engine';

export function toAuditDTO(row: Row<'audit_logs'>): AuditLogDTO {
  return {
    id: row.id,
    actorType: row.actor_type,
    actorLabel: row.actor_label,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    metadata: fromJson<Record<string, unknown>>(row.metadata, {}),
    ip: row.ip,
    createdAt: row.created_at,
  };
}

/**
 * Audit trail for significant actions: sending, approvals, consent changes,
 * exports, permission changes, integration changes. Metadata must never
 * contain message bodies or secrets.
 */
export class AuditService {
  constructor(private readonly e: Engine) {}

  async record(
    ctx: WorkspaceContext,
    action: string,
    entity: { type: string; id: string } | null = null,
    metadata: Record<string, unknown> = {},
    db: Db = this.e.db,
  ): Promise<void> {
    await db
      .insertInto('audit_logs')
      .values({
        id: newId('aud'),
        workspace_id: ctx.workspaceId,
        actor_type: ctx.actor.type,
        actor_id: ctx.actor.id,
        actor_label: ctx.actor.label,
        action,
        entity_type: entity?.type ?? null,
        entity_id: entity?.id ?? null,
        metadata: toJson(metadata),
        ip: ctx.ip ?? null,
        created_at: this.e.nowIso(),
      })
      .execute();
  }

  async list(
    ctx: WorkspaceContext,
    filter: { entityType?: string; entityId?: string; action?: string; before?: string; limit?: number } = {},
  ): Promise<AuditLogDTO[]> {
    authorize(ctx, 'audit:read');
    let q = this.e.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(Math.min(filter.limit ?? 100, 500));
    if (filter.entityType) q = q.where('entity_type', '=', filter.entityType);
    if (filter.entityId) q = q.where('entity_id', '=', filter.entityId);
    // Prefix match ("api_key." finds every API key action); wildcards in the input are literal.
    if (filter.action) q = q.where(sql<boolean>`action like ${`${escapeLike(filter.action)}%`} escape '\\'`);
    if (filter.before) q = q.where('created_at', '<', filter.before);
    return (await q.execute()).map(toAuditDTO);
  }
}
