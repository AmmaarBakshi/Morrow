import { describe, expect, it } from 'vitest';
import {
  classifyHttpStatus,
  classifySmtpError,
  createProvider,
  FakeProvider,
  listProviders,
  missingProviderFields,
  parseRetryAfter,
  PostmarkProvider,
  ProviderConfigError,
  ProviderError,
  ResendProvider,
  signSvix,
  verifySvixSignature,
  WebhookVerificationError,
  type OutboundEmail,
} from '../src';

const email = (to: string, key = `k-${to}`): OutboundEmail => ({
  messageId: 'msg_1',
  idempotencyKey: key,
  from: { email: 'hello@cyphen.dev', name: 'Cyphen' },
  to: { email: to },
  subject: 'Hi',
  html: '<p>Hi</p>',
  text: 'Hi',
});

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('error classification', () => {
  it('classifies HTTP statuses', () => {
    expect(classifyHttpStatus(429, 'slow down', '12').retryAfterMs).toBe(12_000);
    expect(classifyHttpStatus(429, '').errorClass).toBe('transient');
    expect(classifyHttpStatus(503, '').errorClass).toBe('transient');
    expect(classifyHttpStatus(401, '').code).toBe('provider_auth');
    expect(classifyHttpStatus(422, 'bad').errorClass).toBe('permanent');
  });

  it('classifies SMTP replies', () => {
    expect(classifySmtpError({ responseCode: 421, response: '421 try later' }).errorClass).toBe('transient');
    const unknownUser = classifySmtpError({ responseCode: 550, response: '550 5.1.1 user unknown' });
    expect(unknownUser.errorClass).toBe('permanent');
    expect(unknownUser.invalidRecipient).toBe(true);
    expect(classifySmtpError({ responseCode: 552, response: '552 5.2.2 mailbox full' }).errorClass).toBe('transient');
    expect(classifySmtpError({ code: 'ECONNRESET', message: 'reset' }).errorClass).toBe('transient');
  });

  it('parses Retry-After values', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter(new Date(Date.now() + 10_000).toUTCString())).toBeGreaterThan(8000);
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});

describe('FakeProvider', () => {
  it('accepts and simulates delivery', async () => {
    const p = new FakeProvider();
    const r = await p.send(email('rahul@example.com'));
    expect(r.providerMessageId).toMatch(/^fake_/);
    expect(r.simulatedEvents?.map((e) => e.type)).toEqual(['delivered']);
    expect(p.lastTo('rahul@example.com')?.subject).toBe('Hi');
  });

  it('simulates hard bounces, soft bounces and complaints', async () => {
    const p = new FakeProvider();
    expect((await p.send(email('rahul+bounce@example.com'))).simulatedEvents?.[0]).toMatchObject({ type: 'bounced', bounceType: 'hard' });
    expect((await p.send(email('rahul+softbounce@example.com'))).simulatedEvents?.[0]).toMatchObject({ type: 'bounced', bounceType: 'soft' });
    expect((await p.send(email('rahul+complaint@example.com'))).simulatedEvents?.map((e) => e.type)).toEqual(['delivered', 'complained']);
  });

  it('distinguishes permanent and transient failures', async () => {
    const p = new FakeProvider();
    const rejected = await p.send(email('x+reject@example.com')).catch((e) => e as ProviderError);
    expect(rejected).toBeInstanceOf(ProviderError);
    expect((rejected as ProviderError).retryable).toBe(false);
    const failed = await p.send(email('x+fail@example.com')).catch((e) => e as ProviderError);
    expect((failed as ProviderError).retryable).toBe(true);
    await expect(p.send(email('x+flaky@example.com'))).rejects.toBeInstanceOf(ProviderError);
    await expect(p.send(email('x+flaky@example.com'))).resolves.toHaveProperty('providerMessageId');
  });

  it('de-duplicates by idempotency key like a real provider', async () => {
    const p = new FakeProvider();
    const a = await p.send(email('rahul@example.com', 'same'));
    const b = await p.send(email('rahul@example.com', 'same'));
    expect(b.providerMessageId).toBe(a.providerMessageId);
    expect(p.outbox).toHaveLength(1);
  });
});

describe('Svix webhook signatures', () => {
  const secret = `whsec_${Buffer.from('super-secret-key-material').toString('base64')}`;
  const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 'abc' } });

  it('accepts a valid signature', () => {
    const headers = signSvix(secret, 'msg_1', body);
    expect(verifySvixSignature(secret, headers, body).id).toBe('msg_1');
  });

  it('rejects tampered bodies, wrong secrets and stale timestamps', () => {
    const headers = signSvix(secret, 'msg_1', body);
    expect(() => verifySvixSignature(secret, headers, `${body} `)).toThrow(WebhookVerificationError);
    expect(() => verifySvixSignature(`whsec_${Buffer.from('other').toString('base64')}`, headers, body)).toThrow(WebhookVerificationError);
    const stale = signSvix(secret, 'msg_1', body, Math.floor(Date.now() / 1000) - 3600);
    expect(() => verifySvixSignature(secret, stale, body)).toThrow(/outside the allowed window/);
    expect(() => verifySvixSignature(secret, {}, body)).toThrow(/Missing/);
  });
});

describe('ResendProvider', () => {
  it('sends with an idempotency key and maps the response', async () => {
    const { fn, calls } = mockFetch(200, { id: 're_123' });
    const p = new ResendProvider({ apiKey: 're_test', fetch: fn });
    const r = await p.send({ ...email('rahul@example.com'), tags: { campaign: 'cmp 1' } });
    expect(r.providerMessageId).toBe('re_123');
    const init = calls[0]!.init;
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('k-rahul@example.com');
    const sent = JSON.parse(String(init.body));
    expect(sent.from).toBe('Cyphen <hello@cyphen.dev>');
    expect(sent.tags).toEqual([{ name: 'campaign', value: 'cmp_1' }]);
  });

  it('classifies rate limits and validation errors', async () => {
    const limited = new ResendProvider({ apiKey: 'k', fetch: mockFetch(429, { message: 'Too many' }, { 'retry-after': '3' }).fn });
    const e1 = (await limited.send(email('a@b.co')).catch((e) => e)) as ProviderError;
    expect(e1.retryable).toBe(true);
    expect(e1.retryAfterMs).toBe(3000);
    const invalid = new ResendProvider({ apiKey: 'k', fetch: mockFetch(422, { message: 'Invalid `to` field' }).fn });
    const e2 = (await invalid.send(email('a@b.co')).catch((e) => e)) as ProviderError;
    expect(e2.retryable).toBe(false);
    expect(e2.invalidRecipient).toBe(true);
  });

  it('parses signed webhooks into normalised events', async () => {
    const secret = `whsec_${Buffer.from('k').toString('base64')}`;
    const p = new ResendProvider({ apiKey: 'k', webhookSecret: secret });
    const body = JSON.stringify({
      type: 'email.bounced',
      created_at: '2026-03-07T04:00:00.000Z',
      data: { email_id: 're_123', to: ['rahul@example.com'], bounce: { type: 'Permanent', subType: 'General', message: 'User unknown' } },
    });
    const { events } = await p.parseWebhook({ headers: signSvix(secret, 'evt_1', body), rawBody: body });
    expect(events).toEqual([
      {
        providerEventId: 'evt_1',
        providerMessageId: 're_123',
        type: 'bounced',
        bounceType: 'hard',
        reason: 'General: User unknown',
        occurredAt: '2026-03-07T04:00:00.000Z',
        recipient: 'rahul@example.com',
      },
    ]);
    await expect(p.parseWebhook({ headers: {}, rawBody: body })).rejects.toBeInstanceOf(WebhookVerificationError);
  });
});

describe('PostmarkProvider', () => {
  it('routes marketing to the broadcast stream', async () => {
    const { fn, calls } = mockFetch(200, { MessageID: 'pm_1', SubmittedAt: '2026-03-07T04:00:00Z', ErrorCode: 0 });
    const p = new PostmarkProvider({ serverToken: 't', fetch: fn });
    await p.send({ ...email('a@b.co'), category: 'marketing' });
    await p.send({ ...email('a@b.co'), category: 'transactional' });
    expect(JSON.parse(String(calls[0]!.init.body)).MessageStream).toBe('broadcast');
    expect(JSON.parse(String(calls[1]!.init.body)).MessageStream).toBe('outbound');
  });

  it('treats inactive recipients as permanent', async () => {
    const p = new PostmarkProvider({ serverToken: 't', fetch: mockFetch(422, { ErrorCode: 406, Message: 'Inactive recipient' }).fn });
    const e = (await p.send(email('a@b.co')).catch((x) => x)) as ProviderError;
    expect(e.errorClass).toBe('permanent');
    expect(e.invalidRecipient).toBe(true);
  });

  it('requires basic auth on webhooks and parses bounces', async () => {
    const p = new PostmarkProvider({ serverToken: 't', webhookUsername: 'morrow', webhookPassword: 'pw' });
    const body = JSON.stringify({ RecordType: 'Bounce', ID: 42, Type: 'HardBounce', MessageID: 'pm_1', Email: 'a@b.co', BouncedAt: '2026-03-07T05:00:00Z', Description: 'Unknown user' });
    const auth = { authorization: `Basic ${Buffer.from('morrow:pw').toString('base64')}` };
    const { events } = await p.parseWebhook({ headers: auth, rawBody: body });
    expect(events[0]).toMatchObject({ providerEventId: 'bounce:42', type: 'bounced', bounceType: 'hard', providerMessageId: 'pm_1' });
    await expect(p.parseWebhook({ headers: { authorization: 'Basic bm9wZQ==' }, rawBody: body })).rejects.toBeInstanceOf(WebhookVerificationError);
  });
});

describe('provider registry', () => {
  it('lists built-in providers', () => {
    expect(listProviders().map((p) => p.name)).toEqual(expect.arrayContaining(['fake', 'smtp', 'resend', 'postmark']));
  });

  it('reports missing required fields', () => {
    expect(missingProviderFields('resend', {}, {})).toEqual(['API key']);
    expect(() => createProvider('resend', {}, {})).toThrow(ProviderConfigError);
    expect(createProvider('resend', {}, { apiKey: 're_x' }).name).toBe('resend');
    expect(() => createProvider('carrier-pigeon')).toThrow(/Unknown/);
  });
});
