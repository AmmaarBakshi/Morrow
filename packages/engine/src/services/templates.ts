import {
  ConflictError,
  MESSAGE_CATEGORIES,
  newId,
  NotFoundError,
  normalizeEmail,
  PARTIAL_NAME_RE,
  PreconditionError,
  randomToken,
  requiresUnsubscribeLink,
  sanitizeTemplateHtml,
  validateTemplateSource,
  ValidationError,
  type MessageCategory,
  type RenderedEmailDTO,
  type SnippetDTO,
  type TemplateDTO,
  type TemplateIssueDTO,
  type TemplatePurpose,
  type TemplateSummaryDTO,
  type TemplateVersionDTO,
} from '@morrow/core';
import { escapeLike, sql, type Row } from '@morrow/db';
import { actorUserId, authorize, type WorkspaceContext } from '../context';
import type { Engine } from '../engine';
import type { ComposeTemplate, SenderIdentity } from './delivery';

export const TEMPLATE_PURPOSES: TemplatePurpose[] = [
  'birthday',
  'welcome',
  'follow_up',
  'newsletter',
  'announcement',
  'collaboration',
  'work_anniversary',
  're_engagement',
  'project_completion',
  'feedback',
  'custom',
];

export interface TemplateContentInput {
  subject?: string;
  previewText?: string | null;
  html?: string;
  text?: string | null;
  missingPolicy?: 'fallback' | 'skip';
}

export interface PublishedTemplate extends ComposeTemplate {
  name: string;
  category: MessageCategory;
}

function versionDTO(v: Row<'template_versions'>): TemplateVersionDTO {
  return {
    id: v.id,
    version: v.version,
    subject: v.subject,
    previewText: v.preview_text,
    html: v.html,
    text: v.text,
    missingPolicy: v.missing_policy as 'fallback' | 'skip',
    createdAt: v.created_at,
    publishedAt: v.published_at,
  };
}

function snippetDTO(s: Row<'snippets'>): SnippetDTO {
  return { id: s.id, key: s.key, name: s.name, kind: s.kind as SnippetDTO['kind'], html: s.html, text: s.text, updatedAt: s.updated_at };
}

export class TemplatesService {
  constructor(private readonly e: Engine) {}

  // ------------------------------------------------------------ reads

  async row(workspaceId: string, id: string): Promise<Row<'templates'>> {
    const t = await this.e.db.selectFrom('templates').selectAll().where('id', '=', id).where('workspace_id', '=', workspaceId).executeTakeFirst();
    if (!t) throw new NotFoundError('Template', id);
    return t;
  }

  private async version(workspaceId: string, id: string | null): Promise<Row<'template_versions'> | null> {
    if (!id) return null;
    return (await this.e.db.selectFrom('template_versions').selectAll().where('id', '=', id).where('workspace_id', '=', workspaceId).executeTakeFirst()) ?? null;
  }

  private summary(t: Row<'templates'>, draft: Row<'template_versions'> | null, published: Row<'template_versions'> | null): TemplateSummaryDTO {
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      category: t.category as MessageCategory,
      purpose: t.purpose as TemplatePurpose,
      status: t.status as TemplateSummaryDTO['status'],
      subject: draft?.subject ?? published?.subject ?? '',
      version: draft?.version ?? published?.version ?? 1,
      publishedVersion: published?.version ?? null,
      hasUnpublishedChanges: Boolean(draft && t.draft_version_id !== t.published_version_id),
      updatedAt: t.updated_at,
    };
  }

  async list(ctx: WorkspaceContext, query: { status?: string; purpose?: string; category?: string; q?: string } = {}): Promise<TemplateSummaryDTO[]> {
    authorize(ctx, 'templates:read');
    let q = this.e.db.selectFrom('templates').selectAll().where('workspace_id', '=', ctx.workspaceId);
    if (query.status) q = q.where('status', '=', query.status);
    else q = q.where('status', '!=', 'archived');
    if (query.purpose) q = q.where('purpose', '=', query.purpose);
    if (query.category) q = q.where('category', '=', query.category);
    if (query.q) q = q.where(sql<boolean>`lower(name) like ${`%${escapeLike(query.q.toLowerCase())}%`} escape '\\'`);
    const rows = await q.orderBy('updated_at', 'desc').execute();
    const ids = [...new Set(rows.flatMap((t) => [t.draft_version_id, t.published_version_id]).filter((x): x is string => Boolean(x)))];
    const versions = ids.length ? await this.e.db.selectFrom('template_versions').selectAll().where('id', 'in', ids).execute() : [];
    const byId = new Map(versions.map((v) => [v.id, v]));
    return rows.map((t) => this.summary(t, byId.get(t.draft_version_id ?? '') ?? null, byId.get(t.published_version_id ?? '') ?? null));
  }

  async get(ctx: WorkspaceContext, id: string): Promise<TemplateDTO> {
    authorize(ctx, 'templates:read');
    const t = await this.row(ctx.workspaceId, id);
    const draft = await this.version(ctx.workspaceId, t.draft_version_id);
    const published = await this.version(ctx.workspaceId, t.published_version_id);
    if (!draft) throw new NotFoundError('Template version');
    return { ...this.summary(t, draft, published), draft: versionDTO(draft), published: published ? versionDTO(published) : null, createdAt: t.created_at };
  }

  async versions(ctx: WorkspaceContext, id: string): Promise<TemplateVersionDTO[]> {
    authorize(ctx, 'templates:read');
    await this.row(ctx.workspaceId, id);
    const rows = await this.e.db.selectFrom('template_versions').selectAll().where('template_id', '=', id).where('workspace_id', '=', ctx.workspaceId).orderBy('version', 'desc').execute();
    return rows.map(versionDTO);
  }

  /** The published version, ready for sending. Null when not published or archived. */
  async publishedSource(workspaceId: string, templateId: string): Promise<PublishedTemplate | null> {
    const t = await this.e.db.selectFrom('templates').selectAll().where('id', '=', templateId).where('workspace_id', '=', workspaceId).executeTakeFirst();
    if (!t || t.status === 'archived' || !t.published_version_id) return null;
    const v = await this.version(workspaceId, t.published_version_id);
    if (!v) return null;
    return {
      templateId: t.id,
      versionId: v.id,
      name: t.name,
      category: t.category as MessageCategory,
      subject: v.subject,
      previewText: v.preview_text,
      html: v.html,
      text: v.text,
      missingPolicy: v.missing_policy as 'fallback' | 'skip',
    };
  }

  async versionSource(workspaceId: string, versionId: string): Promise<PublishedTemplate | null> {
    const v = await this.version(workspaceId, versionId);
    if (!v) return null;
    const t = await this.row(workspaceId, v.template_id);
    return {
      templateId: t.id,
      versionId: v.id,
      name: t.name,
      category: t.category as MessageCategory,
      subject: v.subject,
      previewText: v.preview_text,
      html: v.html,
      text: v.text,
      missingPolicy: v.missing_policy as 'fallback' | 'skip',
    };
  }

  // ------------------------------------------------------------ validation

  async validateContent(workspaceId: string, content: { subject: string; previewText?: string | null; html: string; text?: string | null }, category: MessageCategory): Promise<TemplateIssueDTO[]> {
    const [snippets, defs, { settings }] = await Promise.all([
      this.e.db.selectFrom('snippets').select('key').where('workspace_id', '=', workspaceId).execute(),
      this.e.fields.definitions(workspaceId),
      this.e.workspaces.settings(workspaceId),
    ]);
    const result = validateTemplateSource(content, {
      snippetNames: snippets.map((s) => s.key),
      workspaceVariables: Object.keys(settings.variables),
      customFieldKeys: defs.map((d) => d.key),
      requireUnsubscribe: requiresUnsubscribeLink(category),
    });
    // The workspace footer snippet carries the unsubscribe link.
    const usesFooter = /\{\{>\s*footer\s*\}\}/.test(content.html);
    return result.issues.filter((i) => !(usesFooter && i.message.includes('unsubscribe_url')));
  }

  private clean(input: TemplateContentInput, base: Row<'template_versions'> | null) {
    const subject = (input.subject ?? base?.subject ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 300);
    const rawHtml = input.html ?? base?.html ?? '';
    const sanitized = sanitizeTemplateHtml(rawHtml);
    return {
      subject,
      previewText: input.previewText !== undefined ? (input.previewText?.trim().slice(0, 300) || null) : (base?.preview_text ?? null),
      html: sanitized.html,
      text: input.text !== undefined ? (input.text?.trim() ? input.text.slice(0, 200_000) : null) : (base?.text ?? null),
      missingPolicy: input.missingPolicy ?? (base?.missing_policy as 'fallback' | 'skip' | undefined) ?? 'fallback',
      removed: sanitized.removed,
    };
  }

  private checkMeta(input: { name?: string; category?: string; purpose?: string }) {
    if (input.category !== undefined && !(MESSAGE_CATEGORIES as readonly string[]).includes(input.category)) {
      throw new ValidationError('Unknown category.', [{ path: 'category', message: 'Use transactional, relationship or marketing.' }]);
    }
    if (input.purpose !== undefined && !TEMPLATE_PURPOSES.includes(input.purpose as TemplatePurpose)) {
      throw new ValidationError('Unknown purpose.', [{ path: 'purpose', message: 'Unknown purpose.' }]);
    }
  }

  private failOnErrors(issues: TemplateIssueDTO[]) {
    const errors = issues.filter((i) => i.severity === 'error');
    if (errors.length) {
      throw new ValidationError(errors[0]!.message, errors.map((i) => ({ path: i.field, message: i.message + (i.line ? ` (line ${i.line})` : '') })));
    }
  }

  // ------------------------------------------------------------ writes

  async create(
    ctx: WorkspaceContext,
    input: TemplateContentInput & { name: string; description?: string | null; category?: MessageCategory; purpose?: TemplatePurpose },
  ): Promise<TemplateDTO & { warnings: string[] }> {
    authorize(ctx, 'templates:write');
    const name = (input.name ?? '').trim().slice(0, 120);
    if (!name) throw new ValidationError('Name the template.', [{ path: 'name', message: 'Required.' }]);
    this.checkMeta(input);
    const category = input.category ?? 'marketing';
    const content = this.clean(input, null);
    const issues = await this.validateContent(ctx.workspaceId, content, category);
    this.failOnErrors(issues);
    const now = this.e.nowIso();
    const id = newId('tpl');
    const versionId = newId('tpv');
    await this.e.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('templates')
        .values({
          id,
          workspace_id: ctx.workspaceId,
          name,
          description: input.description?.trim().slice(0, 500) || null,
          category,
          purpose: input.purpose ?? 'custom',
          status: 'draft',
          draft_version_id: versionId,
          published_version_id: null,
          created_by: actorUserId(ctx),
          created_at: now,
          updated_at: now,
          archived_at: null,
        })
        .execute();
      await trx
        .insertInto('template_versions')
        .values({
          id: versionId,
          workspace_id: ctx.workspaceId,
          template_id: id,
          version: 1,
          subject: content.subject,
          preview_text: content.previewText,
          html: content.html,
          text: content.text,
          missing_policy: content.missingPolicy,
          created_by: actorUserId(ctx),
          created_at: now,
          published_at: null,
        })
        .execute();
    });
    await this.e.audit.record(ctx, 'template.created', { type: 'template', id }, { name });
    return { ...(await this.get(ctx, id)), warnings: content.removed.map((r) => `Removed unsafe content: ${r}`) };
  }

  /**
   * Edit a template. Published versions are immutable: editing a published
   * template creates a new draft version; the published one keeps sending
   * until the draft is published.
   */
  async update(
    ctx: WorkspaceContext,
    id: string,
    input: TemplateContentInput & { name?: string; description?: string | null; category?: MessageCategory; purpose?: TemplatePurpose },
  ): Promise<TemplateDTO & { warnings: string[] }> {
    authorize(ctx, 'templates:write');
    this.checkMeta(input);
    const t = await this.row(ctx.workspaceId, id);
    if (t.status === 'archived') throw new PreconditionError('Restore the template before editing it.');
    const draft = await this.version(ctx.workspaceId, t.draft_version_id);
    const now = this.e.nowIso();
    const meta: Partial<Row<'templates'>> = { updated_at: now };
    if (input.name !== undefined) meta.name = input.name.trim().slice(0, 120) || t.name;
    if (input.description !== undefined) meta.description = input.description?.trim().slice(0, 500) || null;
    if (input.category !== undefined) meta.category = input.category;
    if (input.purpose !== undefined) meta.purpose = input.purpose;
    const contentChanged = ['subject', 'previewText', 'html', 'text', 'missingPolicy'].some((k) => (input as Record<string, unknown>)[k] !== undefined);
    let removed: string[] = [];
    if (contentChanged) {
      const content = this.clean(input, draft);
      removed = content.removed;
      this.failOnErrors(await this.validateContent(ctx.workspaceId, content, (meta.category ?? t.category) as MessageCategory));
      const values = {
        subject: content.subject,
        preview_text: content.previewText,
        html: content.html,
        text: content.text,
        missing_policy: content.missingPolicy,
      };
      if (draft && draft.id !== t.published_version_id) {
        await this.e.db.updateTable('template_versions').set(values).where('id', '=', draft.id).execute();
      } else {
        const latest = await this.e.db
          .selectFrom('template_versions')
          .select((eb) => eb.fn.max('version').as('v'))
          .where('template_id', '=', id)
          .executeTakeFirst();
        const versionId = newId('tpv');
        await this.e.db
          .insertInto('template_versions')
          .values({
            id: versionId,
            workspace_id: ctx.workspaceId,
            template_id: id,
            version: Number(latest?.v ?? 0) + 1,
            ...values,
            created_by: actorUserId(ctx),
            created_at: now,
            published_at: null,
          })
          .execute();
        meta.draft_version_id = versionId;
      }
    }
    await this.e.db.updateTable('templates').set(meta).where('id', '=', id).execute();
    await this.e.audit.record(ctx, 'template.updated', { type: 'template', id }, { content: contentChanged });
    return { ...(await this.get(ctx, id)), warnings: removed.map((r) => `Removed unsafe content: ${r}`) };
  }

  async publish(ctx: WorkspaceContext, id: string): Promise<TemplateDTO> {
    authorize(ctx, 'templates:publish');
    const t = await this.row(ctx.workspaceId, id);
    if (t.status === 'archived') throw new PreconditionError('Restore the template before publishing it.');
    const draft = await this.version(ctx.workspaceId, t.draft_version_id);
    if (!draft) throw new NotFoundError('Template draft');
    const issues = await this.validateContent(ctx.workspaceId, { subject: draft.subject, previewText: draft.preview_text, html: draft.html, text: draft.text }, t.category as MessageCategory);
    this.failOnErrors(issues);
    const now = this.e.nowIso();
    await this.e.db.transaction().execute(async (trx) => {
      await trx.updateTable('template_versions').set({ published_at: now }).where('id', '=', draft.id).execute();
      await trx.updateTable('templates').set({ published_version_id: draft.id, status: 'published', updated_at: now }).where('id', '=', id).execute();
    });
    await this.e.audit.record(ctx, 'template.published', { type: 'template', id }, { version: draft.version });
    return this.get(ctx, id);
  }

  async restoreVersion(ctx: WorkspaceContext, id: string, versionId: string): Promise<TemplateDTO> {
    authorize(ctx, 'templates:write');
    const v = await this.version(ctx.workspaceId, versionId);
    if (!v || v.template_id !== id) throw new NotFoundError('Template version', versionId);
    return this.update(ctx, id, { subject: v.subject, previewText: v.preview_text, html: v.html, text: v.text, missingPolicy: v.missing_policy as 'fallback' | 'skip' });
  }

  async archive(ctx: WorkspaceContext, id: string): Promise<void> {
    authorize(ctx, 'templates:write');
    await this.row(ctx.workspaceId, id);
    const campaign = await this.e.db
      .selectFrom('campaigns')
      .select('name')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('template_id', '=', id)
      .where('status', 'in', ['scheduled', 'sending', 'paused', 'pending_approval'])
      .executeTakeFirst();
    if (campaign) throw new PreconditionError(`Template is used by campaign "${campaign.name}".`);
    const automations = await this.e.automations.usingTemplate(ctx.workspaceId, id);
    if (automations.length) throw new PreconditionError(`Template is used by active automation "${automations[0]}". Pause or edit it first.`);
    await this.e.db.updateTable('templates').set({ status: 'archived', archived_at: this.e.nowIso(), updated_at: this.e.nowIso() }).where('id', '=', id).execute();
    await this.e.audit.record(ctx, 'template.archived', { type: 'template', id });
  }

  async restore(ctx: WorkspaceContext, id: string): Promise<TemplateDTO> {
    authorize(ctx, 'templates:write');
    const t = await this.row(ctx.workspaceId, id);
    await this.e.db
      .updateTable('templates')
      .set({ status: t.published_version_id ? 'published' : 'draft', archived_at: null, updated_at: this.e.nowIso() })
      .where('id', '=', id)
      .execute();
    return this.get(ctx, id);
  }

  async duplicate(ctx: WorkspaceContext, id: string): Promise<TemplateDTO> {
    authorize(ctx, 'templates:write');
    const src = await this.get(ctx, id);
    return this.create(ctx, {
      name: `${src.name} (copy)`.slice(0, 120),
      description: src.description,
      category: src.category,
      purpose: src.purpose,
      subject: src.draft.subject,
      previewText: src.draft.previewText,
      html: src.draft.html,
      text: src.draft.text,
      missingPolicy: src.draft.missingPolicy,
    });
  }

  // ------------------------------------------------------------ rendering

  private async previewSender(workspaceId: string): Promise<SenderIdentity> {
    const s = await this.e.senders.defaultSender(workspaceId);
    if (s) return { email: s.email, name: s.name, replyTo: s.reply_to };
    const { settings, workspace } = await this.e.workspaces.settings(workspaceId);
    return { email: 'you@yourcompany.com', name: settings.companyName || workspace.name, replyTo: null };
  }

  /** A synthetic contact used for previews when no real contact is chosen. */
  private sampleContact(workspaceId: string): Row<'contacts'> {
    const now = this.e.nowIso();
    return {
      id: 'con_preview',
      workspace_id: workspaceId,
      first_name: 'Rahul',
      last_name: 'Mehta',
      email: 'rahul@example.com',
      email_normalized: 'rahul@example.com',
      email_status: 'valid',
      company: 'Northwind Labs',
      job_title: 'CTO',
      birthday_month: 3,
      birthday_day: 7,
      birth_year: null,
      birthday_md: 307,
      work_anniversary: null,
      anniversary_md: null,
      relationship_type: 'client',
      interests: '[]',
      preferences: '{}',
      language: null,
      timezone: null,
      source: 'preview',
      consent_status: 'granted',
      consent_updated_at: null,
      consent_source: null,
      status: 'active',
      archived_at: null,
      last_interaction_at: null,
      last_emailed_at: null,
      search_text: '',
      created_at: now,
      updated_at: now,
    };
  }

  /** Render arbitrary (possibly unsaved) content — powers the live editor preview. */
  async renderContent(
    ctx: WorkspaceContext,
    content: { subject: string; previewText?: string | null; html: string; text?: string | null; missingPolicy?: 'fallback' | 'skip' },
    options: { category?: MessageCategory; contactId?: string | null; data?: Record<string, unknown> } = {},
  ): Promise<RenderedEmailDTO> {
    authorize(ctx, 'templates:read');
    const category = options.category ?? 'marketing';
    const sanitized = sanitizeTemplateHtml(content.html);
    const source = { subject: content.subject, previewText: content.previewText ?? null, html: sanitized.html, text: content.text ?? null };
    const issues = await this.validateContent(ctx.workspaceId, source, category);
    const contact = options.contactId ? await this.e.contacts.row(ctx.workspaceId, options.contactId) : this.sampleContact(ctx.workspaceId);
    const blank: RenderedEmailDTO = { subject: '', previewText: '', html: '', text: '', missing: [], fallbacksUsed: [], warnings: [], issues, eligibility: null };
    if (issues.some((i) => i.severity === 'error')) return blank;
    const sender = await this.previewSender(ctx.workspaceId);
    const composed = await this.e.delivery.compose({
      workspaceId: ctx.workspaceId,
      messageId: 'msg_preview',
      contact,
      toEmail: contact.email ?? 'preview@example.com',
      category,
      template: { templateId: null, versionId: null, ...source, missingPolicy: content.missingPolicy ?? 'fallback' },
      sender,
      data: { occasion_date: null, years: 3, event: { project_name: 'Orbit Analytics', proposal_name: 'the Orbit proposal' }, ...(options.data ?? {}) },
      preview: true,
    });
    let eligibility: RenderedEmailDTO['eligibility'] = null;
    if (options.contactId) {
      const { settings } = await this.e.workspaces.settings(ctx.workspaceId);
      eligibility = await this.e.delivery.eligibility(ctx.workspaceId, contact, contact.email, category, settings);
    }
    return {
      subject: composed.email.subject,
      previewText: composed.email.previewText,
      html: composed.email.html,
      text: composed.email.text,
      missing: composed.email.missing,
      fallbacksUsed: composed.email.fallbacksUsed,
      warnings: [...sanitized.removed.map((r) => `Removed unsafe content: ${r}`), ...composed.email.warnings],
      issues,
      eligibility,
    };
  }

  async render(ctx: WorkspaceContext, id: string, options: { which?: 'draft' | 'published'; versionId?: string; contactId?: string | null } = {}): Promise<RenderedEmailDTO> {
    const t = await this.get(ctx, id);
    let v: TemplateVersionDTO | null = options.which === 'published' ? t.published : t.draft;
    if (options.versionId) v = (await this.versions(ctx, id)).find((x) => x.id === options.versionId) ?? null;
    if (!v) throw new NotFoundError('Template version');
    return this.renderContent(ctx, v, { category: t.category, contactId: options.contactId });
  }

  /**
   * Send a test to a workspace member. Tests never go to arbitrary addresses,
   * never affect analytics and carry an inert unsubscribe link.
   */
  async testSend(ctx: WorkspaceContext, id: string, input: { to?: string; contactId?: string | null; which?: 'draft' | 'published' } = {}): Promise<{ messageId: string; to: string }> {
    authorize(ctx, 'messages:test');
    const members = await this.e.workspaces.members(ctx);
    let to = input.to ? normalizeEmail(input.to) : null;
    if (!to) {
      const me = members.find((m) => m.userId === ctx.actor.id);
      to = me?.email ?? null;
    }
    if (!to || !members.some((m) => m.email === to)) {
      throw new PreconditionError('Test e-mails can only be sent to members of this workspace.');
    }
    const rendered = await this.render(ctx, id, { which: input.which, contactId: input.contactId });
    if (rendered.issues.some((i) => i.severity === 'error')) throw new ValidationError('Fix the template errors before sending a test.');
    const sender = await this.e.senders.defaultSender(ctx.workspaceId);
    const from: SenderIdentity | null = sender
      ? { email: sender.email, name: sender.name, replyTo: sender.reply_to }
      : this.e.config.env !== 'production'
        ? { email: 'test@morrow.local', name: 'Morrow test', replyTo: null }
        : null;
    if (!from) throw new PreconditionError('Verify a sender address before sending tests.');
    const result = await this.e.delivery.prepare({
      workspaceId: ctx.workspaceId,
      kind: 'test',
      category: 'transactional',
      idempotencyKey: `test:${id}:${randomToken(8)}`,
      toEmail: to,
      template: { templateId: id, versionId: null, subject: rendered.subject, previewText: rendered.previewText, html: rendered.html, text: rendered.text, missingPolicy: 'fallback', raw: true },
      sender: from,
      bypassConsent: true,
      bypassFrequencyCap: true,
      subjectPrefix: '[Test] ',
    });
    if (result.outcome === 'skipped') throw new PreconditionError(`Test not sent: ${result.reasons.join(', ')}`);
    await this.e.audit.record(ctx, 'template.test_sent', { type: 'template', id }, { messageId: result.messageId });
    return { messageId: result.messageId, to };
  }

  // ------------------------------------------------------------ snippets

  async snippets(ctx: WorkspaceContext): Promise<SnippetDTO[]> {
    authorize(ctx, 'templates:read');
    const rows = await this.e.db.selectFrom('snippets').selectAll().where('workspace_id', '=', ctx.workspaceId).orderBy('key', 'asc').execute();
    return rows.map(snippetDTO);
  }

  private snippetContent(input: { html?: string; text?: string | null }) {
    const sanitized = sanitizeTemplateHtml(input.html ?? '');
    const check = validateTemplateSource({ subject: 'x', html: sanitized.html || 'x', text: input.text ?? null }, { snippetNames: [] });
    const syntax = check.issues.filter((i) => i.severity === 'error' && !i.message.includes('Snippet "'));
    if (syntax.length) throw new ValidationError(syntax[0]!.message);
    return { html: sanitized.html, text: input.text?.trim() ? input.text : null };
  }

  async createSnippet(ctx: WorkspaceContext, input: { key: string; name: string; kind?: SnippetDTO['kind']; html: string; text?: string | null }): Promise<SnippetDTO> {
    authorize(ctx, 'templates:write');
    const key = (input.key ?? '').trim().toLowerCase();
    if (!PARTIAL_NAME_RE.test(key)) throw new ValidationError('Snippet keys use letters, numbers, - and _.', [{ path: 'key', message: 'Invalid key.' }]);
    const exists = await this.e.db.selectFrom('snippets').select('id').where('workspace_id', '=', ctx.workspaceId).where('key', '=', key).executeTakeFirst();
    if (exists) throw new ConflictError(`Snippet "${key}" already exists.`);
    const content = this.snippetContent(input);
    const now = this.e.nowIso();
    const row: Row<'snippets'> = {
      id: newId('snp'),
      workspace_id: ctx.workspaceId,
      key,
      name: (input.name ?? key).trim().slice(0, 80) || key,
      kind: ['header', 'footer', 'signature', 'custom'].includes(input.kind ?? '') ? input.kind! : 'custom',
      html: content.html,
      text: content.text,
      created_at: now,
      updated_at: now,
    };
    await this.e.db.insertInto('snippets').values(row).execute();
    await this.e.audit.record(ctx, 'snippet.created', { type: 'snippet', id: row.id }, { key });
    return snippetDTO(row);
  }

  async updateSnippet(ctx: WorkspaceContext, id: string, input: { name?: string; html?: string; text?: string | null }): Promise<SnippetDTO> {
    authorize(ctx, 'templates:write');
    const row = await this.e.db.selectFrom('snippets').selectAll().where('id', '=', id).where('workspace_id', '=', ctx.workspaceId).executeTakeFirst();
    if (!row) throw new NotFoundError('Snippet', id);
    const content = this.snippetContent({ html: input.html ?? row.html, text: input.text !== undefined ? input.text : row.text });
    const patch = { name: input.name?.trim().slice(0, 80) || row.name, html: content.html, text: content.text, updated_at: this.e.nowIso() };
    await this.e.db.updateTable('snippets').set(patch).where('id', '=', id).execute();
    await this.e.audit.record(ctx, 'snippet.updated', { type: 'snippet', id });
    return snippetDTO({ ...row, ...patch });
  }

  async deleteSnippet(ctx: WorkspaceContext, id: string): Promise<void> {
    authorize(ctx, 'templates:write');
    const row = await this.e.db.selectFrom('snippets').selectAll().where('id', '=', id).where('workspace_id', '=', ctx.workspaceId).executeTakeFirst();
    if (!row) throw new NotFoundError('Snippet', id);
    const used = await this.e.db
      .selectFrom('template_versions')
      .innerJoin('templates', 'templates.published_version_id', 'template_versions.id')
      .select('templates.name')
      .where('template_versions.workspace_id', '=', ctx.workspaceId)
      .where('templates.status', '!=', 'archived')
      .where(sql<boolean>`(template_versions.html like ${`%{{> ${row.key}}}%`} or template_versions.html like ${`%{{>${row.key}}}%`})`)
      .executeTakeFirst();
    if (used) throw new PreconditionError(`Snippet is used by template "${used.name}".`);
    await this.e.db.deleteFrom('snippets').where('id', '=', id).execute();
    await this.e.audit.record(ctx, 'snippet.deleted', { type: 'snippet', id }, { key: row.key });
  }
}
