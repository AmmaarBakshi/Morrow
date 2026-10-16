import {
  appendToBody,
  checkEligibility,
  composeEmail,
  decodeEntities,
  escapeHtml,
  formatMonthDay,
  fullName,
  localDate,
  newId,
  normalizeEmail,
  requiresUnsubscribeLink,
  type ComposedEmail,
  type IneligibleReason,
  type MessageCategory,
  type SnippetSource,
  type SuppressionReason,
  type SuppressionScope,
  type WorkspaceSettings,
} from '@morrow/core';
import { fromJson, toJson, type Db, type Row } from '@morrow/db';
import { ProviderError, type ProviderEvent } from '@morrow/email';
import { signToken, verifyToken } from '../crypto';
import type { Engine } from '../engine';
import type { Job } from '../queue/queue';
import { JobError, type Reschedule } from '../queue/worker';

// ---------------------------------------------------------------- types

export interface ComposeTemplate {
  templateId: string | null;
  versionId: string | null;
  subject: string;
  previewText: string | null;
  html: string;
  text: string | null;
  missingPolicy: 'fallback' | 'skip';
  /** Use the content verbatim (system e-mail); no template syntax is interpreted. */
  raw?: boolean;
}

export interface SenderIdentity {
  email: string;
  name: string | null;
  replyTo: string | null;
}

export type MessageKind = 'campaign' | 'automation' | 'test' | 'system';

export interface PrepareInput {
  workspaceId: string;
  kind: MessageKind;
  category: MessageCategory;
  idempotencyKey: string;
  contact?: Row<'contacts'> | null;
  /** Recipient when there is no contact (tests and system e-mail). */
  toEmail?: string;
  template: ComposeTemplate;
  sender: SenderIdentity;
  campaignId?: string | null;
  automationId?: string | null;
  automationRunId?: string | null;
  /** Extra personalisation data (occasion_date, years, event properties…). */
  data?: Record<string, unknown>;
  requireApproval?: boolean;
  scheduledFor?: Date | null;
  /** Tests to workspace members skip consent checks (never hard suppressions). */
  bypassConsent?: boolean;
  bypassFrequencyCap?: boolean;
  subjectPrefix?: string;
}

export type PrepareResult =
  | { outcome: 'queued' | 'pending_approval'; messageId: string }
  | { outcome: 'duplicate'; messageId: string; status: string }
  | { outcome: 'skipped'; messageId: string; reasons: string[] };

export interface ComposeResult {
  email: ComposedEmail;
  unsubscribeUrl: string | null;
  headers: Record<string, string>;
}

/** Status precedence: events never move a message "backwards" when they arrive out of order. */
export const STATUS_RANK: Record<string, number> = {
  queued: 0,
  pending_approval: 0,
  sending: 1,
  sent: 2,
  uncertain: 2,
  failed: 3,
  rejected: 3,
  delivered: 4,
  bounced: 5,
  complained: 6,
  suppressed: 7,
  cancelled: 7,
};

const ACTIVE_STATUSES = ['queued', 'pending_approval', 'sending', 'sent', 'delivered', 'uncertain'];
const BOT_UA = /bot|crawler|spider|scanner|proofpoint|mimecast|barracuda|safelinks|urldefense|preview|headless|python-requests|curl\//i;
const NO_PROVIDER_EXPIRY_MS = 72 * 3_600_000;

function minIso(a: string | null, b: string): string {
  return a && a < b ? a : b;
}

// ---------------------------------------------------------------- service

export class DeliveryService {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(private readonly e: Engine) {}

  // ------------------------------------------------------------ links

  unsubscribeUrl(workspaceId: string, contactId: string | null, messageId: string, email: string): string {
    const token = signToken({ w: workspaceId, c: contactId, m: messageId, e: email }, this.e.config.secretKey, 'unsub');
    return `${this.e.config.publicUrl}/u/${token}`;
  }

  private trackingToken(purpose: 'open' | 'click', payload: Record<string, unknown>): string {
    return signToken(payload, this.e.config.secretKey, purpose);
  }

  /** Rewrite http(s) links through the click tracker and add the open pixel. */
  applyTracking(html: string, messageId: string, opts: { opens: boolean; clicks: boolean; skip: string[] }): string {
    let out = html;
    if (opts.clicks) {
      out = out.replace(/(<a\b[^>]*?\bhref\s*=\s*)(["'])(https?:\/\/[^"']+)\2/gi, (match, prefix: string, quote: string, raw: string) => {
        const url = decodeEntities(raw);
        if (opts.skip.some((s) => s && url.startsWith(s))) return match;
        const token = this.trackingToken('click', { m: messageId, u: url });
        return `${prefix}${quote}${this.e.config.publicUrl}/t/c/${token}${quote}`;
      });
    }
    if (opts.opens) {
      const token = this.trackingToken('open', { m: messageId });
      out = appendToBody(
        out,
        `<img src="${this.e.config.publicUrl}/t/o/${token}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px;overflow:hidden" />`,
      );
    }
    return out;
  }

  // ------------------------------------------------------------ personalisation

  async snippets(workspaceId: string, db: Db = this.e.db): Promise<Record<string, SnippetSource>> {
    const rows = await db.selectFrom('snippets').select(['key', 'html', 'text']).where('workspace_id', '=', workspaceId).execute();
    return Object.fromEntries(rows.map((r) => [r.key, { html: r.html, text: r.text }]));
  }

  buildTemplateData(params: {
    contact: Row<'contacts'> | null;
    customFields: Record<string, unknown>;
    workspace: Row<'workspaces'>;
    settings: WorkspaceSettings;
    sender: SenderIdentity;
    toEmail: string | null;
    unsubscribeUrl: string | null;
    extra?: Record<string, unknown>;
  }): Record<string, unknown> {
    const { contact, settings, workspace, sender } = params;
    const now = this.e.now();
    const birthday =
      contact?.birthday_month && contact.birthday_day ? formatMonthDay({ month: contact.birthday_month, day: contact.birthday_day }) : null;
    const extra = params.extra ?? {};
    return {
      // Workspace-defined variables first so built-in values always win.
      ...settings.variables,
      company_name: settings.companyName || workspace.name,
      company_address: settings.companyAddress || null,
      website_url: settings.websiteUrl || null,
      logo_url: settings.logoUrl || null,
      brand_color: settings.brandColor,
      sender_name: sender.name ?? null,
      sender_email: sender.email,
      first_name: contact?.first_name ?? null,
      last_name: contact?.last_name ?? null,
      full_name: contact ? fullName({ firstName: contact.first_name, lastName: contact.last_name }) || null : null,
      email: contact?.email ?? params.toEmail,
      company: contact?.company ?? null,
      job_title: contact?.job_title ?? null,
      relationship_type: contact?.relationship_type ?? null,
      language: contact?.language ?? null,
      birthday,
      unsubscribe_url: params.unsubscribeUrl,
      preferences_url: params.unsubscribeUrl,
      current_year: Number(localDate(now, workspace.timezone).slice(0, 4)),
      today: localDate(now, workspace.timezone),
      occasion_date: (extra.occasion_date as string | undefined) ?? null,
      years: (extra.years as number | undefined) ?? null,
      custom: params.customFields,
      event: (extra.event as Record<string, unknown> | undefined) ?? {},
    };
  }

  private complianceFooter(settings: WorkspaceSettings, workspace: Row<'workspaces'>, unsubscribeUrl: string): { html: string; text: string } {
    const company = settings.companyName || workspace.name;
    const address = settings.companyAddress;
    return {
      html:
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:24px 16px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:#6b7280;text-align:center">` +
        `${escapeHtml(company)}${address ? ` &middot; ${escapeHtml(address)}` : ''}<br>` +
        `You received this e-mail because of your relationship with ${escapeHtml(company)}. ` +
        `<a href="${escapeHtml(unsubscribeUrl)}" style="color:#6b7280;text-decoration:underline">Unsubscribe</a></td></tr></table>`,
      text: `\n\n--\n${company}${address ? `, ${address}` : ''}\nUnsubscribe: ${unsubscribeUrl}`,
    };
  }

  /**
   * Render a message for one recipient. Shared by real sends, previews and dry
   * runs so what you preview is exactly what is sent (minus tracking).
   */
  async compose(params: {
    workspaceId: string;
    messageId: string;
    contact: Row<'contacts'> | null;
    toEmail: string;
    category: MessageCategory;
    template: ComposeTemplate;
    sender: SenderIdentity;
    data?: Record<string, unknown>;
    preview?: boolean;
    db?: Db;
  }): Promise<ComposeResult> {
    const db = params.db ?? this.e.db;
    const { workspace, settings } = await this.e.workspaces.settings(params.workspaceId);
    const needsUnsubscribe = requiresUnsubscribeLink(params.category);
    const unsubscribeUrl = needsUnsubscribe
      ? params.preview
        ? `${this.e.config.publicUrl}/u/preview`
        : this.unsubscribeUrl(params.workspaceId, params.contact?.id ?? null, params.messageId, params.toEmail)
      : null;
    const customFields = params.contact ? ((await this.e.fields.valuesFor(params.workspaceId, [params.contact.id], db)).get(params.contact.id) ?? {}) : {};
    const data = this.buildTemplateData({
      contact: params.contact,
      customFields,
      workspace,
      settings,
      sender: params.sender,
      toEmail: params.toEmail,
      unsubscribeUrl,
      extra: params.data,
    });
    const email: ComposedEmail = params.template.raw
      ? {
          subject: params.template.subject,
          previewText: params.template.previewText ?? '',
          html: params.template.html,
          text: params.template.text ?? '',
          missing: [],
          fallbacksUsed: [],
          used: [],
          warnings: [],
        }
      : composeEmail(
          { subject: params.template.subject, previewText: params.template.previewText, html: params.template.html, text: params.template.text },
          data,
          { snippets: await this.snippets(params.workspaceId, db), fallbacks: { first_name: settings.fallbackFirstName }, locale: params.contact?.language || settings.locale },
        );
    const headers: Record<string, string> = { 'X-Morrow-Category': params.category };
    if (unsubscribeUrl) {
      if (!email.html.includes(unsubscribeUrl)) {
        const footer = this.complianceFooter(settings, workspace, unsubscribeUrl);
        email.html = appendToBody(email.html, footer.html);
        email.text += footer.text;
        email.warnings.push('The template has no unsubscribe link, so Morrow appended its standard footer.');
      } else if (!email.text.includes(unsubscribeUrl)) {
        email.text += `\n\nUnsubscribe: ${unsubscribeUrl}`;
      }
      headers['List-Unsubscribe'] = `<${unsubscribeUrl}>`;
      headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
    }
    return { email, unsubscribeUrl, headers };
  }

  // ------------------------------------------------------------ eligibility

  async eligibility(
    workspaceId: string,
    contact: Row<'contacts'> | null,
    email: string | null,
    category: MessageCategory,
    settings: WorkspaceSettings,
    options: { bypassConsent?: boolean } = {},
    db: Db = this.e.db,
  ): Promise<{ eligible: boolean; reasons: IneligibleReason[] }> {
    const normalized = email ? normalizeEmail(email, { gmailCanonical: settings.dedupe.gmailCanonical }) : null;
    const supp = await this.e.suppressions.active(workspaceId, normalized ?? (email ? email.toLowerCase() : null), db);
    const result = checkEligibility(
      {
        email,
        emailValid: Boolean(normalized) && (!contact || !['invalid', 'bounced', 'complained'].includes(contact.email_status)),
        archived: contact ? contact.status !== 'active' : false,
        consentStatus: options.bypassConsent || !contact ? 'granted' : (contact.consent_status as 'granted'),
        suppression: supp ? { reason: supp.reason as SuppressionReason, scope: supp.scope as SuppressionScope } : null,
      },
      options.bypassConsent ? 'transactional' : category,
      settings.consent,
    );
    // Even tests and system mail must never go to hard-suppressed addresses.
    if (options.bypassConsent && supp && supp.scope === 'all' && !result.reasons.includes('suppressed')) {
      return { eligible: false, reasons: ['suppressed'] };
    }
    return result;
  }

  /** True when sending would exceed the contact's daily or weekly frequency cap. */
  async frequencyCapped(workspaceId: string, contact: Row<'contacts'>, settings: WorkspaceSettings, db: Db = this.e.db): Promise<boolean> {
    let { dailyCapPerContact: daily, weeklyCapPerContact: weekly } = settings.sending;
    const prefs = fromJson<{ frequency?: string }>(contact.preferences, {});
    if (prefs.frequency === 'reduced') {
      daily = daily ? Math.max(1, Math.floor(daily / 2)) : 1;
      weekly = weekly ? Math.max(1, Math.floor(weekly / 2)) : 2;
    } else if (prefs.frequency === 'minimal') {
      daily = 1;
      weekly = 1;
    }
    if (!daily && !weekly) return false;
    const now = this.e.now().getTime();
    const since = new Date(now - 7 * 86_400_000).toISOString();
    const rows = await db
      .selectFrom('messages')
      .select('created_at')
      .where('workspace_id', '=', workspaceId)
      .where('contact_id', '=', contact.id)
      .where('category', '!=', 'transactional')
      .where('kind', 'in', ['campaign', 'automation'])
      .where('status', 'in', ACTIVE_STATUSES)
      .where('created_at', '>=', since)
      .execute();
    const dayAgo = new Date(now - 86_400_000).toISOString();
    if (daily && rows.filter((r) => r.created_at >= dayAgo).length >= daily) return true;
    if (weekly && rows.length >= weekly) return true;
    return false;
  }

  // ------------------------------------------------------------ prepare

  private async existingByKey(workspaceId: string, key: string, db: Db = this.e.db) {
    return db.selectFrom('messages').select(['id', 'status']).where('workspace_id', '=', workspaceId).where('idempotency_key', '=', key).executeTakeFirst();
  }

  private baseRow(input: PrepareInput, id: string, toEmail: string, now: string): Row<'messages'> {
    return {
      id,
      workspace_id: input.workspaceId,
      contact_id: input.contact?.id ?? null,
      campaign_id: input.campaignId ?? null,
      automation_id: input.automationId ?? null,
      automation_run_id: input.automationRunId ?? null,
      template_id: input.template.templateId,
      template_version_id: input.template.versionId,
      kind: input.kind,
      category: input.category,
      idempotency_key: input.idempotencyKey,
      to_email: toEmail,
      from_email: input.sender.email,
      from_name: input.sender.name,
      reply_to: input.sender.replyTo,
      subject: input.template.subject.slice(0, 500),
      html: null,
      text: null,
      headers: '{}',
      status: 'queued',
      approval_status: 'not_required',
      approved_by: null,
      approved_at: null,
      provider: null,
      provider_message_id: null,
      attempts: 0,
      error_code: null,
      error_message: null,
      error_class: null,
      scheduled_for: input.scheduledFor ? input.scheduledFor.toISOString() : null,
      queued_at: null,
      sent_at: null,
      delivered_at: null,
      bounced_at: null,
      bounce_type: null,
      complained_at: null,
      opened_at: null,
      clicked_at: null,
      unsubscribed_at: null,
      failed_at: null,
      created_at: now,
      updated_at: now,
    };
  }

  /**
   * Create exactly one message for an intended send and queue it (or hold it
   * for approval). Ineligible recipients are recorded as `suppressed` so the
   * decision is auditable and never re-evaluated for the same send action.
   */
  async prepare(input: PrepareInput): Promise<PrepareResult> {
    const existing = await this.existingByKey(input.workspaceId, input.idempotencyKey);
    if (existing) return { outcome: 'duplicate', messageId: existing.id, status: existing.status };

    const { settings } = await this.e.workspaces.settings(input.workspaceId);
    const toEmail = (input.contact?.email ?? input.toEmail ?? '').trim();
    const id = newId('msg');
    const nowIso = this.e.nowIso();
    const base = this.baseRow(input, id, toEmail || '(none)', nowIso);

    const reasons: string[] = [];
    const elig = await this.eligibility(input.workspaceId, input.contact ?? null, toEmail || null, input.category, settings, { bypassConsent: input.bypassConsent });
    reasons.push(...elig.reasons);
    if (
      elig.eligible &&
      input.contact &&
      !input.bypassFrequencyCap &&
      input.category !== 'transactional' &&
      (await this.frequencyCapped(input.workspaceId, input.contact, settings))
    ) {
      reasons.push('frequency_cap');
    }

    let composed: ComposeResult | null = null;
    if (reasons.length === 0) {
      composed = await this.compose({
        workspaceId: input.workspaceId,
        messageId: id,
        contact: input.contact ?? null,
        toEmail,
        category: input.category,
        template: input.template,
        sender: input.sender,
        data: input.data,
      });
      if (composed.email.missing.length && input.template.missingPolicy === 'skip') {
        reasons.push(`missing_personalization:${composed.email.missing.join(',')}`);
      }
    }

    if (reasons.length) {
      const row: Row<'messages'> = {
        ...base,
        status: 'suppressed',
        error_code: reasons[0]!.split(':')[0]!,
        error_message: reasons.join('; '),
        error_class: 'permanent',
      };
      const inserted = await this.e.db.insertInto('messages').values(row).onConflict((oc) => oc.doNothing()).returning('id').executeTakeFirst();
      if (!inserted) {
        const winner = await this.existingByKey(input.workspaceId, input.idempotencyKey);
        return { outcome: 'duplicate', messageId: winner!.id, status: winner!.status };
      }
      return { outcome: 'skipped', messageId: id, reasons };
    }

    const email = composed!.email;
    const tracking = input.kind === 'campaign' || input.kind === 'automation';
    const html = tracking
      ? this.applyTracking(email.html, id, {
          opens: settings.tracking.opens,
          clicks: settings.tracking.clicks,
          skip: [composed!.unsubscribeUrl ?? '', `${this.e.config.publicUrl}/u/`],
        })
      : email.html;
    const pending = Boolean(input.requireApproval);
    const row: Row<'messages'> = {
      ...base,
      subject: `${input.subjectPrefix ?? ''}${email.subject}`.slice(0, 500),
      html,
      text: email.text,
      headers: toJson(composed!.headers),
      status: pending ? 'pending_approval' : 'queued',
      approval_status: pending ? 'pending' : 'not_required',
      queued_at: pending ? null : nowIso,
    };
    const result = await this.e.db.transaction().execute(async (trx) => {
      const inserted = await trx.insertInto('messages').values(row).onConflict((oc) => oc.doNothing()).returning('id').executeTakeFirst();
      if (!inserted) return null;
      if (!pending) await this.enqueueSend(id, input.workspaceId, input.scheduledFor ?? undefined, trx, input.kind === 'test' || input.kind === 'system' ? 5 : 0);
      return inserted.id;
    });
    if (!result) {
      const winner = await this.existingByKey(input.workspaceId, input.idempotencyKey);
      return { outcome: 'duplicate', messageId: winner!.id, status: winner!.status };
    }
    this.e.nudgeWorker();
    return { outcome: pending ? 'pending_approval' : 'queued', messageId: id };
  }

  async enqueueSend(messageId: string, workspaceId: string, runAt?: Date, db: Db = this.e.db, priority = 0): Promise<void> {
    await this.e.queue.enqueue('email.send', { messageId }, { workspaceId, runAt, dedupeKey: `send:${messageId}`, priority, maxAttempts: 8 }, db);
  }

  // ------------------------------------------------------------ sending

  private takeToken(workspaceId: string, ratePerSecond: number): number {
    const now = Date.now();
    const capacity = Math.max(1, Math.ceil(ratePerSecond));
    const b = this.buckets.get(workspaceId) ?? { tokens: capacity, at: now };
    b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 1000) * ratePerSecond);
    b.at = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      this.buckets.set(workspaceId, b);
      return 0;
    }
    this.buckets.set(workspaceId, b);
    return Math.ceil(((1 - b.tokens) / ratePerSecond) * 1000);
  }

  private async markSuppressed(message: Row<'messages'>, reasons: string[]): Promise<void> {
    await this.e.db
      .updateTable('messages')
      .set({ status: 'suppressed', error_code: reasons[0] ?? 'ineligible', error_message: reasons.join('; '), error_class: 'permanent', updated_at: this.e.nowIso() })
      .where('id', '=', message.id)
      .where('status', 'in', ['queued', 'sending', 'pending_approval'])
      .execute();
  }

  /** Job handler for `email.send`: final checks, provider hand-off and result recording. */
  async send(job: Job): Promise<void | Reschedule> {
    const messageId = String(job.payload.messageId ?? '');
    const message = await this.e.db.selectFrom('messages').selectAll().where('id', '=', messageId).executeTakeFirst();
    if (!message) return;
    if (message.status !== 'queued' && message.status !== 'sending') return; // already handled

    const now = this.e.now();
    const { settings } = await this.e.workspaces.settings(message.workspace_id);

    // Campaign / automation state can change after a message was queued.
    if (message.campaign_id) {
      const c = await this.e.db.selectFrom('campaigns').select('status').where('id', '=', message.campaign_id).executeTakeFirst();
      if (c?.status === 'paused') return { reschedule: new Date(now.getTime() + 60_000) };
      if (!c || c.status === 'cancelled') {
        await this.e.db.updateTable('messages').set({ status: 'cancelled', updated_at: now.toISOString() }).where('id', '=', message.id).where('status', '=', 'queued').execute();
        return;
      }
    }
    if (message.automation_id) {
      const a = await this.e.db.selectFrom('automations').select('status').where('id', '=', message.automation_id).executeTakeFirst();
      if (a?.status === 'paused') return { reschedule: new Date(now.getTime() + 5 * 60_000) };
      if (!a || a.status === 'archived') {
        await this.e.db.updateTable('messages').set({ status: 'cancelled', updated_at: now.toISOString() }).where('id', '=', message.id).where('status', '=', 'queued').execute();
        return;
      }
    }

    // Final-stage eligibility: suppression and consent are re-checked right before sending.
    const contact = message.contact_id
      ? ((await this.e.db.selectFrom('contacts').selectAll().where('id', '=', message.contact_id).executeTakeFirst()) ?? null)
      : null;
    if (message.contact_id && !contact) {
      await this.markSuppressed(message, ['contact_deleted']);
      return;
    }
    const elig = await this.eligibility(message.workspace_id, contact, message.to_email, message.category as MessageCategory, settings, {
      bypassConsent: message.kind === 'test' || message.kind === 'system',
    });
    if (!elig.eligible) {
      await this.markSuppressed(message, elig.reasons);
      return;
    }

    const wait = this.takeToken(message.workspace_id, settings.sending.ratePerSecond);
    if (wait > 0) return { reschedule: new Date(now.getTime() + wait) };

    const resolved = await this.e.integrations.resolveEmailProvider(message.workspace_id);
    if (!resolved) {
      if (now.getTime() - Date.parse(message.queued_at ?? message.created_at) > NO_PROVIDER_EXPIRY_MS) {
        await this.e.db
          .updateTable('messages')
          .set({ status: 'failed', failed_at: now.toISOString(), error_code: 'no_provider', error_message: 'No e-mail provider was configured within 72 hours.', error_class: 'permanent', updated_at: now.toISOString() })
          .where('id', '=', message.id)
          .execute();
        return;
      }
      await this.e.db
        .updateTable('messages')
        .set({ error_code: 'no_provider', error_message: 'Waiting for an e-mail provider to be configured.', updated_at: now.toISOString() })
        .where('id', '=', message.id)
        .execute();
      return { reschedule: new Date(now.getTime() + 5 * 60_000) };
    }

    if (message.status === 'sending') {
      // A previous worker died mid-send. Only resend if the provider de-duplicates.
      if (!resolved.provider.capabilities.idempotencyKeys) {
        await this.e.db
          .updateTable('messages')
          .set({
            status: 'uncertain',
            error_code: 'uncertain_delivery',
            error_message: 'The worker stopped while handing this message to the provider. Check the provider before resending to avoid a duplicate.',
            updated_at: now.toISOString(),
          })
          .where('id', '=', message.id)
          .execute();
        await this.e.notifications.notifyAdmins(message.workspace_id, {
          kind: 'delivery.uncertain',
          title: 'A message needs review',
          body: `Morrow could not confirm whether message ${message.id} reached the provider.`,
          link: `/messages/${message.id}`,
          dedupeKey: `uncertain:${message.id}`,
        });
        return;
      }
    }

    // Atomic claim of the send action: only one worker can move it to "sending".
    const claimed = await this.e.db
      .updateTable('messages')
      .set((eb) => ({ status: 'sending', attempts: eb('attempts', '+', 1), provider: resolved.name, updated_at: now.toISOString() }))
      .where('id', '=', message.id)
      .where('status', '=', message.status)
      .executeTakeFirst();
    if (Number(claimed.numUpdatedRows ?? 0) === 0) return;

    const headers = fromJson<Record<string, string>>(message.headers, {});
    try {
      const result = await resolved.provider.send({
        messageId: message.id,
        idempotencyKey: message.idempotency_key,
        from: { email: message.from_email, name: message.from_name },
        to: { email: message.to_email, name: contact ? fullName({ firstName: contact.first_name, lastName: contact.last_name }) || null : null },
        replyTo: message.reply_to,
        subject: message.subject,
        html: message.html ?? '',
        text: message.text ?? '',
        headers,
        category: message.category as MessageCategory,
        tags: { workspace: message.workspace_id, kind: message.kind, ...(message.campaign_id ? { campaign: message.campaign_id } : {}) },
      });
      const at = this.e.nowIso();
      await this.e.db.transaction().execute(async (trx) => {
        await trx
          .updateTable('messages')
          .set({ status: 'sent', sent_at: result.acceptedAt, provider_message_id: result.providerMessageId, error_code: null, error_message: null, error_class: null, updated_at: at })
          .where('id', '=', message.id)
          .where('status', '=', 'sending')
          .execute();
        await trx
          .insertInto('message_events')
          .values({
            id: newId('mev'),
            workspace_id: message.workspace_id,
            message_id: message.id,
            type: 'accepted',
            provider: resolved.name,
            provider_event_id: `${resolved.name}:${result.providerMessageId}:accepted`,
            occurred_at: result.acceptedAt,
            data: '{}',
            created_at: at,
          })
          .onConflict((oc) => oc.doNothing())
          .execute();
        if (contact && (message.kind === 'campaign' || message.kind === 'automation')) {
          await trx.updateTable('contacts').set({ last_emailed_at: at }).where('id', '=', contact.id).execute();
        }
      });
      if (result.simulatedEvents?.length) {
        await this.e.queue.enqueue(
          'email.events',
          { workspaceId: message.workspace_id, provider: resolved.name, events: result.simulatedEvents as unknown as Record<string, unknown>[] },
          { workspaceId: message.workspace_id, runAt: new Date(this.e.now().getTime() + (this.e.config.env === 'test' ? 0 : 1500)), maxAttempts: 5 },
        );
      }
    } catch (err) {
      const pe = err instanceof ProviderError ? err : new ProviderError((err as Error).message ?? 'Send failed', { errorClass: 'transient', code: 'unknown' });
      const at = this.e.nowIso();
      const finalAttempt = job.attempts >= job.maxAttempts;
      if (pe.errorClass === 'transient' && !finalAttempt) {
        await this.e.db
          .updateTable('messages')
          .set({ status: 'queued', error_code: pe.code, error_message: pe.message.slice(0, 1000), error_class: 'transient', updated_at: at })
          .where('id', '=', message.id)
          .execute();
        throw new JobError(pe.message, { retryable: true, retryAfterMs: pe.retryAfterMs });
      }
      await this.e.db
        .updateTable('messages')
        .set({
          status: pe.errorClass === 'permanent' ? 'rejected' : 'failed',
          failed_at: at,
          error_code: pe.code,
          error_message: pe.message.slice(0, 1000),
          error_class: pe.errorClass,
          updated_at: at,
        })
        .where('id', '=', message.id)
        .execute();
      if (pe.invalidRecipient) {
        const email = normalizeEmail(message.to_email);
        if (email) await this.e.suppressions.suppress(message.workspace_id, { email, reason: 'invalid_address', source: `provider:${resolved.name}`, messageId: message.id });
        if (contact) await this.e.db.updateTable('contacts').set({ email_status: 'invalid', updated_at: at }).where('id', '=', contact.id).execute();
      }
      if (pe.errorClass === 'transient') {
        await this.e.notifications.notifyAdmins(message.workspace_id, {
          kind: 'delivery.failed',
          title: 'Messages are failing to send',
          body: `${resolved.name}: ${pe.message.slice(0, 200)}`,
          link: '/settings/system',
          dedupeKey: `send-failing:${message.workspace_id}:${at.slice(0, 13)}`,
        });
      }
      throw new JobError(pe.message, { retryable: pe.errorClass === 'transient' });
    }
  }

  // ------------------------------------------------------------ provider events

  /**
   * Ingest normalised provider events. Idempotent (repeated deliveries of an
   * event are ignored) and order-independent (status precedence).
   * Returns events whose message could not be found yet.
   */
  async ingestEvents(workspaceHint: string | null, provider: string, events: ProviderEvent[]): Promise<{ processed: number; duplicates: number; unknown: ProviderEvent[] }> {
    let processed = 0;
    let duplicates = 0;
    const unknown: ProviderEvent[] = [];
    for (const ev of events) {
      let q = this.e.db.selectFrom('messages').selectAll().where('provider', '=', provider).where('provider_message_id', '=', ev.providerMessageId);
      if (workspaceHint) q = q.where('workspace_id', '=', workspaceHint);
      const message = await q.executeTakeFirst();
      if (!message) {
        unknown.push(ev);
        continue;
      }
      const applied = await this.applyEvent(message, provider, ev);
      if (applied) processed++;
      else duplicates++;
    }
    return { processed, duplicates, unknown };
  }

  /** Apply one event to a message. Returns false when it was a duplicate. */
  async applyEvent(message: Row<'messages'>, provider: string, ev: ProviderEvent, data: Record<string, unknown> = {}): Promise<boolean> {
    const at = new Date(ev.occurredAt).toISOString();
    const nowIso = this.e.nowIso();
    const ws = message.workspace_id;
    const eventData = { ...data, ...(ev.reason ? { reason: ev.reason.slice(0, 500) } : {}), ...(ev.url ? { url: ev.url.slice(0, 1000) } : {}), ...(ev.bounceType ? { bounceType: ev.bounceType } : {}) };
    const inserted = await this.e.db
      .insertInto('message_events')
      .values({
        id: newId('mev'),
        workspace_id: ws,
        message_id: message.id,
        type: ev.type,
        provider,
        provider_event_id: ev.providerEventId,
        occurred_at: at,
        data: toJson(eventData),
        created_at: nowIso,
      })
      .onConflict((oc) => oc.doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!inserted) return false;

    const rank = STATUS_RANK[message.status] ?? 0;
    const patch: Partial<Row<'messages'>> = { updated_at: nowIso };
    const suspectedBot = data.suspectedBot === true;
    switch (ev.type) {
      case 'accepted':
        patch.sent_at = message.sent_at ?? at;
        if (rank < STATUS_RANK.sent!) patch.status = 'sent';
        break;
      case 'delivered':
        patch.delivered_at = minIso(message.delivered_at, at);
        if (rank < STATUS_RANK.delivered!) patch.status = 'delivered';
        break;
      case 'bounced':
        if (ev.bounceType === 'hard') {
          patch.bounced_at = minIso(message.bounced_at, at);
          patch.bounce_type = 'hard';
          if (rank < STATUS_RANK.bounced!) patch.status = 'bounced';
        } else {
          patch.bounce_type = message.bounce_type ?? 'soft';
          patch.bounced_at = message.bounced_at ?? at;
        }
        break;
      case 'complained':
        patch.complained_at = minIso(message.complained_at, at);
        if (rank < STATUS_RANK.complained!) patch.status = 'complained';
        break;
      case 'opened':
        if (!suspectedBot) patch.opened_at = minIso(message.opened_at, at);
        break;
      case 'clicked':
        if (!suspectedBot) patch.clicked_at = minIso(message.clicked_at, at);
        break;
      case 'unsubscribed':
        patch.unsubscribed_at = minIso(message.unsubscribed_at, at);
        break;
      case 'rejected':
      case 'failed':
        if (rank < STATUS_RANK.delivered!) {
          patch.status = ev.type === 'rejected' ? 'rejected' : 'failed';
          patch.failed_at = message.failed_at ?? at;
          patch.error_message = ev.reason?.slice(0, 1000) ?? message.error_message;
          patch.error_class = 'permanent';
        }
        break;
      default:
        break;
    }
    await this.e.db.updateTable('messages').set(patch).where('id', '=', message.id).execute();

    // Side effects that protect the sender's reputation and the recipient's wishes.
    const email = normalizeEmail(message.to_email);
    const contact = message.contact_id ? await this.e.db.selectFrom('contacts').selectAll().where('id', '=', message.contact_id).executeTakeFirst() : undefined;
    if (ev.type === 'bounced' && ev.bounceType === 'hard') {
      if (email) await this.e.suppressions.suppress(ws, { email, reason: 'hard_bounce', source: `provider:${provider}`, messageId: message.id, note: ev.reason ?? null });
      if (contact) await this.e.db.updateTable('contacts').set({ email_status: 'bounced', updated_at: nowIso }).where('id', '=', contact.id).execute();
    } else if (ev.type === 'complained' || ev.type === 'unsubscribed') {
      if (email) {
        await this.e.suppressions.suppress(ws, {
          email,
          reason: ev.type === 'complained' ? 'complaint' : 'unsubscribed',
          source: `provider:${provider}`,
          messageId: message.id,
        });
      }
      if (contact) await this.e.contacts.withdrawConsent(ws, contact, ev.type === 'complained' ? 'spam_complaint' : `provider_unsubscribe:${provider}`);
      if (contact && ev.type === 'complained') {
        await this.e.db.updateTable('contacts').set({ email_status: 'complained' }).where('id', '=', contact.id).execute();
      }
    } else if (ev.type === 'clicked' && !suspectedBot && contact) {
      if (!contact.last_interaction_at || contact.last_interaction_at < at) {
        await this.e.db.updateTable('contacts').set({ last_interaction_at: at }).where('id', '=', contact.id).execute();
      }
    }
    return true;
  }

  // ------------------------------------------------------------ public links

  async recordOpen(token: string, userAgent: string | null): Promise<void> {
    const p = verifyToken<{ m: string }>(token, this.e.config.secretKey, 'open');
    if (!p?.m) return;
    const message = await this.e.db.selectFrom('messages').selectAll().where('id', '=', p.m).executeTakeFirst();
    if (!message) return;
    const suspectedBot = Boolean(userAgent && BOT_UA.test(userAgent));
    await this.applyEvent(message, 'morrow', { providerEventId: null, providerMessageId: message.provider_message_id ?? message.id, type: 'opened', occurredAt: this.e.nowIso() }, { suspectedBot });
  }

  /** Returns the destination URL (or null for an invalid token). */
  async recordClick(token: string, userAgent: string | null): Promise<string | null> {
    const p = verifyToken<{ m: string; u: string }>(token, this.e.config.secretKey, 'click');
    if (!p?.m || typeof p.u !== 'string' || !/^https?:\/\//i.test(p.u)) return null;
    const message = await this.e.db.selectFrom('messages').selectAll().where('id', '=', p.m).executeTakeFirst();
    if (message) {
      const tooFast = message.sent_at ? this.e.now().getTime() - Date.parse(message.sent_at) < 10_000 : false;
      const suspectedBot = tooFast || Boolean(userAgent && BOT_UA.test(userAgent));
      await this.applyEvent(
        message,
        'morrow',
        { providerEventId: null, providerMessageId: message.provider_message_id ?? message.id, type: 'clicked', url: p.u, occurredAt: this.e.nowIso() },
        { suspectedBot },
      );
    }
    return p.u;
  }

  parseUnsubscribeToken(token: string): { w: string; c: string | null; m: string; e: string } | null {
    const p = verifyToken<{ w: string; c: string | null; m: string; e: string }>(token, this.e.config.secretKey, 'unsub');
    return p?.w && p.m && p.e ? p : null;
  }

  async unsubscribeInfo(token: string): Promise<{ workspaceName: string; email: string; unsubscribed: boolean } | null> {
    const p = this.parseUnsubscribeToken(token);
    if (!p) return null;
    const ws = await this.e.db.selectFrom('workspaces').selectAll().where('id', '=', p.w).executeTakeFirst();
    if (!ws) return null;
    const supp = await this.e.suppressions.active(p.w, normalizeEmail(p.e) ?? p.e);
    const settings = (await this.e.workspaces.settings(p.w)).settings;
    return { workspaceName: settings.companyName || ws.name, email: p.e, unsubscribed: Boolean(supp) };
  }

  /** Honour an unsubscribe (link click or RFC 8058 one-click POST). Idempotent. */
  async unsubscribe(token: string, method: 'link' | 'one_click'): Promise<boolean> {
    const p = this.parseUnsubscribeToken(token);
    if (!p) return false;
    const ws = await this.e.db.selectFrom('workspaces').select('id').where('id', '=', p.w).executeTakeFirst();
    if (!ws) return false;
    const email = normalizeEmail(p.e) ?? p.e.toLowerCase();
    await this.e.suppressions.suppress(p.w, { email, reason: 'unsubscribed', source: `unsubscribe:${method}`, messageId: p.m });
    const contact = p.c ? await this.e.db.selectFrom('contacts').selectAll().where('id', '=', p.c).where('workspace_id', '=', p.w).executeTakeFirst() : undefined;
    if (contact) await this.e.contacts.withdrawConsent(p.w, contact, `unsubscribe_${method}`);
    const message = await this.e.db.selectFrom('messages').selectAll().where('id', '=', p.m).where('workspace_id', '=', p.w).executeTakeFirst();
    if (message) {
      await this.applyEvent(message, 'morrow', {
        providerEventId: `unsubscribe:${message.id}`,
        providerMessageId: message.provider_message_id ?? message.id,
        type: 'unsubscribed',
        occurredAt: this.e.nowIso(),
      });
    }
    // Withdraw anything not yet sent that this person would no longer want.
    if (contact) {
      await this.e.db
        .updateTable('messages')
        .set({ status: 'suppressed', error_code: 'unsubscribed', error_message: 'Recipient unsubscribed before sending', error_class: 'permanent', updated_at: this.e.nowIso() })
        .where('workspace_id', '=', p.w)
        .where('contact_id', '=', contact.id)
        .where('category', '!=', 'transactional')
        .where('status', 'in', ['queued', 'pending_approval'])
        .execute();
    }
    await this.e.audit.record(
      { workspaceId: p.w, role: 'owner', actor: { type: 'system', id: null, label: 'Recipient' } },
      'contact.unsubscribed',
      contact ? { type: 'contact', id: contact.id } : null,
      { method, messageId: p.m },
    );
    return true;
  }

  /** Undo from the unsubscribe page: the recipient re-grants consent themselves. */
  async resubscribe(token: string): Promise<boolean> {
    const p = this.parseUnsubscribeToken(token);
    if (!p) return false;
    const email = normalizeEmail(p.e) ?? p.e.toLowerCase();
    const supp = await this.e.suppressions.active(p.w, email);
    if (supp && supp.reason !== 'unsubscribed') return false; // bounces/complaints cannot be undone here
    if (supp) await this.e.db.updateTable('suppressions').set({ lifted_at: this.e.nowIso(), note: 'Recipient re-subscribed from the unsubscribe page' }).where('id', '=', supp.id).execute();
    const contact = p.c ? await this.e.db.selectFrom('contacts').selectAll().where('id', '=', p.c).where('workspace_id', '=', p.w).executeTakeFirst() : undefined;
    if (contact) await this.e.contacts.recordConsentChange(p.w, contact, 'granted', 'resubscribed_from_unsubscribe_page', { type: 'system', id: null, label: 'Recipient' });
    return true;
  }
}
