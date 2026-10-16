import { afterEach, describe, expect, it } from 'vitest';
import { PreconditionError, ValidationError } from '@morrow/core';
import { createHarness, type Harness } from './helpers';

let h: Harness;
afterEach(async () => h?.close());

const FOOTER = '{{> footer}}';

describe('template studio', () => {
  it('sanitises unsafe markup and reports what was removed', async () => {
    h = await createHarness();
    const t = await h.engine.templates.create(h.ctx, {
      name: 'Unsafe',
      category: 'relationship',
      subject: 'Hello\r\nBcc: victim@example.com {{first_name}}',
      html: `<p onclick="steal()">Hi {{first_name}}</p><script>alert(1)</script><a href="javascript:alert(1)">x</a>${FOOTER}`,
    });
    expect(t.draft.subject).toBe('Hello Bcc: victim@example.com {{first_name}}');
    expect(t.draft.html).not.toMatch(/script|onclick|javascript:/i);
    expect(t.warnings.length).toBeGreaterThan(0);
  });

  it('rejects syntax errors and flags typos and missing unsubscribe links', async () => {
    h = await createHarness();
    const { engine, ctx } = h;
    await expect(engine.templates.create(ctx, { name: 'Broken', subject: 'Hi', html: '<p>{{#if first_name}}unclosed</p>' })).rejects.toBeInstanceOf(ValidationError);
    await expect(engine.templates.create(ctx, { name: 'Ghost', subject: 'Hi', html: '<p>x</p>{{> nope}}' })).rejects.toThrow(/Snippet "nope" does not exist/);
    // Typos and a missing unsubscribe link are warnings: the footer is appended anyway.
    const typo = await engine.templates.create(ctx, { name: 'Typo', category: 'marketing', subject: 'Hi {{frist_name}}', html: '<p>News</p>' });
    const rendered = await engine.templates.render(ctx, typo.id);
    expect(rendered.issues.map((i) => i.message).join(' ')).toMatch(/Unknown variable "frist_name"/);
    expect(rendered.issues.some((i) => i.message.includes('unsubscribe_url'))).toBe(true);
    expect(rendered.warnings.some((w) => w.includes('appended its standard footer'))).toBe(true);
    expect(rendered.html).toContain('Unsubscribe</a>');
    // Transactional e-mail does not need an unsubscribe link at all.
    const receipt = await engine.templates.create(ctx, { name: 'Receipt', category: 'transactional', subject: 'Receipt', html: '<p>Thanks</p>' });
    expect((await engine.templates.render(ctx, receipt.id)).html).not.toContain('Unsubscribe</a>');
  });

  it('keeps published versions immutable and sends the published one until republished', async () => {
    h = await createHarness();
    const { engine, ctx } = h;
    const t = await engine.templates.create(ctx, { name: 'Versioned', category: 'relationship', subject: 'v1 for {{first_name}}', html: `<p>Version one</p>${FOOTER}` });
    const published = await engine.templates.publish(ctx, t.id);
    expect(published.published?.version).toBe(1);

    const edited = await engine.templates.update(ctx, t.id, { subject: 'v2 for {{first_name}}', html: `<p>Version two</p>${FOOTER}` });
    expect(edited.draft.version).toBe(2);
    expect(edited.published?.subject).toBe('v1 for {{first_name}}');
    // Further edits change the same draft rather than piling up versions.
    const again = await engine.templates.update(ctx, t.id, { subject: 'v2b for {{first_name}}' });
    expect(again.draft.version).toBe(2);
    expect((await engine.templates.publishedSource(h.workspaceId, t.id))!.subject).toBe('v1 for {{first_name}}');

    await engine.templates.publish(ctx, t.id);
    expect((await engine.templates.publishedSource(h.workspaceId, t.id))!.subject).toBe('v2b for {{first_name}}');
    const versions = await engine.templates.versions(ctx, t.id);
    expect(versions.map((v) => [v.version, Boolean(v.publishedAt)])).toEqual([
      [2, true],
      [1, true],
    ]);

    const restored = await engine.templates.restoreVersion(ctx, t.id, versions[1]!.id);
    expect(restored.draft.version).toBe(3);
    expect(restored.draft.html).toContain('Version one');
  });

  it('renders previews with sample data, fallbacks and eligibility for a real contact', async () => {
    h = await createHarness();
    const { engine, ctx } = h;
    const tplId = await h.templateId('Newsletter');
    const sample = await engine.templates.render(ctx, tplId, { which: 'published' });
    expect(sample.html).toContain('/u/preview');
    expect(sample.issues.filter((i) => i.severity === 'error')).toHaveLength(0);

    const anon = await h.contact({ email: 'anon@example.com' });
    const forContact = await engine.templates.render(ctx, tplId, { which: 'published', contactId: anon });
    expect(forContact.html).toContain('Hi there,');
    expect(forContact.fallbacksUsed).toContain('first_name');
    expect(forContact.eligibility).toMatchObject({ eligible: false, reasons: ['consent_missing'] });

    const live = await engine.templates.renderContent(ctx, { subject: 'Draft {{ first_name }}', html: `<p>{{company_name}}</p>${FOOTER}` });
    expect(live.subject).toMatch(/^Draft /);
    expect(live.html).toContain('Cyphen');
  });

  it('expands snippets and blocks deleting ones in use', async () => {
    h = await createHarness();
    const { engine, ctx } = h;
    const sig = await engine.templates.createSnippet(ctx, { key: 'sign_off', name: 'Sign-off', kind: 'signature', html: '<p>— {{sender_name}}</p>' });
    await expect(engine.templates.createSnippet(ctx, { key: 'sign_off', name: 'Again', html: '<p>x</p>' })).rejects.toThrow(/already exists/);
    await expect(engine.templates.createSnippet(ctx, { key: 'bad key!', name: 'Bad', html: '<p>x</p>' })).rejects.toBeInstanceOf(ValidationError);
    const t = await engine.templates.create(ctx, { name: 'Signed', category: 'relationship', subject: 'Hi', html: `<p>Body</p>{{> sign_off}}${FOOTER}` });
    const rendered = await engine.templates.render(ctx, t.id);
    expect(rendered.html).toContain('— Ammaar from Cyphen');
    await engine.templates.updateSnippet(ctx, sig.id, { html: '<p>Cheers, {{sender_name}}</p>' });
    expect((await engine.templates.render(ctx, t.id)).html).toContain('Cheers, Ammaar from Cyphen');
    await expect(engine.templates.deleteSnippet(ctx, sig.id)).rejects.toBeInstanceOf(PreconditionError);
  });

  it('sends tests only to workspace members, marked and excluded from analytics', async () => {
    h = await createHarness();
    const { engine, ctx } = h;
    const tplId = await h.templateId('Newsletter');
    await expect(engine.templates.testSend(ctx, tplId, { to: 'someone@example.com' })).rejects.toThrow(/members of this workspace/);
    await expect(engine.templates.testSend(h.as('analyst'), tplId)).rejects.toThrow(/messages:test/);
    const sent = await engine.templates.testSend(ctx, tplId, { which: 'published' });
    expect(sent.to).toBe('owner@cyphen.dev');
    await h.drain();
    expect(h.provider.outbox).toHaveLength(1);
    expect(h.provider.outbox[0]!.subject).toMatch(/^\[Test\] /);
    const overview = await engine.analytics.overview(ctx, { from: '2027-03-01', to: '2027-03-31' });
    expect(overview.counts.sent).toBe(0);
  });

  it('refuses to archive templates used by live automations', async () => {
    h = await createHarness();
    const { engine, ctx } = h;
    const automation = await h.automationId('Birthday greetings');
    await engine.automations.activate(ctx, automation);
    const def = (await engine.automations.get(ctx, automation)).definition;
    const step = def.steps.find((s) => s.type === 'send_email') as { templateId: string };
    await expect(engine.templates.archive(ctx, step.templateId)).rejects.toThrow(/Birthday greetings/);
    const dup = await engine.templates.duplicate(ctx, step.templateId);
    expect(dup.name).toMatch(/\(copy\)$/);
    await engine.templates.archive(ctx, dup.id);
    expect((await engine.templates.list(ctx, { status: 'archived' })).map((t) => t.id)).toEqual([dup.id]);
  });
});
