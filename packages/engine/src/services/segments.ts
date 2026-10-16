import {
  addDays,
  checkCriteria,
  criteriaGroupSchema,
  describeCriteria,
  emptyCriteria,
  fullName,
  localDate,
  newId,
  NotFoundError,
  occasionKeysInWindow,
  PreconditionError,
  referencedSegments,
  startOfLocalDay,
  toFieldIssues,
  ValidationError,
  type ConsentStatus,
  type CriteriaGroup,
  type RelationshipType,
  type Rule,
  type SegmentDTO,
  type SegmentPreviewDTO,
} from '@morrow/core';
import { escapeLike, fromJson, sql, toJson, type Database, type Db, type ExpressionBuilder, type Row } from '@morrow/db';
import type { Expression, RawBuilder, SqlBool } from 'kysely';
import { actorUserId, authorize, type WorkspaceContext } from '../context';
import type { Engine } from '../engine';

export type ContactWhere = (eb: ExpressionBuilder<Database, 'contacts'>) => Expression<SqlBool>;

interface CompileContext {
  workspaceId: string;
  now: Date;
  timezone: string;
  segments: Map<string, CriteriaGroup>;
  stack: string[];
}

const TEXT_COLUMNS: Record<string, string> = {
  first_name: 'contacts.first_name',
  last_name: 'contacts.last_name',
  email: 'contacts.email_normalized',
  company: 'contacts.company',
  job_title: 'contacts.job_title',
  relationship_type: 'contacts.relationship_type',
  language: 'contacts.language',
  timezone: 'contacts.timezone',
  source: 'contacts.source',
  consent_status: 'contacts.consent_status',
};

const TIMESTAMP_COLUMNS: Record<string, string> = {
  created_at: 'contacts.created_at',
  updated_at: 'contacts.updated_at',
  last_interaction_at: 'contacts.last_interaction_at',
  last_emailed_at: 'contacts.last_emailed_at',
  consent_updated_at: 'contacts.consent_updated_at',
};

const TRUE = sql<SqlBool>`1 = 1`;
const FALSE = sql<SqlBool>`1 = 0`;

function like(value: string, prefix = '%', suffix = '%'): string {
  return `${prefix}${escapeLike(value.toLowerCase())}${suffix}`;
}

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).toLowerCase());
  if (value === undefined || value === null || value === '') return [];
  return [String(value).toLowerCase()];
}

function textPredicate(column: string, op: string, value: unknown): RawBuilder<SqlBool> {
  const ref = sql.ref(column);
  const lower = sql`lower(${ref})`;
  const v = typeof value === 'string' ? value.toLowerCase() : '';
  switch (op) {
    case 'eq':
      return v === '' ? sql<SqlBool>`(${ref} is null or ${ref} = '')` : sql<SqlBool>`${lower} = ${v}`;
    case 'neq':
      return sql<SqlBool>`(${ref} is null or ${lower} <> ${v})`;
    case 'contains':
      return sql<SqlBool>`${lower} like ${like(v)} escape '\\'`;
    case 'not_contains':
      return sql<SqlBool>`(${ref} is null or ${lower} not like ${like(v)} escape '\\')`;
    case 'starts_with':
      return sql<SqlBool>`${lower} like ${like(v, '')} escape '\\'`;
    case 'ends_with':
      return sql<SqlBool>`${lower} like ${like(v, '%', '')} escape '\\'`;
    case 'in': {
      const list = asList(value);
      return list.length ? sql<SqlBool>`${lower} in (${sql.join(list)})` : FALSE;
    }
    case 'not_in': {
      const list = asList(value);
      return list.length ? sql<SqlBool>`(${ref} is null or ${lower} not in (${sql.join(list)}))` : TRUE;
    }
    case 'is_empty':
      return sql<SqlBool>`(${ref} is null or ${ref} = '')`;
    case 'is_not_empty':
      return sql<SqlBool>`(${ref} is not null and ${ref} <> '')`;
    default:
      return FALSE;
  }
}

function domainPredicate(op: string, value: unknown): RawBuilder<SqlBool> {
  const col = sql.ref('contacts.email_normalized');
  const domains = asList(value).map((d) => d.replace(/^@/, ''));
  const one = domains[0] ?? '';
  switch (op) {
    case 'eq':
      return sql<SqlBool>`${col} like ${like(one, '%@', '')} escape '\\'`;
    case 'neq':
      return sql<SqlBool>`(${col} is null or ${col} not like ${like(one, '%@', '')} escape '\\')`;
    case 'contains':
      return sql<SqlBool>`${col} like ${like(one, '%@%')} escape '\\'`;
    case 'not_contains':
      return sql<SqlBool>`(${col} is null or ${col} not like ${like(one, '%@%')} escape '\\')`;
    case 'starts_with':
      return sql<SqlBool>`${col} like ${like(one, '%@')} escape '\\'`;
    case 'ends_with':
      return sql<SqlBool>`${col} like ${like(one, '%', '')} escape '\\'`;
    case 'in':
      return domains.length ? sql<SqlBool>`(${sql.join(domains.map((d) => sql`${col} like ${like(d, '%@', '')} escape '\\'`), sql` or `)})` : FALSE;
    case 'not_in':
      return domains.length
        ? sql<SqlBool>`(${col} is null or (${sql.join(domains.map((d) => sql`${col} not like ${like(d, '%@', '')} escape '\\'`), sql` and `)}))`
        : TRUE;
    case 'is_empty':
      return sql<SqlBool>`${col} is null`;
    case 'is_not_empty':
      return sql<SqlBool>`${col} is not null`;
    default:
      return FALSE;
  }
}

function compileRule(eb: ExpressionBuilder<Database, 'contacts'>, rule: Rule, c: CompileContext): Expression<SqlBool> {
  const ws = c.workspaceId;
  const cutoff = (days: number) => new Date(c.now.getTime() - days * 86_400_000).toISOString();
  switch (rule.kind) {
    case 'field':
      if (rule.field === 'email_domain') return domainPredicate(rule.op, rule.value);
      return textPredicate(TEXT_COLUMNS[rule.field]!, rule.op, rule.value);

    case 'date': {
      if (rule.field === 'work_anniversary') {
        const col = sql.ref('contacts.work_anniversary');
        const today = localDate(c.now, c.timezone);
        switch (rule.op) {
          case 'before':
            return sql<SqlBool>`${col} < ${String(rule.value)}`;
          case 'after':
            return sql<SqlBool>`${col} > ${String(rule.value)}`;
          case 'on':
            return sql<SqlBool>`${col} = ${String(rule.value)}`;
          case 'within_last_days':
            return sql<SqlBool>`(${col} >= ${addDays(today, -Number(rule.value))} and ${col} <= ${today})`;
          case 'more_than_days_ago':
            return sql<SqlBool>`${col} < ${addDays(today, -Number(rule.value))}`;
          case 'is_empty':
            return sql<SqlBool>`${col} is null`;
          case 'is_not_empty':
            return sql<SqlBool>`${col} is not null`;
        }
        return FALSE;
      }
      const col = sql.ref(TIMESTAMP_COLUMNS[rule.field]!);
      switch (rule.op) {
        case 'before':
          return sql<SqlBool>`${col} < ${startOfLocalDay(String(rule.value), c.timezone).toISOString()}`;
        case 'after':
          return sql<SqlBool>`${col} >= ${startOfLocalDay(addDays(String(rule.value), 1), c.timezone).toISOString()}`;
        case 'on':
          return sql<SqlBool>`(${col} >= ${startOfLocalDay(String(rule.value), c.timezone).toISOString()} and ${col} < ${startOfLocalDay(addDays(String(rule.value), 1), c.timezone).toISOString()})`;
        case 'within_last_days':
          return sql<SqlBool>`${col} >= ${cutoff(Number(rule.value))}`;
        case 'more_than_days_ago':
          return sql<SqlBool>`${col} < ${cutoff(Number(rule.value))}`;
        case 'is_empty':
          return sql<SqlBool>`${col} is null`;
        case 'is_not_empty':
          return sql<SqlBool>`${col} is not null`;
      }
      return FALSE;
    }

    case 'tag': {
      const exists = eb.exists(
        eb
          .selectFrom('contact_tags')
          .innerJoin('tags', 'tags.id', 'contact_tags.tag_id')
          .select(sql`1`.as('one'))
          .whereRef('contact_tags.contact_id', '=', 'contacts.id')
          .where('tags.workspace_id', '=', ws)
          .where('tags.name_normalized', '=', rule.tag.trim().replace(/\s+/g, ' ').toLowerCase()),
      );
      return rule.op === 'has' ? exists : eb.not(exists);
    }

    case 'custom_field': {
      const sub = (pred: RawBuilder<SqlBool> | null) => {
        let q = eb
          .selectFrom('contact_field_values as v')
          .innerJoin('custom_fields as f', 'f.id', 'v.field_id')
          .select(sql`1`.as('one'))
          .whereRef('v.contact_id', '=', 'contacts.id')
          .where('f.workspace_id', '=', ws)
          .where('f.key', '=', rule.key)
          .where('v.value_text', 'is not', null);
        if (pred) q = q.where(pred);
        return eb.exists(q);
      };
      const text = typeof rule.value === 'string' ? rule.value.toLowerCase() : String(rule.value ?? '').toLowerCase();
      const num = Number(rule.value);
      switch (rule.op) {
        case 'eq':
          return sub(sql<SqlBool>`lower(v.value_text) = ${text}`);
        case 'neq':
          return eb.not(sub(sql<SqlBool>`lower(v.value_text) = ${text}`));
        case 'contains':
          return sub(sql<SqlBool>`lower(v.value_text) like ${like(text)} escape '\\'`);
        case 'gt':
          return sub(sql<SqlBool>`v.value_number > ${num}`);
        case 'gte':
          return sub(sql<SqlBool>`v.value_number >= ${num}`);
        case 'lt':
          return sub(sql<SqlBool>`v.value_number < ${num}`);
        case 'lte':
          return sub(sql<SqlBool>`v.value_number <= ${num}`);
        case 'before':
          return sub(sql<SqlBool>`v.value_text < ${String(rule.value)}`);
        case 'after':
          return sub(sql<SqlBool>`v.value_text > ${String(rule.value)}`);
        case 'is_true':
          return sub(sql<SqlBool>`v.value_text = 'true'`);
        case 'is_false':
          return sub(sql<SqlBool>`v.value_text = 'false'`);
        case 'is_empty':
          return eb.not(sub(null));
        case 'is_not_empty':
          return sub(null);
      }
      return FALSE;
    }

    case 'suppression': {
      const exists = eb.exists(
        eb
          .selectFrom('suppressions')
          .select(sql`1`.as('one'))
          .whereRef('suppressions.email_normalized', '=', 'contacts.email_normalized')
          .where('suppressions.workspace_id', '=', ws)
          .where('suppressions.lifted_at', 'is', null),
      );
      return rule.op === 'is_suppressed' ? exists : eb.not(exists);
    }

    case 'segment': {
      const nested = c.segments.get(rule.segmentId);
      if (!nested || c.stack.includes(rule.segmentId)) return rule.op === 'in' ? FALSE : TRUE;
      const expr = compileGroup(eb, nested, { ...c, stack: [...c.stack, rule.segmentId] });
      return rule.op === 'in' ? expr : eb.not(expr);
    }

    case 'engagement': {
      if (rule.event === 'replied') {
        let q = eb
          .selectFrom('contact_events')
          .select(sql`1`.as('one'))
          .whereRef('contact_events.contact_id', '=', 'contacts.id')
          .where('contact_events.workspace_id', '=', ws)
          .where('contact_events.name', '=', 'email.replied');
        if (rule.withinDays) q = q.where('contact_events.occurred_at', '>=', cutoff(rule.withinDays));
        return rule.op === 'did' ? eb.exists(q) : eb.not(eb.exists(q));
      }
      const column = { received: 'm.sent_at', delivered: 'm.delivered_at', opened: 'm.opened_at', clicked: 'm.clicked_at', bounced: 'm.bounced_at' }[rule.event];
      let q = eb
        .selectFrom('messages as m')
        .select(sql`1`.as('one'))
        .whereRef('m.contact_id', '=', 'contacts.id')
        .where('m.workspace_id', '=', ws)
        .where('m.kind', 'in', ['campaign', 'automation'])
        .where(sql<SqlBool>`${sql.ref(column)} is not null`);
      if (rule.withinDays) q = q.where(sql<SqlBool>`${sql.ref(column)} >= ${cutoff(rule.withinDays)}`);
      if (rule.campaignId) q = q.where('m.campaign_id', '=', rule.campaignId);
      return rule.op === 'did' ? eb.exists(q) : eb.not(eb.exists(q));
    }

    case 'birthday':
      switch (rule.op) {
        case 'is_set':
          return sql<SqlBool>`contacts.birthday_md is not null`;
        case 'is_not_set':
          return sql<SqlBool>`contacts.birthday_md is null`;
        case 'year_known':
          return sql<SqlBool>`contacts.birth_year is not null`;
        case 'in_month':
          return sql<SqlBool>`contacts.birthday_month = ${Number(rule.value)}`;
        case 'in_next_days': {
          const keys = occasionKeysInWindow(localDate(c.now, c.timezone), Math.max(1, Number(rule.value ?? 1)), 'feb28');
          return keys.length ? sql<SqlBool>`contacts.birthday_md in (${sql.join(keys)})` : FALSE;
        }
      }
      return FALSE;

    case 'event': {
      let q = eb
        .selectFrom('contact_events')
        .select(sql`1`.as('one'))
        .whereRef('contact_events.contact_id', '=', 'contacts.id')
        .where('contact_events.workspace_id', '=', ws)
        .where('contact_events.name', '=', rule.name);
      if (rule.withinDays) q = q.where('contact_events.occurred_at', '>=', cutoff(rule.withinDays));
      return rule.op === 'did' ? eb.exists(q) : eb.not(eb.exists(q));
    }
  }
}

function compileGroup(eb: ExpressionBuilder<Database, 'contacts'>, group: CriteriaGroup, c: CompileContext): Expression<SqlBool> {
  const parts = group.rules.map((r) => (r.kind === 'group' ? compileGroup(eb, r, c) : compileRule(eb, r, c)));
  if (parts.length === 0) return TRUE;
  if (parts.length === 1) return parts[0]!;
  return group.match === 'all' ? eb.and(parts) : eb.or(parts);
}

function toDTO(r: Row<'segments'>, segmentNames: Record<string, string> = {}): SegmentDTO {
  const criteria = fromJson<CriteriaGroup>(r.criteria, emptyCriteria());
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    criteria,
    summary: describeCriteria(criteria, segmentNames),
    count: r.cached_count,
    countedAt: r.cached_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Segments: saved, reusable audience definitions. The same compiler powers
 * segment previews, automation conditions/branches, campaign audiences and
 * contact list filters, always evaluated in the database.
 */
export class SegmentsService {
  constructor(private readonly e: Engine) {}

  /** Load nested segment definitions referenced (transitively) by criteria. */
  private async loadGraph(workspaceId: string, criteria: CriteriaGroup, db: Db = this.e.db): Promise<Map<string, CriteriaGroup>> {
    const graph = new Map<string, CriteriaGroup>();
    let pending = referencedSegments(criteria);
    for (let depth = 0; depth < 4 && pending.length; depth++) {
      const rows = await db
        .selectFrom('segments')
        .select(['id', 'criteria'])
        .where('workspace_id', '=', workspaceId)
        .where('id', 'in', pending)
        .execute();
      const next: string[] = [];
      for (const r of rows) {
        const g = fromJson<CriteriaGroup>(r.criteria, emptyCriteria());
        graph.set(r.id, g);
        for (const id of referencedSegments(g)) if (!graph.has(id)) next.push(id);
      }
      pending = next;
    }
    return graph;
  }

  /** Compile criteria into a reusable WHERE function for `contacts`. */
  async compile(workspaceId: string, criteria: CriteriaGroup, options: { now?: Date; db?: Db } = {}): Promise<ContactWhere> {
    const ws = await this.e.workspaces.row(workspaceId);
    const segments = await this.loadGraph(workspaceId, criteria, options.db);
    const c: CompileContext = { workspaceId, now: options.now ?? this.e.now(), timezone: ws.timezone, segments, stack: [] };
    return (eb) => compileGroup(eb, criteria, c);
  }

  validate(raw: unknown): CriteriaGroup {
    const parsed = criteriaGroupSchema.safeParse(raw);
    if (!parsed.success) throw new ValidationError('The segment rules are invalid.', toFieldIssues(parsed.error.issues));
    const problems = checkCriteria(parsed.data);
    if (problems.length) throw new ValidationError(problems[0]!.message, problems);
    return parsed.data;
  }

  /** Active contacts matching criteria (base query for counts, previews and batches). */
  private async matching(workspaceId: string, criteria: CriteriaGroup, options: { now?: Date; db?: Db } = {}) {
    const where = await this.compile(workspaceId, criteria, options);
    return (options.db ?? this.e.db)
      .selectFrom('contacts')
      .where('contacts.workspace_id', '=', workspaceId)
      .where('contacts.status', '=', 'active')
      .where(where);
  }

  async count(workspaceId: string, criteria: CriteriaGroup, options: { now?: Date } = {}): Promise<number> {
    const q = await this.matching(workspaceId, criteria, options);
    return Number((await q.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst())?.n ?? 0);
  }

  async matches(workspaceId: string, criteria: CriteriaGroup | null | undefined, contactId: string, options: { now?: Date; db?: Db } = {}): Promise<boolean> {
    if (!criteria || criteria.rules.length === 0) return true;
    const where = await this.compile(workspaceId, criteria, options);
    const row = await (options.db ?? this.e.db)
      .selectFrom('contacts')
      .select('contacts.id')
      .where('contacts.workspace_id', '=', workspaceId)
      .where('contacts.id', '=', contactId)
      .where(where)
      .executeTakeFirst();
    return Boolean(row);
  }

  /** Keyset-paginated matching contacts (bounded memory for large audiences). */
  async contactBatch(workspaceId: string, criteria: CriteriaGroup, afterId: string, limit: number, options: { now?: Date } = {}): Promise<Row<'contacts'>[]> {
    const q = await this.matching(workspaceId, criteria, options);
    return q.selectAll('contacts').where('contacts.id', '>', afterId).orderBy('contacts.id', 'asc').limit(limit).execute();
  }

  async criteriaFor(workspaceId: string, segmentId: string | null | undefined, db: Db = this.e.db): Promise<CriteriaGroup> {
    if (!segmentId) return emptyCriteria();
    const r = await db.selectFrom('segments').select('criteria').where('id', '=', segmentId).where('workspace_id', '=', workspaceId).executeTakeFirst();
    if (!r) throw new NotFoundError('Segment', segmentId);
    return fromJson<CriteriaGroup>(r.criteria, emptyCriteria());
  }

  async preview(ctx: WorkspaceContext, raw: unknown, limit = 10): Promise<SegmentPreviewDTO> {
    authorize(ctx, 'segments:read');
    const criteria = this.validate(raw);
    const q = await this.matching(ctx.workspaceId, criteria);
    const count = Number((await q.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst())?.n ?? 0);
    const rows = await q.selectAll('contacts').orderBy('contacts.created_at', 'desc').limit(Math.min(50, limit)).execute();
    return {
      count,
      sample: rows.map((r) => ({
        id: r.id,
        name: fullName({ firstName: r.first_name, lastName: r.last_name }) || r.email || 'Unnamed contact',
        email: r.email,
        relationshipType: r.relationship_type as RelationshipType,
        consentStatus: r.consent_status as ConsentStatus,
      })),
    };
  }

  // ------------------------------------------------------------ CRUD

  private async names(workspaceId: string): Promise<Record<string, string>> {
    const rows = await this.e.db.selectFrom('segments').select(['id', 'name']).where('workspace_id', '=', workspaceId).execute();
    return Object.fromEntries(rows.map((r) => [r.id, r.name]));
  }

  async list(ctx: WorkspaceContext): Promise<SegmentDTO[]> {
    authorize(ctx, 'segments:read');
    const rows = await this.e.db.selectFrom('segments').selectAll().where('workspace_id', '=', ctx.workspaceId).where('archived_at', 'is', null).orderBy('name', 'asc').execute();
    const names = Object.fromEntries(rows.map((r) => [r.id, r.name]));
    return rows.map((r) => toDTO(r, names));
  }

  async row(workspaceId: string, id: string): Promise<Row<'segments'>> {
    const r = await this.e.db.selectFrom('segments').selectAll().where('id', '=', id).where('workspace_id', '=', workspaceId).executeTakeFirst();
    if (!r) throw new NotFoundError('Segment', id);
    return r;
  }

  async get(ctx: WorkspaceContext, id: string): Promise<SegmentDTO> {
    authorize(ctx, 'segments:read');
    return toDTO(await this.row(ctx.workspaceId, id), await this.names(ctx.workspaceId));
  }

  private async assertReferences(workspaceId: string, criteria: CriteriaGroup, selfId: string | null): Promise<void> {
    const refs = referencedSegments(criteria);
    if (!refs.length) return;
    if (selfId && refs.includes(selfId)) throw new ValidationError('A segment cannot include itself.');
    const graph = await this.loadGraph(workspaceId, criteria);
    for (const id of refs) if (!graph.has(id)) throw new ValidationError(`Referenced segment ${id} does not exist.`);
    if (selfId) {
      for (const g of graph.values()) {
        if (referencedSegments(g).includes(selfId)) throw new ValidationError('This would create a loop between segments.');
      }
    }
  }

  async create(ctx: WorkspaceContext, input: { name: string; description?: string | null; criteria: unknown }): Promise<SegmentDTO> {
    authorize(ctx, 'segments:write');
    const name = (input.name ?? '').trim().slice(0, 100);
    if (!name) throw new ValidationError('Name the segment.', [{ path: 'name', message: 'Required.' }]);
    const criteria = this.validate(input.criteria);
    await this.assertReferences(ctx.workspaceId, criteria, null);
    const now = this.e.nowIso();
    const count = await this.count(ctx.workspaceId, criteria);
    const row: Row<'segments'> = {
      id: newId('seg'),
      workspace_id: ctx.workspaceId,
      name,
      description: input.description?.trim().slice(0, 500) || null,
      criteria: toJson(criteria),
      created_by: actorUserId(ctx),
      cached_count: count,
      cached_at: now,
      created_at: now,
      updated_at: now,
      archived_at: null,
    };
    await this.e.db.insertInto('segments').values(row).execute();
    await this.e.audit.record(ctx, 'segment.created', { type: 'segment', id: row.id }, { name });
    return toDTO(row, await this.names(ctx.workspaceId));
  }

  async update(ctx: WorkspaceContext, id: string, input: { name?: string; description?: string | null; criteria?: unknown }): Promise<SegmentDTO> {
    authorize(ctx, 'segments:write');
    const current = await this.row(ctx.workspaceId, id);
    const patch: Partial<Row<'segments'>> = { updated_at: this.e.nowIso() };
    if (input.name !== undefined) patch.name = input.name.trim().slice(0, 100) || current.name;
    if (input.description !== undefined) patch.description = input.description?.trim().slice(0, 500) || null;
    if (input.criteria !== undefined) {
      const criteria = this.validate(input.criteria);
      await this.assertReferences(ctx.workspaceId, criteria, id);
      patch.criteria = toJson(criteria);
      patch.cached_count = await this.count(ctx.workspaceId, criteria);
      patch.cached_at = this.e.nowIso();
    }
    await this.e.db.updateTable('segments').set(patch).where('id', '=', id).execute();
    await this.e.audit.record(ctx, 'segment.updated', { type: 'segment', id });
    return this.get(ctx, id);
  }

  async refreshCount(ctx: WorkspaceContext, id: string): Promise<SegmentDTO> {
    authorize(ctx, 'segments:read');
    const row = await this.row(ctx.workspaceId, id);
    const count = await this.count(ctx.workspaceId, fromJson<CriteriaGroup>(row.criteria, emptyCriteria()));
    await this.e.db.updateTable('segments').set({ cached_count: count, cached_at: this.e.nowIso() }).where('id', '=', id).execute();
    return this.get(ctx, id);
  }

  async archive(ctx: WorkspaceContext, id: string): Promise<void> {
    authorize(ctx, 'segments:write');
    await this.row(ctx.workspaceId, id);
    const campaign = await this.e.db
      .selectFrom('campaigns')
      .select('name')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('segment_id', '=', id)
      .where('status', 'in', ['scheduled', 'sending', 'paused', 'pending_approval'])
      .executeTakeFirst();
    if (campaign) throw new PreconditionError(`This segment is the audience of campaign "${campaign.name}".`);
    const usedBy = await this.e.db
      .selectFrom('segments')
      .select('name')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('archived_at', 'is', null)
      .where('criteria', 'like', `%${id}%`)
      .where('id', '!=', id)
      .executeTakeFirst();
    if (usedBy) throw new PreconditionError(`Segment "${usedBy.name}" includes this segment.`);
    await this.e.db.updateTable('segments').set({ archived_at: this.e.nowIso(), updated_at: this.e.nowIso() }).where('id', '=', id).execute();
    await this.e.audit.record(ctx, 'segment.archived', { type: 'segment', id });
  }

  /**
   * Reconcile the membership snapshot for "enters segment" triggers.
   * Returns contacts that newly entered; contacts that left are removed so
   * they can enter again later.
   */
  async refreshMemberships(workspaceId: string, segmentId: string, now = this.e.now()): Promise<string[]> {
    const row = await this.e.db.selectFrom('segments').select(['criteria', 'archived_at']).where('id', '=', segmentId).where('workspace_id', '=', workspaceId).executeTakeFirst();
    if (!row || row.archived_at) return [];
    const criteria = fromJson<CriteriaGroup>(row.criteria, emptyCriteria());
    const entered: string[] = [];
    let after = '';
    for (;;) {
      const batch = await this.contactBatch(workspaceId, criteria, after, 500, { now });
      if (!batch.length) break;
      for (const c of batch) {
        const res = await this.e.db
          .insertInto('segment_memberships')
          .values({ workspace_id: workspaceId, segment_id: segmentId, contact_id: c.id, entered_at: now.toISOString() })
          .onConflict((oc) => oc.doNothing())
          .returning('contact_id')
          .executeTakeFirst();
        if (res) entered.push(c.id);
      }
      after = batch[batch.length - 1]!.id;
      if (batch.length < 500) break;
    }
    const stillMatching = (await this.matching(workspaceId, criteria, { now })).select('contacts.id');
    await this.e.db
      .deleteFrom('segment_memberships')
      .where('segment_id', '=', segmentId)
      .where('contact_id', 'not in', stillMatching)
      .execute();
    return entered;
  }

  /** Check one contact against a segment and update its membership; returns true when it newly entered. */
  async syncContactMembership(workspaceId: string, segmentId: string, contactId: string, db: Db = this.e.db): Promise<boolean> {
    const criteria = await this.criteriaFor(workspaceId, segmentId, db).catch(() => null);
    if (!criteria) return false;
    const inSegment = await this.matches(workspaceId, criteria, contactId, { db });
    if (inSegment) {
      const res = await db
        .insertInto('segment_memberships')
        .values({ workspace_id: workspaceId, segment_id: segmentId, contact_id: contactId, entered_at: this.e.nowIso() })
        .onConflict((oc) => oc.doNothing())
        .returning('contact_id')
        .executeTakeFirst();
      return Boolean(res);
    }
    await db.deleteFrom('segment_memberships').where('segment_id', '=', segmentId).where('contact_id', '=', contactId).execute();
    return false;
  }
}
