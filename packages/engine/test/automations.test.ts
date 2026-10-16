import { afterEach, describe, expect, it } from 'vitest';
import { PreconditionError } from '@morrow/core';
import { createHarness, type Harness } from './helpers';

let h: Harness;
afterEach(async () => h?.close());

describe('automation engine', () => {
  it('runs the proposal follow-up: event → wait 5 days → branch → e-mail + task', async () => {
    h = await createHarness({ start: '2027-04-01T05:00:00Z' });
    const { engine, ctx } = h;
    const id = await h.automationId('Proposal follow-up');
    await engine.automations.activate(ctx, id, { deliveryMode: 'auto' });

    const quiet = await h.contact({ firstName: 'Quiet', email: 'quiet@example.com', relationshipType: 'lead', consentStatus: 'implied', consentSource: 'Requested a proposal' });
    const replied = await h.contact({ firstName: 'Replied', email: 'replied@example.com', relationshipType: 'lead', consentStatus: 'implied', consentSource: 'Requested a proposal' });
    for (const contactId of [quiet, replied]) {
      await engine.contacts.recordEvent(ctx, { contactId, name: 'proposal.sent', properties: { proposal_name: 'the Orbit redesign proposal' } });
    }
    await h.drain();
    let runs = await engine.db.selectFrom('automation_runs').selectAll().execute();
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.status === 'waiting')).toBe(true);
    expect(h.provider.outbox).toHaveLength(0);

    // Two days later one lead responds.
    h.clock.advanceDays(2);
    await engine.contacts.recordEvent(ctx, { contactId: replied, name: 'proposal.responded' });
    await h.drain();

    // Nothing happens before the wait ends…
    h.clock.advanceDays(2);
    await h.drain();
    expect(h.provider.outbox).toHaveLength(0);

    // …then the quiet lead gets the follow-up and the team gets a call task.
    h.clock.advanceDays(1);
    h.clock.advanceMinutes(1);
    await h.drain();
    expect(h.provider.outbox.map((m) => m.to.email)).toEqual(['quiet@example.com']);
    expect(h.provider.outbox[0]!.subject).toBe('Following up on the Orbit redesign proposal');
    runs = await engine.db.selectFrom('automation_runs').selectAll().orderBy('contact_id').execute();
    expect(runs.map((r) => r.status)).toEqual(['completed', 'completed']);
    const tasks = await engine.tasks.list(ctx);
    expect(tasks.items.map((t) => [t.title, t.contactName])).toEqual([['Call Quiet about the proposal', 'Quiet']]);
    const quietRun = await engine.automations.run(ctx, runs.find((r) => r.contact_id === quiet)!.id);
    expect(quietRun.steps!.map((s) => [s.stepId, s.status])).toEqual([
      ['__entry', 'ok'],
      ['wait_five_days', 'waiting'],
      ['wait_five_days', 'ok'],
      ['responded', 'ok'],
      ['send_follow_up', 'ok'],
      ['call_task', 'ok'],
    ]);
  });

  it('keeps in-flight runs on their version when the automation is edited', async () => {
    h = await createHarness({ start: '2027-04-01T05:00:00Z' });
    const { engine, ctx } = h;
    const id = await h.automationId('Proposal follow-up');
    await engine.automations.activate(ctx, id, { deliveryMode: 'auto' });
    const contactId = await h.contact({ firstName: 'Lead', email: 'lead@example.com', consentStatus: 'implied', consentSource: 'proposal' });
    await engine.contacts.recordEvent(ctx, { contactId, name: 'proposal.sent' });
    await h.drain();
    const before = await engine.automations.get(ctx, id);
    const def = before.definition;
    const edited = await engine.automations.update(ctx, id, { definition: { ...def, steps: [{ id: 'just_tag', type: 'add_tag', tag: 'new-version' }] } });
    expect(edited.version).toBe(before.version + 1);
    // Editing clears approval for fully automatic delivery.
    expect(edited.deliveryMode).toBe('review');
    h.clock.advanceDays(6);
    await h.drain();
    const run = await engine.db.selectFrom('automation_runs').selectAll().executeTakeFirstOrThrow();
    expect(run.version_id).toBe(before.versionId);
    expect(run.status).toBe('completed');
  });

  it('holds runs while paused and resumes them afterwards', async () => {
    h = await createHarness({ start: '2027-04-01T05:00:00Z' });
    const { engine, ctx } = h;
    const id = await h.automationId('Welcome new subscribers');
    await engine.automations.activate(ctx, id, { deliveryMode: 'auto' });
    const contactId = await h.contact({ firstName: 'Sub', email: 'sub@example.com' });
    await engine.automations.pause(ctx, id);
    // Paused automations do not start new runs.
    await engine.contacts.setConsent(ctx, contactId, { status: 'granted', source: 'Double opt-in' });
    await h.drain();
    expect(await engine.db.selectFrom('automation_runs').selectAll().execute()).toHaveLength(0);
    await engine.automations.resume(ctx, id);
    const other = await h.contact({ firstName: 'Other', email: 'other@example.com' });
    await engine.contacts.setConsent(ctx, other, { status: 'granted', source: 'Double opt-in' });
    await h.drain();
    expect(h.provider.outbox.map((m) => m.to.email)).toEqual(['other@example.com']);
  });

  it('runs manually for chosen contacts and never twice for the same request', async () => {
    h = await createHarness();
    const { engine, ctx } = h;
    const tplId = await h.templateId('Collaboration invitation');
    const created = await engine.automations.create(ctx, {
      name: 'Invite developers',
      definition: { trigger: { type: 'manual' }, steps: [{ id: 'invite', type: 'send_email', templateId: tplId }] },
    });
    await expect(engine.automations.runManual(ctx, created.id, { contactIds: [] })).rejects.toBeInstanceOf(PreconditionError);
    await engine.automations.activate(ctx, created.id, { deliveryMode: 'auto' });
    const dev = await h.contact({ firstName: 'Dev', email: 'dev@example.com', relationshipType: 'developer', jobTitle: 'Rust developer', consentStatus: 'granted', consentSource: 'Conference sign-up' });
    const res = await engine.automations.runManual(ctx, created.id, { contactIds: [dev] });
    expect(res.started).toBe(1);
    await h.drain();
    expect(h.provider.outbox).toHaveLength(1);
    expect(h.provider.outbox[0]!.html).toContain('https://morrow.test/t/c/'); // collaboration link is tracked
  });

  it('validates references before activation', async () => {
    h = await createHarness();
    const { engine, ctx } = h;
    const draft = await engine.templates.create(ctx, { name: 'Unpublished', subject: 'Hi {{first_name}}', html: '<p>Hello {{first_name}}</p>{{> footer}}', category: 'relationship' });
    const a = await engine.automations.create(ctx, { name: 'Broken', definition: { trigger: { type: 'contact_created' }, steps: [{ id: 's', type: 'send_email', templateId: draft.id }] } });
    expect(a.problems.some((p) => p.message.includes('has not been published'))).toBe(true);
    await expect(engine.automations.activate(ctx, a.id)).rejects.toThrow(/not been published/);
    await engine.templates.publish(ctx, draft.id);
    await expect(engine.automations.activate(ctx, a.id)).resolves.toMatchObject({ status: 'active' });
  });

  it('dry-runs unsaved definitions without writing anything', async () => {
    h = await createHarness();
    const { engine, ctx } = h;
    const id = await h.automationId('Birthday greetings');
    await h.contact({ firstName: 'Zoe', email: 'zoe@example.com', birthday: { month: 3, day: 8 }, consentStatus: 'granted', consentSource: 'form' });
    const current = await engine.automations.get(ctx, id);
    const result = await engine.automations.dryRun(ctx, id, {
      at: '2027-03-07T04:00:00Z',
      definition: { ...current.definition, trigger: { ...current.definition.trigger, offsetDays: -1 } },
    });
    expect(result.qualified).toBe(1);
    expect(result.results[0]!.eventKey).toBe('birthday:2027-03-08');
    expect(await engine.db.selectFrom('messages').selectAll().execute()).toHaveLength(0);
    expect(await engine.db.selectFrom('automation_runs').selectAll().execute()).toHaveLength(0);
  });
});
