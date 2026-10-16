import { afterEach, describe, expect, it } from 'vitest';
import { MorrowApiError, MorrowClient, MorrowNetworkError } from '@morrow/sdk';
import { createServerHarness, type ServerHarness } from './client';

let h: ServerHarness;
afterEach(async () => h?.close());

/** An SDK client whose fetch goes straight into the Hono app (no sockets). */
function sdk(harness: ServerHarness, token?: string) {
  const fetchViaApp = ((input: string | URL | Request, init?: RequestInit) => harness.app.request(String(input), init)) as typeof fetch;
  return new MorrowClient({ baseUrl: 'https://morrow.test', token, fetch: fetchViaApp });
}

describe('@morrow/sdk against the real API', () => {
  it('signs in for a token and drives contacts, events and automations', async () => {
    h = await createServerHarness();
    const anon = sdk(h);
    const setup = await anon.auth.setup();
    expect(setup.hasUsers).toBe(true);
    const { token, session } = await anon.auth.login({ email: 'owner@cyphen.dev', password: 'correct horse battery staple', issueToken: true });
    expect(token).toBeTruthy();
    expect(session.role).toBe('owner');
    const morrow = anon.configure({ token });

    const lead = await morrow.contacts.create({ firstName: 'Priya', email: 'priya@example.com', relationshipType: 'lead', consentStatus: 'implied', consentSource: 'Requested a proposal' });
    const id = (await morrow.automations.list()).items.find((a) => a.name === 'Proposal follow-up')!.id;
    await morrow.automations.activate(id, 'auto');
    const event = await morrow.events.record({ email: 'priya@example.com', name: 'proposal.sent', properties: { proposal_name: 'the Atlas proposal' }, dedupeKey: 'proposal-1' });
    expect(event).toMatchObject({ contactId: lead.id, duplicate: false });
    expect((await morrow.events.record({ email: 'priya@example.com', name: 'proposal.sent', dedupeKey: 'proposal-1' })).duplicate).toBe(true);
    await h.drain();
    const runs = await morrow.automations.runs(id);
    expect(runs.items.map((r) => r.status)).toEqual(['waiting']);

    const timeline = await morrow.contacts.timeline(lead.id);
    expect(timeline.items.some((t) => t.title.includes('proposal.sent'))).toBe(true);
  });

  it('raises typed errors with field issues', async () => {
    h = await createServerHarness();
    const { token } = await sdk(h).auth.login({ email: 'owner@cyphen.dev', password: 'correct horse battery staple', issueToken: true });
    const morrow = sdk(h, token);
    const err = await morrow.contacts.create({ email: 'not-an-email' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MorrowApiError);
    expect((err as MorrowApiError).status).toBe(422);
    expect((err as MorrowApiError).issues.length).toBeGreaterThan(0);
    const missing = await morrow.contacts.get('ctc_missing').catch((e: unknown) => e);
    expect((missing as MorrowApiError).code).toBe('not_found');

    const offline = new MorrowClient({ baseUrl: 'http://127.0.0.1:9', fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
    await expect(offline.auth.setup()).rejects.toBeInstanceOf(MorrowNetworkError);
  });

  it('works with API keys for imports, paging and exports', async () => {
    h = await createServerHarness();
    const { token } = await sdk(h).auth.login({ email: 'owner@cyphen.dev', password: 'correct horse battery staple', issueToken: true });
    const created = await sdk(h, token).workspace.createApiKey({ name: 'Cyphen sync', role: 'manager' });
    const morrow = sdk(h, created.key);
    expect((await morrow.auth.whoami()).apiKey?.name).toBe('Cyphen sync');

    const rows = Array.from({ length: 5 }, (_, i) => `Dev ${i},dev${i}@example.com,developer`).join('\n');
    const upload = await morrow.imports.upload('devs.csv', `Name,Email,Type\n${rows}\n`);
    const mapping = upload.suggestedMapping;
    expect(mapping).toEqual(['full_name', 'email', 'relationship_type']);
    const preview = await morrow.imports.preview(upload.id, { mapping });
    expect(preview.willCreate).toBe(5);
    const report = await morrow.imports.commit(upload.id, { mapping, options: { addTags: ['imported'] } });
    expect(report.created).toBe(5);

    const seen: string[] = [];
    for await (const c of morrow.contacts.all({ tag: 'imported', pageSize: 2, sort: 'email', dir: 'asc' })) seen.push(c.email!);
    expect(seen).toEqual(['dev0@example.com', 'dev1@example.com', 'dev2@example.com', 'dev3@example.com', 'dev4@example.com']);

    const csv = await morrow.contacts.exportCsv({ tag: 'imported' });
    expect(csv.trim().split(/\r?\n/)).toHaveLength(6); // header + five contacts
  });
});
