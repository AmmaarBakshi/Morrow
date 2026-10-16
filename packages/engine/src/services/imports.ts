import {
  CONSENT_STATUSES,
  IMPORT_FIELDS,
  mapImportRow,
  monthDayKey,
  newId,
  NotFoundError,
  normalizeEmail,
  parseCsv,
  parseLocalDate,
  PreconditionError,
  RELATIONSHIP_TYPES,
  suggestMapping,
  ValidationError,
  type ConsentStatus,
  type ImportDTO,
  type ImportOptionsDTO,
  type ImportPreviewDTO,
  type ImportRecord,
  type ImportReportDTO,
  type ImportRowIssueDTO,
  type ImportTarget,
  type WorkspaceSettings,
} from '@morrow/core';
import { chunk, fromJson, toJson, type Db, type Row } from '@morrow/db';
import { actorUserId, authorize, type WorkspaceContext } from '../context';
import type { Engine } from '../engine';

export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 50_000;
const MAX_ISSUES = 500;
const BATCH = 200;

const DEFAULT_OPTIONS: ImportOptionsDTO = {
  duplicateStrategy: 'update_empty',
  dateOrder: 'DMY',
  addTags: [],
  defaultRelationship: 'subscriber',
  defaultConsent: 'unknown',
  consentSource: null,
};

interface Planned {
  row: number;
  record: ImportRecord;
  email: string | null;
  action: 'create' | 'update' | 'skip' | 'invalid';
  existing: Row<'contacts'> | null;
  errors: string[];
  warnings: string[];
  conflicts: string[];
  consent: ConsentStatus | null;
}

function toDTO(r: Row<'imports'>): ImportDTO {
  return {
    id: r.id,
    filename: r.filename,
    status: r.status as ImportDTO['status'],
    headers: fromJson<string[]>(r.headers, []),
    sample: fromJson<string[][]>(r.sample, []),
    suggestedMapping: fromJson<ImportTarget[]>(r.mapping, []),
    rowCount: r.row_count,
    createdAt: r.created_at,
    committedAt: r.committed_at,
    report: fromJson<ImportReportDTO | null>(r.report, null),
  };
}

function validateMapping(mapping: unknown, headerCount: number, customKeys: Set<string>): ImportTarget[] {
  if (!Array.isArray(mapping) || mapping.length !== headerCount) {
    throw new ValidationError(`Provide a mapping for each of the ${headerCount} columns.`, [{ path: 'mapping', message: 'Wrong length.' }]);
  }
  const seen = new Set<string>();
  return mapping.map((m, i) => {
    const t = String(m);
    if (t === 'ignore') return 'ignore';
    const valid = (IMPORT_FIELDS as readonly string[]).includes(t) || (t.startsWith('custom:') && customKeys.has(t.slice(7)));
    if (!valid) throw new ValidationError(`Column ${i + 1}: unknown field "${t}".`, [{ path: `mapping.${i}`, message: 'Unknown field.' }]);
    if (seen.has(t)) throw new ValidationError(`"${t}" is mapped to more than one column.`, [{ path: `mapping.${i}`, message: 'Duplicate mapping.' }]);
    seen.add(t);
    return t as ImportTarget;
  });
}

function validateOptions(raw: Partial<ImportOptionsDTO> | undefined): ImportOptionsDTO {
  const o = { ...DEFAULT_OPTIONS, ...(raw ?? {}) };
  if (!['skip', 'update_empty', 'overwrite'].includes(o.duplicateStrategy)) throw new ValidationError('Unknown duplicate strategy.');
  if (!['DMY', 'MDY', 'YMD'].includes(o.dateOrder)) throw new ValidationError('Unknown date order.');
  if (!(RELATIONSHIP_TYPES as readonly string[]).includes(o.defaultRelationship)) throw new ValidationError('Unknown relationship type.');
  if (!(CONSENT_STATUSES as readonly string[]).includes(o.defaultConsent)) throw new ValidationError('Unknown consent status.');
  if ((o.defaultConsent === 'granted' || o.defaultConsent === 'implied') && !o.consentSource?.trim()) {
    throw new ValidationError('Record where consent for these contacts came from.', [{ path: 'options.consentSource', message: 'Required when defaulting consent to granted or implied.' }]);
  }
  o.addTags = (o.addTags ?? []).map((t) => String(t).trim()).filter(Boolean).slice(0, 10);
  return o;
}

const CONFLICT_FIELDS: Array<[keyof ImportRecord, keyof Row<'contacts'>, string]> = [
  ['firstName', 'first_name', 'first name'],
  ['lastName', 'last_name', 'last name'],
  ['company', 'company', 'company'],
  ['jobTitle', 'job_title', 'job title'],
];

/**
 * CSV contact import: upload → map columns → preview → commit. Invalid rows
 * never touch existing data; conflicting values are reported and only
 * overwritten when the user explicitly chooses "overwrite".
 */
export class ImportsService {
  constructor(private readonly e: Engine) {}

  async row(workspaceId: string, id: string): Promise<Row<'imports'>> {
    const r = await this.e.db.selectFrom('imports').selectAll().where('id', '=', id).where('workspace_id', '=', workspaceId).executeTakeFirst();
    if (!r) throw new NotFoundError('Import', id);
    return r;
  }

  async list(ctx: WorkspaceContext): Promise<ImportDTO[]> {
    authorize(ctx, 'contacts:import');
    const rows = await this.e.db.selectFrom('imports').selectAll().where('workspace_id', '=', ctx.workspaceId).orderBy('created_at', 'desc').limit(50).execute();
    return rows.map(toDTO);
  }

  async get(ctx: WorkspaceContext, id: string): Promise<ImportDTO> {
    authorize(ctx, 'contacts:import');
    return toDTO(await this.row(ctx.workspaceId, id));
  }

  async upload(ctx: WorkspaceContext, input: { filename: string; csv: string }): Promise<ImportDTO> {
    authorize(ctx, 'contacts:import');
    const csv = String(input.csv ?? '');
    if (!csv.trim()) throw new ValidationError('The file is empty.');
    if (Buffer.byteLength(csv, 'utf8') > MAX_IMPORT_BYTES) throw new PreconditionError('Files are limited to 10 MB. Split the file and import in parts.');
    const parsed = parseCsv(csv, { maxRecords: MAX_IMPORT_ROWS + 2 });
    const [headers, ...rows] = parsed.rows;
    if (!headers || headers.every((h) => !h.trim())) throw new ValidationError('The first row must contain column headers.');
    if (rows.length > MAX_IMPORT_ROWS) throw new PreconditionError(`Imports are limited to ${MAX_IMPORT_ROWS.toLocaleString()} rows.`);
    const customKeys = (await this.e.fields.definitions(ctx.workspaceId)).map((d) => d.key);
    const now = this.e.nowIso();
    const row: Row<'imports'> = {
      id: newId('imp'),
      workspace_id: ctx.workspaceId,
      filename: (input.filename || 'contacts.csv').replace(/[^\w .()-]/g, '_').slice(0, 120),
      status: 'uploaded',
      headers: toJson(headers.map((h) => h.trim().slice(0, 100))),
      sample: toJson(rows.slice(0, 5).map((r) => r.map((c) => c.slice(0, 200)))),
      mapping: toJson(suggestMapping(headers, customKeys)),
      options: null,
      row_count: rows.length,
      csv,
      summary: null,
      report: null,
      created_by: actorUserId(ctx),
      created_at: now,
      updated_at: now,
      committed_at: null,
    };
    await this.e.db.insertInto('imports').values(row).execute();
    return toDTO(row);
  }

  /** Analyse every row without writing anything. */
  private async plan(ctx: WorkspaceContext, imp: Row<'imports'>, mappingRaw: unknown, optionsRaw: Partial<ImportOptionsDTO> | undefined) {
    if (imp.status !== 'uploaded' || !imp.csv) throw new PreconditionError('This import has already been processed.');
    const defs = await this.e.fields.definitions(ctx.workspaceId);
    const headers = fromJson<string[]>(imp.headers, []);
    const mapping = validateMapping(mappingRaw, headers.length, new Set(defs.map((d) => d.key)));
    if (!mapping.includes('email') && !mapping.includes('first_name') && !mapping.includes('full_name')) {
      throw new ValidationError('Map at least an e-mail or a name column.', [{ path: 'mapping', message: 'Map email or a name.' }]);
    }
    const options = validateOptions(optionsRaw);
    const { settings } = await this.e.workspaces.settings(ctx.workspaceId);
    const rows = parseCsv(imp.csv).rows.slice(1);
    const fieldDefs = defs.map((d) => ({ key: d.key, type: d.type as 'text', options: fromJson<string[] | null>(d.options, null) }));

    const planned: Planned[] = rows.map((cells, i) => {
      const r = mapImportRow(cells, mapping, { dateOrder: options.dateOrder, customFields: fieldDefs });
      const email = r.record.email ? normalizeEmail(r.record.email, { gmailCanonical: settings.dedupe.gmailCanonical }) : null;
      return { row: i + 2, record: r.record, email, action: r.errors.length ? 'invalid' : 'create', existing: null, errors: r.errors, warnings: r.warnings, conflicts: [], consent: null };
    });

    // Duplicates within the file: the first occurrence wins.
    const firstSeen = new Map<string, number>();
    let duplicatesInFile = 0;
    for (const p of planned) {
      if (!p.email || p.action === 'invalid') continue;
      const first = firstSeen.get(p.email);
      if (first !== undefined) {
        p.action = 'skip';
        p.warnings.push(`Duplicate of row ${first} in this file`);
        duplicatesInFile++;
      } else firstSeen.set(p.email, p.row);
    }

    const emails = [...firstSeen.keys()];
    const existing = new Map<string, Row<'contacts'>>();
    for (const batch of chunk(emails, 500)) {
      const found = await this.e.db.selectFrom('contacts').selectAll().where('workspace_id', '=', ctx.workspaceId).where('email_normalized', 'in', batch).execute();
      for (const c of found) existing.set(c.email_normalized!, c);
    }
    const suppressions = await this.e.suppressions.activeMany(ctx.workspaceId, emails);

    let conflicts = 0;
    let suppressed = 0;
    for (const p of planned) {
      if (p.action !== 'create') continue;
      const ex = p.email ? existing.get(p.email) : undefined;
      // Consent: column value, else the default; granted/implied need a recorded source.
      let consent: ConsentStatus | null = p.record.consentStatus ?? (ex ? null : options.defaultConsent);
      if ((consent === 'granted' || consent === 'implied') && !p.record.consentSource && !options.consentSource) {
        p.warnings.push('Consent marked granted without a source — recorded as unknown. Set a consent source to keep it.');
        consent = ex ? null : 'unknown';
      }
      const supp = p.email ? suppressions.get(p.email) : undefined;
      if (supp && (consent === 'granted' || consent === 'implied')) {
        p.warnings.push(`This address is suppressed (${supp.reason}); the import cannot re-grant consent`);
        consent = ex ? null : 'withdrawn';
        suppressed++;
      } else if (supp) {
        suppressed++;
      }
      if (ex && ex.consent_status === 'withdrawn' && (consent === 'granted' || consent === 'implied')) {
        p.warnings.push('Contact previously withdrew consent; keeping it withdrawn');
        consent = null;
      }
      p.consent = consent;
      if (!ex) continue;
      p.existing = ex;
      if (options.duplicateStrategy === 'skip') {
        p.action = 'skip';
        p.warnings.push('Already exists — skipped');
        continue;
      }
      p.action = 'update';
      for (const [rk, ck, label] of CONFLICT_FIELDS) {
        const incoming = p.record[rk] as string | null;
        const current = ex[ck] as string | null;
        if (incoming && current && incoming.trim().toLowerCase() !== current.trim().toLowerCase()) p.conflicts.push(`${label}: "${current}" → "${incoming}"`);
      }
      const b = p.record.birthday;
      if (b && ex.birthday_md && monthDayKey(b) !== ex.birthday_md) p.conflicts.push('birthday differs from the existing record');
      if (p.conflicts.length) conflicts++;
    }

    const count = (a: Planned['action']) => planned.filter((p) => p.action === a).length;
    const preview: ImportPreviewDTO = {
      total: planned.length,
      valid: planned.length - count('invalid'),
      invalid: count('invalid'),
      duplicatesInFile,
      existing: planned.filter((p) => p.existing).length,
      conflicts,
      suppressed,
      willCreate: count('create'),
      willUpdate: count('update'),
      willSkip: count('skip'),
      issues: planned
        .filter((p) => p.errors.length || p.warnings.length || p.conflicts.length)
        .slice(0, MAX_ISSUES)
        .map<ImportRowIssueDTO>((p) => ({ row: p.row, email: p.email, errors: p.errors, warnings: p.warnings, action: p.action, ...(p.conflicts.length ? { conflicts: p.conflicts } : {}) })),
    };
    return { planned, preview, options, mapping };
  }

  async preview(ctx: WorkspaceContext, id: string, input: { mapping: unknown; options?: Partial<ImportOptionsDTO> }): Promise<ImportPreviewDTO> {
    authorize(ctx, 'contacts:import');
    const imp = await this.row(ctx.workspaceId, id);
    return (await this.plan(ctx, imp, input.mapping, input.options)).preview;
  }

  private async applyRow(ctx: WorkspaceContext, p: Planned, options: ImportOptionsDTO, filename: string, db: Db, triggerAutomations: boolean, settings: WorkspaceSettings) {
    const r = p.record;
    const tags = [...r.tags, ...options.addTags];
    if (p.action === 'create') {
      await this.e.contacts.create(
        ctx,
        {
          firstName: r.firstName,
          lastName: r.lastName,
          email: r.email,
          company: r.company,
          jobTitle: r.jobTitle,
          birthday: r.birthday,
          workAnniversary: r.workAnniversary,
          relationshipType: r.relationshipType ?? options.defaultRelationship,
          tags,
          interests: r.interests,
          language: r.language,
          timezone: r.timezone,
          source: r.source ?? `import:${filename}`,
          consentStatus: p.consent ?? 'unknown',
          consentSource: p.consent && p.consent !== 'unknown' ? (r.consentSource ?? options.consentSource ?? `import:${filename}`) : null,
          customFields: r.customFields,
          lastInteractionAt: r.lastInteractionAt,
          note: r.notes ?? undefined,
        },
        { source: 'import', silent: !triggerAutomations, db, settings },
      );
      return;
    }
    const ex = p.existing!;
    const overwrite = options.duplicateStrategy === 'overwrite';
    const pick = <T>(incoming: T | null, current: unknown): T | undefined => {
      if (incoming === null || incoming === undefined || (typeof incoming === 'string' && incoming === '')) return undefined;
      if (overwrite || current === null || current === undefined || current === '') return incoming;
      return undefined;
    };
    const patch: Record<string, unknown> = {};
    const set = (key: string, v: unknown) => {
      if (v !== undefined) patch[key] = v;
    };
    set('firstName', pick(r.firstName, ex.first_name));
    set('lastName', pick(r.lastName, ex.last_name));
    set('company', pick(r.company, ex.company));
    set('jobTitle', pick(r.jobTitle, ex.job_title));
    set('language', pick(r.language, ex.language));
    set('timezone', pick(r.timezone, ex.timezone));
    set('source', pick(r.source, ex.source));
    set('workAnniversary', pick(r.workAnniversary, ex.work_anniversary));
    if (r.relationshipType) set('relationshipType', pick(r.relationshipType, overwrite ? null : ex.relationship_type === 'subscriber' ? null : ex.relationship_type));
    if (r.birthday) set('birthday', pick(r.birthday, ex.birthday_md));
    if (r.lastInteractionAt && (!ex.last_interaction_at || ex.last_interaction_at < r.lastInteractionAt)) set('lastInteractionAt', r.lastInteractionAt);
    if (Object.keys(patch).length) await this.e.contacts.update(ctx, ex.id, patch, { source: 'import', silent: !triggerAutomations, db, settings });
    if (tags.length) await this.e.tags.attach(ctx.workspaceId, ex.id, tags, db);
    if (Object.keys(r.customFields).length) await this.e.fields.setValues(ctx.workspaceId, ex.id, r.customFields, db, overwrite ? 'merge' : 'fill_empty');
    if (p.consent === 'withdrawn' && ex.consent_status !== 'withdrawn') {
      // Opt-outs are always honoured, whatever the duplicate strategy.
      if (ex.email_normalized) await this.e.suppressions.suppress(ctx.workspaceId, { email: ex.email_normalized, reason: 'unsubscribed', source: `import:${filename}` }, db);
      await this.e.contacts.recordConsentChange(ctx.workspaceId, ex, 'withdrawn', `import:${filename}`, ctx.actor, db);
    } else if (p.consent && p.consent !== 'unknown' && ex.consent_status === 'unknown') {
      await this.e.contacts.recordConsentChange(ctx.workspaceId, ex, p.consent, r.consentSource ?? options.consentSource ?? `import:${filename}`, ctx.actor, db);
    }
    if (r.notes) {
      await db.insertInto('contact_notes').values({ id: newId('not'), workspace_id: ctx.workspaceId, contact_id: ex.id, author_id: actorUserId(ctx), body: r.notes, created_at: this.e.nowIso() }).execute();
    }
  }

  async commit(
    ctx: WorkspaceContext,
    id: string,
    input: { mapping: unknown; options?: Partial<ImportOptionsDTO>; triggerAutomations?: boolean },
  ): Promise<ImportReportDTO> {
    authorize(ctx, 'contacts:import');
    const imp = await this.row(ctx.workspaceId, id);
    const { planned, preview, options, mapping } = await this.plan(ctx, imp, input.mapping, input.options);
    const { settings } = await this.e.workspaces.settings(ctx.workspaceId);
    let created = 0;
    let updated = 0;
    let failed = 0;
    const issues = [...preview.issues];
    const work = planned.filter((p) => p.action === 'create' || p.action === 'update');
    for (const batch of chunk(work, BATCH)) {
      try {
        await this.e.db.transaction().execute(async (trx) => {
          for (const p of batch) await this.applyRow(ctx, p, options, imp.filename, trx, Boolean(input.triggerAutomations), settings);
        });
        created += batch.filter((p) => p.action === 'create').length;
        updated += batch.filter((p) => p.action === 'update').length;
      } catch {
        // Retry the batch row by row so one bad row cannot sink its neighbours.
        for (const p of batch) {
          try {
            await this.e.db.transaction().execute((trx) => this.applyRow(ctx, p, options, imp.filename, trx, Boolean(input.triggerAutomations), settings));
            if (p.action === 'create') created++;
            else updated++;
          } catch (err) {
            failed++;
            if (issues.length < MAX_ISSUES) issues.push({ row: p.row, email: p.email, errors: [(err as Error).message], warnings: [], action: 'invalid' });
          }
        }
      }
    }
    const report: ImportReportDTO = {
      ...preview,
      issues,
      created,
      updated,
      skipped: preview.willSkip + preview.invalid,
      failed,
      finishedAt: this.e.nowIso(),
    };
    await this.e.db
      .updateTable('imports')
      .set({
        status: 'committed',
        mapping: toJson(mapping),
        options: toJson(options),
        report: toJson(report),
        summary: toJson({ created, updated, skipped: report.skipped, failed }),
        csv: null, // the raw file is discarded once processed
        committed_at: this.e.nowIso(),
        updated_at: this.e.nowIso(),
      })
      .where('id', '=', id)
      .execute();
    await this.e.audit.record(ctx, 'contacts.imported', { type: 'import', id }, { created, updated, skipped: report.skipped, failed, strategy: options.duplicateStrategy });
    return report;
  }

  /** Remove raw CSV data from imports that were never committed (privacy). */
  async purgeStale(olderThanDays = 7): Promise<number> {
    const cutoff = new Date(this.e.now().getTime() - olderThanDays * 86_400_000).toISOString();
    const res = await this.e.db
      .updateTable('imports')
      .set({ csv: null, status: 'failed', updated_at: this.e.nowIso() })
      .where('status', '=', 'uploaded')
      .where('created_at', '<', cutoff)
      .executeTakeFirst();
    return Number(res.numUpdatedRows ?? 0);
  }

  isValidDate(v: string): boolean {
    return parseLocalDate(v) !== null;
  }
}
