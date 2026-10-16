import {
  ConflictError,
  isValidLocalDate,
  newId,
  NotFoundError,
  parseCustomFieldValue,
  ValidationError,
  type CustomFieldDTO,
  type CustomFieldType,
} from '@morrow/core';
import { chunk, fromJson, toJson, type Db, type Row } from '@morrow/db';
import { authorize, type WorkspaceContext } from '../context';
import type { Engine } from '../engine';

export const CUSTOM_FIELD_TYPES: CustomFieldType[] = ['text', 'number', 'date', 'boolean', 'select', 'url'];
const KEY_RE = /^[a-z][a-z0-9_]{0,47}$/;

function toDTO(r: Row<'custom_fields'>): CustomFieldDTO {
  return {
    id: r.id,
    key: r.key,
    label: r.label,
    type: r.type as CustomFieldDTO['type'],
    options: fromJson<string[] | null>(r.options, null),
    createdAt: r.created_at,
    archivedAt: r.archived_at,
  };
}

export type CustomValue = string | number | boolean | null;

/**
 * Custom contact fields defined per workspace. Values live in a typed
 * key/value table, so adding a field never needs a schema migration.
 */
export class CustomFieldsService {
  constructor(private readonly e: Engine) {}

  async list(ctx: WorkspaceContext, includeArchived = false): Promise<CustomFieldDTO[]> {
    authorize(ctx, 'contacts:read');
    let q = this.e.db.selectFrom('custom_fields').selectAll().where('workspace_id', '=', ctx.workspaceId).orderBy('created_at', 'asc');
    if (!includeArchived) q = q.where('archived_at', 'is', null);
    return (await q.execute()).map(toDTO);
  }

  async definitions(workspaceId: string, db: Db = this.e.db): Promise<Row<'custom_fields'>[]> {
    return db.selectFrom('custom_fields').selectAll().where('workspace_id', '=', workspaceId).where('archived_at', 'is', null).execute();
  }

  private checkOptions(type: string, options: unknown): string[] | null {
    if (type !== 'select') return null;
    if (!Array.isArray(options) || options.length === 0) throw new ValidationError('Select fields need at least one option.', [{ path: 'options', message: 'Add options.' }]);
    const clean = [...new Set(options.map((o) => String(o).trim()).filter(Boolean))].slice(0, 100);
    if (clean.some((o) => o.length > 100)) throw new ValidationError('Options are limited to 100 characters.');
    return clean;
  }

  async create(ctx: WorkspaceContext, input: { key: string; label: string; type: CustomFieldType; options?: string[] }): Promise<CustomFieldDTO> {
    authorize(ctx, 'contacts:write');
    const key = (input.key ?? '').trim().toLowerCase();
    if (!KEY_RE.test(key)) throw new ValidationError('Keys use lowercase letters, numbers and underscores, starting with a letter.', [{ path: 'key', message: 'Invalid key.' }]);
    if (!CUSTOM_FIELD_TYPES.includes(input.type)) throw new ValidationError('Unknown field type.', [{ path: 'type', message: 'Unknown type.' }]);
    const label = (input.label ?? '').trim().slice(0, 80) || key;
    const exists = await this.e.db.selectFrom('custom_fields').select('id').where('workspace_id', '=', ctx.workspaceId).where('key', '=', key).executeTakeFirst();
    if (exists) throw new ConflictError(`A field with key "${key}" already exists.`);
    const row: Row<'custom_fields'> = {
      id: newId('fld'),
      workspace_id: ctx.workspaceId,
      key,
      label,
      type: input.type,
      options: input.type === 'select' ? toJson(this.checkOptions(input.type, input.options)) : null,
      created_at: this.e.nowIso(),
      archived_at: null,
    };
    await this.e.db.insertInto('custom_fields').values(row).execute();
    await this.e.audit.record(ctx, 'custom_field.created', { type: 'custom_field', id: row.id }, { key, type: input.type });
    return toDTO(row);
  }

  async update(ctx: WorkspaceContext, id: string, input: { label?: string; options?: string[] }): Promise<CustomFieldDTO> {
    authorize(ctx, 'contacts:write');
    const row = await this.e.db.selectFrom('custom_fields').selectAll().where('id', '=', id).where('workspace_id', '=', ctx.workspaceId).executeTakeFirst();
    if (!row) throw new NotFoundError('Custom field', id);
    const patch: Partial<Row<'custom_fields'>> = {};
    if (input.label !== undefined) patch.label = input.label.trim().slice(0, 80) || row.label;
    if (input.options !== undefined) patch.options = toJson(this.checkOptions(row.type, input.options));
    if (Object.keys(patch).length) await this.e.db.updateTable('custom_fields').set(patch).where('id', '=', id).execute();
    return toDTO({ ...row, ...patch });
  }

  async archive(ctx: WorkspaceContext, id: string): Promise<void> {
    authorize(ctx, 'contacts:write');
    const res = await this.e.db
      .updateTable('custom_fields')
      .set({ archived_at: this.e.nowIso() })
      .where('id', '=', id)
      .where('workspace_id', '=', ctx.workspaceId)
      .executeTakeFirst();
    if (Number(res.numUpdatedRows ?? 0) === 0) throw new NotFoundError('Custom field', id);
    await this.e.audit.record(ctx, 'custom_field.archived', { type: 'custom_field', id });
  }

  /** Custom values for many contacts, keyed by contact then field key. */
  async valuesFor(workspaceId: string, contactIds: string[], db: Db = this.e.db): Promise<Map<string, Record<string, CustomValue>>> {
    const out = new Map<string, Record<string, CustomValue>>();
    if (!contactIds.length) return out;
    for (const batch of chunk(contactIds, 500)) {
      const rows = await db
        .selectFrom('contact_field_values')
        .innerJoin('custom_fields', 'custom_fields.id', 'contact_field_values.field_id')
        .select(['contact_field_values.contact_id', 'custom_fields.key', 'custom_fields.type', 'contact_field_values.value_text', 'contact_field_values.value_number'])
        .where('contact_field_values.workspace_id', '=', workspaceId)
        .where('contact_field_values.contact_id', 'in', batch)
        .where('custom_fields.archived_at', 'is', null)
        .execute();
      for (const r of rows) {
        const rec = out.get(r.contact_id) ?? {};
        rec[r.key] =
          r.type === 'number' ? r.value_number : r.type === 'boolean' ? r.value_text === 'true' : r.value_text;
        out.set(r.contact_id, rec);
      }
    }
    return out;
  }

  /** Validate a value against a field definition, coercing strings where sensible. */
  coerce(def: Row<'custom_fields'>, value: unknown): { text: string | null; number: number | null } {
    if (value === null || value === undefined || value === '') return { text: null, number: null };
    const type = def.type as CustomFieldType;
    if (typeof value === 'string') {
      const parsed = parseCustomFieldValue({ key: def.key, type, options: fromJson<string[] | null>(def.options, null) }, value);
      if (parsed.error) throw new ValidationError(`Invalid value for ${def.label}.`, [{ path: `customFields.${def.key}`, message: parsed.error }]);
      value = parsed.value;
    }
    if (value === null) return { text: null, number: null };
    switch (type) {
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new ValidationError(`${def.label} must be a number.`, [{ path: `customFields.${def.key}`, message: 'Must be a number.' }]);
        return { text: String(value), number: value };
      case 'boolean':
        if (typeof value !== 'boolean') throw new ValidationError(`${def.label} must be yes or no.`, [{ path: `customFields.${def.key}`, message: 'Must be true or false.' }]);
        return { text: value ? 'true' : 'false', number: value ? 1 : 0 };
      case 'date':
        if (typeof value !== 'string' || !isValidLocalDate(value)) throw new ValidationError(`${def.label} must be a YYYY-MM-DD date.`, [{ path: `customFields.${def.key}`, message: 'Use YYYY-MM-DD.' }]);
        return { text: value, number: null };
      default:
        return { text: String(value).slice(0, 2000), number: null };
    }
  }

  /**
   * Upsert values for one contact. `null` deletes a value. In `fill_empty`
   * mode existing values are kept (used by non-destructive imports).
   */
  async setValues(
    workspaceId: string,
    contactId: string,
    values: Record<string, unknown>,
    db: Db = this.e.db,
    mode: 'merge' | 'fill_empty' = 'merge',
  ): Promise<string[]> {
    const keys = Object.keys(values);
    if (!keys.length) return [];
    const defs = await this.definitions(workspaceId, db);
    const byKey = new Map(defs.map((d) => [d.key, d]));
    const unknown = keys.filter((k) => !byKey.has(k));
    if (unknown.length) {
      throw new ValidationError(`Unknown custom field${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. Create them first.`, unknown.map((k) => ({ path: `customFields.${k}`, message: 'Unknown field.' })));
    }
    const existing =
      mode === 'fill_empty'
        ? new Set(
            (
              await db
                .selectFrom('contact_field_values')
                .select('field_id')
                .where('contact_id', '=', contactId)
                .where('value_text', 'is not', null)
                .execute()
            ).map((r) => r.field_id),
          )
        : new Set<string>();
    const changed: string[] = [];
    const now = this.e.nowIso();
    for (const key of keys) {
      const def = byKey.get(key)!;
      if (mode === 'fill_empty' && existing.has(def.id)) continue;
      const { text, number } = this.coerce(def, values[key]);
      if (text === null) {
        await db.deleteFrom('contact_field_values').where('contact_id', '=', contactId).where('field_id', '=', def.id).execute();
      } else {
        await db
          .insertInto('contact_field_values')
          .values({ workspace_id: workspaceId, contact_id: contactId, field_id: def.id, value_text: text, value_number: number, updated_at: now })
          .onConflict((oc) => oc.columns(['contact_id', 'field_id']).doUpdateSet({ value_text: text, value_number: number, updated_at: now }))
          .execute();
      }
      changed.push(key);
    }
    return changed;
  }
}
