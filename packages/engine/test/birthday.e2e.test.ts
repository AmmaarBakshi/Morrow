import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers';

let h: Harness;
afterEach(async () => h?.close());

async function activateBirthdays(harness: Harness, overrides: Record<string, unknown> = {}) {
  const id = await harness.automationId('Birthday greetings');
  if (Object.keys(overrides).length) {
    const current = await harness.engine.automations.get(harness.ctx, id);
    await harness.engine.automations.update(harness.ctx, id, {
      definition: { ...current.definition, trigger: { ...current.definition.trigger, ...overrides } },
    });
  }
  await harness.engine.automations.activate(harness.ctx, id, { deliveryMode: 'auto' });
  return id;
}

const count = async (harness: Harness, table: 'messages' | 'automation_runs' | 'jobs' | 'tasks', where: Record<string, string> = {}) => {
  let q = harness.engine.db.selectFrom(table).select((eb) => eb.fn.countAll<number>().as('n'));
  for (const [k, v] of Object.entries(where)) q = q.where(k as never, '=', v as never);
  return Number((await q.executeTakeFirst())?.n ?? 0);
};

describe('birthday automation, end to end', () => {
  it('creates, personalises, sends exactly once and records delivery', async () => {
    h = await createHarness({ start: '2027-03-06T12:00:00Z', timezone: 'Asia/Kolkata' });
    const { engine, ctx } = h;

    // 1. Create a contact with a month/day birthday and no birth year.
    const rahulId = await h.contact({
      firstName: 'Rahul',
      lastName: 'Mehta',
      email: 'rahul@northwind.dev',
      company: 'Northwind Labs',
      relationshipType: 'client',
      birthday: { month: 3, day: 7 },
      consentStatus: 'implied',
      consentSource: 'Signed services agreement, 2025',
    });

    // 2. The birthday template ships with the workspace and is published.
    const templateId = await h.templateId('Birthday — personal');
    const preview = await engine.templates.render(ctx, templateId, { contactId: rahulId });
    expect(preview.subject).toBe('Happy birthday, Rahul! 🎉');
    expect(preview.issues.filter((i) => i.severity === 'error')).toEqual([]);

    // 3. Enable the birthday automation (fully automatic delivery, approved by the owner).
    const automationId = await activateBirthdays(h);
    const automation = await engine.automations.get(ctx, automationId);
    expect(automation.status).toBe('active');
    expect(automation.autoApprovedBy).toBe(h.userId);

    // A dry run for the birthday morning shows who qualifies, without writing anything.
    const dry = await engine.automations.dryRun(ctx, automationId, { at: '2027-03-07T03:31:00Z' });
    expect(dry.qualified).toBe(1);
    expect(dry.results[0]!.contact.id).toBe(rahulId);
    expect(dry.results[0]!.steps[0]).toMatchObject({ type: 'send_email', outcome: 'would_run' });
    expect(dry.results[0]!.steps[0]!.email?.subject).toBe('Happy birthday, Rahul! 🎉');
    expect(await count(h, 'automation_runs')).toBe(0);

    // Before the send time nothing happens.
    h.clock.set('2027-03-07T03:00:00Z'); // 08:30 IST
    await h.tick();
    expect(await count(h, 'automation_runs')).toBe(0);

    // 4. Simulate the birthday: 09:01 IST on 7 March.
    h.clock.set('2027-03-07T03:31:00Z');
    const report = await h.tick();
    expect(report.leader).toBe(true);
    expect(report.calendar?.runsStarted).toBe(1);

    // 5. The contact qualifies and a run exists for this exact occasion.
    const runs = await engine.db.selectFrom('automation_runs').selectAll().execute();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.event_key).toBe('birthday:2027-03-07');

    // 6–8. The worker personalises, queues one delivery job and the provider delivers.
    await h.drain();
    const messages = await engine.db.selectFrom('messages').selectAll().execute();
    expect(messages).toHaveLength(1);
    const msg = messages[0]!;
    expect(msg.subject).toBe('Happy birthday, Rahul! 🎉');
    expect(msg.html).toContain('Hi Rahul,');
    expect(msg.html).toContain('/u/'); // unsubscribe link from the footer snippet
    expect(msg.category).toBe('relationship');
    expect(JSON.parse(msg.headers)['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(await count(h, 'jobs', { type: 'email.send' })).toBe(1);
    expect(h.provider.outbox).toHaveLength(1);
    expect(h.provider.outbox[0]!.to.email).toBe('rahul@northwind.dev');

    // 9. History and analytics reflect the recorded delivery events.
    const delivered = await engine.messages.get(ctx, msg.id);
    expect(delivered.status).toBe('delivered');
    expect(delivered.sentAt).not.toBeNull();
    expect(delivered.deliveredAt).not.toBeNull();
    expect(delivered.events.map((e) => e.type)).toEqual(['accepted', 'delivered']);
    const overview = await engine.analytics.overview(ctx, { from: '2027-03-01', to: '2027-03-31' });
    expect(overview.counts.sent).toBe(1);
    expect(overview.counts.delivered).toBe(1);
    expect(overview.rates.deliveryRate).toBe(1);
    const timeline = await engine.contacts.timeline(ctx, rahulId);
    expect(timeline.some((t) => t.type === 'message' && t.status === 'delivered')).toBe(true);
    const run = await engine.automations.run(ctx, runs[0]!.id);
    expect(run.status).toBe('completed');

    // The client branch created a personal follow-up task.
    const tasks = await engine.tasks.list(ctx);
    expect(tasks.items.map((t) => t.title)).toEqual(['Send Rahul a personal birthday message']);

    // 10. Run the same event again — twice, and even after losing the scheduler cursor.
    await h.tick();
    await engine.db.deleteFrom('scheduler_state').where('key', 'like', 'cal:%').execute();
    await h.tick();
    const again = await engine.executor.startRun({
      workspaceId: h.workspaceId,
      automationId,
      versionId: runs[0]!.version_id,
      contactId: rahulId,
      eventKey: 'birthday:2027-03-07',
    });
    expect(again.created).toBe(false);
    await h.drain();
    expect(await count(h, 'automation_runs')).toBe(1);
    expect(await count(h, 'messages')).toBe(1);
    expect(await count(h, 'jobs', { type: 'email.send' })).toBe(1);
    expect(h.provider.outbox).toHaveLength(1);
  });

  it('never sends to unsubscribed, suppressed or non-consenting contacts', async () => {
    h = await createHarness({ start: '2027-03-06T12:00:00Z' });
    const { engine, ctx } = h;
    const base = { birthday: { month: 3, day: 7 }, relationshipType: 'client' as const };
    await h.contact({ ...base, firstName: 'Granted', email: 'granted@example.com', consentStatus: 'granted', consentSource: 'signup form' });
    const unsubId = await h.contact({ ...base, firstName: 'Unsub', email: 'unsub@example.com', consentStatus: 'granted', consentSource: 'signup form' });
    await h.contact({ ...base, firstName: 'Unknown', email: 'unknown@example.com' }); // consent unknown
    await h.contact({ ...base, firstName: 'Bounced', email: 'bounced@example.com', consentStatus: 'granted', consentSource: 'signup form' });
    await engine.contacts.setConsent(ctx, unsubId, { status: 'withdrawn', source: 'Asked by phone' });
    await engine.suppressions.add(ctx, { email: 'bounced@example.com', reason: 'hard_bounce' });

    await activateBirthdays(h);
    h.clock.set('2027-03-07T03:31:00Z');
    await h.tick();
    await h.drain();

    const rows = await engine.db.selectFrom('messages').select(['to_email', 'status', 'error_code']).orderBy('to_email').execute();
    expect(rows).toEqual([
      { to_email: 'bounced@example.com', status: 'suppressed', error_code: 'suppressed' },
      { to_email: 'granted@example.com', status: 'delivered', error_code: null },
      { to_email: 'unknown@example.com', status: 'suppressed', error_code: 'consent_missing' },
      { to_email: 'unsub@example.com', status: 'suppressed', error_code: 'unsubscribed' },
    ]);
    expect(h.provider.outbox.map((m) => m.to.email)).toEqual(['granted@example.com']);
  });

  it('re-checks suppression at the final sending stage', async () => {
    h = await createHarness({ start: '2027-03-06T12:00:00Z' });
    const { engine, ctx } = h;
    await h.contact({ firstName: 'Late', email: 'late@example.com', birthday: { month: 3, day: 7 }, consentStatus: 'granted', consentSource: 'form' });
    await activateBirthdays(h);
    h.clock.set('2027-03-07T03:31:00Z');
    await h.tick();
    // Run the automation step (which queues the message) but not the send yet.
    const worker = engine.createWorker({ id: 'automation-only', types: ['automation.execute'] });
    await worker.drain();
    const queued = await engine.db.selectFrom('messages').selectAll().executeTakeFirstOrThrow();
    expect(queued.status).toBe('queued');
    // The person unsubscribes from a different e-mail before this one goes out.
    await engine.suppressions.add(ctx, { email: 'late@example.com', reason: 'unsubscribed' });
    await h.drain();
    const after = await engine.db.selectFrom('messages').selectAll().executeTakeFirstOrThrow();
    expect(after.status).toBe('suppressed');
    expect(h.provider.outbox).toHaveLength(0);
  });

  it('celebrates 29 February birthdays on 28 February in non-leap years (feb28 policy)', async () => {
    h = await createHarness({ start: '2027-02-27T12:00:00Z' });
    await h.contact({ firstName: 'Leap', email: 'leap@example.com', birthday: { month: 2, day: 29 }, consentStatus: 'granted', consentSource: 'form' });
    await activateBirthdays(h, { leapDayPolicy: 'feb28' });
    h.clock.set('2027-02-28T03:31:00Z');
    await h.tick();
    await h.drain();
    const msg = await h.engine.db.selectFrom('messages').selectAll().executeTakeFirstOrThrow();
    expect(msg.to_email).toBe('leap@example.com');
    const run = await h.engine.db.selectFrom('automation_runs').selectAll().executeTakeFirstOrThrow();
    expect(run.event_key).toBe('birthday:2027-02-28');
  });

  it('can use each contact’s own time zone', async () => {
    h = await createHarness({ start: '2027-03-06T12:00:00Z', timezone: 'Asia/Kolkata' });
    await h.contact({ firstName: 'Nia', email: 'nia@example.com', timezone: 'America/New_York', birthday: { month: 3, day: 7 }, consentStatus: 'granted', consentSource: 'form' });
    await h.contact({ firstName: 'Arjun', email: 'arjun@example.com', birthday: { month: 3, day: 7 }, consentStatus: 'granted', consentSource: 'form' });
    await activateBirthdays(h, { timezoneMode: 'contact' });

    h.clock.set('2027-03-07T03:31:00Z'); // 09:01 in India, 22:31 on 6 March in New York
    await h.tick();
    await h.drain();
    expect(h.provider.outbox.map((m) => m.to.email)).toEqual(['arjun@example.com']);

    h.clock.set('2027-03-07T14:01:00Z'); // 09:01 EST in New York
    await h.tick();
    await h.drain();
    expect(h.provider.outbox.map((m) => m.to.email).sort()).toEqual(['arjun@example.com', 'nia@example.com']);
  });

  it('catches up within the window after downtime and reports older dates as missed', async () => {
    h = await createHarness({ start: '2027-03-06T12:00:00Z' });
    const { engine } = h;
    await h.contact({ firstName: 'Ninth', email: 'ninth@example.com', birthday: { month: 3, day: 9 }, consentStatus: 'granted', consentSource: 'form' });
    await h.contact({ firstName: 'Eleventh', email: 'eleventh@example.com', birthday: { month: 3, day: 11 }, consentStatus: 'granted', consentSource: 'form' });
    await activateBirthdays(h, { catchUpDays: 1 });
    h.clock.set('2027-03-07T03:31:00Z');
    await h.tick();

    // The scheduler is down from 7 March until 12 March 09:01 IST.
    h.clock.set('2027-03-12T03:31:00Z');
    const report = await h.tick();
    await h.drain();
    expect(report.calendar?.missedDates).toBe(3); // 8, 9 and 10 March
    expect(h.provider.outbox.map((m) => m.to.email)).toEqual(['eleventh@example.com']);
    const notes = await engine.notifications.list(h.ctx);
    expect(notes.items.some((n) => n.kind === 'automation.missed')).toBe(true);
  });

  it('holds messages for review unless automatic delivery was approved', async () => {
    h = await createHarness({ start: '2027-03-06T12:00:00Z' });
    const { engine, ctx } = h;
    await h.contact({ firstName: 'Review', email: 'review@example.com', birthday: { month: 3, day: 7 }, consentStatus: 'granted', consentSource: 'form' });
    const id = await h.automationId('Birthday greetings');
    await engine.automations.activate(ctx, id); // default: review mode
    h.clock.set('2027-03-07T03:31:00Z');
    await h.tick();
    await h.drain();
    const pending = await engine.messages.pendingApprovals(ctx);
    expect(pending.total).toBe(1);
    expect(h.provider.outbox).toHaveLength(0);
    await engine.messages.approve(ctx, [pending.items[0]!.id]);
    await h.drain();
    expect(h.provider.outbox).toHaveLength(1);
  });

  it('does not let campaign managers grant fully automatic delivery', async () => {
    h = await createHarness();
    const id = await h.automationId('Birthday greetings');
    await expect(h.engine.automations.activate(h.as('manager'), id, { deliveryMode: 'auto' })).rejects.toThrow(/cannot perform "automations:approve_auto"/);
    await expect(h.engine.automations.activate(h.as('manager'), id, { deliveryMode: 'review' })).resolves.toMatchObject({ status: 'active' });
  });
});
