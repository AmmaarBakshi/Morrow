import { addDays, localDate, type ContactCreateInput } from '@morrow/core';
import type { WorkspaceContext } from './context';
import type { Engine } from './engine';

export interface DemoOptions {
  email?: string;
  name?: string;
  password?: string;
  workspaceName?: string;
  timezone?: string;
}

export interface DemoResult {
  created: boolean;
  email: string;
  password: string | null;
  workspaceId: string;
  contacts: number;
}

const FIRST = ['Aarav', 'Diya', 'Kabir', 'Meera', 'Rohan', 'Ananya', 'Vikram', 'Isha', 'Arjun', 'Sara', 'Leo', 'Maya', 'Noah', 'Zara', 'Omar', 'Lena', 'Yuki', 'Tariq', 'Elena', 'Sam'];
const LAST = ['Shah', 'Iyer', 'Kapoor', 'Nair', 'Reddy', 'Fernandes', 'Khan', 'Okafor', 'Silva', 'Novak'];
const COMPANIES = ['Northwind Labs', 'Orbit Analytics', 'Bluefin Health', 'Kite Logistics', 'Lumen Studio', null];
const TYPES = ['client', 'lead', 'developer', 'collaborator', 'subscriber', 'partner'] as const;

/**
 * A realistic demo workspace: people with birthdays in the coming weeks,
 * tags, segments, a sender and the starter automations in review mode.
 * Every address is on example.com, so nothing can reach a real inbox.
 */
export async function seedDemo(engine: Engine, options: DemoOptions = {}): Promise<DemoResult> {
  const email = (options.email ?? 'demo@morrow.local').toLowerCase();
  const existing = await engine.db.selectFrom('users').select('id').where('email', '=', email).executeTakeFirst();
  if (existing) {
    const ws = (await engine.workspaces.listForUser(existing.id))[0];
    return { created: false, email, password: null, workspaceId: ws?.id ?? '', contacts: 0 };
  }
  const password = options.password ?? 'morrow-demo-password';
  const user = await engine.auth.createUser({ email, name: options.name ?? 'Demo Owner', password });
  const ws = await engine.workspaces.create(user, { name: options.workspaceName ?? 'Cyphen (demo)', timezone: options.timezone ?? 'Asia/Kolkata', companyName: 'Cyphen' });
  const ctx: WorkspaceContext = { workspaceId: ws.id, role: 'owner', actor: { type: 'system', id: null, label: 'Demo seed' } };
  const userCtx: WorkspaceContext = { workspaceId: ws.id, role: 'owner', actor: { type: 'user', id: user.id, label: user.name } };

  await engine.workspaces.update(ctx, {
    settings: {
      companyName: 'Cyphen',
      companyAddress: '221B Residency Road, Bengaluru 560025, India',
      websiteUrl: 'https://cyphen.example.com',
      variables: { collaboration_url: 'https://cyphen.example.com/collaborate', latest_project_name: 'Orbit Analytics', brand_voice: 'Warm, concise and technically credible.' },
    },
  });
  const sender = await engine.senders.create(userCtx, { name: 'Cyphen Team', email: 'hello@cyphen.example.com', isDefault: true });
  await engine.senders.markVerified(userCtx, sender.id, 'Demo data: example domain, development provider only');
  // The verification e-mail queued above is irrelevant in a demo.
  await engine.db.deleteFrom('jobs').where('workspace_id', '=', ws.id).execute();

  for (const [name, color] of [['vip', '#f59e0b'], ['newsletter', '#6366f1'], ['rust', '#ef4444'], ['design', '#10b981']] as const) {
    await engine.tags.create(ctx, { name, color });
  }
  await engine.fields.create(ctx, { key: 'github', label: 'GitHub username', type: 'text' });

  const today = localDate(engine.now(), ws.timezone);
  let count = 0;
  for (let i = 0; i < 40; i++) {
    const first = FIRST[i % FIRST.length]!;
    const last = LAST[(i * 7) % LAST.length]!;
    const type = TYPES[i % TYPES.length]!;
    // Spread birthdays so the calendar and "upcoming" lists have something in the next weeks.
    const bday = addDays(today, (i * 5) % 75 - 3);
    const [, month, day] = bday.split('-').map(Number) as [number, number, number];
    const tags = [i % 4 === 0 ? 'vip' : null, i % 2 === 0 ? 'newsletter' : null, type === 'developer' ? (i % 3 ? 'rust' : 'design') : null].filter(Boolean) as string[];
    const input: ContactCreateInput = {
      firstName: first,
      lastName: last,
      email: i === 7 ? null : `${first}.${last}${i}@example.com`.toLowerCase(),
      company: COMPANIES[i % COMPANIES.length] ?? null,
      jobTitle: type === 'developer' ? 'Software engineer' : type === 'client' ? 'Head of product' : null,
      relationshipType: type,
      birthday: i % 5 === 4 ? null : { month, day, year: i % 3 === 0 ? 1985 + (i % 15) : null },
      workAnniversary: type === 'client' ? addDays(today, 10 + i - 365 * (1 + (i % 4))) : null,
      tags,
      consentStatus: type === 'lead' ? 'implied' : i % 9 === 0 ? 'unknown' : 'granted',
      consentSource: type === 'lead' ? 'Requested a proposal' : i % 9 === 0 ? null : 'Demo sign-up form',
      source: 'demo',
      customFields: type === 'developer' ? { github: `${first.toLowerCase()}-dev` } : undefined,
    };
    await engine.contacts.create(ctx, input, { silent: true, source: 'system' });
    count += 1;
  }

  await engine.segments.create(ctx, { name: 'Newsletter subscribers', criteria: { kind: 'group', match: 'all', rules: [{ kind: 'tag', op: 'has', tag: 'newsletter' }, { kind: 'field', field: 'consent_status', op: 'eq', value: 'granted' }] } });
  await engine.segments.create(ctx, { name: 'Developers', criteria: { kind: 'group', match: 'all', rules: [{ kind: 'field', field: 'relationship_type', op: 'eq', value: 'developer' }] } });
  await engine.segments.create(ctx, { name: 'VIP clients', criteria: { kind: 'group', match: 'all', rules: [{ kind: 'tag', op: 'has', tag: 'vip' }, { kind: 'field', field: 'relationship_type', op: 'eq', value: 'client' }] } });

  const birthday = (await engine.automations.list(ctx)).find((a) => a.name === 'Birthday greetings');
  if (birthday) await engine.automations.activate(userCtx, birthday.id, { deliveryMode: 'review' });

  return { created: true, email, password, workspaceId: ws.id, contacts: count };
}
