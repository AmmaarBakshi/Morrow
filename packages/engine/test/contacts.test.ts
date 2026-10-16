import { afterEach, describe, expect, it } from 'vitest';
import { ConflictError, ValidationError, type CriteriaGroup } from '@morrow/core';
import { createHarness, type Harness } from './helpers';

let h: Harness;
afterEach(async () => h?.close());

describe('contacts', () => {
  it('creates contacts with tags, custom fields and consent history', async () => {
    h = await createHarness();
    await h.engine.fields.create(h.ctx, { key: 'plan', label: 'Plan', type: 'select', options: ['Free', 'Pro'] });
    await h.engine.fields.create(h.ctx, { key: 'seats', label: 'Seats', type: 'number' });
    const c = await h.engine.contacts.create(h.ctx, {
      firstName: 'Priya',
      email: 'Priya.Shah@Example.com',
      tags: ['vip', 'beta tester'],
      customFields: { plan: 'pro', seats: 12 },
      consentStatus: 'granted',
      consentSource: 'Website newsletter form',
      birthday: { month: 11, day: 2 },
    });
    expect(c.email).toBe('Priya.Shah@Example.com');
    expect(c.tags.map((t) => t.name)).toEqual(['beta tester', 'vip']);
    expect(c.customFields).toEqual({ plan: 'Pro', seats: 12 });
    expect(c.birthday).toEqual({ month: 11, day: 2, year: null });
    const history = await h.engine.contacts.consentHistory(h.ctx, c.id);
    expect(history).toMatchObject([{ fromStatus: null, toStatus: 'granted', source: 'Website newsletter form' }]);
  });

  it('detects duplicates by normalised e-mail', async () => {
    h = await createHarness();
    await h.contact({ email: 'rahul@example.com', firstName: 'Rahul' });
    await expect(h.contact({ email: '  RAHUL@example.com ' })).rejects.toBeInstanceOf(ConflictError);
  });

  it('requires a consent source and refuses to re-grant consent after an opt-out', async () => {
    h = await createHarness();
    await expect(h.contact({ email: 'a@example.com', consentStatus: 'granted' })).rejects.toBeInstanceOf(ValidationError);
    const id = await h.contact({ email: 'b@example.com', consentStatus: 'granted', consentSource: 'form' });
    await h.engine.contacts.setConsent(h.ctx, id, { status: 'withdrawn', source: 'Replied STOP' });
    expect((await h.engine.contacts.get(h.ctx, id)).suppression?.reason).toBe('unsubscribed');
    // An analyst cannot change consent at all.
    await expect(h.engine.contacts.setConsent(h.as('analyst'), id, { status: 'granted', source: 'x' })).rejects.toThrow(/cannot perform/);
    // Re-consent needs a recorded source and lifts the unsubscribe.
    await h.engine.contacts.setConsent(h.ctx, id, { status: 'granted', source: 'Signed new consent form on 2027-03-01' });
    const after = await h.engine.contacts.get(h.ctx, id);
    expect(after.consentStatus).toBe('granted');
    expect(after.suppression).toBeNull();
  });

  it('records custom events that can identify contacts by e-mail', async () => {
    h = await createHarness();
    const res = await h.engine.contacts.recordEvent(h.ctx, {
      email: 'new.client@example.com',
      name: 'project.completed',
      properties: { project_name: 'Orbit Analytics' },
      contact: { firstName: 'New', relationshipType: 'client' },
      dedupeKey: 'proj-42',
    });
    expect(res.contactCreated).toBe(true);
    const dup = await h.engine.contacts.recordEvent(h.ctx, { email: 'new.client@example.com', name: 'project.completed', dedupeKey: 'proj-42' });
    expect(dup).toMatchObject({ duplicate: true, eventId: res.eventId });
    await expect(h.engine.contacts.recordEvent(h.ctx, { email: 'x@example.com', name: 'bad name!' })).rejects.toBeInstanceOf(ValidationError);
    const timeline = await h.engine.contacts.timeline(h.ctx, res.contactId);
    expect(timeline.some((t) => t.type === 'event' && t.title === 'project.completed')).toBe(true);
  });

  it('lists upcoming birthdays and anniversaries', async () => {
    h = await createHarness({ start: '2027-12-28T06:00:00Z' });
    await h.contact({ firstName: 'Soon', email: 'soon@example.com', birthday: { month: 1, day: 2 } });
    await h.contact({ firstName: 'Later', email: 'later@example.com', birthday: { month: 6, day: 1 } });
    await h.contact({ firstName: 'Anniv', email: 'anniv@example.com', workAnniversary: '2024-12-30' });
    const upcoming = await h.engine.contacts.upcomingOccasions(h.ctx, { days: 14 });
    expect(upcoming.map((o) => [o.name, o.kind, o.date, o.daysAway, o.years])).toEqual([
      ['Anniv', 'work_anniversary', '2027-12-30', 2, 3],
      ['Soon', 'birthday', '2028-01-02', 5, null],
    ]);
  });

  it('exports CSV safely and audits the export', async () => {
    h = await createHarness();
    await h.contact({ firstName: '=HYPERLINK("http://evil")', email: 'csv@example.com', tags: ['a'] });
    let csv = '';
    for await (const chunk of h.engine.contacts.exportCsv(h.ctx)) csv += chunk;
    expect(csv.split('\r\n')[0]).toContain('first_name');
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
    const audit = await h.engine.audit.list(h.ctx, { action: 'contacts.exported' });
    expect(audit).toHaveLength(1);
    const analystExport = h.engine.contacts.exportCsv(h.as('analyst'));
    await expect(analystExport.next()).rejects.toThrow(/cannot perform/);
  });

  it('erases a contact but keeps them suppressed', async () => {
    h = await createHarness();
    const id = await h.contact({ firstName: 'Forget', email: 'forget@example.com' });
    await expect(h.engine.contacts.erase(h.as('manager'), id)).rejects.toThrow(/cannot perform/);
    await h.engine.contacts.erase(h.ctx, id);
    await expect(h.engine.contacts.get(h.ctx, id)).rejects.toThrow(/not found/);
    expect(await h.engine.suppressions.active(h.workspaceId, 'forget@example.com')).toBeTruthy();
  });
});

describe('segments', () => {
  it('evaluates nested criteria in the database', async () => {
    h = await createHarness();
    await h.contact({ firstName: 'A', email: 'a@client.dev', relationshipType: 'client', tags: ['vip'], consentStatus: 'granted', consentSource: 'form' });
    await h.contact({ firstName: 'B', email: 'b@client.dev', relationshipType: 'client', consentStatus: 'granted', consentSource: 'form' });
    await h.contact({ firstName: 'C', email: 'c@lead.io', relationshipType: 'lead', tags: ['vip'] });
    await h.contact({ firstName: 'D', email: 'd@lead.io', relationshipType: 'lead', company: 'Acme Robotics' });
    const criteria: CriteriaGroup = {
      kind: 'group',
      match: 'any',
      rules: [
        { kind: 'group', match: 'all', rules: [{ kind: 'field', field: 'relationship_type', op: 'eq', value: 'client' }, { kind: 'tag', op: 'has', tag: 'VIP' }] },
        { kind: 'field', field: 'company', op: 'contains', value: 'robot' },
      ],
    };
    const preview = await h.engine.segments.preview(h.ctx, criteria);
    expect(preview.count).toBe(2);
    expect(preview.sample.map((s) => s.name).sort()).toEqual(['A', 'D']);

    const vip = await h.engine.segments.create(h.ctx, { name: 'VIPs', criteria: { kind: 'group', match: 'all', rules: [{ kind: 'tag', op: 'has', tag: 'vip' }] } });
    expect(vip.count).toBe(2);
    const notVip = await h.engine.segments.preview(h.ctx, {
      kind: 'group',
      match: 'all',
      rules: [{ kind: 'segment', op: 'not_in', segmentId: vip.id }, { kind: 'field', field: 'email_domain', op: 'eq', value: 'lead.io' }],
    });
    expect(notVip.sample.map((s) => s.name)).toEqual(['D']);
    const granted = await h.engine.segments.preview(h.ctx, { kind: 'group', match: 'all', rules: [{ kind: 'field', field: 'consent_status', op: 'in', value: ['granted'] }] });
    expect(granted.count).toBe(2);
  });

  it('rejects self-referencing segments and invalid rules', async () => {
    h = await createHarness();
    const seg = await h.engine.segments.create(h.ctx, { name: 'All', criteria: { kind: 'group', match: 'all', rules: [] } });
    await expect(
      h.engine.segments.update(h.ctx, seg.id, { criteria: { kind: 'group', match: 'all', rules: [{ kind: 'segment', op: 'in', segmentId: seg.id }] } }),
    ).rejects.toThrow(/itself/);
    await expect(h.engine.segments.preview(h.ctx, { kind: 'group', match: 'all', rules: [{ kind: 'field', field: 'password', op: 'eq', value: 'x' }] })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('CSV import', () => {
  const csv = [
    'Name,E-mail,Birthday,Tags,Marketing consent,Company',
    'Rahul Mehta,rahul@example.com,07/03/1990,client;vip,yes,Northwind',
    'Priya Shah,PRIYA@example.com,2 November,,yes,',
    'Bad Row,not-an-email,31/02/1990,,,',
    'Rahul Again,Rahul@Example.com,,,,',
    'Existing Person,existing@example.com,,,yes,New Co',
    'Unsub Person,unsub@example.com,,,yes,',
  ].join('\n');

  it('previews, reports problems and commits without corrupting existing data', async () => {
    h = await createHarness();
    await h.contact({ firstName: 'Existing', lastName: 'Person', email: 'existing@example.com', company: 'Old Co' });
    await h.engine.suppressions.add(h.ctx, { email: 'unsub@example.com', reason: 'unsubscribed' });

    const upload = await h.engine.imports.upload(h.ctx, { filename: 'contacts.csv', csv });
    expect(upload.rowCount).toBe(6);
    expect(upload.suggestedMapping).toEqual(['full_name', 'email', 'birthday', 'tags', 'consent_status', 'company']);

    const options = { duplicateStrategy: 'update_empty' as const, consentSource: 'Imported from 2026 webinar sign-ups' };
    const preview = await h.engine.imports.preview(h.ctx, upload.id, { mapping: upload.suggestedMapping, options });
    expect(preview).toMatchObject({ total: 6, invalid: 1, duplicatesInFile: 1, existing: 1, conflicts: 1, willCreate: 3, willUpdate: 1, willSkip: 1 });
    expect(preview.issues.find((i) => i.row === 4)?.errors.join(' ')).toMatch(/Invalid e-mail/);
    expect(preview.issues.find((i) => i.row === 6)?.conflicts?.[0]).toMatch(/company/);
    expect(preview.issues.find((i) => i.row === 7)?.warnings.join(' ')).toMatch(/cannot re-grant consent/);
    // Preview writes nothing.
    expect((await h.engine.contacts.list(h.ctx)).total).toBe(1);

    const report = await h.engine.imports.commit(h.ctx, upload.id, { mapping: upload.suggestedMapping, options });
    expect(report).toMatchObject({ created: 3, updated: 1, failed: 0 });
    const contacts = (await h.engine.contacts.list(h.ctx, { pageSize: 50 })).items;
    const rahul = contacts.find((c) => c.email === 'rahul@example.com')!;
    expect(rahul).toMatchObject({ firstName: 'Rahul', lastName: 'Mehta', birthday: { month: 3, day: 7, year: 1990 }, consentStatus: 'granted' });
    expect(rahul.tags.map((t) => t.name).sort()).toEqual(['client', 'vip']);
    // Conflicting values were not overwritten with "update empty".
    expect(contacts.find((c) => c.email === 'existing@example.com')!.company).toBe('Old Co');
    // A suppressed address never gets consent from an import.
    expect(contacts.find((c) => c.email === 'unsub@example.com')!.consentStatus).toBe('withdrawn');
    // The raw file is discarded once processed.
    const stored = await h.engine.db.selectFrom('imports').select(['csv', 'status']).where('id', '=', upload.id).executeTakeFirstOrThrow();
    expect(stored).toEqual({ csv: null, status: 'committed' });
    await expect(h.engine.imports.commit(h.ctx, upload.id, { mapping: upload.suggestedMapping, options })).rejects.toThrow(/already been processed/);
  });

  it('overwrites only when explicitly asked', async () => {
    h = await createHarness();
    await h.contact({ firstName: 'Existing', email: 'existing@example.com', company: 'Old Co' });
    const upload = await h.engine.imports.upload(h.ctx, { filename: 'c.csv', csv: 'email,company\nexisting@example.com,New Co\n' });
    await h.engine.imports.commit(h.ctx, upload.id, { mapping: upload.suggestedMapping, options: { duplicateStrategy: 'overwrite' } });
    const c = (await h.engine.contacts.list(h.ctx)).items[0]!;
    expect(c.company).toBe('New Co');
  });
});
