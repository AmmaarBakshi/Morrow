import { ConflictError, newId, NotFoundError, tagNameSchema, ValidationError, type TagDTO } from '@morrow/core';
import { chunk, isUniqueViolation, type Db, type Row } from '@morrow/db';
import { authorize, type WorkspaceContext } from '../context';
import type { Engine } from '../engine';

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function normalizeTag(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

function toDTO(r: Row<'tags'>, count?: number): TagDTO {
  return { id: r.id, name: r.name, color: r.color, ...(count !== undefined ? { contactCount: count } : {}) };
}

export class TagsService {
  constructor(private readonly e: Engine) {}

  async list(ctx: WorkspaceContext): Promise<TagDTO[]> {
    authorize(ctx, 'contacts:read');
    const rows = await this.e.db
      .selectFrom('tags')
      .leftJoin('contact_tags', 'contact_tags.tag_id', 'tags.id')
      .select(['tags.id', 'tags.name', 'tags.color', 'tags.name_normalized', 'tags.workspace_id', 'tags.created_at', (eb) => eb.fn.count<number>('contact_tags.contact_id').as('n')])
      .where('tags.workspace_id', '=', ctx.workspaceId)
      .groupBy(['tags.id', 'tags.name', 'tags.color', 'tags.name_normalized', 'tags.workspace_id', 'tags.created_at'])
      .orderBy('tags.name_normalized', 'asc')
      .execute();
    return rows.map((r) => toDTO(r, Number(r.n)));
  }

  async create(ctx: WorkspaceContext, input: { name: string; color?: string | null }): Promise<TagDTO> {
    authorize(ctx, 'contacts:write');
    const parsed = tagNameSchema.safeParse(input.name);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid tag name.', [{ path: 'name', message: 'Invalid tag name.' }]);
    if (input.color && !COLOR_RE.test(input.color)) throw new ValidationError('Use a hex colour.', [{ path: 'color', message: 'Use #rrggbb.' }]);
    const row: Row<'tags'> = {
      id: newId('tag'),
      workspace_id: ctx.workspaceId,
      name: parsed.data,
      name_normalized: normalizeTag(parsed.data),
      color: input.color ?? null,
      created_at: this.e.nowIso(),
    };
    try {
      await this.e.db.insertInto('tags').values(row).execute();
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError(`Tag "${parsed.data}" already exists.`);
      throw err;
    }
    return toDTO(row, 0);
  }

  async update(ctx: WorkspaceContext, id: string, input: { name?: string; color?: string | null }): Promise<TagDTO> {
    authorize(ctx, 'contacts:write');
    const row = await this.e.db.selectFrom('tags').selectAll().where('id', '=', id).where('workspace_id', '=', ctx.workspaceId).executeTakeFirst();
    if (!row) throw new NotFoundError('Tag', id);
    const patch: Partial<Row<'tags'>> = {};
    if (input.name !== undefined) {
      const parsed = tagNameSchema.safeParse(input.name);
      if (!parsed.success) throw new ValidationError('Invalid tag name.', [{ path: 'name', message: 'Invalid tag name.' }]);
      patch.name = parsed.data;
      patch.name_normalized = normalizeTag(parsed.data);
    }
    if (input.color !== undefined) {
      if (input.color && !COLOR_RE.test(input.color)) throw new ValidationError('Use a hex colour.');
      patch.color = input.color;
    }
    try {
      await this.e.db.updateTable('tags').set(patch).where('id', '=', id).execute();
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError('A tag with that name already exists.');
      throw err;
    }
    return toDTO({ ...row, ...patch });
  }

  async remove(ctx: WorkspaceContext, id: string): Promise<void> {
    authorize(ctx, 'contacts:write');
    const res = await this.e.db.deleteFrom('tags').where('id', '=', id).where('workspace_id', '=', ctx.workspaceId).executeTakeFirst();
    if (Number(res.numDeletedRows ?? 0) === 0) throw new NotFoundError('Tag', id);
    await this.e.audit.record(ctx, 'tag.deleted', { type: 'tag', id });
  }

  /** Find or create tags by name (case-insensitive). */
  async ensure(workspaceId: string, names: string[], db: Db = this.e.db): Promise<Row<'tags'>[]> {
    const wanted = new Map<string, string>();
    for (const n of names) {
      const parsed = tagNameSchema.safeParse(n);
      if (parsed.success) wanted.set(normalizeTag(parsed.data), parsed.data);
    }
    if (!wanted.size) return [];
    const existing = await db.selectFrom('tags').selectAll().where('workspace_id', '=', workspaceId).where('name_normalized', 'in', [...wanted.keys()]).execute();
    const have = new Set(existing.map((t) => t.name_normalized));
    const now = this.e.nowIso();
    for (const [norm, name] of wanted) {
      if (have.has(norm)) continue;
      await db
        .insertInto('tags')
        .values({ id: newId('tag'), workspace_id: workspaceId, name, name_normalized: norm, color: null, created_at: now })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
    return db.selectFrom('tags').selectAll().where('workspace_id', '=', workspaceId).where('name_normalized', 'in', [...wanted.keys()]).execute();
  }

  /** Attach tags to a contact. Returns the names that were newly attached. */
  async attach(workspaceId: string, contactId: string, names: string[], db: Db = this.e.db): Promise<string[]> {
    const tags = await this.ensure(workspaceId, names, db);
    const added: string[] = [];
    const now = this.e.nowIso();
    for (const t of tags) {
      const res = await db
        .insertInto('contact_tags')
        .values({ workspace_id: workspaceId, contact_id: contactId, tag_id: t.id, created_at: now })
        .onConflict((oc) => oc.doNothing())
        .returning('tag_id')
        .executeTakeFirst();
      if (res) added.push(t.name);
    }
    return added;
  }

  async detach(workspaceId: string, contactId: string, names: string[], db: Db = this.e.db): Promise<string[]> {
    const norms = names.map(normalizeTag).filter(Boolean);
    if (!norms.length) return [];
    const tags = await db.selectFrom('tags').selectAll().where('workspace_id', '=', workspaceId).where('name_normalized', 'in', norms).execute();
    if (!tags.length) return [];
    const res = await db
      .deleteFrom('contact_tags')
      .where('contact_id', '=', contactId)
      .where('tag_id', 'in', tags.map((t) => t.id))
      .returning('tag_id')
      .execute();
    const removed = new Set(res.map((r) => r.tag_id));
    return tags.filter((t) => removed.has(t.id)).map((t) => t.name);
  }

  async forContacts(workspaceId: string, contactIds: string[], db: Db = this.e.db): Promise<Map<string, TagDTO[]>> {
    const out = new Map<string, TagDTO[]>();
    for (const batch of chunk(contactIds, 500)) {
      const rows = await db
        .selectFrom('contact_tags')
        .innerJoin('tags', 'tags.id', 'contact_tags.tag_id')
        .select(['contact_tags.contact_id', 'tags.id', 'tags.name', 'tags.color'])
        .where('contact_tags.workspace_id', '=', workspaceId)
        .where('contact_tags.contact_id', 'in', batch)
        .orderBy('tags.name_normalized', 'asc')
        .execute();
      for (const r of rows) {
        const list = out.get(r.contact_id) ?? [];
        list.push({ id: r.id, name: r.name, color: r.color });
        out.set(r.contact_id, list);
      }
    }
    return out;
  }
}
