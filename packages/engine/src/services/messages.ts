import {
  fullName,
  NotFoundError,
  type MessageCategory,
  type MessageDetailDTO,
  type MessageDTO,
  type MessageStatus,
  type Page,
} from '@morrow/core';
import { escapeLike, fromJson, sql, type Row } from '@morrow/db';
import { actorUserId, authorize, type WorkspaceContext } from '../context';
import type { Engine } from '../engine';

type MessageRow = Row<'messages'> & { contact_first_name?: string | null; contact_last_name?: string | null };

export function toMessageDTO(r: MessageRow): MessageDTO {
  const name = fullName({ firstName: r.contact_first_name ?? null, lastName: r.contact_last_name ?? null });
  return {
    id: r.id,
    contactId: r.contact_id,
    contactName: name || null,
    campaignId: r.campaign_id,
    automationId: r.automation_id,
    automationRunId: r.automation_run_id,
    templateId: r.template_id,
    kind: r.kind as MessageDTO['kind'],
    category: r.category as MessageCategory,
    toEmail: r.to_email,
    fromEmail: r.from_email,
    fromName: r.from_name,
    subject: r.subject,
    status: r.status as MessageStatus,
    approvalStatus: r.approval_status as MessageDTO['approvalStatus'],
    provider: r.provider,
    providerMessageId: r.provider_message_id,
    attempts: r.attempts,
    errorCode: r.error_code,
    errorMessage: r.error_message,
    errorClass: (r.error_class as MessageDTO['errorClass']) ?? null,
    scheduledFor: r.scheduled_for,
    queuedAt: r.queued_at,
    sentAt: r.sent_at,
    deliveredAt: r.delivered_at,
    bouncedAt: r.bounced_at,
    bounceType: (r.bounce_type as MessageDTO['bounceType']) ?? null,
    complainedAt: r.complained_at,
    openedAt: r.opened_at,
    clickedAt: r.clicked_at,
    unsubscribedAt: r.unsubscribed_at,
    failedAt: r.failed_at,
    createdAt: r.created_at,
  };
}

export interface MessageQuery {
  status?: string;
  kind?: string;
  campaignId?: string;
  automationId?: string;
  contactId?: string;
  provider?: string;
  q?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export class MessagesService {
  constructor(private readonly e: Engine) {}

  private base(workspaceId: string, query: MessageQuery) {
    let q = this.e.db
      .selectFrom('messages')
      .leftJoin('contacts', 'contacts.id', 'messages.contact_id')
      .where('messages.workspace_id', '=', workspaceId);
    if (query.status) q = q.where('messages.status', 'in', query.status.split(',').slice(0, 10));
    if (query.kind) q = q.where('messages.kind', '=', query.kind);
    if (query.campaignId) q = q.where('messages.campaign_id', '=', query.campaignId);
    if (query.automationId) q = q.where('messages.automation_id', '=', query.automationId);
    if (query.contactId) q = q.where('messages.contact_id', '=', query.contactId);
    if (query.provider) q = q.where('messages.provider', '=', query.provider);
    if (query.from) q = q.where('messages.created_at', '>=', query.from);
    if (query.to) q = q.where('messages.created_at', '<', query.to);
    if (query.q) {
      const like = `%${escapeLike(query.q.toLowerCase())}%`;
      q = q.where(sql<boolean>`(lower(messages.to_email) like ${like} escape '\\' or lower(messages.subject) like ${like} escape '\\')`);
    }
    return q;
  }

  async list(ctx: WorkspaceContext, query: MessageQuery = {}): Promise<Page<MessageDTO>> {
    authorize(ctx, 'messages:read');
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, query.pageSize ?? 50));
    const total = Number(
      (await this.base(ctx.workspaceId, query).select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst())?.n ?? 0,
    );
    const rows = await this.base(ctx.workspaceId, query)
      .selectAll('messages')
      .select(['contacts.first_name as contact_first_name', 'contacts.last_name as contact_last_name'])
      .orderBy('messages.created_at', 'desc')
      .orderBy('messages.id', 'desc')
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .execute();
    return { items: rows.map(toMessageDTO), total, page, pageSize };
  }

  async get(ctx: WorkspaceContext, id: string): Promise<MessageDetailDTO> {
    authorize(ctx, 'messages:read');
    const row = await this.e.db
      .selectFrom('messages')
      .leftJoin('contacts', 'contacts.id', 'messages.contact_id')
      .selectAll('messages')
      .select(['contacts.first_name as contact_first_name', 'contacts.last_name as contact_last_name'])
      .where('messages.id', '=', id)
      .where('messages.workspace_id', '=', ctx.workspaceId)
      .executeTakeFirst();
    if (!row) throw new NotFoundError('Message', id);
    const events = await this.e.db
      .selectFrom('message_events')
      .selectAll()
      .where('message_id', '=', id)
      .where('workspace_id', '=', ctx.workspaceId)
      .orderBy('occurred_at', 'asc')
      .execute();
    return {
      ...toMessageDTO(row),
      html: row.html,
      text: row.text,
      events: events.map((ev) => ({ id: ev.id, type: ev.type, provider: ev.provider, occurredAt: ev.occurred_at, data: fromJson(ev.data, {}) })),
    };
  }

  async pendingApprovals(ctx: WorkspaceContext, query: { automationId?: string; page?: number; pageSize?: number } = {}): Promise<Page<MessageDTO>> {
    return this.list(ctx, { ...query, status: 'pending_approval' });
  }

  /** Approve messages held for review; they are queued and re-checked at send time. */
  async approve(ctx: WorkspaceContext, ids: string[]): Promise<{ approved: number }> {
    authorize(ctx, 'messages:approve');
    let approved = 0;
    const now = this.e.nowIso();
    for (const id of [...new Set(ids)].slice(0, 500)) {
      const ok = await this.e.db.transaction().execute(async (trx) => {
        const res = await trx
          .updateTable('messages')
          .set({ status: 'queued', approval_status: 'approved', approved_by: actorUserId(ctx), approved_at: now, queued_at: now, updated_at: now })
          .where('id', '=', id)
          .where('workspace_id', '=', ctx.workspaceId)
          .where('status', '=', 'pending_approval')
          .executeTakeFirst();
        if (Number(res.numUpdatedRows ?? 0) === 0) return false;
        await this.e.delivery.enqueueSend(id, ctx.workspaceId, undefined, trx);
        return true;
      });
      if (ok) approved++;
    }
    if (approved) {
      await this.e.audit.record(ctx, 'messages.approved', null, { count: approved });
      this.e.nudgeWorker();
    }
    return { approved };
  }

  async reject(ctx: WorkspaceContext, ids: string[], note?: string): Promise<{ rejected: number }> {
    authorize(ctx, 'messages:approve');
    const res = await this.e.db
      .updateTable('messages')
      .set({
        status: 'cancelled',
        approval_status: 'rejected',
        approved_by: actorUserId(ctx),
        approved_at: this.e.nowIso(),
        error_code: 'rejected_in_review',
        error_message: note ? note.slice(0, 500) : 'Rejected during review',
        updated_at: this.e.nowIso(),
      })
      .where('id', 'in', [...new Set(ids)].slice(0, 500))
      .where('workspace_id', '=', ctx.workspaceId)
      .where('status', '=', 'pending_approval')
      .executeTakeFirst();
    const rejected = Number(res.numUpdatedRows ?? 0);
    if (rejected) await this.e.audit.record(ctx, 'messages.rejected', null, { count: rejected });
    return { rejected };
  }

  /** Cancel a message that has not been handed to the provider yet. */
  async cancel(ctx: WorkspaceContext, id: string): Promise<{ cancelled: boolean; reason?: string }> {
    authorize(ctx, 'campaigns:write');
    const row = await this.e.db.selectFrom('messages').select(['status']).where('id', '=', id).where('workspace_id', '=', ctx.workspaceId).executeTakeFirst();
    if (!row) throw new NotFoundError('Message', id);
    if (!['queued', 'pending_approval'].includes(row.status)) {
      return { cancelled: false, reason: `The message is already ${row.status}; once a provider has accepted a message it cannot be recalled.` };
    }
    await this.e.db
      .updateTable('messages')
      .set({ status: 'cancelled', updated_at: this.e.nowIso() })
      .where('id', '=', id)
      .where('status', 'in', ['queued', 'pending_approval'])
      .execute();
    await this.e.queue.cancelByDedupeKey(`send:${id}`);
    await this.e.audit.record(ctx, 'message.cancelled', { type: 'message', id });
    return { cancelled: true };
  }
}
