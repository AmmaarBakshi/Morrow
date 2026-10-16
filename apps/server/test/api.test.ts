import { afterEach, describe, expect, it } from 'vitest';
import { createServerHarness, type ServerHarness } from './client';

let h: ServerHarness;
afterEach(async () => h?.close());

describe('operations endpoints', () => {
  it('reports liveness, readiness and Prometheus metrics', async () => {
    h = await createServerHarness();
    const c = h.client();
    expect((await c.get('/healthz')).body).toMatchObject({ ok: true });
    const ready = await c.get('/readyz');
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({ ok: true, database: true });
    const metrics = await c.get('/metrics');
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get('content-type')).toContain('text/plain');
    expect(metrics.text).toContain('morrow_queue_lag_seconds');
  });

  it('protects metrics with a bearer token when one is configured', async () => {
    h = await createServerHarness({ server: { metricsToken: 'scrape-secret-token' } });
    const c = h.client();
    expect((await c.get('/metrics')).status).toBe(401);
    expect((await c.get('/metrics', { authorization: 'Bearer wrong-token-value' })).status).toBe(401);
    expect((await c.get('/metrics', { authorization: 'Bearer scrape-secret-token' })).status).toBe(200);
  });

  it('sets security headers and answers unknown API paths with JSON', async () => {
    h = await createServerHarness();
    const c = h.client();
    const res = await c.get('/api/v1/auth/setup');
    expect(res.body).toMatchObject({ hasUsers: true });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('strict-transport-security')).toContain('max-age');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-request-id')).toBeTruthy();
    await c.login();
    const missing = await c.get('/api/v1/definitely-not-here');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('not_found');
  });
});

describe('authentication', () => {
  it('signs in with an HttpOnly cookie and requires the CSRF token for changes', async () => {
    h = await createServerHarness();
    const c = h.client();
    expect((await c.get('/api/v1/contacts')).status).toBe(401);
    const login = await c.login();
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Secure/i);
    expect(login.body.token).toBeUndefined();
    expect(login.body.session.workspace.name).toBe('Cyphen');

    const session = await c.get('/api/v1/auth/session');
    expect(session.body.user.email).toBe('owner@cyphen.dev');

    const csrf = c.csrf;
    c.csrf = null;
    const blocked = await c.post('/api/v1/contacts', { firstName: 'Ana', email: 'ana@example.com' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.message).toMatch(/CSRF/);
    c.csrf = csrf;
    const created = await c.post('/api/v1/contacts', { firstName: 'Ana', email: 'ana@example.com' });
    expect(created.status).toBe(201);

    await c.post('/api/v1/auth/logout');
    expect(c.cookie).toBeNull();
    expect((await c.get('/api/v1/contacts')).status).toBe(401);
  });

  it('issues bearer tokens for the CLI that need no CSRF token', async () => {
    h = await createServerHarness();
    const c = h.client();
    const res = await c.post('/api/v1/auth/login', { email: 'owner@cyphen.dev', password: 'correct horse battery staple', issueToken: true });
    expect(res.headers.get('set-cookie')).toBeNull();
    c.bearer = res.body.token;
    expect((await c.post('/api/v1/contacts', { firstName: 'Cli' })).status).toBe(201);
    const who = await c.get('/api/v1/auth/whoami');
    expect(who.body).toMatchObject({ kind: 'session', role: 'owner', workspace: { name: 'Cyphen' } });
  });

  it('rejects non-JSON bodies so cross-site forms cannot post to the API', async () => {
    h = await createServerHarness();
    const c = h.client();
    const res = await c.request('POST', '/api/v1/auth/login', 'email=owner%40cyphen.dev&password=x', { 'content-type': 'application/x-www-form-urlencoded' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/application\/json/);
  });

  it('rate limits repeated failed sign-ins', async () => {
    h = await createServerHarness();
    const c = h.client();
    for (let i = 0; i < 10; i++) expect((await c.post('/api/v1/auth/login', { email: 'owner@cyphen.dev', password: 'wrong' })).status).toBe(401);
    const limited = await c.post('/api/v1/auth/login', { email: 'owner@cyphen.dev', password: 'correct horse battery staple' });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    // Another address from the same IP is unaffected, and the window expires.
    expect((await c.post('/api/v1/auth/login', { email: 'other@cyphen.dev', password: 'wrong' })).status).toBe(401);
    h.clock.advanceMinutes(16);
    expect((await c.login()).status).toBe(200);
  });

  it('authenticates API keys with their role and stops honouring revoked keys', async () => {
    h = await createServerHarness();
    const owner = h.client();
    await owner.login();
    const key = await owner.post('/api/v1/api-keys', { name: 'Reporting', role: 'analyst' });
    expect(key.status).toBe(201);
    const bot = h.client('198.51.100.20');
    bot.bearer = key.body.key;
    expect((await bot.get('/api/v1/contacts')).status).toBe(200);
    const denied = await bot.post('/api/v1/contacts', { firstName: 'Nope' });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('forbidden');
    expect((await bot.post('/api/v1/auth/logout')).status).toBe(403); // keys are not sessions
    expect((await bot.get('/api/v1/auth/whoami')).body).toMatchObject({ kind: 'api_key', apiKey: { name: 'Reporting' }, role: 'analyst' });
    await owner.delete(`/api/v1/api-keys/${key.body.id}`);
    expect((await bot.get('/api/v1/contacts')).status).toBe(401);
  });
});

describe('API behaviour', () => {
  it('returns field-level validation errors', async () => {
    h = await createServerHarness();
    const c = h.client();
    await c.login();
    const res = await c.post('/api/v1/tags', { name: '' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.details.issues[0].path).toBe('name');
    const bad = await c.request('POST', '/api/v1/tags', '{not json');
    expect(bad.status).toBe(400);
  });

  it('isolates workspaces at the HTTP layer too', async () => {
    h = await createServerHarness();
    const owner = h.client();
    await owner.login();
    const ana = await owner.post('/api/v1/contacts', { firstName: 'Ana', email: 'ana@example.com' });
    const rival = h.client('198.51.100.30');
    const signup = await rival.post('/api/v1/auth/signup', { email: 'rival@elsewhere.dev', name: 'Rival', password: 'another long passphrase', workspaceName: 'Elsewhere' });
    expect(signup.status).toBe(201);
    rival.csrf = signup.body.session.csrfToken;
    expect((await rival.get(`/api/v1/contacts/${ana.body.id}`)).status).toBe(404);
    expect((await rival.patch(`/api/v1/contacts/${ana.body.id}`, { firstName: 'Mine now' })).status).toBe(404);
    expect((await rival.get('/api/v1/contacts')).body.total).toBe(0);
    // Picking another workspace by header requires membership.
    const forced = await rival.get('/api/v1/contacts', { 'x-morrow-workspace': h.workspaceId });
    expect(forced.status).toBe(403);
  });

  it('lists each template variable once, including workspace values for standard keys', async () => {
    h = await createServerHarness();
    const c = h.client();
    await c.login();
    const patched = await c.patch('/api/v1/workspace', { settings: { variables: { collaboration_url: 'https://cal.example.com/team', github_org: 'example' } } });
    expect(patched.status).toBe(200);
    const { items } = (await c.get('/api/v1/variables')).body as { items: { key: string }[] };
    const keys = items.map((v) => v.key);
    expect(keys.filter((k) => k === 'collaboration_url')).toHaveLength(1);
    expect(keys).toContain('github_org');
  });

  it('streams CSV exports only to roles allowed to export', async () => {
    h = await createServerHarness();
    const owner = h.client();
    await owner.login();
    await owner.post('/api/v1/contacts', { firstName: 'Formula', lastName: '=HYPERLINK("http://evil")', email: 'f@example.com' });
    const csv = await owner.get('/api/v1/contacts/export');
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(csv.headers.get('content-disposition')).toMatch(/attachment; filename="morrow-contacts-/);
    expect(csv.text.split('\n')[0]).toContain('first_name');
    expect(csv.text).toContain(`'=HYPERLINK`);
    const key = await owner.post('/api/v1/api-keys', { name: 'Analyst', role: 'analyst' });
    const analyst = h.client('198.51.100.40');
    analyst.bearer = key.body.key;
    expect((await analyst.get('/api/v1/contacts/export')).status).toBe(403);
  });

  it('accepts CSV uploads as text/csv and previews the mapping', async () => {
    h = await createServerHarness();
    const c = h.client();
    await c.login();
    const upload = await c.request('POST', '/api/v1/imports?filename=people.csv', 'First Name,Email,Birthday\nRavi,ravi@example.com,1990-03-07\n', { 'content-type': 'text/csv' });
    expect(upload.status).toBe(201);
    expect(upload.body.rowCount).toBe(1);
    const imports = await c.get('/api/v1/imports');
    expect(imports.body.items.map((i: { filename: string }) => i.filename)).toEqual(['people.csv']);
  });

  it('runs the campaign lifecycle over HTTP', async () => {
    h = await createServerHarness();
    const c = h.client();
    await c.login();
    for (const name of ['Ana', 'Ben']) await c.post('/api/v1/contacts', { firstName: name, email: `${name.toLowerCase()}@example.com`, consentStatus: 'granted', consentSource: 'Form', tags: ['news'] });
    const seg = await c.post('/api/v1/segments', { name: 'News', criteria: { kind: 'group', match: 'all', rules: [{ kind: 'tag', op: 'has', tag: 'news' }] } });
    const templates = await c.get('/api/v1/templates?purpose=newsletter');
    const campaign = await c.post('/api/v1/campaigns', { name: 'Hello', segmentId: seg.body.id, templateId: templates.body.items[0].id });
    expect(campaign.status).toBe(201);
    const pre = await c.get(`/api/v1/campaigns/${campaign.body.id}/preflight`);
    expect(pre.body).toMatchObject({ ok: true, eligible: 2 });
    expect((await c.post(`/api/v1/campaigns/${campaign.body.id}/launch`)).body.status).toBe('sending');
    await h.drain();
    expect(h.provider.outbox.map((m) => m.to.email).sort()).toEqual(['ana@example.com', 'ben@example.com']);
    const messages = await c.get(`/api/v1/messages?campaignId=${campaign.body.id}`);
    expect(messages.body.total).toBe(2);
  });
});

describe('recipient endpoints', () => {
  it('serves an unsubscribe page, honours one-click and lets people undo it', async () => {
    h = await createServerHarness();
    const contactId = await h.contact({ firstName: 'Leaving', email: 'leaving@example.com', consentStatus: 'granted', consentSource: 'Form' });
    const url = h.engine.delivery.unsubscribeUrl(h.workspaceId, contactId, 'msg_test', 'leaving@example.com');
    const path = new URL(url).pathname;
    const c = h.client();
    const page = await c.get(path);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(page.text).toContain('Unsubscribe from Cyphen?');
    expect(page.text).toContain('le•••@example.com');
    expect(page.text).not.toContain('leaving@example.com');
    expect(page.text).not.toContain('<script');

    const oneClick = await c.request('POST', path, 'List-Unsubscribe=One-Click', { 'content-type': 'application/x-www-form-urlencoded' });
    expect(oneClick.status).toBe(200);
    expect(await h.engine.suppressions.active(h.workspaceId, 'leaving@example.com')).toBeTruthy();
    expect((await h.engine.contacts.get(h.ctx, contactId)).consentStatus).toBe('withdrawn');
    expect((await c.get(path)).text).toMatch(/You(&#39;|&#x27;)re unsubscribed/);

    const undo = await c.request('POST', path, 'action=resubscribe', { 'content-type': 'application/x-www-form-urlencoded' });
    expect(undo.text).toContain('Welcome back');
    expect(await h.engine.suppressions.active(h.workspaceId, 'leaving@example.com')).toBeFalsy();

    expect((await c.get('/u/forged-token')).status).toBe(404);
    expect((await c.get('/u/preview')).text).toContain('preview');
  });

  it('records clicks and redirects only for signed links', async () => {
    h = await createServerHarness();
    const html = h.engine.delivery.applyTracking('<a href="https://cyphen.dev/work">Our work</a>', 'msg_unknown', { opens: true, clicks: true, skip: [] });
    const token = /\/t\/c\/([^"]+)"/.exec(html)![1]!;
    const c = h.client();
    const res = await c.get(`/t/c/${token}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://cyphen.dev/work');
    expect((await c.get(`/t/c/${token.slice(0, -2)}xx`)).status).toBe(404);
    const pixel = await c.get('/t/o/not-a-token');
    expect(pixel.status).toBe(200);
    expect(pixel.headers.get('content-type')).toBe('image/gif');
  });

  it('accepts only correctly signed provider webhooks', async () => {
    const { signSvix } = await import('@morrow/email');
    h = await createServerHarness();
    const c = h.client();
    await c.login();
    const secret = `whsec_${Buffer.from('server-test-key').toString('base64')}`;
    const integration = await c.put('/api/v1/integrations/email', { provider: 'resend', secrets: { apiKey: 're_test_key', webhookSecret: secret } });
    expect(integration.status).toBe(200);
    expect(integration.body.secretsSet).toMatchObject({ apiKey: true, webhookSecret: true });
    expect(JSON.stringify(integration.body)).not.toContain('re_test_key');
    const path = new URL(integration.body.webhookUrl).pathname;
    const body = JSON.stringify({ type: 'email.delivered', created_at: '2027-03-06T12:10:00Z', data: { email_id: 're_unknown', to: ['x@example.com'] } });
    const forged = await c.request('POST', path, body, { 'content-type': 'application/json', ...signSvix(`whsec_${Buffer.from('attacker').toString('base64')}`, 'evt_1', body) });
    expect(forged.status).toBe(401);
    const ok = await c.request('POST', path, body, { 'content-type': 'application/json', ...signSvix(secret, 'evt_1', body) });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ received: 1 });
    const jobs = await h.engine.db.selectFrom('jobs').select('type').where('type', '=', 'email.events').execute();
    expect(jobs).toHaveLength(1);
    expect((await c.request('POST', '/webhooks/resend/int_missing', body)).status).toBe(404);
  });
});
