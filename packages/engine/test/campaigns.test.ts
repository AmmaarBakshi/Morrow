import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers';

let h: Harness;
afterEach(async () => h?.close());

async function audience(harness: Harness) {
  const g = { consentStatus: 'granted' as const, consentSource: 'Newsletter form', tags: ['newsletter'] };
  await harness.contact({ firstName: 'Ana', email: 'ana@example.com', ...g });
  await harness.contact({ firstName: 'Ben', email: 'ben@example.com', ...g });
  await harness.contact({ email: 'noname@example.com', ...g });
  await harness.contact({ firstName: 'Cara', email: 'cara@example.com', tags: ['newsletter'] }); // no consent
  await harness.contact({ firstName: 'Dan', email: 'dan+bounce@example.com', ...g });
  await harness.contact({ firstName: 'Eve', tags: ['newsletter'] }); // no e-mail
  const unsub = await harness.contact({ firstName: 'Fay', email: 'fay@example.com', ...g });
  await harness.engine.contacts.setConsent(harness.ctx, unsub, { status: 'withdrawn', source: 'Unsubscribed by reply' });
  return harness.engine.segments.create(harness.ctx, { name: 'Newsletter', criteria: { kind: 'group', match: 'all', rules: [{ kind: 'tag', op: 'has', tag: 'newsletter' }] } });
}

describe('campaigns', () => {
  it('preflights, sends in batches and reports actual delivery', async () => {
    h = await createHarness();
    const { engine, ctx } = h;
    const seg = await audience(h);
    const campaign = await engine.campaigns.create(ctx, { name: 'October newsletter', segmentId: seg.id, templateId: await h.templateId('Newsletter') });
    expect(campaign.category).toBe('marketing');
    expect(campaign.sender?.email).toBe('hello@cyphen.dev');

    const pre = await engine.campaigns.preflight(ctx, campaign.id);
    expect(pre.ok).toBe(true);
    expect(pre.audience).toBe(7);
    expect(pre.eligible).toBe(4);
    expect(pre.excluded).toMatchObject({ no_email: 1, unsubscribed: 1, consent_missing: 1 });
    expect(pre.missingPersonalization).toEqual([{ variable: 'first_name', contacts: 1, handledBy: 'fallback' }]);
    expect(pre.warnings.some((w) => w.includes('development inbox'))).toBe(false); // provider override, not the dev provider

    const launched = await engine.campaigns.launch(ctx, campaign.id);
    expect(launched.status).toBe('sending');
    await h.drain();
    await engine.campaigns.checkCompletion();
    const done = await engine.campaigns.get(ctx, campaign.id);
    expect(done.status).toBe('completed');
    expect(done.recipientCount).toBe(7);
    expect(done.stats.counts).toMatchObject({ sent: 4, delivered: 3, bounced: 1, hardBounced: 1, suppressed: 3 });
    expect(done.stats.rates.deliveryRate).toBeCloseTo(0.75);
    expect(h.provider.outbox.map((m) => m.to.email).sort()).toEqual(['ana@example.com', 'ben@example.com', 'dan+bounce@example.com', 'noname@example.com']);
    expect(h.provider.outbox.find((m) => m.to.email === 'noname@example.com')!.html).toContain('Hi there,');

    const skipped = await engine.campaigns.recipients(ctx, campaign.id, { status: 'skipped' });
    expect(skipped.items.map((r) => r.skipReason).sort()).toEqual(['consent_missing', 'no_email, consent_missing', 'unsubscribed']); // every reason is recorded
    // Relaunching a finished campaign is impossible; duplicates are impossible anyway.
    await expect(engine.campaigns.launch(ctx, campaign.id)).rejects.toThrow(/cannot be scheduled/);
  });

  it('requires approval from someone other than the submitter', async () => {
    h = await createHarness();
    const { engine, ctx } = h;
    await engine.workspaces.update(ctx, { settings: { sending: { requireCampaignApproval: true } } });
    const seg = await audience(h);
    const c = await engine.campaigns.create(ctx, { name: 'Announcement', segmentId: seg.id, templateId: await h.templateId('Project announcement') });
    const manager = { ...ctx, role: 'manager' as const, actor: { type: 'user' as const, id: 'usr_manager', label: 'Manager' } };
    const submitted = await engine.campaigns.launch(manager, c.id);
    expect(submitted.status).toBe('pending_approval');
    await expect(engine.campaigns.approve(manager, c.id)).rejects.toThrow(/cannot perform "campaigns:approve"/);
    const adminSelf = { ...ctx, role: 'admin' as const, actor: { type: 'user' as const, id: 'usr_manager', label: 'Manager' } };
    await expect(engine.campaigns.approve(adminSelf, c.id)).rejects.toThrow(/other than the submitter/);
    const approved = await engine.campaigns.approve(ctx, c.id, 'Looks good');
    expect(approved.status).toBe('sending');
    expect(approved.approvalStatus).toBe('approved');
    const dashboard = await engine.dashboard.summary(ctx);
    expect(dashboard.approvals.campaigns).toBe(0);
  });

  it('schedules for later and launches when due', async () => {
    h = await createHarness({ start: '2027-05-01T00:00:00Z' });
    const { engine, ctx } = h;
    const seg = await audience(h);
    const c = await engine.campaigns.create(ctx, { name: 'Scheduled', segmentId: seg.id, templateId: await h.templateId('Newsletter') });
    const scheduled = await engine.campaigns.schedule(ctx, c.id, { scheduledAt: '2027-05-02T04:30:00Z', timezone: 'Asia/Kolkata' });
    expect(scheduled.status).toBe('scheduled');
    await h.tick();
    expect((await engine.campaigns.get(ctx, c.id)).status).toBe('scheduled');
    h.clock.set('2027-05-02T04:31:00Z');
    await h.tick();
    await h.drain();
    expect((await engine.campaigns.get(ctx, c.id)).stats.counts.sent).toBe(4);
    const calendar = await engine.calendar.events(ctx, { from: '2027-05-01', to: '2027-05-31' });
    expect(calendar.some((e) => e.kind === 'campaign' && e.title === 'Scheduled' && e.date === '2027-05-02' && e.time === '10:01')).toBe(true);
  });

  it('pauses delivery and reports what cannot be recalled when cancelled', async () => {
    h = await createHarness();
    const { engine, ctx } = h;
    const seg = await audience(h);
    const c = await engine.campaigns.create(ctx, { name: 'Pausable', segmentId: seg.id, templateId: await h.templateId('Newsletter') });
    await engine.campaigns.launch(ctx, c.id);
    // Dispatch creates messages, then we pause before they are handed over.
    await engine.createWorker({ id: 'dispatch-only', types: ['campaign.dispatch'] }).drain();
    await engine.campaigns.pause(ctx, c.id);
    await h.drain();
    expect(h.provider.outbox).toHaveLength(0);
    const queued = await engine.db.selectFrom('messages').select('status').where('campaign_id', '=', c.id).where('status', '=', 'queued').execute();
    expect(queued).toHaveLength(4);
    const result = await engine.campaigns.cancel(ctx, c.id);
    expect(result).toMatchObject({ cancelledMessages: 4, alreadySent: 0 });
    h.clock.advanceMinutes(2);
    await h.drain();
    expect(h.provider.outbox).toHaveLength(0);
  });

  it('blocks launch when nothing can be sent', async () => {
    h = await createHarness();
    const { engine, ctx } = h;
    await h.contact({ firstName: 'Nope', email: 'nope@example.com', tags: ['cold'] });
    const seg = await engine.segments.create(ctx, { name: 'Cold', criteria: { kind: 'group', match: 'all', rules: [{ kind: 'tag', op: 'has', tag: 'cold' }] } });
    const c = await engine.campaigns.create(ctx, { name: 'Cold', segmentId: seg.id, templateId: await h.templateId('Newsletter') });
    const pre = await engine.campaigns.preflight(ctx, c.id);
    expect(pre.ok).toBe(false);
    expect(pre.blockers).toContain('No contacts in the audience can receive this campaign.');
    await expect(engine.campaigns.launch(ctx, c.id)).rejects.toThrow(/Cannot launch/);
  });
});

describe('analytics', () => {
  it('buckets activity by local day in the workspace time zone', async () => {
    h = await createHarness({ start: '2027-03-06T18:20:00Z', timezone: 'Asia/Kolkata' }); // 23:50 IST on 6 March
    const { engine, ctx } = h;
    const seg = await audience(h);
    const c = await engine.campaigns.create(ctx, { name: 'Midnight', segmentId: seg.id, templateId: await h.templateId('Newsletter') });
    await engine.campaigns.launch(ctx, c.id);
    await engine.createWorker({ id: 'dispatch', types: ['campaign.dispatch'] }).drain();
    // Send two before local midnight and the rest after it.
    const sendWorker = engine.createWorker({ id: 'send', types: ['email.send', 'email.events'], concurrency: 1 });
    await sendWorker.runOnce();
    await sendWorker.runOnce();
    h.clock.set('2027-03-06T18:40:00Z'); // 00:10 IST on 7 March
    await h.drain();
    const series = await engine.analytics.timeseries(ctx, { from: '2027-03-06', to: '2027-03-07' });
    expect(series.map((p) => [p.date, p.sent])).toEqual([
      ['2027-03-06', 2],
      ['2027-03-07', 2],
    ]);
    const failures = await engine.analytics.failures(ctx, { from: '2027-03-01', to: '2027-03-31' });
    expect(failures.some((f) => f.status === 'bounced' && !f.reason.includes('dan+bounce@example.com'))).toBe(true);
    const csv = await engine.analytics.exportCsv(ctx, { from: '2027-03-01', to: '2027-03-31' });
    expect(csv).toContain('Midnight');
  });
});

describe('campaign scheduling safety', () => {
  it('rejects times in the past instead of sending immediately, and unschedules through update', async () => {
    h = await createHarness({ start: '2027-05-01T00:00:00Z' });
    const { engine, ctx } = h;
    const seg = await audience(h);
    const c = await engine.campaigns.create(ctx, { name: 'Late', segmentId: seg.id, templateId: await h.templateId('Newsletter') });
    await expect(engine.campaigns.schedule(ctx, c.id, { scheduledAt: '2027-04-30T09:00:00Z' })).rejects.toThrow(/already passed/);
    expect((await engine.campaigns.get(ctx, c.id)).status).toBe('draft');
    await engine.campaigns.schedule(ctx, c.id, { scheduledAt: '2027-05-03T09:00:00Z' });
    const back = await engine.campaigns.update(ctx, c.id, { scheduledAt: null });
    expect(back).toMatchObject({ status: 'draft', scheduledAt: null });
    h.clock.set('2027-05-04T00:00:00Z');
    await h.tick();
    await h.drain();
    expect(h.provider.outbox).toHaveLength(0);
  });
});
