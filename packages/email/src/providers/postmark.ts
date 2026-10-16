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
import { verifyBasicAuth } from '../webhooks';

export interface PostmarkConfig {
  serverToken: string;
  /** Stream for transactional mail. */
  transactionalStream?: string;
  /** Stream for marketing and relationship mail (Postmark requires a broadcast stream). */
  broadcastStream?: string;
  /** Basic-auth credentials configured on the Postmark webhook URL. */
  webhookUsername?: string;
  webhookPassword?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

// Postmark API error codes that mean "this recipient will never work".
const INVALID_RECIPIENT_CODES = new Set([300, 406]);

/**
 * Postmark (https://postmarkapp.com) via its REST API. Postmark does not sign
 * webhooks, so Morrow requires HTTP Basic credentials on the webhook URL.
 */
export class PostmarkProvider implements EmailProvider {
  readonly name = 'postmark';
  readonly capabilities = {
    deliveryEvents: true,
    bounceEvents: true,
    complaintEvents: true,
    openTracking: true,
    clickTracking: true,
    idempotencyKeys: false,
    webhooks: true,
    customHeaders: true,
  };

  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: PostmarkConfig) {
    if (!config.serverToken) throw new Error('Postmark requires a server token');
    this.baseUrl = (config.baseUrl ?? 'https://api.postmarkapp.com').replace(/\/$/, '');
    this.fetchImpl = config.fetch ?? fetch;
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Postmark-Server-Token': this.config.serverToken,
        },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw toProviderError(err);
    }
  }

  async send(email: OutboundEmail): Promise<SendResult> {
    const stream =
      email.category && email.category !== 'transactional'
        ? (this.config.broadcastStream ?? 'broadcast')
        : (this.config.transactionalStream ?? 'outbound');
    const name = (email.from.name ?? '').replace(/[\r\n"<>]/g, '').trim();
    const res = await this.request('/email', {
      method: 'POST',
      body: JSON.stringify({
        From: name ? `"${name}" <${email.from.email}>` : email.from.email,
        To: email.to.email,
        ReplyTo: email.replyTo ?? undefined,
        Subject: email.subject,
        HtmlBody: email.html,
        TextBody: email.text,
        Headers: Object.entries({ ...email.headers, 'X-Morrow-Message-Id': email.messageId }).map(([Name, Value]) => ({ Name, Value })),
        MessageStream: stream,
        // Morrow does its own open/click tracking when enabled.
        TrackOpens: false,
        TrackLinks: 'None',
        Metadata: { morrow_message_id: email.messageId, ...(email.tags ?? {}) },
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { MessageID?: string; SubmittedAt?: string; ErrorCode?: number; Message?: string };
    if (!res.ok || (body.ErrorCode ?? 0) !== 0) {
      if (body.ErrorCode !== undefined && INVALID_RECIPIENT_CODES.has(body.ErrorCode)) {
        throw new ProviderError(body.Message ?? 'Recipient rejected', { errorClass: 'permanent', code: `postmark_${body.ErrorCode}`, invalidRecipient: true });
      }
      if (body.ErrorCode === 10) {
        throw new ProviderError(body.Message ?? 'Invalid server token', { errorClass: 'transient', code: 'provider_auth', retryAfterMs: 300_000 });
      }
      throw classifyHttpStatus(res.status, body.Message ?? '', res.headers.get('retry-after'));
    }
    if (!body.MessageID) throw new ProviderError('Postmark did not return a message ID', { errorClass: 'transient', code: 'bad_response' });
    return { providerMessageId: body.MessageID, acceptedAt: new Date(body.SubmittedAt ?? Date.now()).toISOString() };
  }

  async verify(): Promise<VerifyResult> {
    const res = await this.request('/server', { method: 'GET' }).catch((e) => e as Error);
    if (res instanceof Error) return { ok: false, message: res.message };
    const body = (await res.json().catch(() => ({}))) as { Name?: string; Message?: string };
    return res.ok ? { ok: true, message: `Connected to Postmark server "${body.Name ?? ''}".` } : { ok: false, message: body.Message ?? `Postmark returned HTTP ${res.status}` };
  }

  async parseWebhook(request: WebhookRequest): Promise<WebhookResult> {
    if (!this.config.webhookUsername || !this.config.webhookPassword) {
      throw new ProviderError('Postmark webhook credentials are not configured', { errorClass: 'permanent', code: 'config' });
    }
    verifyBasicAuth(request.headers, this.config.webhookUsername, this.config.webhookPassword);
    const p = JSON.parse(request.rawBody) as Record<string, unknown> & { RecordType?: string; MessageID?: string };
    const messageId = p.MessageID;
    if (!messageId || !p.RecordType) return { events: [] };
    const str = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : undefined);
    const num = (k: string) => (typeof p[k] === 'number' ? (p[k] as number) : undefined);
    const at = (k: string) => new Date(str(k) ?? Date.now()).toISOString();
    let event: ProviderEvent | null = null;
    switch (p.RecordType) {
      case 'Delivery':
        event = { providerEventId: `delivery:${messageId}`, providerMessageId: messageId, type: 'delivered', occurredAt: at('DeliveredAt'), recipient: str('Recipient') };
        break;
      case 'Bounce': {
        const type = str('Type') ?? '';
        const hard = ['HardBounce', 'BadEmailAddress', 'ManuallyDeactivated', 'Unsubscribe', 'AddressChange', 'DnsError'].includes(type);
        event = {
          providerEventId: `bounce:${num('ID') ?? messageId}`,
          providerMessageId: messageId,
          type: 'bounced',
          bounceType: hard ? 'hard' : 'soft',
          reason: [type, str('Description')].filter(Boolean).join(': '),
          occurredAt: at('BouncedAt'),
          recipient: str('Email'),
        };
        break;
      }
      case 'SpamComplaint':
        event = { providerEventId: `complaint:${num('ID') ?? messageId}`, providerMessageId: messageId, type: 'complained', occurredAt: at('BouncedAt'), recipient: str('Email') };
        break;
      case 'Open':
        event = { providerEventId: `open:${messageId}:${str('ReceivedAt') ?? ''}`, providerMessageId: messageId, type: 'opened', occurredAt: at('ReceivedAt'), recipient: str('Recipient') };
        break;
      case 'Click':
        event = { providerEventId: `click:${messageId}:${str('ReceivedAt') ?? ''}`, providerMessageId: messageId, type: 'clicked', url: str('OriginalLink'), occurredAt: at('ReceivedAt'), recipient: str('Recipient') };
        break;
      case 'SubscriptionChange':
        if (p.SuppressSending === true) {
          event = { providerEventId: `subscription:${messageId}:${str('ChangedAt') ?? ''}`, providerMessageId: messageId, type: 'unsubscribed', reason: str('SuppressionReason'), occurredAt: at('ChangedAt'), recipient: str('Recipient') };
        }
        break;
      default:
        break;
    }
    return { events: event ? [event] : [] };
  }
}
