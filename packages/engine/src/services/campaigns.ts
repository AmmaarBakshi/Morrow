import {
  emptyCounts,
  ForbiddenError,
  fullName,
  isValidTimeZone,
  MESSAGE_CATEGORIES,
  newId,
  NotFoundError,
  normalizeEmail,
  PreconditionError,
  validateTemplateSource,
  ValidationError,
  type CampaignDTO,
  type CampaignRecipientDTO,
  type CampaignStatsDTO,
  type CampaignStatus,
  type ConsentStatus,
  type CriteriaGroup,
  type MessageCategory,
  type MessageStatus,
  type Page,
  type PreflightDTO,
  type RelationshipType,
} from '@morrow/core';
import { fromBool, sql, toBool, type Database, type ExpressionBuilder, type Row } from '@morrow/db';
import type { Expression, SqlBool } from 'kysely';
import { actorUserId, authorize, type WorkspaceContext } from '../context';
import type { Engine } from '../engine';
import type { Job } from '../queue/queue';
import type { Reschedule } from '../queue/worker';
import { toSenderDTO } from './senders';

const DISPATCH_BATCH = 200;
const EDITABLE: CampaignStatus[] = ['draft', 'pending_approval', 'scheduled'];
const BAD_EMAIL = ['invalid', 'bounced', 'complained'];

export interface CampaignInput {
  name?: string;
  description?: string | null;
  category?: MessageCategory;
  segmentId?: string | null;
  templateId?: string | null;
  subject?: string | null;
  previewText?: string | null;
  senderId?: string | null;
  replyTo?: string | null;
  scheduledAt?: string | null;
  timezone?: string | null;
  requiresApproval?: boolean;
}

export class CampaignsService {
  constructor(private readonly e: Engine) {}

  async row(workspaceId: string, id: string): Promise<Row<'campaigns'>> {
    const c = await this.e.db.selectFrom('campaigns').selectAll().where('id', '=', id).where('workspace_id', '=', workspaceId).executeTakeFirst();
    if (!c) throw new NotFoundError('Campaign', id);
    return c;
  }

  // ------------------------------------------------------------ mapping

  async stats(workspaceId: string, ids: string[]): Promise<Map<string, CampaignStatsDTO>> {
    const counts = await this.e.analytics.groupedCounts(workspaceId, 'campaign_id', ids);
    const reporting = await this.e.analytics.reporting(workspaceId);
    const out = new Map<string, CampaignStatsDTO>();
    for (const id of ids) {
      const c = counts.get(id) ?? emptyCounts();
      out.set(id, { counts: c, rates: this.e.analytics.rates(c, reporting), reporting });
    }
    return out;
  }

  private async toDTO(rows: Row<'campaigns'>[], workspaceId: string): Promise<CampaignDTO[]> {
    if (!rows.length) return [];
    const stats = await this.stats(workspaceId, rows.map((r) => r.id));
    const segIds = [...new Set(rows.map((r) => r.segment_id).filter((x): x is string => Boolean(x)))];
    const tplIds = [...new Set(rows.map((r) => r.template_id).filter((x): x is string => Boolean(x)))];
    const sndIds = [...new Set(rows.map((r) => r.sender_id).filter((x): x is string => Boolean(x)))];
    const [segs, tpls, snds] = await Promise.all([
      segIds.length ? this.e.db.selectFrom('segments').select(['id', 'name']).where('id', 'in', segIds).execute() : [],
      tplIds.length ? this.e.db.selectFrom('templates').select(['id', 'name']).where('id', 'in', tplIds).execute() : [],
      sndIds.length ? this.e.db.selectFrom('senders').selectAll().where('id', 'in', sndIds).execute() : [],
    ]);
    const segName = new Map(segs.map((s) => [s.id, s.name]));
    const tplName = new Map(tpls.map((t) => [t.id, t.name]));
    const sender = new Map(snds.map((s) => [s.id, s]));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      status: r.status as CampaignStatus,
      category: r.category as MessageCategory,
      segmentId: r.segment_id,
      segmentName: r.segment_id ? (segName.get(r.segment_id) ?? null) : 'All active contacts',
      templateId: r.template_id,
      templateName: r.template_id ? (tplName.get(r.template_id) ?? null) : null,
      templateVersionId: r.template_version_id,
      subject: r.subject,
      previewText: r.preview_text,
      senderId: r.sender_id,
      sender: r.sender_id && sender.get(r.sender_id) ? toSenderDTO(sender.get(r.sender_id)!) : null,
      replyTo: r.reply_to,
      scheduledAt: r.scheduled_at,
      timezone: r.timezone,
      requiresApproval: toBool(r.requires_approval),
      approvalStatus: r.approval_status as CampaignDTO['approvalStatus'],
      approvalNote: r.approval_note,
      approvedBy: r.approved_by,
      approvedAt: r.approved_at,
      launchedAt: r.launched_at,
      pausedAt: r.paused_at,
      completedAt: r.completed_at,
      cancelledAt: r.cancelled_at,
      recipientCount: r.recipient_count,
      stats: stats.get(r.id)!,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  async list(ctx: WorkspaceContext, query: { status?: string } = {}): Promise<CampaignDTO[]> {
    authorize(ctx, 'campaigns:read');
    let q = this.e.db.selectFrom('campaigns').selectAll().where('workspace_id', '=', ctx.workspaceId);
    if (query.status) q = q.where('status', '=', query.status);
    return this.toDTO(await q.orderBy('created_at', 'desc').limit(500).execute(), ctx.workspaceId);
  }

  async get(ctx: WorkspaceContext, id: string): Promise<CampaignDTO> {
    authorize(ctx, 'campaigns:read');
    return (await this.toDTO([await this.row(ctx.workspaceId, id)], ctx.workspaceId))[0]!;
  }

  // ------------------------------------------------------------ drafts

  private async checkInput(ctx: WorkspaceContext, input: CampaignInput): Promise<Partial<Row<'campaigns'>>> {
    const patch: Partial<Row<'campaigns'>> = {};
    if (input.name !== undefined) {
      const name = input.name.trim().slice(0, 150);
      if (!name) throw new ValidationError('Name the campaign.', [{ path: 'name', message: 'Required.' }]);
      patch.name = name;
    }
    if (input.description !== undefined) patch.description = input.description?.trim().slice(0, 1000) || null;
    if (input.category !== undefined) {
      if (!(MESSAGE_CATEGORIES as readonly string[]).includes(input.category)) throw new ValidationError('Unknown category.', [{ path: 'category', message: 'Unknown category.' }]);
      patch.category = input.category;
    }
    if (input.segmentId !== undefined) {
      if (input.segmentId) await this.e.segments.row(ctx.workspaceId, input.segmentId);
      patch.segment_id = input.segmentId || null;
    }
    if (input.templateId !== undefined) {
      if (input.templateId) {
        const t = await this.e.templates.row(ctx.workspaceId, input.templateId);
        if (input.category === undefined) patch.category = t.category;
      }
      patch.template_id = input.templateId || null;
    }
    if (input.subject !== undefined) patch.subject = input.subject?.replace(/[\r\n]+/g, ' ').trim().slice(0, 300) || null;
    if (input.previewText !== undefined) patch.preview_text = input.previewText?.trim().slice(0, 300) || null;
    if (input.senderId !== undefined) {
      if (input.senderId) await this.e.senders.row(ctx.workspaceId, input.senderId);
      patch.sender_id = input.senderId || null;
    }
    if (input.replyTo !== undefined) {
      const r = input.replyTo ? normalizeEmail(input.replyTo) : null;
      if (input.replyTo && !r) throw new ValidationError('Reply-to must be a valid address.', [{ path: 'replyTo', message: 'Invalid e-mail address.' }]);
      patch.reply_to = r;
    }
    if (input.timezone !== undefined) {
      if (input.timezone && !isValidTimeZone(input.timezone)) throw new ValidationError('Unknown time zone.', [{ path: 'timezone', message: 'Unknown time zone.' }]);
      patch.timezone = input.timezone || null;
    }
    if (input.scheduledAt !== undefined) {
      if (input.scheduledAt && Number.isNaN(Date.parse(input.scheduledAt))) throw new ValidationError('Invalid schedule time.', [{ path: 'scheduledAt', message: 'Use an ISO timestamp.' }]);
      patch.scheduled_at = input.scheduledAt ? new Date(input.scheduledAt).toISOString() : null;
    }
    if (input.requiresApproval !== undefined) patch.requires_approval = fromBool(input.requiresApproval);
    return patch;
  }

  async create(ctx: WorkspaceContext, input: CampaignInput): Promise<CampaignDTO> {
    authorize(ctx, 'campaigns:write');
    const patch = await this.checkInput(ctx, { name: input.name ?? '', ...input });
    const now = this.e.nowIso();
    const sender = patch.sender_id ? null : await this.e.senders.defaultSender(ctx.workspaceId);
    const row: Row<'campaigns'> = {
      id: newId('cmp'),
      workspace_id: ctx.workspaceId,
      name: patch.name!,
      description: patch.description ?? null,
      status: 'draft',
      category: patch.category ?? 'marketing',
      segment_id: patch.segment_id ?? null,
      template_id: patch.template_id ?? null,
      template_version_id: null,
      subject: patch.subject ?? null,
      preview_text: patch.preview_text ?? null,
      sender_id: patch.sender_id ?? sender?.id ?? null,
      reply_to: patch.reply_to ?? null,
      scheduled_at: patch.scheduled_at ?? null,
      timezone: patch.timezone ?? null,
      requires_approval: patch.requires_approval ?? 0,
      approval_status: 'not_required',
      approval_note: null,
      submitted_by: null,
      approved_by: null,
      approved_at: null,
      launched_at: null,
      paused_at: null,
      completed_at: null,
      cancelled_at: null,
      dispatch_cursor: null,
      recipient_count: null,
      created_by: actorUserId(ctx),
      created_at: now,
      updated_at: now,
    };
    await this.e.db.insertInto('campaigns').values(row).execute();
    await this.e.audit.record(ctx, 'campaign.created', { type: 'campaign', id: row.id }, { name: row.name });
    return this.get(ctx, row.id);
  }

  /** Edit a draft. Editing a scheduled or pending campaign returns it to draft and clears approval. */
  async update(ctx: WorkspaceContext, id: string, input: CampaignInput): Promise<CampaignDTO> {
    authorize(ctx, 'campaigns:write');
    const c = await this.row(ctx.workspaceId, id);
    if (!EDITABLE.includes(c.status as CampaignStatus)) throw new PreconditionError(`A ${c.status} campaign cannot be edited.`);
    const patch = await this.checkInput(ctx, input);
    if (c.status !== 'draft' || c.approval_status !== 'not_required') {
      patch.status = 'draft';
      patch.approval_status = 'not_required';
      patch.approved_by = null;
      patch.approved_at = null;
    }
    patch.updated_at = this.e.nowIso();
    await this.e.db.updateTable('campaigns').set(patch).where('id', '=', id).execute();
    await this.e.audit.record(ctx, 'campaign.updated', { type: 'campaign', id }, { fields: Object.keys(input) });
    return this.get(ctx, id);
  }

  async remove(ctx: WorkspaceContext, id: string): Promise<void> {
    authorize(ctx, 'campaigns:write');
    const c = await this.row(ctx.workspaceId, id);
    if (c.status !== 'draft') throw new PreconditionError('Only drafts can be deleted. Cancel the campaign instead.');
    await this.e.db.deleteFrom('campaigns').where('id', '=', id).execute();
    await this.e.audit.record(ctx, 'campaign.deleted', { type: 'campaign', id });
  }

  async duplicate(ctx: WorkspaceContext, id: string): Promise<CampaignDTO> {
    const c = await this.row(ctx.workspaceId, id);
    return this.create(ctx, {
      name: `${c.name} (copy)`,
      description: c.description,
      category: c.category as MessageCategory,
      segmentId: c.segment_id,
      templateId: c.template_id,
      subject: c.subject,
      previewText: c.preview_text,
      senderId: c.sender_id,
      replyTo: c.reply_to,
      timezone: c.timezone,
      requiresApproval: toBool(c.requires_approval),
    });
  }

  // ------------------------------------------------------------ preflight

  /** SQL predicate: contact can receive this category (mirrors core checkEligibility). */
  private eligibleWhere(workspaceId: string, category: MessageCategory, consent: { allowImpliedForMarketing: boolean; allowUnknownForRelationship: boolean }) {
    return (eb: ExpressionBuilder<Database, 'contacts'>): Expression<SqlBool> => {
      const suppression = eb
        .selectFrom('suppressions')
        .select(sql`1`.as('one'))
        .whereRef('suppressions.email_normalized', '=', 'contacts.email_normalized')
        .where('suppressions.workspace_id', '=', workspaceId)
        .where('suppressions.lifted_at', 'is', null);
      const parts: Expression<SqlBool>[] = [
        eb('contacts.email_normalized', 'is not', null),
        eb('contacts.email_status', 'not in', BAD_EMAIL),
        eb.not(eb.exists(category === 'transactional' ? suppression.where('suppressions.scope', '=', 'all') : suppression)),
      ];
      if (category === 'marketing') parts.push(eb('contacts.consent_status', 'in', consent.allowImpliedForMarketing ? ['granted', 'implied'] : ['granted']));
      if (category === 'relationship') parts.push(eb('contacts.consent_status', 'in', consent.allowUnknownForRelationship ? ['granted', 'implied', 'unknown'] : ['granted', 'implied']));
      return eb.and(parts);
    };
  }

  async preflight(ctx: WorkspaceContext, id: string): Promise<PreflightDTO> {
    authorize(ctx, 'campaigns:read');
    const c = await this.row(ctx.workspaceId, id);
    const { settings } = await this.e.workspaces.settings(ctx.workspaceId);
    const category = c.category as MessageCategory;
    const blockers: string[] = [];
    const warnings: string[] = [];

    const tpl = c.template_id ? await this.e.templates.publishedSource(ctx.workspaceId, c.template_id) : null;
    if (!c.template_id) blockers.push('Choose a template.');
    else if (!tpl) blockers.push('The template has not been published.');
    const sender = await this.e.senders.resolve(ctx.workspaceId, c.sender_id);
    if (!sender) blockers.push(c.sender_id ? 'The selected sender is not verified.' : 'Verify a sender address in Settings → Sending.');
    const provider = await this.e.integrations.resolveEmailProvider(ctx.workspaceId);
    if (!provider) blockers.push('Configure an e-mail provider in Settings → Sending.');
    else if (!provider.provider.capabilities.deliveryEvents) warnings.push(`${provider.name} only reports acceptance; delivery and bounce statistics will not be available.`);
    if (provider?.name === 'fake') warnings.push('The development inbox is active: nothing will actually be delivered.');

    let criteria: CriteriaGroup;
    try {
      criteria = await this.e.segments.criteriaFor(ctx.workspaceId, c.segment_id);
    } catch {
      blockers.push('The audience segment no longer exists.');
      return { ok: false, audience: 0, eligible: 0, excluded: {}, missingPersonalization: [], blockers, warnings, sample: [] };
    }
    const where = await this.e.segments.compile(ctx.workspaceId, criteria);
    const audienceQ = () => this.e.db.selectFrom('contacts').where('contacts.workspace_id', '=', ctx.workspaceId).where('contacts.status', '=', 'active').where(where);
    const count = async (extra?: (eb: ExpressionBuilder<Database, 'contacts'>) => Expression<SqlBool>) => {
      let q = audienceQ();
      if (extra) q = q.where(extra);
      return Number((await q.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst())?.n ?? 0);
    };
    const supp = (eb: ExpressionBuilder<Database, 'contacts'>, scope?: string) => {
      let q = eb
        .selectFrom('suppressions')
        .select(sql`1`.as('one'))
        .whereRef('suppressions.email_normalized', '=', 'contacts.email_normalized')
        .where('suppressions.workspace_id', '=', ctx.workspaceId)
        .where('suppressions.lifted_at', 'is', null);
      if (scope) q = q.where('suppressions.scope', '=', scope);
      return eb.exists(q);
    };
    const eligibleWhere = this.eligibleWhere(ctx.workspaceId, category, settings.consent);
    const audience = await count();
    const excluded: PreflightDTO['excluded'] = {
      no_email: await count((eb) => eb('contacts.email_normalized', 'is', null)),
      invalid_email: await count((eb) => eb.and([eb('contacts.email_normalized', 'is not', null), eb('contacts.email_status', 'in', BAD_EMAIL)])),
      suppressed: await count((eb) => supp(eb, 'all')),
    };
    if (category !== 'transactional') {
      excluded.unsubscribed = await count((eb) => eb.or([supp(eb, 'marketing'), eb('contacts.consent_status', '=', 'withdrawn')]));
      const allowed: ConsentStatus[] =
        category === 'marketing'
          ? settings.consent.allowImpliedForMarketing ? ['granted', 'implied'] : ['granted']
          : settings.consent.allowUnknownForRelationship ? ['granted', 'implied', 'unknown'] : ['granted', 'implied'];
      excluded.consent_missing = await count((eb) => eb.and([eb('contacts.consent_status', 'not in', allowed), eb('contacts.consent_status', '!=', 'withdrawn')]));
    }
    const prior = await count((eb) =>
      eb.exists(eb.selectFrom('messages').select(sql`1`.as('one')).whereRef('messages.contact_id', '=', 'contacts.id').where('messages.campaign_id', '=', c.id)),
    );
    if (prior) excluded.duplicate = prior;
    let eligible = await count(eligibleWhere);
    const weekly = settings.sending.weeklyCapPerContact;
    if (weekly > 0 && category !== 'transactional') {
      const since = new Date(this.e.now().getTime() - 7 * 86_400_000).toISOString();
      const capped = await count((eb) =>
        eb.and([
          eligibleWhere(eb),
          sql<SqlBool>`(select count(*) from messages m where m.contact_id = contacts.id and m.category <> 'transactional' and m.kind in ('campaign', 'automation') and m.status in ('queued', 'pending_approval', 'sending', 'sent', 'delivered', 'uncertain') and m.created_at >= ${since}) >= ${weekly}`,
        ]),
      );
      if (capped) {
        excluded.frequency_cap = capped;
        eligible -= capped;
        warnings.push(`${capped} contact(s) already reached the weekly limit of ${weekly} e-mails and will be skipped.`);
      }
    }
    eligible = Math.max(0, eligible - prior);

    const missingPersonalization: PreflightDTO['missingPersonalization'] = [];
    if (tpl) {
      const required = validateTemplateSource({ subject: c.subject || tpl.subject, previewText: c.preview_text ?? tpl.previewText, html: tpl.html, text: tpl.text }).requiredVariables;
      const columns: Record<string, string> = { first_name: 'first_name', last_name: 'last_name', company: 'company', job_title: 'job_title' };
      for (const v of required) {
        let missing = 0;
        if (columns[v]) {
          const col = columns[v]!;
          missing = await count((eb) => eb.and([eligibleWhere(eb), sql<SqlBool>`(${sql.ref(`contacts.${col}`)} is null or ${sql.ref(`contacts.${col}`)} = '')`]));
        } else if (v.startsWith('custom.')) {
          const key = v.slice(7);
          missing = await count((eb) =>
            eb.and([
              eligibleWhere(eb),
              eb.not(
                eb.exists(
                  eb
                    .selectFrom('contact_field_values as v')
                    .innerJoin('custom_fields as f', 'f.id', 'v.field_id')
                    .select(sql`1`.as('one'))
                    .whereRef('v.contact_id', '=', 'contacts.id')
                    .where('f.key', '=', key)
                    .where('v.value_text', 'is not', null),
                ),
              ),
            ]),
          );
        } else continue;
        if (missing > 0) {
          const handledBy = v === 'first_name' && settings.fallbackFirstName ? 'fallback' : tpl.missingPolicy === 'skip' ? 'skip' : 'blank';
          missingPersonalization.push({ variable: v, contacts: missing, handledBy });
          if (handledBy === 'blank') warnings.push(`${missing} recipient(s) have no ${v}; that part of the message will be blank.`);
          if (handledBy === 'skip') warnings.push(`${missing} recipient(s) have no ${v} and will be skipped.`);
        }
      }
      if (category !== 'transactional' && !/\{\{\s*unsubscribe_url|\{\{>\s*footer/.test(tpl.html)) {
        warnings.push('The template has no unsubscribe link; Morrow will append a standard footer.');
      }
    }
    if (audience === 0) blockers.push('The audience is empty.');
    else if (eligible === 0) blockers.push('No contacts in the audience can receive this campaign.');
    if (category === 'marketing' && (excluded.consent_missing ?? 0) > 0) {
      warnings.push(`${excluded.consent_missing} contact(s) have not given marketing consent and will not receive this campaign.`);
    }
    const requiresApproval = toBool(c.requires_approval) || settings.sending.requireCampaignApproval;
    if (requiresApproval && c.approval_status !== 'approved') warnings.push('This campaign needs approval before it is sent.');

    const sampleRows = await audienceQ().selectAll('contacts').where(eligibleWhere).orderBy('contacts.created_at', 'desc').limit(10).execute();
    return {
      ok: blockers.length === 0,
      audience,
      eligible,
      excluded,
      missingPersonalization,
      blockers,
      warnings,
      sample: sampleRows.map((r) => ({
        id: r.id,
        name: fullName({ firstName: r.first_name, lastName: r.last_name }) || r.email || 'Unnamed contact',
        email: r.email,
        relationshipType: r.relationship_type as RelationshipType,
        consentStatus: r.consent_status as ConsentStatus,
      })),
    };
  }

  async testSend(ctx: WorkspaceContext, id: string, input: { to?: string } = {}): Promise<{ messageId: string; to: string }> {
    const c = await this.row(ctx.workspaceId, id);
    if (!c.template_id) throw new PreconditionError('Choose a template first.');
    return this.e.templates.testSend(ctx, c.template_id, { to: input.to, which: 'published' });
  }

  // ------------------------------------------------------------ launch & approval

  private requiresApproval(c: Row<'campaigns'>, requireSetting: boolean): boolean {
    return toBool(c.requires_approval) || requireSetting;
  }

  /**
   * Schedule (or launch now when `scheduledAt` is empty/past). Campaigns that
   * need approval move to pending approval first.
   */
  async schedule(ctx: WorkspaceContext, id: string, input: { scheduledAt?: string | null; timezone?: string | null } = {}): Promise<CampaignDTO> {
    authorize(ctx, 'campaigns:launch');
    const c = await this.row(ctx.workspaceId, id);
    if (!['draft', 'scheduled'].includes(c.status)) throw new PreconditionError(`A ${c.status} campaign cannot be scheduled.`);
    const pre = await this.preflight(ctx, id);
    if (!pre.ok) throw new PreconditionError(`Cannot launch: ${pre.blockers.join(' ')}`, { blockers: pre.blockers });
    const at = input.scheduledAt ? new Date(input.scheduledAt) : null;
    if (at && Number.isNaN(at.getTime())) throw new ValidationError('Invalid schedule time.');
    const now = this.e.now();
    const { settings } = await this.e.workspaces.settings(ctx.workspaceId);
    const patch: Partial<Row<'campaigns'>> = {
      scheduled_at: at && at > now ? at.toISOString() : null,
      timezone: input.timezone ?? c.timezone,
      updated_at: now.toISOString(),
    };
    if (this.requiresApproval(c, settings.sending.requireCampaignApproval) && c.approval_status !== 'approved') {
      patch.status = 'pending_approval';
      patch.approval_status = 'pending';
      patch.submitted_by = actorUserId(ctx);
      await this.e.db.updateTable('campaigns').set(patch).where('id', '=', id).execute();
      await this.e.notifications.notifyAdmins(ctx.workspaceId, {
        kind: 'campaign.approval',
        title: `Campaign "${c.name}" is waiting for approval`,
        body: `${ctx.actor.label} submitted it for ${pre.eligible} recipient(s).`,
        link: `/campaigns/${id}`,
        dedupeKey: `approve:${id}:${now.toISOString()}`,
      });
      await this.e.audit.record(ctx, 'campaign.submitted', { type: 'campaign', id }, { eligible: pre.eligible });
      return this.get(ctx, id);
    }
    if (patch.scheduled_at) {
      patch.status = 'scheduled';
      await this.e.db.updateTable('campaigns').set(patch).where('id', '=', id).execute();
      await this.e.audit.record(ctx, 'campaign.scheduled', { type: 'campaign', id }, { at: patch.scheduled_at, eligible: pre.eligible });
      return this.get(ctx, id);
    }
    await this.e.db.updateTable('campaigns').set(patch).where('id', '=', id).execute();
    await this.startDispatch(ctx.workspaceId, id);
    await this.e.audit.record(ctx, 'campaign.launched', { type: 'campaign', id }, { eligible: pre.eligible });
    return this.get(ctx, id);
  }

  async launch(ctx: WorkspaceContext, id: string): Promise<CampaignDTO> {
    return this.schedule(ctx, id, { scheduledAt: null });
  }

  async approve(ctx: WorkspaceContext, id: string, note?: string | null): Promise<CampaignDTO> {
    authorize(ctx, 'campaigns:approve');
    const c = await this.row(ctx.workspaceId, id);
    if (c.status !== 'pending_approval') throw new PreconditionError('This campaign is not waiting for approval.');
    if (c.submitted_by && c.submitted_by === actorUserId(ctx) && ctx.role !== 'owner') {
      throw new ForbiddenError('Someone other than the submitter must approve this campaign.');
    }
    const pre = await this.preflight(ctx, id);
    if (!pre.ok) throw new PreconditionError(`Cannot approve: ${pre.blockers.join(' ')}`);
    const now = this.e.now();
    const future = c.scheduled_at && Date.parse(c.scheduled_at) > now.getTime();
    await this.e.db
      .updateTable('campaigns')
      .set({ approval_status: 'approved', approved_by: actorUserId(ctx) ?? ctx.actor.label, approved_at: now.toISOString(), approval_note: note ?? null, status: future ? 'scheduled' : 'draft', updated_at: now.toISOString() })
      .where('id', '=', id)
      .execute();
    await this.e.audit.record(ctx, 'campaign.approved', { type: 'campaign', id }, { note: note ?? null });
    if (!future) await this.startDispatch(ctx.workspaceId, id);
    return this.get(ctx, id);
  }

  async reject(ctx: WorkspaceContext, id: string, note: string): Promise<CampaignDTO> {
    authorize(ctx, 'campaigns:approve');
    const c = await this.row(ctx.workspaceId, id);
    if (c.status !== 'pending_approval') throw new PreconditionError('This campaign is not waiting for approval.');
    await this.e.db
      .updateTable('campaigns')
      .set({ status: 'draft', approval_status: 'rejected', approval_note: note?.slice(0, 1000) || null, approved_by: actorUserId(ctx), approved_at: this.e.nowIso(), updated_at: this.e.nowIso() })
      .where('id', '=', id)
      .execute();
    await this.e.audit.record(ctx, 'campaign.rejected', { type: 'campaign', id });
    return this.get(ctx, id);
  }

  /** Lock the template version and begin batched dispatch. */
  async startDispatch(workspaceId: string, id: string): Promise<void> {
    const c = await this.row(workspaceId, id);
    const tpl = c.template_id ? await this.e.templates.publishedSource(workspaceId, c.template_id) : null;
    if (!tpl) throw new PreconditionError('The template is not published.');
    const now = this.e.nowIso();
    await this.e.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('campaigns')
        .set({ status: 'sending', template_version_id: tpl.versionId, launched_at: now, dispatch_cursor: '', updated_at: now })
        .where('id', '=', id)
        .execute();
      await this.e.queue.enqueue('campaign.dispatch', { campaignId: id }, { workspaceId, dedupeKey: `dispatch:${id}:start`, priority: 5 }, trx);
    });
    this.e.nudgeWorker();
  }

  /** Job handler: expand one batch of the audience into messages. */
  async dispatch(job: Job): Promise<void | Reschedule> {
    const id = String(job.payload.campaignId ?? '');
    const c = await this.e.db.selectFrom('campaigns').selectAll().where('id', '=', id).executeTakeFirst();
    if (!c) return;
    if (c.status === 'paused') return { reschedule: new Date(this.e.now().getTime() + 60_000) };
    if (c.status !== 'sending' || c.dispatch_cursor === 'done') return;
    const ws = c.workspace_id;
    const tpl = c.template_version_id ? await this.e.templates.versionSource(ws, c.template_version_id) : null;
    const sender = await this.e.senders.resolve(ws, c.sender_id);
    if (!tpl || !sender) {
      await this.e.db.updateTable('campaigns').set({ status: 'failed', updated_at: this.e.nowIso() }).where('id', '=', id).execute();
      await this.e.notifications.notifyAdmins(ws, {
        kind: 'campaign.failed',
        title: `Campaign "${c.name}" stopped`,
        body: !tpl ? 'Its template version is missing.' : 'Its sender is no longer verified.',
        link: `/campaigns/${id}`,
        dedupeKey: `campaign-failed:${id}`,
      });
      return;
    }
    const criteria = await this.e.segments.criteriaFor(ws, c.segment_id).catch(() => null);
    if (!criteria) {
      await this.e.db.updateTable('campaigns').set({ status: 'failed', updated_at: this.e.nowIso() }).where('id', '=', id).execute();
      return;
    }
    const cursor = c.dispatch_cursor ?? '';
    const batch = await this.e.segments.contactBatch(ws, criteria, cursor, DISPATCH_BATCH);
    for (const contact of batch) {
      const inserted = await this.e.db
        .insertInto('campaign_recipients')
        .values({ workspace_id: ws, campaign_id: id, contact_id: contact.id, status: 'queued', skip_reason: null, message_id: null, created_at: this.e.nowIso() })
        .onConflict((oc) => oc.doNothing())
        .returning('contact_id')
        .executeTakeFirst();
      if (!inserted) continue;
      const result = await this.e.delivery.prepare({
        workspaceId: ws,
        kind: 'campaign',
        category: c.category as MessageCategory,
        idempotencyKey: `campaign:${id}:${contact.id}`,
        contact,
        template: { ...tpl, subject: c.subject || tpl.subject, previewText: c.preview_text ?? tpl.previewText },
        sender: { email: sender.email, name: sender.name, replyTo: c.reply_to ?? sender.reply_to },
        campaignId: id,
      });
      await this.e.db
        .updateTable('campaign_recipients')
        .set({
          status: result.outcome === 'skipped' ? 'skipped' : 'queued',
          skip_reason: result.outcome === 'skipped' ? result.reasons.join(', ').slice(0, 300) : null,
          message_id: result.messageId,
        })
        .where('campaign_id', '=', id)
        .where('contact_id', '=', contact.id)
        .execute();
    }
    if (batch.length === DISPATCH_BATCH) {
      const next = batch[batch.length - 1]!.id;
      await this.e.db.updateTable('campaigns').set({ dispatch_cursor: next, updated_at: this.e.nowIso() }).where('id', '=', id).execute();
      await this.e.queue.enqueue('campaign.dispatch', { campaignId: id }, { workspaceId: ws, dedupeKey: `dispatch:${id}:${next}`, priority: 5 });
      return;
    }
    const total = await this.e.db
      .selectFrom('campaign_recipients')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('campaign_id', '=', id)
      .executeTakeFirst();
    await this.e.db
      .updateTable('campaigns')
      .set({ dispatch_cursor: 'done', recipient_count: Number(total?.n ?? 0), updated_at: this.e.nowIso() })
      .where('id', '=', id)
      .execute();
    await this.checkCompletion(id);
  }

  /** Mark campaigns completed once every message has left the queue. */
  async checkCompletion(onlyId?: string): Promise<number> {
    let q = this.e.db.selectFrom('campaigns').select(['id', 'workspace_id', 'name']).where('status', '=', 'sending').where('dispatch_cursor', '=', 'done');
    if (onlyId) q = q.where('id', '=', onlyId);
    let completed = 0;
    for (const c of await q.execute()) {
      const pending = await this.e.db
        .selectFrom('messages')
        .select('id')
        .where('campaign_id', '=', c.id)
        .where('status', 'in', ['queued', 'sending', 'pending_approval'])
        .limit(1)
        .executeTakeFirst();
      if (pending) continue;
      await this.e.db.updateTable('campaigns').set({ status: 'completed', completed_at: this.e.nowIso(), updated_at: this.e.nowIso() }).where('id', '=', c.id).execute();
      completed++;
    }
    return completed;
  }

  /** Scheduler hook: launch scheduled campaigns that are due. */
  async launchDue(now: Date = this.e.now()): Promise<number> {
    const due = await this.e.db
      .selectFrom('campaigns')
      .select(['id', 'workspace_id'])
      .where('status', '=', 'scheduled')
      .where('scheduled_at', '<=', now.toISOString())
      .execute();
    let launched = 0;
    for (const c of due) {
      try {
        await this.startDispatch(c.workspace_id, c.id);
        launched++;
      } catch (err) {
        await this.e.db.updateTable('campaigns').set({ status: 'failed', updated_at: this.e.nowIso() }).where('id', '=', c.id).execute();
        this.e.log.error('scheduled campaign could not launch', { campaignId: c.id, error: err as Error });
      }
    }
    return launched;
  }

  async pause(ctx: WorkspaceContext, id: string): Promise<CampaignDTO> {
    authorize(ctx, 'campaigns:launch');
    const c = await this.row(ctx.workspaceId, id);
    if (!['sending', 'scheduled'].includes(c.status)) throw new PreconditionError('Only scheduled or sending campaigns can be paused.');
    await this.e.db.updateTable('campaigns').set({ status: 'paused', paused_at: this.e.nowIso(), updated_at: this.e.nowIso() }).where('id', '=', id).execute();
    await this.e.audit.record(ctx, 'campaign.paused', { type: 'campaign', id });
    return this.get(ctx, id);
  }

  async resume(ctx: WorkspaceContext, id: string): Promise<CampaignDTO> {
    authorize(ctx, 'campaigns:launch');
    const c = await this.row(ctx.workspaceId, id);
    if (c.status !== 'paused') throw new PreconditionError('Only paused campaigns can be resumed.');
    const status = c.launched_at ? 'sending' : 'scheduled';
    await this.e.db.updateTable('campaigns').set({ status, paused_at: null, updated_at: this.e.nowIso() }).where('id', '=', id).execute();
    if (status === 'sending' && c.dispatch_cursor !== 'done') {
      await this.e.queue.enqueue('campaign.dispatch', { campaignId: id }, { workspaceId: ctx.workspaceId, dedupeKey: `dispatch:${id}:${c.dispatch_cursor ?? ''}:resume:${this.e.nowIso()}`, priority: 5 });
    }
    await this.e.audit.record(ctx, 'campaign.resumed', { type: 'campaign', id });
    this.e.nudgeWorker();
    return this.get(ctx, id);
  }

  /**
   * Cancel. Messages not yet handed to the provider are cancelled; messages a
   * provider has already accepted cannot be recalled and are reported.
   */
  async cancel(ctx: WorkspaceContext, id: string): Promise<{ campaign: CampaignDTO; cancelledMessages: number; alreadySent: number }> {
    authorize(ctx, 'campaigns:launch');
    const c = await this.row(ctx.workspaceId, id);
    if (['completed', 'cancelled', 'failed'].includes(c.status)) throw new PreconditionError(`The campaign is already ${c.status}.`);
    const now = this.e.nowIso();
    const res = await this.e.db
      .updateTable('messages')
      .set({ status: 'cancelled', error_code: 'campaign_cancelled', updated_at: now })
      .where('campaign_id', '=', id)
      .where('workspace_id', '=', ctx.workspaceId)
      .where('status', 'in', ['queued', 'pending_approval'])
      .executeTakeFirst();
    const sent = await this.e.db
      .selectFrom('messages')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('campaign_id', '=', id)
      .where('status', 'in', ['sending', 'sent', 'delivered', 'bounced', 'complained'])
      .executeTakeFirst();
    await this.e.db.updateTable('campaigns').set({ status: 'cancelled', cancelled_at: now, updated_at: now }).where('id', '=', id).execute();
    await this.e.audit.record(ctx, 'campaign.cancelled', { type: 'campaign', id }, { cancelled: Number(res.numUpdatedRows ?? 0) });
    return { campaign: await this.get(ctx, id), cancelledMessages: Number(res.numUpdatedRows ?? 0), alreadySent: Number(sent?.n ?? 0) };
  }

  async recipients(ctx: WorkspaceContext, id: string, query: { status?: string; page?: number; pageSize?: number } = {}): Promise<Page<CampaignRecipientDTO>> {
    authorize(ctx, 'campaigns:read');
    await this.row(ctx.workspaceId, id);
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, query.pageSize ?? 50));
    let base = this.e.db
      .selectFrom('campaign_recipients')
      .innerJoin('contacts', 'contacts.id', 'campaign_recipients.contact_id')
      .leftJoin('messages', 'messages.id', 'campaign_recipients.message_id')
      .where('campaign_recipients.campaign_id', '=', id)
      .where('campaign_recipients.workspace_id', '=', ctx.workspaceId);
    if (query.status) base = base.where('campaign_recipients.status', '=', query.status);
    const total = Number((await base.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst())?.n ?? 0);
    const rows = await base
      .select([
        'campaign_recipients.contact_id',
        'campaign_recipients.status',
        'campaign_recipients.skip_reason',
        'campaign_recipients.message_id',
        'contacts.first_name',
        'contacts.last_name',
        'contacts.email',
        'messages.status as message_status',
      ])
      .orderBy('campaign_recipients.created_at', 'asc')
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .execute();
    return {
      items: rows.map((r) => ({
        contactId: r.contact_id,
        name: fullName({ firstName: r.first_name, lastName: r.last_name }) || r.email || 'Unnamed contact',
        email: r.email,
        status: r.status,
        skipReason: r.skip_reason,
        messageId: r.message_id,
        messageStatus: (r.message_status as MessageStatus | null) ?? null,
      })),
      total,
      page,
      pageSize,
    };
  }
}
