import {
  NotFoundError,
  newId,
  normalizeEmail,
  PreconditionError,
  SUPPRESSION_REASONS,
  suppressionScopeFor,
  ValidationError,
  type Page,
  type SuppressionDTO,
  type SuppressionReason,
  type SuppressionScope,
} from '@morrow/core';
import { chunk, escapeLike, sql, type Db, type Row } from '@morrow/db';
import { actorUserId, authorize, type WorkspaceContext } from '../context';
import type { Engine } from '../engine';

function toDTO(r: Row<'suppressions'>): SuppressionDTO {
  return {
    id: r.id,
    email: r.email_normalized,
    reason: r.reason as SuppressionReason,
    scope: r.scope as SuppressionScope,
    source: r.source,
    note: r.note,
    createdAt: r.created_at,
    liftedAt: r.lifted_at,
  };
}

/** Strength order: a stronger reason replaces a weaker one on the same address. */
const STRENGTH: Record<SuppressionReason, number> = { unsubscribed: 1, manual: 2, invalid_address: 3, hard_bounce: 3, complaint: 4 };

/**
 * The central suppression list. Checked when messages are created and again
 * immediately before sending, across every workflow and campaign.
 */
export class SuppressionService {
  constructor(private readonly e: Engine) {}

  async active(workspaceId: string, email: string | null, db: Db = this.e.db): Promise<Row<'suppressions'> | undefined> {
    if (!email) return undefined;
    return db
      .selectFrom('suppressions')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .where('email_normalized', '=', email)
      .where('lifted_at', 'is', null)
      .executeTakeFirst();
  }

  async activeMany(workspaceId: string, emails: string[]): Promise<Map<string, Row<'suppressions'>>> {
    const out = new Map<string, Row<'suppressions'>>();
    for (const batch of chunk([...new Set(emails.filter(Boolean))], 500)) {
      const rows = await this.e.db
        .selectFrom('suppressions')
        .selectAll()
        .where('workspace_id', '=', workspaceId)
        .where('email_normalized', 'in', batch)
        .where('lifted_at', 'is', null)
        .execute();
      for (const r of rows) out.set(r.email_normalized, r);
    }
    return out;
  }

  /**
   * Add (or strengthen) a suppression. Idempotent: suppressing an already
   * suppressed address keeps one active row, upgraded to the stronger reason.
   */
  async suppress(
    workspaceId: string,
    input: { email: string; reason: SuppressionReason; source?: string | null; note?: string | null; messageId?: string | null; createdBy?: string | null },
    db: Db = this.e.db,
  ): Promise<Row<'suppressions'>> {
    const email = normalizeEmail(input.email) ?? input.email.trim().toLowerCase();
    const scope = suppressionScopeFor(input.reason);
    const existing = await this.active(workspaceId, email, db);
    if (existing) {
      if (STRENGTH[input.reason] > STRENGTH[existing.reason as SuppressionReason]) {
        await db
          .updateTable('suppressions')
          .set({ reason: input.reason, scope, note: input.note ?? existing.note, source: input.source ?? existing.source, message_id: input.messageId ?? existing.message_id })
          .where('id', '=', existing.id)
          .execute();
        return { ...existing, reason: input.reason, scope };
      }
      return existing;
    }
    const row: Row<'suppressions'> = {
      id: newId('sup'),
      workspace_id: workspaceId,
      email_normalized: email,
      reason: input.reason,
      scope,
      source: input.source ?? null,
      message_id: input.messageId ?? null,
      note: input.note ?? null,
      created_by: input.createdBy ?? null,
      created_at: this.e.nowIso(),
      lifted_at: null,
      lifted_by: null,
    };
    const inserted = await db.insertInto('suppressions').values(row).onConflict((oc) => oc.doNothing()).returningAll().executeTakeFirst();
    // Lost a race with a concurrent insert: return the winner.
    return inserted ?? (await this.active(workspaceId, email, db))!;
  }

  async add(ctx: WorkspaceContext, input: { email: string; reason?: SuppressionReason; note?: string | null }): Promise<SuppressionDTO> {
    authorize(ctx, 'suppressions:manage');
    const email = normalizeEmail(input.email);
    if (!email) throw new ValidationError('Enter a valid e-mail address.', [{ path: 'email', message: 'Invalid e-mail address.' }]);
    const reason = input.reason ?? 'manual';
    if (!(SUPPRESSION_REASONS as readonly string[]).includes(reason)) throw new ValidationError('Unknown suppression reason.');
    const row = await this.suppress(ctx.workspaceId, { email, reason, note: input.note ?? null, source: `manual:${ctx.actor.label}`, createdBy: actorUserId(ctx) });
    await this.e.audit.record(ctx, 'suppression.added', { type: 'suppression', id: row.id }, { reason });
    return toDTO(row);
  }

  /**
   * Lift a suppression. Unsubscribes and complaints express the recipient's
   * wishes, so lifting them requires an administrator and a recorded reason.
   */
  async lift(ctx: WorkspaceContext, id: string, note: string): Promise<void> {
    authorize(ctx, 'suppressions:manage');
    const row = await this.e.db.selectFrom('suppressions').selectAll().where('id', '=', id).where('workspace_id', '=', ctx.workspaceId).executeTakeFirst();
    if (!row || row.lifted_at) throw new NotFoundError('Suppression', id);
    if (['unsubscribed', 'complaint'].includes(row.reason)) {
      authorize(ctx, 'integrations:manage');
      if (!note || note.trim().length < 5) {
        throw new PreconditionError('Explain why this opt-out is being lifted (for example, the contact re-subscribed in writing).');
      }
    }
    await this.e.db.updateTable('suppressions').set({ lifted_at: this.e.nowIso(), lifted_by: actorUserId(ctx), note: note || row.note }).where('id', '=', id).execute();
    await this.e.audit.record(ctx, 'suppression.lifted', { type: 'suppression', id }, { reason: row.reason });
  }

  async list(
    ctx: WorkspaceContext,
    query: { q?: string; reason?: string; includeLifted?: boolean; page?: number; pageSize?: number } = {},
  ): Promise<Page<SuppressionDTO>> {
    authorize(ctx, 'suppressions:read');
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, query.pageSize ?? 50));
    let base = this.e.db.selectFrom('suppressions').where('workspace_id', '=', ctx.workspaceId);
    if (!query.includeLifted) base = base.where('lifted_at', 'is', null);
    if (query.reason) base = base.where('reason', '=', query.reason);
    if (query.q) base = base.where(sql<boolean>`email_normalized like ${`%${escapeLike(query.q.toLowerCase())}%`} escape '\\'`);
    const total = Number((await base.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst())?.n ?? 0);
    const rows = await base.selectAll().orderBy('created_at', 'desc').limit(pageSize).offset((page - 1) * pageSize).execute();
    return { items: rows.map(toDTO), total, page, pageSize };
  }
}
