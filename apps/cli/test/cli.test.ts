import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '@morrow/engine/testing';
import { createApp, RateLimiter } from '@morrow/server';
import { runCli } from '../src/program';
import { parseBirthday } from '../src/commands/contacts';
import { parseProps } from '../src/commands/automations';

let h: Harness | undefined;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'morrow-cli-'));
});
afterEach(async () => {
  await h?.close();
  h = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** Run `morrow …` in-process against an in-memory server. */
async function cli(harness: Harness | null, args: string[], env: Record<string, string> = {}) {
  let stdout = '';
  let stderr = '';
  const app = harness ? createApp({ engine: harness.engine, limiter: new RateLimiter() }) : null;
  const fetchViaApp = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!app) throw new TypeError('fetch failed');
    return app.request(String(input), init);
  }) as typeof fetch;
  const code = await runCli(args, {
    env: { MORROW_CONFIG: join(dir, 'config.json'), ...env },
    fetch: fetchViaApp,
    writer: { out: (t) => (stdout += t.endsWith('\n') ? t : `${t}\n`), err: (t) => (stderr += t.endsWith('\n') ? t : `${t}\n`) },
  });
  // eslint-disable-next-line no-control-regex
  const plain = (t: string) => t.replace(/\x1b\[[0-9;]*m/g, '');
  return { code, stdout: plain(stdout), stderr: plain(stderr), json: () => JSON.parse(stdout) };
}

async function signedIn(): Promise<Harness> {
  const harness = await createHarness({ start: '2027-03-01T06:00:00Z' });
  const key = await harness.engine.workspaces.createApiKey(harness.ctx, { name: 'CLI', role: 'admin' });
  const login = await cli(harness, ['login', '--url', 'https://morrow.test', '--api-key', key.key]);
  expect(login.code).toBe(0);
  expect(login.stdout).toContain('Signed in to');
  return harness;
}

describe('morrow CLI', () => {
  it('prints help and version without touching the network', async () => {
    const help = await cli(null, ['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Usage: morrow');
    expect(help.stdout).toContain('birthdays');
    const version = await cli(null, ['--version']);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    const unknown = await cli(null, ['frobnicate']);
    expect(unknown.code).toBe(1);
  });

  it('explains how to sign in when no credentials are configured', async () => {
    const res = await cli(null, ['contacts', 'list']);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('morrow login');
  });

  it('logs in with an API key, saves a private profile and reports whoami', async () => {
    h = await signedIn();
    const saved = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    expect(saved.profiles.default).toMatchObject({ url: 'https://morrow.test', kind: 'api_key' });
    const who = await cli(h, ['whoami', '--json']);
    expect(who.json()).toMatchObject({ kind: 'api_key', role: 'admin', workspace: { name: 'Cyphen' } });
    const profiles = await cli(h, ['profiles', '--json']);
    expect(profiles.json()[0]).toMatchObject({ name: 'default', current: true });
  });

  it('manages contacts, events and upcoming birthdays', async () => {
    h = await signedIn();
    const added = await cli(h, ['contacts', 'add', '--email', 'zoe@example.com', '--first-name', 'Zoe', '--birthday', '03-08', '--type', 'client', '--consent', 'granted', '--consent-source', 'Signed contract', '--tag', 'vip', '--json']);
    expect(added.code).toBe(0);
    const contact = added.json();
    expect(contact).toMatchObject({ firstName: 'Zoe', birthday: { month: 3, day: 8 } });

    const list = await cli(h, ['contacts', 'list', '--tag', 'vip']);
    expect(list.stdout).toContain('zoe@example.com');
    expect(list.stdout).toContain('1 of 1');

    const event = await cli(h, ['events', 'send', 'project.completed', '--email', 'zoe@example.com', '--prop', 'project_name=Orbit', 'hours=12', '--dedupe', 'orbit-done', '--json']);
    expect(event.json()).toMatchObject({ contactId: contact.id, duplicate: false });
    const again = await cli(h, ['events', 'send', 'project.completed', '--email', 'zoe@example.com', '--dedupe', 'orbit-done']);
    expect(again.stdout).toContain('Already recorded');

    const upcoming = await cli(h, ['birthdays', 'upcoming', '--days', '14']);
    expect(upcoming.stdout).toContain('Zoe');
    expect(upcoming.stdout).toContain('2027-03-08');

    const missing = await cli(h, ['contacts', 'get', 'ctc_missing']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/not found/i);

    const invalid = await cli(h, ['contacts', 'add', '--email', 'nope', '--json']);
    expect(invalid.code).toBe(1);
    expect(invalid.json().error.status).toBe(422);
  });

  it('dry-runs the birthday automation without sending anything', async () => {
    h = await signedIn();
    await h.contact({ firstName: 'Ravi', email: 'ravi@example.com', birthday: { month: 3, day: 2 }, consentStatus: 'granted', consentSource: 'form' });
    const id = await h.automationId('Birthday greetings');
    const res = await cli(h, ['automations', 'dry-run', id, '--at', '2027-03-02T04:00:00Z', '--json']);
    expect(res.code).toBe(0);
    expect(res.json()).toMatchObject({ qualified: 1, results: [{ eventKey: 'birthday:2027-03-02' }] });
    const human = await cli(h, ['automations', 'dry-run', id, '--at', '2027-03-02T04:00:00Z']);
    expect(human.stdout).toContain('Ravi');
    await h.drain();
    expect(h.provider.outbox).toHaveLength(0);
  });

  it('launches a campaign only after preflight and confirmation', async () => {
    h = await signedIn();
    await h.contact({ firstName: 'Ana', email: 'ana@example.com', consentStatus: 'granted', consentSource: 'form', tags: ['news'] });
    const seg = await h.engine.segments.create(h.ctx, { name: 'News', criteria: { kind: 'group', match: 'all', rules: [{ kind: 'tag', op: 'has', tag: 'news' }] } });
    const created = await cli(h, ['campaigns', 'create', '--name', 'March news', '--segment', seg.id, '--template', await h.templateId('Newsletter'), '--json']);
    const campaignId = created.json().id;
    const pre = await cli(h, ['campaigns', 'preflight', campaignId]);
    expect(pre.stdout).toMatch(/Will receive\s+1/);
    // Without --yes and without a terminal, nothing is sent.
    const declined = await cli(h, ['campaigns', 'launch', campaignId]);
    expect(declined.code).toBe(0);
    expect((await h.engine.campaigns.get(h.ctx, campaignId)).status).toBe('draft');
    const launched = await cli(h, ['campaigns', 'launch', campaignId, '--yes']);
    expect(launched.stdout).toContain('sending');
    await h.drain();
    expect(h.provider.outbox.map((m) => m.to.email)).toEqual(['ana@example.com']);
  });

  it('reports a network failure with exit code 2', async () => {
    const res = await cli(null, ['whoami'], { MORROW_URL: 'http://127.0.0.1:9', MORROW_API_KEY: 'mrw_x_y' });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('Could not reach Morrow');
  });
});

describe('operator commands', () => {
  it('migrates, creates users, seeds the demo and passes doctor on a fresh SQLite file', async () => {
    const database = `sqlite:${join(dir, 'morrow.db').replace(/\\/g, '/')}`;
    const env = { DATABASE_URL: database, MORROW_ENV: 'development' };
    const status = await cli(null, ['migrate', '--status', '--json'], env);
    expect(status.json().every((m: { executedAt: string | null }) => m.executedAt === null)).toBe(true);
    const migrated = await cli(null, ['migrate', '--json'], env);
    expect(migrated.json().applied.length).toBeGreaterThan(5);

    const user = await cli(null, ['user', 'create', '--email', 'ops@cyphen.dev', '--name', 'Ops', '--workspace', 'Cyphen Ops', '--json'], env);
    expect(user.code).toBe(0);
    expect(user.json().password).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    const reset = await cli(null, ['user', 'reset-password', '--email', 'ops@cyphen.dev', '--password', 'a fresh long password'], env);
    expect(reset.stdout).toContain('Password reset');

    const seed = await cli(null, ['seed', '--demo', '--json'], env);
    expect(seed.json()).toMatchObject({ created: true, contacts: 40 });

    const doctor = await cli(null, ['doctor', '--json'], env);
    const report = doctor.json();
    expect(report.checks.find((c: { check: string }) => c.check === 'Migrations').status).toBe('ok');
    expect(report.checks.find((c: { check: string }) => c.check === 'Database').status).toBe('ok');
    expect(doctor.code).toBe(0);
  });

  it('parses birthdays and event properties', () => {
    expect(parseBirthday('03-07')).toEqual({ year: null, month: 3, day: 7 });
    expect(parseBirthday('1990-12-31')).toEqual({ year: 1990, month: 12, day: 31 });
    expect(() => parseBirthday('March 7')).toThrow(/MM-DD/);
    expect(parseProps(['plan=pro', 'seats=12', 'trial=false', 'note=a=b'])).toEqual({ plan: 'pro', seats: 12, trial: false, note: 'a=b' });
  });
});
