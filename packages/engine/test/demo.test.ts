import { afterEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../src/demo';
import type { WorkspaceContext } from '../src/context';
import { createHarness, type Harness } from './helpers';

let h: Harness;
afterEach(async () => h?.close());

describe('demo seed', () => {
  it('builds a realistic workspace once and never e-mails anyone', async () => {
    h = await createHarness({ start: '2027-03-06T06:00:00Z' });
    const first = await seedDemo(h.engine);
    expect(first).toMatchObject({ created: true, email: 'demo@morrow.local', contacts: 40 });
    expect((await seedDemo(h.engine)).created).toBe(false);

    const ctx: WorkspaceContext = { workspaceId: first.workspaceId, role: 'owner', actor: { type: 'system', id: null, label: 'test' } };
    const contacts = await h.engine.contacts.list(ctx, { pageSize: 100 });
    expect(contacts.total).toBe(40);
    expect(contacts.items.every((c) => !c.email || c.email.endsWith('@example.com'))).toBe(true);
    expect((await h.engine.segments.list(ctx)).map((s) => s.name).sort()).toEqual(['Developers', 'Newsletter subscribers', 'VIP clients']);
    const upcoming = await h.engine.contacts.upcomingOccasions(ctx, { days: 30 });
    expect(upcoming.length).toBeGreaterThan(3);
    const birthday = (await h.engine.automations.list(ctx)).find((a) => a.name === 'Birthday greetings')!;
    expect(birthday).toMatchObject({ status: 'active', deliveryMode: 'review' });

    // A scheduler pass queues greetings for review; nothing is sent without approval.
    await h.tick();
    await h.drain();
    expect(h.provider.outbox).toHaveLength(0);
  });
});
