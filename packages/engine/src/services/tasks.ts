import { fullName, newId, NotFoundError, ValidationError, type Page, type TaskDTO } from '@morrow/core';
import type { Db, Row } from '@morrow/db';
import { actorUserId, authorize, type WorkspaceContext } from '../context';
import type { Engine } from '../engine';

type TaskRow = Row<'tasks'> & {
  contact_first_name?: string | null;
  contact_last_name?: string | null;
  contact_email?: string | null;
  assignee_name?: string | null;
};

function toDTO(r: TaskRow): TaskDTO {
  const contactName = fullName({ firstName: r.contact_first_name ?? null, lastName: r.contact_last_name ?? null }) || r.contact_email || null;
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    status: r.status as TaskDTO['status'],
    dueAt: r.due_at,
    contactId: r.contact_id,
    contactName,
    assigneeId: r.assignee_id,
    assigneeName: r.assignee_name ?? null,
    source: r.source as TaskDTO['source'],
    automationRunId: r.automation_run_id,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  };
}

/** Manual follow-up tasks — for moments when an automated e-mail would be inappropriate. */
export class TasksService {
  constructor(private readonly e: Engine) {}

  private query(workspaceId: string) {
    return this.e.db
      .selectFrom('tasks')
      .leftJoin('contacts', 'contacts.id', 'tasks.contact_id')
      .leftJoin('users', 'users.id', 'tasks.assignee_id')
      .selectAll('tasks')
      .select(['contacts.first_name as contact_first_name', 'contacts.last_name as contact_last_name', 'contacts.email as contact_email', 'users.name as assignee_name'])
      .where('tasks.workspace_id', '=', workspaceId);
  }

  async list(
    ctx: WorkspaceContext,
    query: { status?: string; contactId?: string; assigneeId?: string; mine?: boolean; page?: number; pageSize?: number } = {},
  ): Promise<Page<TaskDTO>> {
    authorize(ctx, 'tasks:read');
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, query.pageSize ?? 50));
    let q = this.query(ctx.workspaceId);
    if (query.status) q = q.where('tasks.status', '=', query.status);
    if (query.contactId) q = q.where('tasks.contact_id', '=', query.contactId);
    if (query.assigneeId) q = q.where('tasks.assignee_id', '=', query.assigneeId);
    if (query.mine && ctx.actor.type === 'user') q = q.where('tasks.assignee_id', '=', ctx.actor.id);
    const total = Number(
      (await q.clearSelect().select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst())?.n ?? 0,
    );
    const rows = await q
      .orderBy('tasks.status', 'desc')
      .orderBy('tasks.due_at', 'asc')
      .orderBy('tasks.created_at', 'desc')
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .execute();
    return { items: rows.map(toDTO), total, page, pageSize };
  }

  async get(ctx: WorkspaceContext, id: string): Promise<TaskDTO> {
    authorize(ctx, 'tasks:read');
    const row = await this.query(ctx.workspaceId).where('tasks.id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundError('Task', id);
    return toDTO(row);
  }

  /** Internal create used by automations (idempotent via dedupe key). */
  async createInternal(
    workspaceId: string,
    input: { title: string; description?: string | null; contactId?: string | null; dueAt?: string | null; assigneeId?: string | null; source: 'manual' | 'automation'; automationRunId?: string | null; dedupeKey?: string | null; createdBy?: string | null },
    db: Db = this.e.db,
  ): Promise<string | null> {
    const now = this.e.nowIso();
    const id = newId('tsk');
    const res = await db
      .insertInto('tasks')
      .values({
        id,
        workspace_id: workspaceId,
        contact_id: input.contactId ?? null,
        title: input.title.slice(0, 200),
        description: input.description?.slice(0, 2000) ?? null,
        status: 'open',
        due_at: input.dueAt ?? null,
        assignee_id: input.assigneeId ?? null,
        source: input.source,
        automation_run_id: input.automationRunId ?? null,
        dedupe_key: input.dedupeKey ?? null,
        created_by: input.createdBy ?? null,
        created_at: now,
        updated_at: now,
        completed_at: null,
      })
      .onConflict((oc) => oc.doNothing())
      .returning('id')
      .executeTakeFirst();
    return res?.id ?? null;
  }

  private async checkRefs(ctx: WorkspaceContext, contactId?: string | null, assigneeId?: string | null): Promise<void> {
    if (contactId) {
      const c = await this.e.db.selectFrom('contacts').select('id').where('id', '=', contactId).where('workspace_id', '=', ctx.workspaceId).executeTakeFirst();
      if (!c) throw new ValidationError('Unknown contact.', [{ path: 'contactId', message: 'Not found in this workspace.' }]);
    }
    if (assigneeId) {
      const m = await this.e.db.selectFrom('memberships').select('id').where('user_id', '=', assigneeId).where('workspace_id', '=', ctx.workspaceId).executeTakeFirst();
      if (!m) throw new ValidationError('The assignee is not a member of this workspace.', [{ path: 'assigneeId', message: 'Not a member.' }]);
    }
  }

  async create(ctx: WorkspaceContext, input: { title: string; description?: string | null; contactId?: string | null; dueAt?: string | null; assigneeId?: string | null }): Promise<TaskDTO> {
    authorize(ctx, 'tasks:write');
    const title = (input.title ?? '').trim();
    if (!title) throw new ValidationError('Give the task a title.', [{ path: 'title', message: 'Required.' }]);
    if (input.dueAt && Number.isNaN(Date.parse(input.dueAt))) throw new ValidationError('Invalid due date.', [{ path: 'dueAt', message: 'Use an ISO date.' }]);
    await this.checkRefs(ctx, input.contactId, input.assigneeId);
    const id = await this.createInternal(ctx.workspaceId, {
      ...input,
      title,
      dueAt: input.dueAt ? new Date(input.dueAt).toISOString() : null,
      source: 'manual',
      createdBy: actorUserId(ctx),
    });
    return this.get(ctx, id!);
  }

  async update(
    ctx: WorkspaceContext,
    id: string,
    input: { title?: string; description?: string | null; status?: 'open' | 'done' | 'dismissed'; dueAt?: string | null; assigneeId?: string | null },
  ): Promise<TaskDTO> {
    authorize(ctx, 'tasks:write');
    await this.get(ctx, id);
    await this.checkRefs(ctx, null, input.assigneeId);
    const now = this.e.nowIso();
    const patch: Partial<Row<'tasks'>> = { updated_at: now };
    if (input.title !== undefined) patch.title = input.title.trim().slice(0, 200) || 'Untitled task';
    if (input.description !== undefined) patch.description = input.description?.slice(0, 2000) ?? null;
    if (input.dueAt !== undefined) patch.due_at = input.dueAt ? new Date(input.dueAt).toISOString() : null;
    if (input.assigneeId !== undefined) patch.assignee_id = input.assigneeId;
    if (input.status) {
      patch.status = input.status;
      patch.completed_at = input.status === 'open' ? null : now;
    }
    await this.e.db.updateTable('tasks').set(patch).where('id', '=', id).where('workspace_id', '=', ctx.workspaceId).execute();
    return this.get(ctx, id);
  }

  async remove(ctx: WorkspaceContext, id: string): Promise<void> {
    authorize(ctx, 'tasks:write');
    await this.e.db.deleteFrom('tasks').where('id', '=', id).where('workspace_id', '=', ctx.workspaceId).execute();
  }

  async counts(workspaceId: string): Promise<{ open: number; overdue: number }> {
    const now = this.e.nowIso();
    const open = await this.e.db
      .selectFrom('tasks')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('workspace_id', '=', workspaceId)
      .where('status', '=', 'open')
      .executeTakeFirst();
    const overdue = await this.e.db
      .selectFrom('tasks')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('workspace_id', '=', workspaceId)
      .where('status', '=', 'open')
      .where('due_at', '<', now)
      .executeTakeFirst();
    return { open: Number(open?.n ?? 0), overdue: Number(overdue?.n ?? 0) };
  }
}
