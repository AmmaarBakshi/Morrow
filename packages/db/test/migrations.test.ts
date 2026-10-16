import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectDatabase, migrationStatus, parseDatabaseUrl, redactUrl, type DatabaseHandle } from '../src';
import { migrateToLatest } from '../src/migrate';
import { MIGRATIONS } from '../src/migrations';
import { escapeLike, fromJson, isUniqueViolation } from '../src/util';

const now = new Date().toISOString();

for (const dialect of ['sqlite', 'postgres'] as const) {
  describe(`migrations on ${dialect}`, () => {
    let h: DatabaseHandle;

    beforeAll(async () => {
      h = await connectDatabase(dialect === 'sqlite' ? 'sqlite::memory:' : 'pglite:memory');
      await migrateToLatest(h.db);
    });
    afterAll(async () => {
      await h.close();
    });

    it('applies every migration exactly once', async () => {
      const status = await migrationStatus(h.db);
      expect(status.map((s) => s.name)).toEqual(Object.keys(MIGRATIONS));
      expect(status.every((s) => s.executedAt)).toBe(true);
      const again = await migrateToLatest(h.db);
      expect(again.applied).toEqual([]);
    });

    it('enforces workspace-scoped e-mail uniqueness while allowing many contacts without e-mail', async () => {
      await h.db
        .insertInto('workspaces')
        .values({ id: 'wsp_1', name: 'Cyphen', slug: `cyphen-${dialect}`, timezone: 'Asia/Kolkata', settings: '{}', created_at: now, updated_at: now })
        .execute();
      const contact = (id: string, email: string | null) => ({
        id,
        workspace_id: 'wsp_1',
        first_name: 'R',
        last_name: null,
        email,
        email_normalized: email,
        email_status: 'unknown',
        company: null,
        job_title: null,
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
        source: null,
        consent_status: 'granted',
        consent_updated_at: null,
        consent_source: null,
        status: 'active',
        archived_at: null,
        last_interaction_at: null,
        last_emailed_at: null,
        search_text: 'r',
        created_at: now,
        updated_at: now,
      });
      await h.db.insertInto('contacts').values(contact('con_1', 'rahul@example.com')).execute();
      await h.db.insertInto('contacts').values([contact('con_2', null), contact('con_3', null)]).execute();
      const dup = await h.db.insertInto('contacts').values(contact('con_4', 'rahul@example.com')).execute().catch((e) => e);
      expect(isUniqueViolation(dup)).toBe(true);
    });

    it('allows only one active suppression per address but keeps lifted history', async () => {
      const sup = (id: string, lifted: string | null) => ({
        id,
        workspace_id: 'wsp_1',
        email_normalized: 'rahul@example.com',
        reason: 'unsubscribed',
        scope: 'marketing',
        source: null,
        message_id: null,
        note: null,
        created_by: null,
        created_at: now,
        lifted_at: lifted,
        lifted_by: null,
      });
      await h.db.insertInto('suppressions').values(sup('sup_1', now)).execute();
      await h.db.insertInto('suppressions').values(sup('sup_2', null)).execute();
      const dup = await h.db.insertInto('suppressions').values(sup('sup_3', null)).execute().catch((e) => e);
      expect(isUniqueViolation(dup)).toBe(true);
    });

    it('ignores duplicate jobs by dedupe key with ON CONFLICT DO NOTHING', async () => {
      const job = (id: string) => ({
        id,
        workspace_id: 'wsp_1',
        type: 'email.send',
        payload: '{}',
        status: 'queued',
        priority: 0,
        run_at: now,
        attempts: 0,
        max_attempts: 5,
        dedupe_key: 'send:msg_1',
        locked_by: null,
        locked_until: null,
        last_error: null,
        created_at: now,
        updated_at: now,
        finished_at: null,
      });
      const first = await h.db.insertInto('jobs').values(job('job_1')).onConflict((oc) => oc.doNothing()).returning('id').execute();
      const second = await h.db.insertInto('jobs').values(job('job_2')).onConflict((oc) => oc.doNothing()).returning('id').execute();
      expect(first).toEqual([{ id: 'job_1' }]);
      expect(second).toEqual([]);
    });

    it('returns COUNT(*) as a JavaScript number', async () => {
      const row = await h.db.selectFrom('contacts').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow();
      expect(row.n).toBe(3);
    });

    it('cascades workspace deletion', async () => {
      await h.db.deleteFrom('workspaces').where('id', '=', 'wsp_1').execute();
      const left = await h.db.selectFrom('contacts').select('id').execute();
      expect(left).toEqual([]);
    });
  });
}

describe('database URLs and helpers', () => {
  it('parses supported URL forms', () => {
    expect(parseDatabaseUrl('sqlite:./data/morrow.db')).toEqual({ kind: 'sqlite', path: './data/morrow.db' });
    expect(parseDatabaseUrl('file:morrow.db')).toEqual({ kind: 'sqlite', path: 'morrow.db' });
    expect(parseDatabaseUrl(':memory:')).toEqual({ kind: 'sqlite', path: ':memory:' });
    expect(parseDatabaseUrl('postgres://u:p@localhost/db')).toEqual({ kind: 'postgres', url: 'postgres://u:p@localhost/db' });
    expect(parseDatabaseUrl('pglite:memory')).toEqual({ kind: 'pglite', dataDir: undefined });
    expect(() => parseDatabaseUrl('mysql://x')).toThrow(/Unsupported/);
  });

  it('redacts credentials', () => {
    expect(redactUrl('postgres://morrow:s3cret@db:5432/morrow')).toBe('postgres://morrow:***@db:5432/morrow');
  });

  it('parses JSON defensively and escapes LIKE patterns', () => {
    expect(fromJson('{"a":1}', {})).toEqual({ a: 1 });
    expect(fromJson('not json', { ok: true })).toEqual({ ok: true });
    expect(fromJson(null, [])).toEqual([]);
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
  });
});
