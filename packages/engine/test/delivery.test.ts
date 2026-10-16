import { afterEach, describe, expect, it } from 'vitest';
import { ResendProvider, signSvix, type EmailProvider } from '@morrow/email';
import { createHarness, type Harness } from './helpers';

let h: Harness;
afterEach(async () => h?.close());

/** Queue one relationship e-mail to a new contact through the real pipeline. */
async function queueTo(harness: Harness, email: string, opts: { key?: string; consent?: 'granted' | 'unknown' } = {}) {
  const contactId = await harness.contact({ firstName: 'Test', email, consentStatus: opts.consent ?? 'granted', consentSource: opts.consent === 'unknown' ? null : 'form' });
  const contact = await harness.engine.contacts.row(harness.workspaceId, contactId);
  const tpl = (await harness.engine.templates.publishedSource(harness.workspaceId, await harness.templateId('Welcome')))!;
  const result = await harness.engine.delivery.prepare({
    workspaceId: harness.workspaceId,
    kind: 'automation',
    category: 'relationship',
    idempotencyKey: opts.key ?? `test:${email}`,
    contact,
    template: tpl,
    sender: { email: 'hello@cyphen.dev', name: 'Cyphen', replyTo: null },
  });
  return { contactId, result };
}

const message = (harness: Harness, id: string) => harness.engine.db.selectFrom('messages').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

describe('delivery pipeline', () => {
  it('creates exactly one message per idempotency key', async () => {
    h = await createHarness();
    const first = await queueTo(h, 'one@example.com', { key: 'same-key' });
    const contact = await h.engine.contacts.row(h.workspaceId, first.contactId);
    const tpl = (await h.engine.templates.publishedSource(h.workspaceId, await h.templateId('Welcome')))!;
    const second = await h.engine.delivery.prepare({
      workspaceId: h.workspaceId,
      kind: 'automation',
      category: 'relationship',
      idempotencyKey: 'same-key',
      contact,
      template: tpl,
      sender: { email: 'hello@cyphen.dev', name: 'Cyphen', replyTo: null },
    });
    expect(first.result.outcome).toBe('queued');
    expect(second).toMatchObject({ outcome: 'duplicate', messageId: first.result.messageId });
    await h.drain();
    expect(h.provider.outbox).toHaveLength(1);
  });

  it('retries transient failures with backoff and then succeeds', async () => {
    h = await createHarness();
    const { result } = await queueTo(h, 'test+flaky@example.com');
    await h.drain();
    let m = await message(h, result.messageId);
    expect(m.status).toBe('queued');
    expect(m.error_class).toBe('transient');
    h.clock.advanceMinutes(2);
    await h.drain();
    m = await message(h, result.messageId);
    expect(m.status).toBe('delivered');
    expect(m.attempts).toBe(2);
  });

  it('does not retry permanent failures and suppresses invalid recipients', async () => {
    h = await createHarness();
    const { result, contactId } = await queueTo(h, 'test+reject@example.com');
    await h.drain();
    const m = await message(h, result.messageId);
    expect(m.status).toBe('rejected');
    expect(m.error_class).toBe('permanent');
    expect(m.attempts).toBe(1);
    const job = await h.engine.db.selectFrom('jobs').selectAll().where('type', '=', 'email.send').executeTakeFirstOrThrow();
    expect(job.status).toBe('failed');
    expect(await h.engine.suppressions.active(h.workspaceId, 'test+reject@example.com')).toMatchObject({ reason: 'invalid_address', scope: 'all' });
    expect((await h.engine.contacts.get(h.ctx, contactId)).emailStatus).toBe('invalid');
  });

  it('dead-letters a message after the maximum attempts', async () => {
    h = await createHarness();
    const { result } = await queueTo(h, 'test+fail@example.com');
    for (let i = 0; i < 10; i++) {
      await h.drain();
      h.clock.advance(7 * 3_600_000);
    }
    const m = await message(h, result.messageId);
    expect(m.status).toBe('failed');
    expect(m.attempts).toBe(8);
    const job = await h.engine.db.selectFrom('jobs').selectAll().where('type', '=', 'email.send').executeTakeFirstOrThrow();
    expect(job.status).toBe('dead');
    const notes = await h.engine.notifications.list(h.ctx);
    expect(notes.items.some((n) => n.kind === 'delivery.failed')).toBe(true);
    // Operators can retry a dead job after fixing the cause.
    expect(await h.engine.system.retryJob(h.ctx, job.id)).toBe(true);
    expect((await message(h, result.messageId)).status).toBe('queued');
  });

  it('records hard bounces and suppresses the address everywhere', async () => {
    h = await createHarness();
    const { result } = await queueTo(h, 'test+bounce@example.com');
    await h.drain();
    const m = await message(h, result.messageId);
    expect(m.status).toBe('bounced');
    expect(m.bounce_type).toBe('hard');
    expect(await h.engine.suppressions.active(h.workspaceId, 'test+bounce@example.com')).toMatchObject({ reason: 'hard_bounce' });
    // Even transactional mail is now blocked.
    const elig = await h.engine.delivery.eligibility(h.workspaceId, null, 'test+bounce@example.com', 'transactional', (await h.engine.workspaces.settings(h.workspaceId)).settings);
    expect(elig.eligible).toBe(false);
  });

  it('withdraws consent and suppresses on spam complaints', async () => {
    h = await createHarness();
    const { result, contactId } = await queueTo(h, 'test+complaint@example.com');
    await h.drain();
    expect((await message(h, result.messageId)).status).toBe('complained');
    const contact = await h.engine.contacts.get(h.ctx, contactId);
    expect(contact.consentStatus).toBe('withdrawn');
    expect(contact.suppression?.reason).toBe('complaint');
    await expect(h.engine.contacts.setConsent(h.ctx, contactId, { status: 'granted', source: 'phone call' })).rejects.toThrow(/spam/);
  });

  it('applies events idempotently and never moves a message backwards', async () => {
    h = await createHarness();
    const { result } = await queueTo(h, 'order@example.com');
    const worker = h.engine.createWorker({ id: 'send-only', types: ['email.send'] });
    await worker.drain();
    const m = await message(h, result.messageId);
    const pmid = m.provider_message_id!;
    const delivered = { providerEventId: 'evt-delivered', providerMessageId: pmid, type: 'delivered' as const, occurredAt: '2027-03-06T12:05:00Z' };
    const lateAccepted = { providerEventId: 'evt-accepted-late', providerMessageId: pmid, type: 'accepted' as const, occurredAt: '2027-03-06T12:00:01Z' };
    const r1 = await h.engine.delivery.ingestEvents(h.workspaceId, 'fake', [delivered]);
    const r2 = await h.engine.delivery.ingestEvents(h.workspaceId, 'fake', [delivered, lateAccepted]);
    expect(r1).toMatchObject({ processed: 1, duplicates: 0 });
    expect(r2).toMatchObject({ processed: 1, duplicates: 1 });
    const after = await message(h, result.messageId);
    expect(after.status).toBe('delivered');
    expect(after.delivered_at).toBe('2027-03-06T12:05:00.000Z');
    const unknown = await h.engine.delivery.ingestEvents(h.workspaceId, 'fake', [{ ...delivered, providerEventId: 'x', providerMessageId: 'nope' }]);
    expect(unknown.unknown).toHaveLength(1);
  });

  it('verifies signed provider webhooks before trusting them', async () => {
    const secret = `whsec_${Buffer.from('test-signing-key').toString('base64')}`;
    const fetchStub = (async () => new Response(JSON.stringify({ id: 're_msg_1' }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const resend = new ResendProvider({ apiKey: 're_test', webhookSecret: secret, fetch: fetchStub });
    h = await createHarness({ provider: resend as EmailProvider });
    const { result } = await queueTo(h, 'hook@example.com');
    const worker = h.engine.createWorker({ id: 'send-only', types: ['email.send'] });
    await worker.drain();
    expect((await message(h, result.messageId)).provider_message_id).toBe('re_msg_1');

    const body = JSON.stringify({ type: 'email.delivered', created_at: '2027-03-06T12:10:00Z', data: { email_id: 're_msg_1', to: ['hook@example.com'] } });
    const forged = resend.parseWebhook({ headers: signSvix(`whsec_${Buffer.from('attacker').toString('base64')}`, 'evt_1', body), rawBody: body });
    await expect(forged).rejects.toThrow(/signature/);
    const { events } = await resend.parseWebhook({ headers: signSvix(secret, 'evt_1', body), rawBody: body });
    await h.engine.delivery.ingestEvents(null, 'resend', events);
    await h.engine.delivery.ingestEvents(null, 'resend', events); // repeated delivery of the same webhook
    expect((await message(h, result.messageId)).status).toBe('delivered');
    const evts = await h.engine.db.selectFrom('message_events').select('type').where('message_id', '=', result.messageId).execute();
    expect(evts.map((e) => e.type).sort()).toEqual(['accepted', 'delivered']);
  });

  it('honours one-click unsubscribe links and cancels queued mail', async () => {
    h = await createHarness();
    const { result, contactId } = await queueTo(h, 'leaving@example.com');
    await h.drain();
    const m = await message(h, result.messageId);
    const token = JSON.parse(m.headers)['List-Unsubscribe'].match(/\/u\/([^>]+)>/)[1];
    // Another message is waiting to go out.
    const next = await h.engine.delivery.prepare({
      workspaceId: h.workspaceId,
      kind: 'automation',
      category: 'marketing',
      idempotencyKey: 'second',
      contact: await h.engine.contacts.row(h.workspaceId, contactId),
      template: (await h.engine.templates.publishedSource(h.workspaceId, await h.templateId('Newsletter')))!,
      sender: { email: 'hello@cyphen.dev', name: 'Cyphen', replyTo: null },
    });
    expect(next.outcome).toBe('queued');

    expect(await h.engine.delivery.unsubscribe(token, 'one_click')).toBe(true);
    expect(await h.engine.delivery.unsubscribe(token, 'link')).toBe(true); // idempotent
    const contact = await h.engine.contacts.get(h.ctx, contactId);
    expect(contact.consentStatus).toBe('withdrawn');
    expect(contact.suppression?.reason).toBe('unsubscribed');
    expect((await message(h, result.messageId)).unsubscribed_at).not.toBeNull();
    expect((await message(h, next.messageId)).status).toBe('suppressed');
    await h.drain();
    expect(h.provider.outbox).toHaveLength(1);
    expect(await h.engine.delivery.unsubscribe('forged.token', 'link')).toBe(false);

    // The recipient can change their mind from the same page.
    expect(await h.engine.delivery.resubscribe(token)).toBe(true);
    expect((await h.engine.contacts.get(h.ctx, contactId)).consentStatus).toBe('granted');
  });

  it('tracks clicks through signed redirects and ignores scanner clicks', async () => {
    h = await createHarness();
    await h.engine.workspaces.update(h.ctx, { settings: { websiteUrl: 'https://cyphen.dev' } });
    const { result, contactId } = await queueTo(h, 'clicker@example.com');
    await h.drain();
    const m = await message(h, result.messageId);
    const trackedLinks = [...m.html!.matchAll(/https:\/\/morrow\.test\/t\/c\/([^"]+)/g)].map((x) => x[1]!);
    expect(trackedLinks.length).toBeGreaterThan(0);
    expect(m.html).toContain('https://morrow.test/t/o/');
    // A security scanner within seconds of delivery is not a human click.
    expect(await h.engine.delivery.recordClick(trackedLinks[0]!, 'Mozilla/5.0')).toMatch(/^https:\/\//);
    expect((await message(h, result.messageId)).clicked_at).toBeNull();
    h.clock.advanceMinutes(30);
    const url = await h.engine.delivery.recordClick(trackedLinks[0]!, 'Mozilla/5.0 (Macintosh)');
    expect(url).toBe('https://cyphen.dev');
    expect((await message(h, result.messageId)).clicked_at).not.toBeNull();
    expect((await h.engine.contacts.get(h.ctx, contactId)).lastInteractionAt).not.toBeNull();
    expect(await h.engine.delivery.recordClick('tampered.signature', null)).toBeNull();
  });

  it('enforces per-contact frequency caps for non-transactional mail', async () => {
    h = await createHarness();
    await h.engine.workspaces.update(h.ctx, { settings: { sending: { dailyCapPerContact: 1, weeklyCapPerContact: 3 } } });
    const first = await queueTo(h, 'busy@example.com', { key: 'cap-1' });
    const contact = await h.engine.contacts.row(h.workspaceId, first.contactId);
    const tpl = (await h.engine.templates.publishedSource(h.workspaceId, await h.templateId('Welcome')))!;
    const second = await h.engine.delivery.prepare({
      workspaceId: h.workspaceId,
      kind: 'campaign',
      category: 'marketing',
      idempotencyKey: 'cap-2',
      contact,
      template: tpl,
      sender: { email: 'hello@cyphen.dev', name: 'Cyphen', replyTo: null },
    });
    expect(second).toMatchObject({ outcome: 'skipped', reasons: ['frequency_cap'] });
  });

  it('never re-sends after a crash when the provider cannot de-duplicate', async () => {
    const sent: string[] = [];
    const plain: EmailProvider = {
      name: 'plain',
      capabilities: { deliveryEvents: false, bounceEvents: false, complaintEvents: false, openTracking: false, clickTracking: false, idempotencyKeys: false, webhooks: false, customHeaders: true },
      async send(e) {
        sent.push(e.messageId);
        return { providerMessageId: `p-${e.messageId}`, acceptedAt: new Date().toISOString() };
      },
      async verify() {
        return { ok: true, message: 'ok' };
      },
    };
    h = await createHarness({ provider: plain });
    sent.length = 0; // ignore set-up e-mail sent while building the harness
    const { result } = await queueTo(h, 'crash@example.com');
    // Simulate a worker that died after handing the message over: status is left at "sending".
    await h.engine.db.updateTable('messages').set({ status: 'sending' }).where('id', '=', result.messageId).execute();
    await h.drain();
    const m = await message(h, result.messageId);
    expect(m.status).toBe('uncertain');
    expect(sent).toEqual([]);
    expect((await h.engine.notifications.list(h.ctx)).items.some((n) => n.kind === 'delivery.uncertain')).toBe(true);
  });

  it('escapes hostile contact data and falls back when first names are missing', async () => {
    h = await createHarness();
    const evilId = await h.contact({ firstName: '<img src=x onerror=alert(1)>', email: 'evil@example.com', consentStatus: 'granted', consentSource: 'form' });
    const blankId = await h.contact({ email: 'noname@example.com', consentStatus: 'granted', consentSource: 'form' });
    const tplId = await h.templateId('Welcome');
    const evil = await h.engine.templates.render(h.ctx, tplId, { contactId: evilId });
    expect(evil.html).not.toContain('<img src=x');
    expect(evil.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    const blank = await h.engine.templates.render(h.ctx, tplId, { contactId: blankId });
    expect(blank.subject).toBe('Welcome to Cyphen, there');
    expect(blank.html).toContain('Hi there,');
    expect(blank.fallbacksUsed).toContain('first_name');
  });
});
