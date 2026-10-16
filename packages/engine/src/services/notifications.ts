import { newId, type NotificationDTO, type Role } from '@morrow/core';
import type { Row } from '@morrow/db';
import { requireUser, type WorkspaceContext } from '../context';
import type { Engine } from '../engine';

function toDTO(r: Row<'notifications'>): NotificationDTO {
  return { id: r.id, kind: r.kind, title: r.title, body: r.body, link: r.link, readAt: r.read_at, createdAt: r.created_at };
}

export interface NotificationInput {
  kind: string;
  title: string;
  body?: string | null;
  link?: string | null;
  /** Prevents the same alert being created repeatedly (per user). */
  dedupeKey?: string;
  /** Also e-mail the recipients (transactional, internal). */
  email?: boolean;
}

/** In-app notifications for workspace members (failures, approvals, automation alerts). */
export class NotificationsService {
  constructor(private readonly e: Engine) {}

  async notify(workspaceId: string, userIds: string[], input: NotificationInput): Promise<number> {
    let created = 0;
    const now = this.e.nowIso();
    for (const userId of [...new Set(userIds)]) {
      const res = await this.e.db
        .insertInto('notifications')
        .values({
          id: newId('ntf'),
          workspace_id: workspaceId,
          user_id: userId,
          kind: input.kind,
          title: input.title.slice(0, 200),
          body: input.body?.slice(0, 2000) ?? null,
          link: input.link ?? null,
          dedupe_key: input.dedupeKey ?? null,
          read_at: null,
          created_at: now,
        })
        .onConflict((oc) => oc.doNothing())
        .returning('id')
        .executeTakeFirst();
      if (res) created++;
    }
    if (created && input.email) {
      const users = await this.e.db.selectFrom('users').select(['id', 'email']).where('id', 'in', userIds).execute();
      for (const u of users) {
        await this.e.system
          .sendSystemEmail(workspaceId, {
            to: u.email,
            subject: input.title,
            text: `${input.body ?? input.title}${input.link ? `\n\n${this.e.config.appUrl}${input.link}` : ''}`,
            idempotencyKey: `notify:${input.dedupeKey ?? newId('ntf')}:${u.id}`,
          })
          .catch((err) => this.e.log.warn('notification e-mail not sent', { error: err as Error }));
      }
    }
    return created;
  }

  async membersWithRoles(workspaceId: string, roles: Role[]): Promise<string[]> {
    const rows = await this.e.db.selectFrom('memberships').select('user_id').where('workspace_id', '=', workspaceId).where('role', 'in', roles).execute();
    return rows.map((r) => r.user_id);
  }

  async notifyAdmins(workspaceId: string, input: NotificationInput): Promise<number> {
    return this.notify(workspaceId, await this.membersWithRoles(workspaceId, ['owner', 'admin']), input);
  }

  async notifyTeam(workspaceId: string, input: NotificationInput): Promise<number> {
    return this.notify(workspaceId, await this.membersWithRoles(workspaceId, ['owner', 'admin', 'manager']), input);
  }

  async list(ctx: WorkspaceContext, options: { unreadOnly?: boolean; limit?: number } = {}): Promise<{ items: NotificationDTO[]; unread: number }> {
    const userId = requireUser(ctx);
    let q = this.e.db
      .selectFrom('notifications')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('user_id', '=', userId)
      .orderBy('created_at', 'desc')
      .limit(Math.min(options.limit ?? 30, 100));
    if (options.unreadOnly) q = q.where('read_at', 'is', null);
    const items = (await q.execute()).map(toDTO);
    const unread = Number(
      (
        await this.e.db
          .selectFrom('notifications')
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .where('workspace_id', '=', ctx.workspaceId)
          .where('user_id', '=', userId)
          .where('read_at', 'is', null)
          .executeTakeFirst()
      )?.n ?? 0,
    );
    return { items, unread };
  }

  async markRead(ctx: WorkspaceContext, ids: string[] | 'all'): Promise<void> {
    const userId = requireUser(ctx);
    let q = this.e.db
      .updateTable('notifications')
      .set({ read_at: this.e.nowIso() })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('user_id', '=', userId)
      .where('read_at', 'is', null);
    if (ids !== 'all') q = q.where('id', 'in', ids.slice(0, 500));
    await q.execute();
  }
}
