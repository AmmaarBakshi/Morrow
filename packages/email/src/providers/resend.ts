import { classifyHttpStatus, toProviderError } from '../classify';
import {
  ProviderError,
  type EmailProvider,
  type OutboundEmail,
  type ProviderEvent,
  type SendResult,
  type VerifyResult,
  type WebhookRequest,
  type WebhookResult,
} from '../types';
import { verifySvixSignature } from '../webhooks';

export interface ResendConfig {
  apiKey: string;
  /** Svix signing secret (whsec_…) from the Resend webhook settings. */
  webhookSecret?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

const TAG_RE = /[^a-zA-Z0-9_-]/g;

function mailbox(email: string, name?: string | null): string {
  const clean = (name ?? '').replace(/[\r\n"<>]/g, '').trim();
  return clean ? `${clean} <${email}>` : email;
}

/**
 * Resend (https://resend.com) via its official REST API. Supports
 * idempotency keys, so a send interrupted by a crash is safe to retry, and
 * signed (Svix) webhooks for delivery, bounce, complaint, open and click events.
 */
export class ResendProvider implements EmailProvider {
  readonly name = 'resend';
  readonly capabilities = {
    deliveryEvents: true,
    bounceEvents: true,
    complaintEvents: true,
    openTracking: true,
    clickTracking: true,
    idempotencyKeys: true,
    webhooks: true,
    customHeaders: true,
  };

  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: ResendConfig) {
    if (!config.apiKey) throw new Error('Resend requires an API key');
    this.baseUrl = (config.baseUrl ?? 'https://api.resend.com').replace(/\/$/, '');
    this.fetchImpl = config.fetch ?? fetch;
  }

  private async request(path: string, init: RequestInit & { idempotencyKey?: string }): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Morrow/0.1',
    };
    if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey.slice(0, 256);
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      throw toProviderError(err);
    }
  }

  async send(email: OutboundEmail): Promise<SendResult> {
    const tags = Object.entries(email.tags ?? {})
      .slice(0, 10)
      .map(([name, value]) => ({ name: name.replace(TAG_RE, '_').slice(0, 256), value: value.replace(TAG_RE, '_').slice(0, 256) }));
    const res = await this.request('/emails', {
      method: 'POST',
      idempotencyKey: email.idempotencyKey,
      body: JSON.stringify({
        from: mailbox(email.from.email, email.from.name),
        to: [email.to.email],
        reply_to: email.replyTo ?? undefined,
        subject: email.subject,
        html: email.html,
        text: email.text,
        headers: { ...email.headers, 'X-Morrow-Message-Id': email.messageId },
        tags,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
    if (!res.ok) {
      const err = classifyHttpStatus(res.status, body.message ?? body.name ?? '', res.headers.get('retry-after'));
      if (res.status === 422 && /to|recipient|email/i.test(body.message ?? '')) {
        throw new ProviderError(err.message, { errorClass: 'permanent', code: 'invalid_recipient', invalidRecipient: true });
      }
      throw err;
    }
    if (!body.id) throw new ProviderError('Resend did not return a message ID', { errorClass: 'transient', code: 'bad_response' });
    return { providerMessageId: body.id, acceptedAt: new Date().toISOString() };
  }

  async verify(): Promise<VerifyResult> {
    const res = await this.request('/domains', { method: 'GET' }).catch((e) => e as Error);
    if (res instanceof Error) return { ok: false, message: res.message };
    const body = (await res.json().catch(() => ({}))) as { data?: Array<{ name: string; status: string }>; name?: string; message?: string };
    if (res.ok) {
      const domains = (body.data ?? []).map((d) => `${d.name} (${d.status})`);
      return { ok: true, message: domains.length ? `Connected. Domains: ${domains.join(', ')}` : 'Connected. No domains added yet.', details: { domains: body.data ?? [] } };
    }
    if (res.status === 401 && body.name === 'restricted_api_key') {
      return { ok: true, message: 'Connected with a sending-only API key (domain status cannot be listed).' };
    }
    return { ok: false, message: body.message ?? `Resend returned HTTP ${res.status}` };
  }

  async parseWebhook(request: WebhookRequest): Promise<WebhookResult> {
    if (!this.config.webhookSecret) throw new ProviderError('Resend webhook secret is not configured', { errorClass: 'permanent', code: 'config' });
    const { id } = verifySvixSignature(this.config.webhookSecret, request.headers, request.rawBody);
    const payload = JSON.parse(request.rawBody) as {
      type?: string;
      created_at?: string;
      data?: {
        email_id?: string;
        to?: string[];
        created_at?: string;
        bounce?: { type?: string; message?: string; subType?: string };
        click?: { link?: string; timestamp?: string };
        failed?: { reason?: string };
      };
    };
    const messageId = payload.data?.email_id;
    if (!messageId || !payload.type) return { events: [] };
    const occurredAt = new Date(payload.data?.click?.timestamp ?? payload.created_at ?? Date.now()).toISOString();
    const base = { providerEventId: id, providerMessageId: messageId, occurredAt, recipient: payload.data?.to?.[0] };
    const map: Record<string, Partial<ProviderEvent> | undefined> = {
      'email.sent': { type: 'accepted' },
      'email.delivered': { type: 'delivered' },
      'email.delivery_delayed': { type: 'deferred' },
      'email.complained': { type: 'complained' },
      'email.opened': { type: 'opened' },
      'email.clicked': { type: 'clicked', url: payload.data?.click?.link },
      'email.failed': { type: 'failed', reason: payload.data?.failed?.reason },
      'email.bounced': {
        type: 'bounced',
        bounceType: payload.data?.bounce?.type === 'Permanent' ? 'hard' : 'soft',
        reason: [payload.data?.bounce?.subType, payload.data?.bounce?.message].filter(Boolean).join(': ') || undefined,
      },
    };
    const mapped = map[payload.type];
    if (!mapped) return { events: [] };
    return { events: [{ ...base, ...mapped } as ProviderEvent] };
  }
}
