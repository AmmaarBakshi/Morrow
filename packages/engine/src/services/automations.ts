import {
  addDays,
  automationDefinitionSchema,
  checkDefinition,
  collectSteps,
  compileSteps,
  describeTrigger,
  emptyCriteria,
  fullName,
  localDate,
  newId,
  NotFoundError,
  PreconditionError,
  randomToken,
  referencedSegments,
  referencedTemplates,
  toFieldIssues,
  ValidationError,
  type AutomationDefinition,
  type AutomationDefinitionInput,
  type AutomationDTO,
  type AutomationRunDTO,
  type AutomationStatsDTO,
  type DryRunContactDTO,
  type DryRunResultDTO,
  type Page,
  type Trigger,
} from '@morrow/core';
import { fromJson, sql, toJson, type Row } from '@morrow/db';
import { actorUserId, authorize, type WorkspaceContext } from '../context';
import type { Engine } from '../engine';

export interface DefinitionProblemDTO {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

function emptyStats(): AutomationStatsDTO {
  return { runs: 0, active: 0, completed: 0, skipped: 0, failed: 0, messages: 0, pendingApproval: 0 };
}

/**
 * Automation CRUD, validation, activation (with explicit approval for fully
 * automatic delivery), dry runs and manual runs.
 */
export class AutomationsService {
  constructor(private readonly e: Engine) {}

  // ------------------------------------------------------------ helpers

  parse(raw: unknown): AutomationDefinition {
    const parsed = automationDefinitionSchema.safeParse(raw);
    if (!parsed.success) throw new ValidationError('The automation definition is invalid.', toFieldIssues(parsed.error.issues));
    try {
      compileSteps(parsed.data.steps);
    } catch (err) {
      throw new ValidationError((err as Error).message, [{ path: 'steps', message: (err as Error).message }]);
    }
    return parsed.data;
  }

  /** Reference checks against workspace data. Errors block activation; warnings are advisory. */
  async check(workspaceId: string, def: AutomationDefinition): Promise<DefinitionProblemDTO[]> {
    const problems: DefinitionProblemDTO[] = checkDefinition(def).map((p) => ({ ...p }));
    for (const templateId of referencedTemplates(def)) {
      const t = await this.e.db.selectFrom('templates').select(['name', 'status', 'published_version_id']).where('id', '=', templateId).where('workspace_id', '=', workspaceId).executeTakeFirst();
      if (!t) problems.push({ path: 'steps', message: `Template ${templateId} does not exist.`, severity: 'error' });
      else if (t.status === 'archived') problems.push({ path: 'steps', message: `Template "${t.name}" is archived.`, severity: 'error' });
      else if (!t.published_version_id) problems.push({ path: 'steps', message: `Template "${t.name}" has not been published.`, severity: 'error' });
    }
    const steps = collectSteps(def.steps);
    const senderIds = [...new Set(steps.flatMap((s) => (s.type === 'send_email' && s.senderId ? [s.senderId] : [])))];
    for (const id of senderIds) {
      if (!(await this.e.senders.resolve(workspaceId, id))) problems.push({ path: 'steps', message: 'A step uses a sender that is not verified.', severity: 'error' });
    }
    if (steps.some((s) => s.type === 'send_email' && !s.senderId) && !(await this.e.senders.defaultSender(workspaceId))) {
      problems.push({ path: 'steps', message: 'Verify a sender address before e-mails can be sent.', severity: 'error' });
    }
    const segmentIds = new Set([
      ...referencedSegments(def.conditions ?? emptyCriteria()),
      ...steps.flatMap((s) => (s.type === 'branch' ? referencedSegments(s.condition) : [])),
      ...(def.trigger.type === 'segment_entered' ? [def.trigger.segmentId] : []),
      ...((def.trigger.type === 'schedule' || def.trigger.type === 'manual') && def.trigger.segmentId ? [def.trigger.segmentId] : []),
    ]);
    for (const id of segmentIds) {
      const seg = await this.e.db.selectFrom('segments').select(['archived_at']).where('id', '=', id).where('workspace_id', '=', workspaceId).executeTakeFirst();
      if (!seg || seg.archived_at) problems.push({ path: 'segments', message: `Segment ${id} does not exist.`, severity: 'error' });
    }
    if (def.trigger.type === 'calendar' && def.trigger.field.startsWith('custom:')) {
      const key = def.trigger.field.slice(7);
      const f = await this.e.db.selectFrom('custom_fields').select('type').where('workspace_id', '=', workspaceId).where('key', '=', key).where('archived_at', 'is', null).executeTakeFirst();
      if (!f || f.type !== 'date') problems.push({ path: 'trigger.field', message: `Custom field "${key}" must exist and be a date field.`, severity: 'error' });
    }
    if (def.trigger.type === 'schedule' && def.trigger.recurrence.frequency === 'once') {
      const ws = await this.e.workspaces.row(workspaceId);
      if (def.trigger.recurrence.date < localDate(this.e.now(), ws.timezone)) problems.push({ path: 'trigger', message: 'The scheduled date is in the past.', severity: 'error' });
    }
    for (const s of steps) {
      if (s.type === 'create_task' && s.assigneeUserId) {
        const m = await this.e.db.selectFrom('memberships').select('id').where('workspace_id', '=', workspaceId).where('user_id', '=', s.assigneeUserId).executeTakeFirst();
        if (!m) problems.push({ path: 'steps', message: 'A task assignee is not a member of this workspace.', severity: 'error' });
      }
    }
    return problems;
  }

  private async stats(workspaceId: string, ids: string[]): Promise<Map<string, AutomationStatsDTO>> {
    const out = new Map<string, AutomationStatsDTO>();
    if (!ids.length) return out;
    const runs = await this.e.db
      .selectFrom('automation_runs')
      .select(['automation_id', 'status', (eb) => eb.fn.countAll<number>().as('n')])
      .where('workspace_id', '=', workspaceId)
      .where('automation_id', 'in', ids)
      .groupBy(['automation_id', 'status'])
      .execute();
    for (const r of runs) {
      const s = out.get(r.automation_id) ?? emptyStats();
      const n = Number(r.n);
      s.runs += n;
      if (r.status === 'running' || r.status === 'waiting') s.active += n;
      if (r.status === 'completed') s.completed += n;
      if (r.status === 'skipped') s.skipped += n;
      if (r.status === 'failed') s.failed += n;
      out.set(r.automation_id, s);
    }
    const msgs = await this.e.db
      .selectFrom('messages')
      .select(['automation_id', 'status', (eb) => eb.fn.countAll<number>().as('n')])
      .where('workspace_id', '=', workspaceId)
      .where('automation_id', 'in', ids)
      .groupBy(['automation_id', 'status'])
      .execute();
    for (const m of msgs) {
      if (!m.automation_id) continue;
      const s = out.get(m.automation_id) ?? emptyStats();
      if (m.status === 'pending_approval') s.pendingApproval += Number(m.n);
      else if (m.status !== 'suppressed' && m.status !== 'cancelled') s.messages += Number(m.n);
      out.set(m.automation_id, s);
    }
    return out;
  }

  private async toDTO(a: Row<'automations'>, stats?: AutomationStatsDTO): Promise<AutomationDTO> {
    const v = a.current_version_id
      ? await this.e.db.selectFrom('automation_versions').selectAll().where('id', '=', a.current_version_id).executeTakeFirst()
      : undefined;
    const definition = v ? automationDefinitionSchema.parse(fromJson(v.definition, {})) : automationDefinitionSchema.parse({ trigger: { type: 'manual' }, steps: [{ id: 'end', type: 'end' }] });
    return {
      id: a.id,
      name: a.name,
      description: a.description,
      status: a.status as AutomationDTO['status'],
      triggerType: a.trigger_type,
      triggerSummary: describeTrigger(definition.trigger),
      deliveryMode: a.delivery_mode as AutomationDTO['deliveryMode'],
      autoApprovedBy: a.auto_approved_by,
      autoApprovedAt: a.auto_approved_at,
      activatedAt: a.activated_at,
      lastTriggeredAt: a.last_triggered_at,
      version: v?.version ?? 0,
      versionId: v?.id ?? null,
      definition,
      stats: stats ?? (await this.stats(a.workspace_id, [a.id])).get(a.id) ?? emptyStats(),
      createdAt: a.created_at,
      updatedAt: a.updated_at,
    };
  }

  async row(workspaceId: string, id: string): Promise<Row<'automations'>> {
    const a = await this.e.db.selectFrom('automations').selectAll().where('id', '=', id).where('workspace_id', '=', workspaceId).executeTakeFirst();
    if (!a) throw new NotFoundError('Automation', id);
    return a;
  }

  // ------------------------------------------------------------ reads

  async list(ctx: WorkspaceContext, query: { status?: string } = {}): Promise<AutomationDTO[]> {
    authorize(ctx, 'automations:read');
    let q = this.e.db.selectFrom('automations').selectAll().where('workspace_id', '=', ctx.workspaceId);
    q = query.status ? q.where('status', '=', query.status) : q.where('status', '!=', 'archived');
    const rows = await q.orderBy('created_at', 'asc').execute();
    const stats = await this.stats(ctx.workspaceId, rows.map((r) => r.id));
    return Promise.all(rows.map((r) => this.toDTO(r, stats.get(r.id) ?? emptyStats())));
  }

  async get(ctx: WorkspaceContext, id: string): Promise<AutomationDTO & { problems: DefinitionProblemDTO[] }> {
    authorize(ctx, 'automations:read');
    const a = await this.row(ctx.workspaceId, id);
    const dto = await this.toDTO(a);
    return { ...dto, problems: await this.check(ctx.workspaceId, dto.definition) };
  }

  async usingTemplate(workspaceId: string, templateId: string): Promise<string[]> {
    const rows = await this.e.db
      .selectFrom('automations')
      .innerJoin('automation_versions', 'automation_versions.id', 'automations.current_version_id')
      .select(['automations.name', 'automation_versions.definition'])
      .where('automations.workspace_id', '=', workspaceId)
      .where('automations.status', 'in', ['active', 'paused'])
      .execute();
    return rows.filter((r) => r.definition.includes(templateId)).map((r) => r.name);
  }

  // ------------------------------------------------------------ writes

  private async insertVersion(workspaceId: string, automationId: string, def: AutomationDefinition, createdBy: string | null): Promise<string> {
    const latest = await this.e.db
      .selectFrom('automation_versions')
      .select((eb) => eb.fn.max('version').as('v'))
      .where('automation_id', '=', automationId)
      .executeTakeFirst();
    const id = newId('auv');
    await this.e.db
      .insertInto('automation_versions')
      .values({ id, workspace_id: workspaceId, automation_id: automationId, version: Number(latest?.v ?? 0) + 1, definition: toJson(def), created_by: createdBy, created_at: this.e.nowIso() })
      .execute();
    return id;
  }

  /** Create without permission checks (starter content). */
  async createInternal(ctx: WorkspaceContext, name: string, description: string | null, raw: AutomationDefinitionInput): Promise<string> {
    const def = this.parse(raw);
    const now = this.e.nowIso();
    const id = newId('aut');
    await this.e.db
      .insertInto('automations')
      .values({
        id,
        workspace_id: ctx.workspaceId,
        name: name.slice(0, 120),
        description: description?.slice(0, 1000) ?? null,
        status: 'draft',
        trigger_type: def.trigger.type,
        current_version_id: null,
        delivery_mode: 'review',
        auto_approved_by: null,
        auto_approved_at: null,
        activated_at: null,
        last_triggered_at: null,
        created_by: actorUserId(ctx),
        created_at: now,
        updated_at: now,
      })
      .execute();
    const versionId = await this.insertVersion(ctx.workspaceId, id, def, actorUserId(ctx));
    await this.e.db.updateTable('automations').set({ current_version_id: versionId }).where('id', '=', id).execute();
    return id;
  }

  async create(ctx: WorkspaceContext, input: { name: string; description?: string | null; definition: unknown }): Promise<AutomationDTO> {
    authorize(ctx, 'automations:write');
    const name = (input.name ?? '').trim();
    if (!name) throw new ValidationError('Name the automation.', [{ path: 'name', message: 'Required.' }]);
    const id = await this.createInternal(ctx, name, input.description?.trim() || null, input.definition as AutomationDefinitionInput);
    await this.e.audit.record(ctx, 'automation.created', { type: 'automation', id }, { name });
    return this.get(ctx, id);
  }

  /**
   * Edit an automation. A changed definition becomes a new immutable version;
   * in-flight runs finish on the version they started with. Editing clears
   * automatic-delivery approval, which must be granted again.
   */
  async update(ctx: WorkspaceContext, id: string, input: { name?: string; description?: string | null; definition?: unknown }): Promise<AutomationDTO> {
    authorize(ctx, 'automations:write');
    const a = await this.row(ctx.workspaceId, id);
    if (a.status === 'archived') throw new PreconditionError('Restore the automation before editing it.');
    const patch: Partial<Row<'automations'>> = { updated_at: this.e.nowIso() };
    if (input.name !== undefined) patch.name = input.name.trim().slice(0, 120) || a.name;
    if (input.description !== undefined) patch.description = input.description?.trim().slice(0, 1000) || null;
    let clearedAuto = false;
    if (input.definition !== undefined) {
      const def = this.parse(input.definition);
      const current = a.current_version_id ? await this.e.db.selectFrom('automation_versions').select('definition').where('id', '=', a.current_version_id).executeTakeFirst() : undefined;
      if (!current || current.definition !== toJson(def)) {
        if (a.status === 'active') {
          const errors = (await this.check(ctx.workspaceId, def)).filter((p) => p.severity === 'error');
          if (errors.length) throw new ValidationError(`Cannot save changes to an active automation: ${errors[0]!.message}`, errors);
        }
        patch.current_version_id = await this.insertVersion(ctx.workspaceId, id, def, actorUserId(ctx));
        patch.trigger_type = def.trigger.type;
        if (a.delivery_mode === 'auto') {
          patch.delivery_mode = 'review';
          patch.auto_approved_by = null;
          patch.auto_approved_at = null;
          clearedAuto = true;
        }
      }
    }
    await this.e.db.updateTable('automations').set(patch).where('id', '=', id).execute();
    this.e.triggers.invalidate(ctx.workspaceId);
    await this.e.audit.record(ctx, 'automation.updated', { type: 'automation', id }, { newVersion: Boolean(patch.current_version_id), autoApprovalCleared: clearedAuto });
    return this.get(ctx, id);
  }

  /**
   * Activate. Default delivery is "review": generated e-mails wait in the
   * approval queue. Fully automatic delivery requires an administrator.
   */
  async activate(ctx: WorkspaceContext, id: string, input: { deliveryMode?: 'review' | 'auto' } = {}): Promise<AutomationDTO> {
    authorize(ctx, 'automations:activate');
    const a = await this.row(ctx.workspaceId, id);
    if (a.status === 'archived') throw new PreconditionError('Restore the automation first.');
    const dto = await this.toDTO(a);
    const errors = (await this.check(ctx.workspaceId, dto.definition)).filter((p) => p.severity === 'error');
    if (errors.length) throw new PreconditionError(`Fix these problems before activating: ${errors.map((e) => e.message).join(' ')}`, { problems: errors });
    const mode = input.deliveryMode ?? (a.delivery_mode as 'review' | 'auto');
    const now = this.e.nowIso();
    const patch: Partial<Row<'automations'>> = { status: 'active', activated_at: a.status === 'active' ? a.activated_at : now, updated_at: now, delivery_mode: mode };
    if (mode === 'auto' && (a.delivery_mode !== 'auto' || !a.auto_approved_at)) {
      authorize(ctx, 'automations:approve_auto');
      patch.auto_approved_by = actorUserId(ctx) ?? ctx.actor.label;
      patch.auto_approved_at = now;
    }
    if (mode === 'review') {
      patch.auto_approved_by = null;
      patch.auto_approved_at = null;
    }
    await this.e.db.updateTable('automations').set(patch).where('id', '=', id).execute();
    this.e.triggers.invalidate(ctx.workspaceId);
    await this.e.audit.record(ctx, 'automation.activated', { type: 'automation', id }, { deliveryMode: mode });
    return this.get(ctx, id);
  }

  async setDeliveryMode(ctx: WorkspaceContext, id: string, mode: 'review' | 'auto'): Promise<AutomationDTO> {
    authorize(ctx, mode === 'auto' ? 'automations:approve_auto' : 'automations:activate');
    const a = await this.row(ctx.workspaceId, id);
    const now = this.e.nowIso();
    await this.e.db
      .updateTable('automations')
      .set(mode === 'auto' ? { delivery_mode: 'auto', auto_approved_by: actorUserId(ctx) ?? ctx.actor.label, auto_approved_at: now, updated_at: now } : { delivery_mode: 'review', auto_approved_by: null, auto_approved_at: null, updated_at: now })
      .where('id', '=', a.id)
      .execute();
    await this.e.audit.record(ctx, 'automation.delivery_mode_changed', { type: 'automation', id }, { mode });
    return this.get(ctx, id);
  }

  async pause(ctx: WorkspaceContext, id: string): Promise<AutomationDTO> {
    authorize(ctx, 'automations:activate');
    const a = await this.row(ctx.workspaceId, id);
    if (a.status !== 'active') throw new PreconditionError('Only active automations can be paused.');
    await this.e.db.updateTable('automations').set({ status: 'paused', updated_at: this.e.nowIso() }).where('id', '=', id).execute();
    this.e.triggers.invalidate(ctx.workspaceId);
    await this.e.audit.record(ctx, 'automation.paused', { type: 'automation', id });
    return this.get(ctx, id);
  }

  async resume(ctx: WorkspaceContext, id: string): Promise<AutomationDTO> {
    const a = await this.row(ctx.workspaceId, id);
    if (a.status !== 'paused') throw new PreconditionError('Only paused automations can be resumed.');
    return this.activate(ctx, id, { deliveryMode: a.delivery_mode as 'review' | 'auto' });
  }

  async archive(ctx: WorkspaceContext, id: string): Promise<void> {
    authorize(ctx, 'automations:write');
    await this.row(ctx.workspaceId, id);
    const now = this.e.nowIso();
    await this.e.db.transaction().execute(async (trx) => {
      await trx.updateTable('automations').set({ status: 'archived', updated_at: now }).where('id', '=', id).execute();
      await trx
        .updateTable('automation_runs')
        .set({ status: 'cancelled', error: 'Automation archived', completed_at: now, updated_at: now })
        .where('automation_id', '=', id)
        .where('status', 'in', ['running', 'waiting'])
        .execute();
      await trx
        .updateTable('messages')
        .set({ status: 'cancelled', error_code: 'automation_archived', updated_at: now })
        .where('automation_id', '=', id)
        .where('status', 'in', ['pending_approval', 'queued'])
        .execute();
    });
    this.e.triggers.invalidate(ctx.workspaceId);
    await this.e.audit.record(ctx, 'automation.archived', { type: 'automation', id });
  }

  async restore(ctx: WorkspaceContext, id: string): Promise<AutomationDTO> {
    authorize(ctx, 'automations:write');
    await this.e.db.updateTable('automations').set({ status: 'draft', updated_at: this.e.nowIso() }).where('id', '=', id).where('workspace_id', '=', ctx.workspaceId).where('status', '=', 'archived').execute();
    return this.get(ctx, id);
  }

  async duplicate(ctx: WorkspaceContext, id: string): Promise<AutomationDTO> {
    authorize(ctx, 'automations:write');
    const src = await this.toDTO(await this.row(ctx.workspaceId, id));
    const copy = await this.createInternal(ctx, `${src.name} (copy)`, src.description, src.definition);
    await this.e.audit.record(ctx, 'automation.duplicated', { type: 'automation', id: copy }, { from: id });
    return this.get(ctx, copy);
  }

  // ------------------------------------------------------------ runs

  private runDTO(r: Row<'automation_runs'> & { first_name?: string | null; last_name?: string | null; email?: string | null; automation_name?: string }): AutomationRunDTO {
    return {
      id: r.id,
      automationId: r.automation_id,
      automationName: r.automation_name,
      contactId: r.contact_id,
      contactName: fullName({ firstName: r.first_name ?? null, lastName: r.last_name ?? null }) || null,
      contactEmail: r.email ?? null,
      eventKey: r.event_key,
      status: r.status as AutomationRunDTO['status'],
      cursor: r.cursor,
      resumeAt: r.resume_at,
      error: r.error,
      startedAt: r.started_at,
      completedAt: r.completed_at,
    };
  }

  async runs(ctx: WorkspaceContext, automationId: string, query: { status?: string; page?: number; pageSize?: number } = {}): Promise<Page<AutomationRunDTO>> {
    authorize(ctx, 'automations:read');
    await this.row(ctx.workspaceId, automationId);
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, query.pageSize ?? 50));
    let base = this.e.db
      .selectFrom('automation_runs')
      .leftJoin('contacts', 'contacts.id', 'automation_runs.contact_id')
      .where('automation_runs.workspace_id', '=', ctx.workspaceId)
      .where('automation_runs.automation_id', '=', automationId);
    if (query.status) base = base.where('automation_runs.status', '=', query.status);
    const total = Number((await base.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst())?.n ?? 0);
    const rows = await base
      .selectAll('automation_runs')
      .select(['contacts.first_name', 'contacts.last_name', 'contacts.email'])
      .orderBy('automation_runs.started_at', 'desc')
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .execute();
    return { items: rows.map((r) => this.runDTO(r)), total, page, pageSize };
  }

  async run(ctx: WorkspaceContext, runId: string): Promise<AutomationRunDTO> {
    authorize(ctx, 'automations:read');
    const r = await this.e.db
      .selectFrom('automation_runs')
      .leftJoin('contacts', 'contacts.id', 'automation_runs.contact_id')
      .innerJoin('automations', 'automations.id', 'automation_runs.automation_id')
      .selectAll('automation_runs')
      .select(['contacts.first_name', 'contacts.last_name', 'contacts.email', 'automations.name as automation_name'])
      .where('automation_runs.id', '=', runId)
      .where('automation_runs.workspace_id', '=', ctx.workspaceId)
      .executeTakeFirst();
    if (!r) throw new NotFoundError('Run', runId);
    const steps = await this.e.db.selectFrom('automation_run_steps').selectAll().where('run_id', '=', runId).orderBy('created_at', 'asc').orderBy('id', 'asc').execute();
    return {
      ...this.runDTO(r),
      steps: steps.map((s) => ({ id: s.id, stepId: s.step_id, stepType: s.step_type, status: s.status as 'ok', detail: s.detail, createdAt: s.created_at })),
    };
  }

  async cancelRun(ctx: WorkspaceContext, runId: string): Promise<void> {
    authorize(ctx, 'automations:activate');
    const now = this.e.nowIso();
    const res = await this.e.db
      .updateTable('automation_runs')
      .set({ status: 'cancelled', error: `Cancelled by ${ctx.actor.label}`, completed_at: now, updated_at: now })
      .where('id', '=', runId)
      .where('workspace_id', '=', ctx.workspaceId)
      .where('status', 'in', ['running', 'waiting'])
      .executeTakeFirst();
    if (Number(res.numUpdatedRows ?? 0) === 0) throw new PreconditionError('Only running or waiting runs can be cancelled.');
    await this.e.audit.record(ctx, 'automation.run_cancelled', { type: 'automation_run', id: runId });
  }

  // ------------------------------------------------------------ dry runs & manual runs

  /**
   * Simulate the automation at a moment in time (e.g. "on 7 March at 09:00")
   * without sending anything or writing to the database.
   */
  async dryRun(
    ctx: WorkspaceContext,
    id: string,
    input: { at?: string; contactIds?: string[]; limit?: number; definition?: unknown } = {},
  ): Promise<DryRunResultDTO> {
    authorize(ctx, 'automations:read');
    const a = await this.row(ctx.workspaceId, id);
    const def = input.definition !== undefined ? this.parse(input.definition) : (await this.toDTO(a)).definition;
    const loaded = { definition: def, compiled: compileSteps(def.steps) };
    const at = input.at ? new Date(input.at) : this.e.now();
    if (Number.isNaN(at.getTime())) throw new ValidationError('Invalid simulation time.', [{ path: 'at', message: 'Use an ISO timestamp.' }]);
    const limit = Math.min(100, Math.max(1, input.limit ?? 25));
    const ws = await this.e.workspaces.row(ctx.workspaceId);
    const t = def.trigger;
    const candidates: Array<{ contact: Row<'contacts'>; eventKey: string; eventData: Record<string, unknown> }> = [];
    let truncated = false;

    if (input.contactIds?.length) {
      const rows = await this.e.db.selectFrom('contacts').selectAll().where('workspace_id', '=', ctx.workspaceId).where('id', 'in', input.contactIds.slice(0, limit)).execute();
      for (const c of rows) candidates.push({ contact: c, eventKey: `dryrun:${at.toISOString()}`, eventData: t.type === 'calendar' ? { field: t.field, occasion_date: localDate(at, c.timezone ?? ws.timezone), years: 1 } : {} });
    } else if (t.type === 'calendar') {
      const zones = t.timezoneMode === 'workspace' ? [ws.timezone] : await this.zones(ctx.workspaceId, ws.timezone);
      for (const zone of zones) {
        const occasionDate = addDays(localDate(at, zone), -t.offsetDays);
        const batch = await this.e.triggers.calendarCandidates(ctx.workspaceId, ws.timezone, t, occasionDate, t.timezoneMode === 'contact' ? zone : null, '', limit + 1);
        for (const { contact, years } of batch) {
          candidates.push({ contact, eventKey: `${t.field}:${occasionDate}`, eventData: { field: t.field, occasion_date: occasionDate, ...(years !== null ? { years } : {}) } });
        }
      }
    } else if (t.type === 'inactivity') {
      const cutoff = new Date(at.getTime() - t.days * 86_400_000).toISOString();
      const rows = await this.e.db
        .selectFrom('contacts')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('status', '=', 'active')
        .where(sql<boolean>`coalesce(last_interaction_at, created_at) < ${cutoff}`)
        .orderBy('id')
        .limit(limit + 1)
        .execute();
      for (const c of rows) candidates.push({ contact: c, eventKey: `inactive:${(c.last_interaction_at ?? c.created_at).slice(0, 10)}`, eventData: {} });
    } else {
      const segmentId = t.type === 'segment_entered' ? t.segmentId : t.type === 'schedule' || t.type === 'manual' ? t.segmentId : null;
      const criteria = await this.e.segments.criteriaFor(ctx.workspaceId, segmentId ?? null);
      const rows = await this.e.segments.contactBatch(ctx.workspaceId, criteria, '', limit + 1, { now: at });
      for (const c of rows) candidates.push({ contact: c, eventKey: `dryrun:${at.toISOString()}`, eventData: t.type === 'event' ? { event: {}, event_name: t.name } : {} });
    }
    if (candidates.length > limit) {
      truncated = true;
      candidates.length = limit;
    }
    const results: DryRunContactDTO[] = [];
    for (const cand of candidates) {
      const reasons: string[] = [];
      const skip = await this.e.executor.entryCheck(ctx.workspaceId, a, def, cand.contact, null, at.toISOString());
      if (skip) reasons.push(skip);
      const existing = await this.e.db
        .selectFrom('automation_runs')
        .select('status')
        .where('automation_id', '=', a.id)
        .where('contact_id', '=', cand.contact.id)
        .where('event_key', '=', cand.eventKey)
        .executeTakeFirst();
      if (existing) reasons.push(`Already handled for this event (${existing.status}) — it will not run twice`);
      const steps = reasons.length ? [] : await this.e.executor.simulateSteps(ctx.workspaceId, a, loaded, cand.contact, cand.eventData);
      results.push({
        contact: { id: cand.contact.id, name: fullName({ firstName: cand.contact.first_name, lastName: cand.contact.last_name }) || cand.contact.email || 'Unnamed contact', email: cand.contact.email },
        eventKey: cand.eventKey,
        qualified: reasons.length === 0,
        reasons,
        steps,
      });
    }
    return {
      simulatedAt: at.toISOString(),
      triggerSummary: describeTrigger(t as Trigger),
      candidates: results.length,
      qualified: results.filter((r) => r.qualified).length,
      truncated,
      results,
    };
  }

  private async zones(workspaceId: string, workspaceTz: string): Promise<string[]> {
    const rows = await this.e.db
      .selectFrom('contacts')
      .select(sql<string>`coalesce(timezone, ${workspaceTz})`.as('tz'))
      .where('workspace_id', '=', workspaceId)
      .where('status', '=', 'active')
      .distinct()
      .execute();
    return [...new Set([workspaceTz, ...rows.map((r) => r.tz)])];
  }

  /** Run an active automation now for chosen contacts or a segment. */
  async runManual(ctx: WorkspaceContext, id: string, input: { contactIds?: string[]; segmentId?: string | null } = {}): Promise<{ started: number; queued: boolean; eventKey: string }> {
    authorize(ctx, 'automations:activate');
    const a = await this.row(ctx.workspaceId, id);
    if (a.status !== 'active') throw new PreconditionError('Activate the automation before running it.');
    const eventKey = `manual:${this.e.nowIso()}:${randomToken(4)}`;
    if (input.contactIds?.length) {
      const ids = (await this.e.db.selectFrom('contacts').select('id').where('workspace_id', '=', ctx.workspaceId).where('id', 'in', input.contactIds.slice(0, 1000)).execute()).map((r) => r.id);
      let started = 0;
      for (const contactId of ids) {
        const res = await this.e.executor.startRun({ workspaceId: ctx.workspaceId, automationId: a.id, versionId: a.current_version_id!, contactId, eventKey });
        if (res.created) started++;
      }
      await this.e.audit.record(ctx, 'automation.run_manual', { type: 'automation', id }, { contacts: started });
      this.e.nudgeWorker();
      return { started, queued: false, eventKey };
    }
    const def = (await this.toDTO(a)).definition;
    const segmentId = input.segmentId ?? (def.trigger.type === 'manual' || def.trigger.type === 'schedule' ? def.trigger.segmentId : null) ?? null;
    if (segmentId) await this.e.segments.criteriaFor(ctx.workspaceId, segmentId);
    await this.e.queue.enqueue(
      'automation.fanout',
      { automationId: a.id, versionId: a.current_version_id, mode: 'audience', segmentId, eventKey, afterId: '' },
      { workspaceId: ctx.workspaceId, dedupeKey: `fanout:${a.id}:${eventKey}:` },
    );
    await this.e.audit.record(ctx, 'automation.run_manual', { type: 'automation', id }, { segmentId });
    this.e.nudgeWorker();
    return { started: 0, queued: true, eventKey };
  }
}
