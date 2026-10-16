import {
  completedYears,
  ConflictError,
  contactCreateSchema,
  contactUpdateSchema,
  daysBetween,
  fullName,
  localDate,
  monthDayKey,
  newId,
  nextCelebration,
  NotFoundError,
  normalizeEmail,
  occasionKeysInWindow,
  parseLocalDate,
  PreconditionError,
  toCsv,
  toFieldIssues,
  ValidationError,
  type ConsentEventDTO,
  type ConsentStatus,
  type ContactCreate,
  type ContactCreateInput,
  type ContactDTO,
  type ContactUpdate,
  type CriteriaGroup,
  type NoteDTO,
  type Page,
  type RelationshipType,
  type SuppressionReason,
  type SuppressionScope,
  type TimelineItemDTO,
  type UpcomingOccasionDTO,
  type WorkspaceSettings,
} from '@morrow/core';
import { escapeLike, fromJson, isUniqueViolation, sql, toJson, type Database, type Db, type ExpressionBuilder, type Row } from '@morrow/db';
import { actorUserId, authorize, type Actor, type WorkspaceContext } from '../context';
import type { Engine } from '../engine';
import type { CustomValue } from './fields';

export interface ContactQuery {
  q?: string;
  status?: 'active' | 'archived' | 'all';
  relationshipType?: string;
  tag?: string;
  consent?: string;
  segmentId?: string;
  criteria?: CriteriaGroup;
  hasBirthday?: boolean;
  sort?: 'created_at' | 'name' | 'email' | 'last_interaction_at' | 'last_emailed_at' | 'company';
  dir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export interface WriteOptions {
  source?: 'ui' | 'api' | 'import' | 'automation' | 'system';
  /** Skip automation triggers (imports default to this unless asked otherwise). */
  silent?: boolean;
  /**
   * Run inside an existing transaction. Callers must also pass `settings`,
   * because nothing inside may touch the root connection while a transaction
   * holds it (SQLite has a single connection).
   */
  db?: Db;
  settings?: WorkspaceSettings;
}

const EVENT_NAME_RE = /^[a-zA-Z0-9_.:-]{1,100}$/;
const MAX_EVENT_BYTES = 8 * 1024;

function searchText(c: { first_name: string | null; last_name: string | null; email: string | null; company: string | null }): string {
  return [c.first_name, c.last_name, c.email, c.company].filter(Boolean).join(' ').toLowerCase().slice(0, 500);
}

function issues(err: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> }) {
  return toFieldIssues(err.issues);
}

export function contactName(c: Pick<Row<'contacts'>, 'first_name' | 'last_name' | 'email'>): string {
  return fullName({ firstName: c.first_name, lastName: c.last_name }) || c.email || 'Unnamed contact';
}

export class ContactsService {
  constructor(private readonly e: Engine) {}

  // ------------------------------------------------------------ mapping

  toDTO(
    r: Row<'contacts'>,
    tags: ContactDTO['tags'] = [],
    customFields: Record<string, CustomValue> = {},
    suppression: Row<'suppressions'> | null = null,
  ): ContactDTO {
    return {
      id: r.id,
      firstName: r.first_name,
      lastName: r.last_name,
      fullName: fullName({ firstName: r.first_name, lastName: r.last_name }),
      email: r.email,
      emailStatus: r.email_status,
      company: r.company,
      jobTitle: r.job_title,
      birthday: r.birthday_month && r.birthday_day ? { month: r.birthday_month, day: r.birthday_day, year: r.birth_year } : null,
      workAnniversary: r.work_anniversary,
      relationshipType: r.relationship_type as RelationshipType,
      interests: fromJson<string[]>(r.interests, []),
      preferences: fromJson(r.preferences, {}),
      language: r.language,
      timezone: r.timezone,
      source: r.source,
      consentStatus: r.consent_status as ConsentStatus,
      consentUpdatedAt: r.consent_updated_at,
      consentSource: r.consent_source,
      status: r.status as ContactDTO['status'],
      archivedAt: r.archived_at,
      lastInteractionAt: r.last_interaction_at,
      lastEmailedAt: r.last_emailed_at,
      tags,
      customFields,
      suppression: suppression
        ? { reason: suppression.reason as SuppressionReason, scope: suppression.scope as SuppressionScope, createdAt: suppression.created_at }
        : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async row(workspaceId: string, id: string, db: Db = this.e.db): Promise<Row<'contacts'>> {
    const r = await db.selectFrom('contacts').selectAll().where('id', '=', id).where('workspace_id', '=', workspaceId).executeTakeFirst();
    if (!r) throw new NotFoundError('Contact', id);
    return r;
  }

  async findByEmail(workspaceId: string, email: string, db: Db = this.e.db): Promise<Row<'contacts'> | undefined> {
    const { settings } = await this.e.workspaces.settings(workspaceId);
    const normalized = normalizeEmail(email, { gmailCanonical: settings.dedupe.gmailCanonical });
    if (!normalized) return undefined;
    return db.selectFrom('contacts').selectAll().where('workspace_id', '=', workspaceId).where('email_normalized', '=', normalized).executeTakeFirst();
  }

  private async hydrate(workspaceId: string, rows: Row<'contacts'>[], withFields = true): Promise<ContactDTO[]> {
    const ids = rows.map((r) => r.id);
    const [tags, fields, supp] = await Promise.all([
      this.e.tags.forContacts(workspaceId, ids),
      withFields ? this.e.fields.valuesFor(workspaceId, ids) : Promise.resolve(new Map<string, Record<string, CustomValue>>()),
      this.e.suppressions.activeMany(workspaceId, rows.map((r) => r.email_normalized ?? '').filter(Boolean)),
    ]);
    return rows.map((r) => this.toDTO(r, tags.get(r.id) ?? [], fields.get(r.id) ?? {}, (r.email_normalized && supp.get(r.email_normalized)) || null));
  }

  async get(ctx: WorkspaceContext, id: string): Promise<ContactDTO> {
    authorize(ctx, 'contacts:read');
    const [dto] = await this.hydrate(ctx.workspaceId, [await this.row(ctx.workspaceId, id)]);
    return dto!;
  }

  // ------------------------------------------------------------ queries

  async list(ctx: WorkspaceContext, query: ContactQuery = {}): Promise<Page<ContactDTO>> {
    authorize(ctx, 'contacts:read');
    const page = Math.max(1, Math.floor(query.page ?? 1));
    const pageSize = Math.min(200, Math.max(1, Math.floor(query.pageSize ?? 50)));
    const where = await this.filters(ctx.workspaceId, query);
    const base = this.e.db.selectFrom('contacts').where('contacts.workspace_id', '=', ctx.workspaceId).where(where);
    const total = Number((await base.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst())?.n ?? 0);
    const dir = query.dir === 'asc' ? 'asc' : 'desc';
    let q = base.selectAll('contacts');
    switch (query.sort) {
      case 'name':
        q = q.orderBy(sql`lower(coalesce(contacts.first_name, contacts.last_name, contacts.email, ''))`, dir);
        break;
      case 'email':
        q = q.orderBy('contacts.email_normalized', dir);
        break;
      case 'company':
        q = q.orderBy(sql`lower(coalesce(contacts.company, ''))`, dir);
        break;
      case 'last_interaction_at':
        q = q.orderBy('contacts.last_interaction_at', dir);
        break;
      case 'last_emailed_at':
        q = q.orderBy('contacts.last_emailed_at', dir);
        break;
      default:
        q = q.orderBy('contacts.created_at', dir);
    }
    const rows = await q.orderBy('contacts.id', dir).limit(pageSize).offset((page - 1) * pageSize).execute();
    return { items: await this.hydrate(ctx.workspaceId, rows, false), total, page, pageSize };
  }

  /** Build the WHERE expression for a contact query (shared by list and export). */
  private async filters(workspaceId: string, query: ContactQuery) {
    let criteria: CriteriaGroup | null = query.criteria ?? null;
    if (query.segmentId) {
      const seg = await this.e.db.selectFrom('segments').select('criteria').where('id', '=', query.segmentId).where('workspace_id', '=', workspaceId).executeTakeFirst();
      if (!seg) throw new NotFoundError('Segment', query.segmentId);
      criteria = fromJson<CriteriaGroup>(seg.criteria, { kind: 'group', match: 'all', rules: [] });
    }
    const segmentWhere = criteria ? await this.e.segments.compile(workspaceId, criteria) : null;
    return (eb: ExpressionBuilder<Database, 'contacts'>) => {
      const parts = [];
      const status = query.status ?? 'active';
      if (status !== 'all') parts.push(eb('contacts.status', '=', status));
      if (query.relationshipType) parts.push(eb('contacts.relationship_type', '=', query.relationshipType));
      if (query.consent) parts.push(eb('contacts.consent_status', '=', query.consent));
      if (query.hasBirthday) parts.push(eb('contacts.birthday_md', 'is not', null));
      if (query.q?.trim()) {
        parts.push(sql<boolean>`contacts.search_text like ${`%${escapeLike(query.q.trim().toLowerCase())}%`} escape '\\'`);
      }
      if (query.tag) {
        parts.push(
          eb.exists(
            eb
              .selectFrom('contact_tags')
              .innerJoin('tags', 'tags.id', 'contact_tags.tag_id')
              .select(sql`1`.as('one'))
              .whereRef('contact_tags.contact_id', '=', 'contacts.id')
              .where('tags.name_normalized', '=', query.tag.trim().toLowerCase()),
          ),
        );
      }
      if (segmentWhere) parts.push(segmentWhere(eb));
      return parts.length ? eb.and(parts) : sql<boolean>`1 = 1`;
    };
  }

  // ------------------------------------------------------------ writes

  private async assertConsentChangeAllowed(workspaceId: string, emailNormalized: string | null, to: ConsentStatus, db: Db): Promise<Row<'suppressions'> | undefined> {
    if (!emailNormalized || (to !== 'granted' && to !== 'implied')) return undefined;
    const supp = await this.e.suppressions.active(workspaceId, emailNormalized, db);
    if (supp?.reason === 'complaint') {
      throw new PreconditionError('This address reported an e-mail as spam. Consent cannot be re-granted on their behalf.');
    }
    return supp?.reason === 'unsubscribed' ? supp : undefined;
  }

  private rowFromCreate(workspaceId: string, input: ContactCreate, emailNormalized: string | null, now: string, source: string): Row<'contacts'> {
    const anniversary = input.workAnniversary ? parseLocalDate(input.workAnniversary) : null;
    const row: Row<'contacts'> = {
      id: newId('con'),
      workspace_id: workspaceId,
      first_name: input.firstName ?? null,
      last_name: input.lastName ?? null,
      email: input.email ? input.email.trim() : null,
      email_normalized: emailNormalized,
      email_status: emailNormalized ? 'valid' : 'unknown',
      company: input.company ?? null,
      job_title: input.jobTitle ?? null,
      birthday_month: input.birthday?.month ?? null,
      birthday_day: input.birthday?.day ?? null,
      birth_year: input.birthday?.year ?? null,
      birthday_md: input.birthday ? monthDayKey(input.birthday) : null,
      work_anniversary: input.workAnniversary ?? null,
      anniversary_md: anniversary ? monthDayKey(anniversary) : null,
      relationship_type: input.relationshipType,
      interests: toJson(input.interests),
      preferences: toJson(input.preferences),
      language: input.language ?? null,
      timezone: input.timezone ?? null,
      source: input.source ?? source,
      consent_status: input.consentStatus,
      consent_updated_at: input.consentStatus !== 'unknown' ? now : null,
      consent_source: input.consentStatus !== 'unknown' ? (input.consentSource ?? null) : null,
      status: 'active',
      archived_at: null,
      last_interaction_at: input.lastInteractionAt ? new Date(input.lastInteractionAt).toISOString() : null,
      last_emailed_at: null,
      search_text: '',
      created_at: now,
      updated_at: now,
    };
    row.search_text = searchText(row);
    return row;
  }

  async create(ctx: WorkspaceContext, raw: ContactCreateInput, options: WriteOptions = {}): Promise<ContactDTO> {
    authorize(ctx, 'contacts:write');
    const parsed = contactCreateSchema.safeParse(raw);
    if (!parsed.success) throw new ValidationError('Please check the contact details.', issues(parsed.error));
    const input = parsed.data;
    if ((input.consentStatus === 'granted' || input.consentStatus === 'implied') && !input.consentSource && options.source !== 'system') {
      throw new ValidationError('Record where consent came from (for example "signup form" or "signed contract").', [
        { path: 'consentSource', message: 'Required when consent is granted or implied.' },
      ]);
    }
    const settings = options.settings ?? (await this.e.workspaces.settings(ctx.workspaceId)).settings;
    const emailNormalized = input.email ? normalizeEmail(input.email, { gmailCanonical: settings.dedupe.gmailCanonical }) : null;
    const now = this.e.nowIso();
    const row = this.rowFromCreate(ctx.workspaceId, input, emailNormalized, now, options.source ?? 'manual');

    const run = async (db: Db) => {
      if (emailNormalized) {
        const dup = await db.selectFrom('contacts').select('id').where('workspace_id', '=', ctx.workspaceId).where('email_normalized', '=', emailNormalized).executeTakeFirst();
        if (dup) throw new ConflictError('A contact with this e-mail address already exists.', { contactId: dup.id });
        if (await this.assertConsentChangeAllowed(ctx.workspaceId, emailNormalized, input.consentStatus, db)) {
          throw new PreconditionError('This address previously unsubscribed. Consent can only be re-granted by the person themselves (for example by re-subscribing).');
        }
      }
      try {
        await db.insertInto('contacts').values(row).execute();
      } catch (err) {
        if (isUniqueViolation(err)) throw new ConflictError('A contact with this e-mail address already exists.');
        throw err;
      }
      const addedTags = input.tags.length ? await this.e.tags.attach(ctx.workspaceId, row.id, input.tags, db) : [];
      if (Object.keys(input.customFields).length) await this.e.fields.setValues(ctx.workspaceId, row.id, input.customFields, db);
      if (input.note) {
        await db.insertInto('contact_notes').values({ id: newId('not'), workspace_id: ctx.workspaceId, contact_id: row.id, author_id: actorUserId(ctx), body: input.note, created_at: now }).execute();
      }
      if (input.consentStatus !== 'unknown') {
        await this.insertConsentEvent(db, ctx.workspaceId, row.id, null, input.consentStatus, input.consentSource ?? `${options.source ?? 'manual'}`, ctx.actor, ctx.ip ?? null);
      }
      if (!options.silent) {
        await this.e.triggers.contactChanged(ctx.workspaceId, { contactId: row.id, change: 'created' }, db);
        if (input.consentStatus !== 'unknown') await this.e.triggers.contactChanged(ctx.workspaceId, { contactId: row.id, change: 'consent', consentTo: input.consentStatus }, db);
        for (const tag of addedTags) await this.e.triggers.contactChanged(ctx.workspaceId, { contactId: row.id, change: 'tag_added', tag }, db);
      }
    };
    if (options.db) await run(options.db);
    else await this.e.db.transaction().execute(run);
    if (options.source !== 'import') await this.e.audit.record(ctx, 'contact.created', { type: 'contact', id: row.id }, { source: options.source ?? 'ui' }, options.db);
    return options.db ? this.toDTO(row) : this.get(ctx, row.id);
  }

  async update(ctx: WorkspaceContext, id: string, raw: unknown, options: WriteOptions = {}): Promise<ContactDTO> {
    authorize(ctx, 'contacts:write');
    const parsed = contactUpdateSchema.safeParse(raw);
    if (!parsed.success) throw new ValidationError('Please check the contact details.', issues(parsed.error));
    const input: ContactUpdate = parsed.data;
    const settings = options.settings ?? (await this.e.workspaces.settings(ctx.workspaceId)).settings;
    const now = this.e.nowIso();
    const changed: string[] = [];

    const run = async (db: Db) => {
      const current = await this.row(ctx.workspaceId, id, db);
      const patch: Partial<Row<'contacts'>> = {};
      const set = <K extends keyof Row<'contacts'>>(key: K, value: Row<'contacts'>[K], field: string) => {
        if (current[key] !== value) {
          patch[key] = value;
          changed.push(field);
        }
      };
      if (input.firstName !== undefined) set('first_name', input.firstName ?? null, 'first_name');
      if (input.lastName !== undefined) set('last_name', input.lastName ?? null, 'last_name');
      if (input.company !== undefined) set('company', input.company ?? null, 'company');
      if (input.jobTitle !== undefined) set('job_title', input.jobTitle ?? null, 'job_title');
      if (input.relationshipType !== undefined) set('relationship_type', input.relationshipType, 'relationship_type');
      if (input.language !== undefined) set('language', input.language ?? null, 'language');
      if (input.timezone !== undefined) set('timezone', input.timezone ?? null, 'timezone');
      if (input.source !== undefined) set('source', input.source ?? null, 'source');
      if (input.interests !== undefined) set('interests', toJson(input.interests), 'interests');
      if (input.preferences !== undefined) set('preferences', toJson(input.preferences), 'preferences');
      if (input.lastInteractionAt !== undefined) set('last_interaction_at', input.lastInteractionAt ? new Date(input.lastInteractionAt).toISOString() : null, 'last_interaction_at');
      if (input.email !== undefined) {
        const email = input.email ? input.email.trim() : null;
        const normalized = email ? normalizeEmail(email, { gmailCanonical: settings.dedupe.gmailCanonical }) : null;
        if (normalized && normalized !== current.email_normalized) {
          const dup = await db.selectFrom('contacts').select('id').where('workspace_id', '=', ctx.workspaceId).where('email_normalized', '=', normalized).where('id', '!=', id).executeTakeFirst();
          if (dup) throw new ConflictError('Another contact already uses this e-mail address.', { contactId: dup.id });
        }
        set('email', email, 'email');
        set('email_normalized', normalized, 'email');
        if (patch.email_normalized !== undefined) patch.email_status = normalized ? 'valid' : 'unknown';
      }
      if (input.birthday !== undefined) {
        const b = input.birthday;
        set('birthday_month', b?.month ?? null, 'birthday');
        set('birthday_day', b?.day ?? null, 'birthday');
        set('birth_year', b?.year ?? null, 'birthday');
        set('birthday_md', b ? monthDayKey(b) : null, 'birthday');
      }
      if (input.workAnniversary !== undefined) {
        const a = input.workAnniversary ? parseLocalDate(input.workAnniversary) : null;
        set('work_anniversary', input.workAnniversary ?? null, 'work_anniversary');
        set('anniversary_md', a ? monthDayKey(a) : null, 'work_anniversary');
      }
      if (Object.keys(patch).length) {
        const merged = { ...current, ...patch };
        patch.search_text = searchText(merged);
        patch.updated_at = now;
        try {
          await db.updateTable('contacts').set(patch).where('id', '=', id).where('workspace_id', '=', ctx.workspaceId).execute();
        } catch (err) {
          if (isUniqueViolation(err)) throw new ConflictError('Another contact already uses this e-mail address.');
          throw err;
        }
      }
      let addedTags: string[] = [];
      if (input.tags !== undefined) {
        const currentTags = (await this.e.tags.forContacts(ctx.workspaceId, [id], db)).get(id) ?? [];
        const wanted = new Set(input.tags.map((t) => t.toLowerCase()));
        const toRemove = currentTags.filter((t) => !wanted.has(t.name.toLowerCase())).map((t) => t.name);
        if (toRemove.length) {
          await this.e.tags.detach(ctx.workspaceId, id, toRemove, db);
          changed.push('tags');
        }
        addedTags = await this.e.tags.attach(ctx.workspaceId, id, input.tags, db);
        if (addedTags.length) changed.push('tags');
      }
      if (input.customFields !== undefined) {
        const keys = await this.e.fields.setValues(ctx.workspaceId, id, input.customFields, db);
        changed.push(...keys.map((k) => `custom.${k}`));
      }
      if (input.consentStatus !== undefined && input.consentStatus !== current.consent_status) {
        await this.applyConsent(ctx, current, input.consentStatus, input.consentSource ?? null, null, db);
        changed.push('consent_status');
      }
      if (changed.length && !options.silent) {
        await db.updateTable('contacts').set({ updated_at: now }).where('id', '=', id).execute();
        await this.e.triggers.contactChanged(ctx.workspaceId, { contactId: id, change: 'updated', fields: [...new Set(changed)] }, db);
        for (const tag of addedTags) await this.e.triggers.contactChanged(ctx.workspaceId, { contactId: id, change: 'tag_added', tag }, db);
      }
    };
    if (options.db) await run(options.db);
    else await this.e.db.transaction().execute(run);
    if (changed.length && options.source !== 'import') {
      await this.e.audit.record(ctx, 'contact.updated', { type: 'contact', id }, { fields: [...new Set(changed)] }, options.db);
    }
    return options.db ? this.toDTO(await this.row(ctx.workspaceId, id, options.db)) : this.get(ctx, id);
  }

  // ------------------------------------------------------------ consent

  private async insertConsentEvent(db: Db, workspaceId: string, contactId: string, from: string | null, to: string, source: string, actor: Actor, ip: string | null, note?: string | null) {
    await db
      .insertInto('consent_events')
      .values({
        id: newId('cns'),
        workspace_id: workspaceId,
        contact_id: contactId,
        from_status: from,
        to_status: to,
        source: source.slice(0, 200),
        actor_type: actor.type,
        actor_id: actor.id,
        ip,
        note: note?.slice(0, 1000) ?? null,
        created_at: this.e.nowIso(),
      })
      .execute();
  }

  /** Record a consent change with history, without permission checks (internal use). */
  async recordConsentChange(workspaceId: string, contact: Row<'contacts'>, to: ConsentStatus, source: string, actor: Actor, db: Db = this.e.db, note?: string | null): Promise<void> {
    if (contact.consent_status === to) return;
    const now = this.e.nowIso();
    await db
      .updateTable('contacts')
      .set({ consent_status: to, consent_updated_at: now, consent_source: source.slice(0, 200), updated_at: now })
      .where('id', '=', contact.id)
      .execute();
    await this.insertConsentEvent(db, workspaceId, contact.id, contact.consent_status, to, source, actor, null, note);
    await this.e.triggers.contactChanged(workspaceId, { contactId: contact.id, change: 'consent', consentTo: to }, db);
  }

  /** Used when a recipient unsubscribes or complains. */
  async withdrawConsent(workspaceId: string, contact: Row<'contacts'>, source: string): Promise<void> {
    await this.recordConsentChange(workspaceId, contact, 'withdrawn', source, { type: 'system', id: null, label: 'Recipient' });
  }

  private async applyConsent(ctx: WorkspaceContext, contact: Row<'contacts'>, to: ConsentStatus, source: string | null, note: string | null, db: Db) {
    if ((to === 'granted' || to === 'implied') && (!source || source.trim().length < 3)) {
      throw new ValidationError('Record where consent came from.', [{ path: 'consentSource', message: 'Required when consent is granted or implied.' }]);
    }
    const unsub = await this.assertConsentChangeAllowed(ctx.workspaceId, contact.email_normalized, to, db);
    if (unsub) {
      // Re-granting after an unsubscribe is allowed only with evidence and the right to manage suppressions.
      authorize(ctx, 'suppressions:manage');
      await db
        .updateTable('suppressions')
        .set({ lifted_at: this.e.nowIso(), lifted_by: actorUserId(ctx), note: `Re-consent recorded: ${source}`.slice(0, 500) })
        .where('id', '=', unsub.id)
        .execute();
    }
    if (to === 'withdrawn' && contact.email_normalized) {
      await this.e.suppressions.suppress(ctx.workspaceId, { email: contact.email_normalized, reason: 'unsubscribed', source: `manual:${ctx.actor.label}`, createdBy: actorUserId(ctx) }, db);
    }
    await this.recordConsentChange(ctx.workspaceId, contact, to, source ?? `manual:${ctx.actor.label}`, ctx.actor, db, note);
  }

  async setConsent(ctx: WorkspaceContext, id: string, input: { status: ConsentStatus; source?: string | null; note?: string | null }): Promise<ContactDTO> {
    authorize(ctx, 'contacts:write');
    await this.e.db.transaction().execute(async (trx) => {
      const contact = await this.row(ctx.workspaceId, id, trx);
      await this.applyConsent(ctx, contact, input.status, input.source ?? null, input.note ?? null, trx);
    });
    await this.e.audit.record(ctx, 'contact.consent_changed', { type: 'contact', id }, { to: input.status, source: input.source ?? null });
    return this.get(ctx, id);
  }

  async consentHistory(ctx: WorkspaceContext, id: string): Promise<ConsentEventDTO[]> {
    authorize(ctx, 'contacts:read');
    await this.row(ctx.workspaceId, id);
    const rows = await this.e.db
      .selectFrom('consent_events')
      .selectAll()
      .where('contact_id', '=', id)
      .where('workspace_id', '=', ctx.workspaceId)
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      fromStatus: r.from_status as ConsentStatus | null,
      toStatus: r.to_status as ConsentStatus,
      source: r.source,
      actorType: r.actor_type,
      note: r.note,
      createdAt: r.created_at,
    }));
  }

  // ------------------------------------------------------------ lifecycle

  async archive(ctx: WorkspaceContext, id: string): Promise<ContactDTO> {
    authorize(ctx, 'contacts:write');
    await this.row(ctx.workspaceId, id);
    await this.e.db.updateTable('contacts').set({ status: 'archived', archived_at: this.e.nowIso(), updated_at: this.e.nowIso() }).where('id', '=', id).execute();
    await this.e.audit.record(ctx, 'contact.archived', { type: 'contact', id });
    return this.get(ctx, id);
  }

  async restore(ctx: WorkspaceContext, id: string): Promise<ContactDTO> {
    authorize(ctx, 'contacts:write');
    await this.row(ctx.workspaceId, id);
    await this.e.db.updateTable('contacts').set({ status: 'active', archived_at: null, updated_at: this.e.nowIso() }).where('id', '=', id).execute();
    await this.e.audit.record(ctx, 'contact.restored', { type: 'contact', id });
    return this.get(ctx, id);
  }

  async bulk(ctx: WorkspaceContext, input: { ids: string[]; action: 'archive' | 'restore' | 'add_tag' | 'remove_tag'; tag?: string }): Promise<{ affected: number }> {
    authorize(ctx, 'contacts:write');
    const ids = [...new Set(input.ids)].slice(0, 1000);
    if (!ids.length) return { affected: 0 };
    const owned = (await this.e.db.selectFrom('contacts').select('id').where('workspace_id', '=', ctx.workspaceId).where('id', 'in', ids).execute()).map((r) => r.id);
    let affected = 0;
    const now = this.e.nowIso();
    if (input.action === 'archive' || input.action === 'restore') {
      const res = await this.e.db
        .updateTable('contacts')
        .set(input.action === 'archive' ? { status: 'archived', archived_at: now, updated_at: now } : { status: 'active', archived_at: null, updated_at: now })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', 'in', owned)
        .executeTakeFirst();
      affected = Number(res.numUpdatedRows ?? 0);
    } else {
      if (!input.tag) throw new ValidationError('Choose a tag.', [{ path: 'tag', message: 'Required.' }]);
      for (const id of owned) {
        if (input.action === 'add_tag') {
          const added = await this.e.tags.attach(ctx.workspaceId, id, [input.tag]);
          if (added.length) {
            affected++;
            await this.e.triggers.contactChanged(ctx.workspaceId, { contactId: id, change: 'tag_added', tag: added[0]! });
          }
        } else if ((await this.e.tags.detach(ctx.workspaceId, id, [input.tag])).length) {
          affected++;
        }
      }
    }
    await this.e.audit.record(ctx, `contacts.bulk_${input.action}`, null, { count: affected, tag: input.tag ?? null });
    return { affected };
  }

  /**
   * Permanently erase a contact (data-subject erasure). Message history is
   * anonymised; the suppression entry is kept so the person is never e-mailed again.
   */
  async erase(ctx: WorkspaceContext, id: string): Promise<void> {
    authorize(ctx, 'contacts:erase');
    const contact = await this.row(ctx.workspaceId, id);
    await this.e.db.transaction().execute(async (trx) => {
      const messageIds = (await trx.selectFrom('messages').select('id').where('workspace_id', '=', ctx.workspaceId).where('contact_id', '=', id).execute()).map((m) => m.id);
      await trx
        .updateTable('messages')
        .set({ to_email: 'erased@erased.invalid', subject: '[erased]', html: null, text: null, headers: '{}', updated_at: this.e.nowIso() })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('contact_id', '=', id)
        .execute();
      if (messageIds.length) await trx.updateTable('message_events').set({ data: '{}' }).where('message_id', 'in', messageIds).execute();
      if (contact.email_normalized) {
        await this.e.suppressions.suppress(ctx.workspaceId, { email: contact.email_normalized, reason: 'manual', source: 'erasure', note: 'Contact erased; kept to prevent future e-mail.' }, trx);
      }
      await trx.deleteFrom('contacts').where('id', '=', id).where('workspace_id', '=', ctx.workspaceId).execute();
    });
    await this.e.audit.record(ctx, 'contact.erased', { type: 'contact', id });
  }

  // ------------------------------------------------------------ notes & timeline

  async notes(ctx: WorkspaceContext, id: string): Promise<NoteDTO[]> {
    authorize(ctx, 'contacts:read');
    await this.row(ctx.workspaceId, id);
    const rows = await this.e.db
      .selectFrom('contact_notes')
      .leftJoin('users', 'users.id', 'contact_notes.author_id')
      .select(['contact_notes.id', 'contact_notes.body', 'contact_notes.created_at', 'users.name'])
      .where('contact_notes.contact_id', '=', id)
      .where('contact_notes.workspace_id', '=', ctx.workspaceId)
      .orderBy('contact_notes.created_at', 'desc')
      .execute();
    return rows.map((r) => ({ id: r.id, body: r.body, authorName: r.name ?? null, createdAt: r.created_at }));
  }

  async addNote(ctx: WorkspaceContext, id: string, body: string): Promise<NoteDTO> {
    authorize(ctx, 'contacts:write');
    await this.row(ctx.workspaceId, id);
    const text = (body ?? '').trim();
    if (!text) throw new ValidationError('A note cannot be empty.', [{ path: 'body', message: 'Required.' }]);
    const note = { id: newId('not'), workspace_id: ctx.workspaceId, contact_id: id, author_id: actorUserId(ctx), body: text.slice(0, 5000), created_at: this.e.nowIso() };
    await this.e.db.insertInto('contact_notes').values(note).execute();
    return { id: note.id, body: note.body, authorName: ctx.actor.label, createdAt: note.created_at };
  }

  async deleteNote(ctx: WorkspaceContext, contactId: string, noteId: string): Promise<void> {
    authorize(ctx, 'contacts:write');
    await this.e.db.deleteFrom('contact_notes').where('id', '=', noteId).where('contact_id', '=', contactId).where('workspace_id', '=', ctx.workspaceId).execute();
  }

  async timeline(ctx: WorkspaceContext, id: string, limit = 100): Promise<TimelineItemDTO[]> {
    authorize(ctx, 'contacts:read');
    const contact = await this.row(ctx.workspaceId, id);
    const ws = ctx.workspaceId;
    const [messages, events, notes, consent, tasks, runs] = await Promise.all([
      this.e.db.selectFrom('messages').select(['id', 'subject', 'status', 'kind', 'created_at']).where('workspace_id', '=', ws).where('contact_id', '=', id).orderBy('created_at', 'desc').limit(limit).execute(),
      this.e.db.selectFrom('contact_events').select(['id', 'name', 'properties', 'occurred_at']).where('workspace_id', '=', ws).where('contact_id', '=', id).orderBy('occurred_at', 'desc').limit(limit).execute(),
      this.e.db.selectFrom('contact_notes').select(['id', 'body', 'created_at']).where('workspace_id', '=', ws).where('contact_id', '=', id).orderBy('created_at', 'desc').limit(limit).execute(),
      this.e.db.selectFrom('consent_events').select(['id', 'from_status', 'to_status', 'source', 'created_at']).where('workspace_id', '=', ws).where('contact_id', '=', id).orderBy('created_at', 'desc').limit(limit).execute(),
      this.e.db.selectFrom('tasks').select(['id', 'title', 'status', 'created_at']).where('workspace_id', '=', ws).where('contact_id', '=', id).orderBy('created_at', 'desc').limit(limit).execute(),
      this.e.db
        .selectFrom('automation_runs')
        .innerJoin('automations', 'automations.id', 'automation_runs.automation_id')
        .select(['automation_runs.id', 'automation_runs.status', 'automation_runs.started_at', 'automations.name', 'automations.id as automation_id'])
        .where('automation_runs.workspace_id', '=', ws)
        .where('automation_runs.contact_id', '=', id)
        .orderBy('automation_runs.started_at', 'desc')
        .limit(limit)
        .execute(),
    ]);
    const items: TimelineItemDTO[] = [
      ...messages.map((m) => ({ id: m.id, type: 'message' as const, at: m.created_at, title: m.subject, status: m.status, detail: m.kind, link: `/messages/${m.id}` })),
      ...events.map((ev) => ({ id: ev.id, type: 'event' as const, at: ev.occurred_at, title: ev.name, detail: ev.properties === '{}' ? null : ev.properties.slice(0, 300) })),
      ...notes.map((n) => ({ id: n.id, type: 'note' as const, at: n.created_at, title: 'Note', detail: n.body.slice(0, 500) })),
      ...consent.map((c) => ({ id: c.id, type: 'consent' as const, at: c.created_at, title: `Consent ${c.from_status ?? 'unset'} → ${c.to_status}`, detail: c.source })),
      ...tasks.map((t) => ({ id: t.id, type: 'task' as const, at: t.created_at, title: t.title, status: t.status, link: '/tasks' })),
      ...runs.map((r) => ({ id: r.id, type: 'automation' as const, at: r.started_at, title: r.name, status: r.status, link: `/automations/${r.automation_id}` })),
      { id: `${contact.id}:created`, type: 'created', at: contact.created_at, title: 'Contact created', detail: contact.source },
    ];
    return items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit);
  }

  // ------------------------------------------------------------ events (integrations)

  /**
   * Record a custom event for a contact (e.g. `project.completed` sent from
   * another product). Events can trigger automations and appear in the timeline.
   */
  async recordEvent(
    ctx: WorkspaceContext,
    input: {
      contactId?: string;
      email?: string;
      name: string;
      properties?: Record<string, unknown>;
      occurredAt?: string;
      dedupeKey?: string;
      contact?: ContactCreateInput;
      interaction?: boolean;
    },
  ): Promise<{ eventId: string; contactId: string; duplicate: boolean; contactCreated: boolean }> {
    authorize(ctx, 'contacts:write');
    if (!EVENT_NAME_RE.test(input.name ?? '')) {
      throw new ValidationError('Event names use letters, numbers and . _ : - (max 100).', [{ path: 'name', message: 'Invalid event name.' }]);
    }
    const props = input.properties ?? {};
    if (typeof props !== 'object' || Array.isArray(props)) throw new ValidationError('Event properties must be an object.');
    const clean: Record<string, string | number | boolean | null> = {};
    for (const [k, v] of Object.entries(props).slice(0, 50)) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(k)) throw new ValidationError(`Invalid property name "${k}".`, [{ path: `properties.${k}`, message: 'Use letters, numbers and underscores.' }]);
      if (v === null || typeof v === 'number' || typeof v === 'boolean') clean[k] = v;
      else if (typeof v === 'string') clean[k] = v.slice(0, 1000);
      else throw new ValidationError(`Property "${k}" must be a string, number, boolean or null.`, [{ path: `properties.${k}`, message: 'Unsupported value.' }]);
    }
    const json = toJson(clean);
    if (json.length > MAX_EVENT_BYTES) throw new ValidationError('Event properties are too large (8 KB max).');
    const occurredAt = input.occurredAt ? new Date(input.occurredAt) : this.e.now();
    if (Number.isNaN(occurredAt.getTime())) throw new ValidationError('Invalid occurredAt.', [{ path: 'occurredAt', message: 'Use an ISO timestamp.' }]);

    let contactCreated = false;
    let contact: Row<'contacts'> | undefined;
    if (input.contactId) contact = await this.row(ctx.workspaceId, input.contactId);
    else if (input.email) contact = await this.findByEmail(ctx.workspaceId, input.email);
    else throw new ValidationError('Provide contactId or email.', [{ path: 'email', message: 'Required.' }]);
    if (!contact) {
      if (!input.contact && !input.email) throw new NotFoundError('Contact');
      if (!input.contact) throw new NotFoundError('Contact with that e-mail');
      const created = await this.create(ctx, { ...input.contact, email: input.email }, { source: 'api' });
      contact = await this.row(ctx.workspaceId, created.id);
      contactCreated = true;
    }
    const id = newId('cev');
    const inserted = await this.e.db
      .insertInto('contact_events')
      .values({
        id,
        workspace_id: ctx.workspaceId,
        contact_id: contact.id,
        name: input.name,
        properties: json,
        source: ctx.actor.type === 'api_key' ? `api:${ctx.actor.label}` : ctx.actor.label,
        dedupe_key: input.dedupeKey ? input.dedupeKey.slice(0, 200) : null,
        occurred_at: occurredAt.toISOString(),
        created_at: this.e.nowIso(),
      })
      .onConflict((oc) => oc.doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!inserted) {
      const existing = await this.e.db
        .selectFrom('contact_events')
        .select('id')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('dedupe_key', '=', input.dedupeKey ?? '')
        .executeTakeFirst();
      return { eventId: existing?.id ?? id, contactId: contact.id, duplicate: true, contactCreated };
    }
    if (input.interaction !== false && (!contact.last_interaction_at || contact.last_interaction_at < occurredAt.toISOString())) {
      await this.e.db.updateTable('contacts').set({ last_interaction_at: occurredAt.toISOString() }).where('id', '=', contact.id).execute();
    }
    await this.e.triggers.contactChanged(ctx.workspaceId, { contactId: contact.id, change: 'event', eventId: id, eventName: input.name });
    return { eventId: id, contactId: contact.id, duplicate: false, contactCreated };
  }

  // ------------------------------------------------------------ occasions

  async upcomingOccasions(ctx: WorkspaceContext, options: { days?: number; kinds?: Array<'birthday' | 'work_anniversary'>; limit?: number } = {}): Promise<UpcomingOccasionDTO[]> {
    authorize(ctx, 'contacts:read');
    const days = Math.min(366, Math.max(1, options.days ?? 30));
    const kinds = options.kinds ?? ['birthday', 'work_anniversary'];
    const ws = await this.e.workspaces.row(ctx.workspaceId);
    const today = localDate(this.e.now(), ws.timezone);
    const keys = occasionKeysInWindow(today, days, 'feb28');
    const out: UpcomingOccasionDTO[] = [];
    if (keys.length === 0) return out;
    const name = (r: Row<'contacts'>) => contactName(r);
    if (kinds.includes('birthday')) {
      const rows = await this.e.db
        .selectFrom('contacts')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('status', '=', 'active')
        .where('birthday_md', 'in', keys)
        .limit(5000)
        .execute();
      for (const r of rows) {
        const next = nextCelebration({ month: r.birthday_month!, day: r.birthday_day! }, today, 'feb28');
        if (!next) continue;
        const daysAway = daysBetween(today, next);
        if (daysAway >= days) continue;
        out.push({ contactId: r.id, name: name(r), email: r.email, kind: 'birthday', date: next, daysAway, years: null, relationshipType: r.relationship_type as RelationshipType });
      }
    }
    if (kinds.includes('work_anniversary')) {
      const rows = await this.e.db
        .selectFrom('contacts')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('status', '=', 'active')
        .where('anniversary_md', 'in', keys)
        .limit(5000)
        .execute();
      for (const r of rows) {
        const start = parseLocalDate(r.work_anniversary ?? '');
        if (!start) continue;
        const next = nextCelebration({ month: start.month, day: start.day }, today, 'feb28');
        if (!next) continue;
        const daysAway = daysBetween(today, next);
        const years = completedYears(r.work_anniversary!, next);
        if (daysAway >= days || years < 1) continue;
        out.push({ contactId: r.id, name: name(r), email: r.email, kind: 'work_anniversary', date: next, daysAway, years, relationshipType: r.relationship_type as RelationshipType });
      }
    }
    return out.sort((a, b) => a.daysAway - b.daysAway || a.name.localeCompare(b.name)).slice(0, options.limit ?? 500);
  }

  // ------------------------------------------------------------ export

  /** Stream contacts as CSV chunks (formula-injection safe). Audited. */
  async *exportCsv(ctx: WorkspaceContext, query: ContactQuery = {}): AsyncGenerator<string> {
    authorize(ctx, 'contacts:export');
    const defs = await this.e.fields.definitions(ctx.workspaceId);
    const header = [
      'id', 'first_name', 'last_name', 'email', 'company', 'job_title', 'birthday', 'work_anniversary', 'relationship_type', 'tags',
      'language', 'timezone', 'source', 'consent_status', 'consent_source', 'consent_updated_at', 'status', 'last_interaction_at',
      'last_emailed_at', 'created_at', ...defs.map((d) => `custom:${d.key}`),
    ];
    yield toCsv([header]);
    const where = await this.filters(ctx.workspaceId, { ...query, status: query.status ?? 'all' });
    let after = '';
    let count = 0;
    for (;;) {
      const rows = await this.e.db
        .selectFrom('contacts')
        .selectAll()
        .where('contacts.workspace_id', '=', ctx.workspaceId)
        .where(where)
        .where('contacts.id', '>', after)
        .orderBy('contacts.id', 'asc')
        .limit(500)
        .execute();
      if (!rows.length) break;
      const ids = rows.map((r) => r.id);
      const [tags, fields] = await Promise.all([this.e.tags.forContacts(ctx.workspaceId, ids), this.e.fields.valuesFor(ctx.workspaceId, ids)]);
      yield toCsv(
        rows.map((r) => {
          const birthday = r.birthday_month
            ? r.birth_year
              ? `${r.birth_year}-${String(r.birthday_month).padStart(2, '0')}-${String(r.birthday_day).padStart(2, '0')}`
              : `--${String(r.birthday_month).padStart(2, '0')}-${String(r.birthday_day).padStart(2, '0')}`
            : '';
          const cf = fields.get(r.id) ?? {};
          return [
            r.id, r.first_name, r.last_name, r.email, r.company, r.job_title, birthday, r.work_anniversary, r.relationship_type,
            (tags.get(r.id) ?? []).map((t) => t.name).join('; '), r.language, r.timezone, r.source, r.consent_status, r.consent_source,
            r.consent_updated_at, r.status, r.last_interaction_at, r.last_emailed_at, r.created_at,
            ...defs.map((d) => (cf[d.key] === undefined || cf[d.key] === null ? '' : String(cf[d.key]))),
          ];
        }),
      );
      count += rows.length;
      after = rows[rows.length - 1]!.id;
    }
    await this.e.audit.record(ctx, 'contacts.exported', null, { count, filters: Object.keys(query) });
  }
}
