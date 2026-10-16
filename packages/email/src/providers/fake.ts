import { ProviderError, type EmailProvider, type OutboundEmail, type ProviderEvent, type SendResult } from '../types';

/**
 * Development and test provider. Nothing leaves the machine.
 *
 * Behaviour is controlled by the recipient address so every delivery path
 * can be exercised end to end:
 *
 *   anything@…            accepted, then delivered
 *   …+bounce@… / bounce@  accepted, then hard bounce
 *   …+softbounce@…        accepted, then soft bounce (deferred)
 *   …+complaint@…         delivered, then spam complaint
 *   …+reject@…            permanent rejection at send time
 *   …+fail@…              transient failure on every attempt
 *   …+flaky@…             transient failure on the first attempt, then accepted
 */
export interface FakeSentEmail extends OutboundEmail {
  providerMessageId: string;
  acceptedAt: string;
}

export interface FakeProviderOptions {
  /** Clock used for timestamps (tests use a fixed clock). */
  now?: () => Date;
  /** Delay before simulated delivery events, in ms (informational). */
  eventDelayMs?: number;
}

let counter = 0;

export class FakeProvider implements EmailProvider {
  readonly name = 'fake';
  readonly capabilities = {
    deliveryEvents: true,
    bounceEvents: true,
    complaintEvents: true,
    openTracking: false,
    clickTracking: false,
    idempotencyKeys: true,
    webhooks: false,
    customHeaders: true,
  };

  /** Everything "sent" so far, newest last. */
  readonly outbox: FakeSentEmail[] = [];
  private readonly attempts = new Map<string, number>();
  private readonly byIdempotencyKey = new Map<string, FakeSentEmail>();
  private readonly now: () => Date;

  constructor(options: FakeProviderOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async send(email: OutboundEmail): Promise<SendResult> {
    const address = email.to.email.toLowerCase();
    const local = address.split('@')[0] ?? '';
    const attempt = (this.attempts.get(email.idempotencyKey) ?? 0) + 1;
    this.attempts.set(email.idempotencyKey, attempt);

    if (local.endsWith('+reject') || local === 'reject') {
      throw new ProviderError('550 5.1.1 Recipient address rejected (simulated)', {
        errorClass: 'permanent',
        code: 'smtp_550',
        invalidRecipient: true,
      });
    }
    if (local.endsWith('+fail')) {
      throw new ProviderError('421 Service not available (simulated)', { errorClass: 'transient', code: 'smtp_421' });
    }
    if (local.endsWith('+flaky') && attempt === 1) {
      throw new ProviderError('Connection reset (simulated)', { errorClass: 'transient', code: 'econnreset' });
    }

    // Honour idempotency keys like a real provider: a retried request returns the original result.
    const existing = this.byIdempotencyKey.get(email.idempotencyKey);
    if (existing) return { providerMessageId: existing.providerMessageId, acceptedAt: existing.acceptedAt };

    counter += 1;
    const acceptedAt = this.now().toISOString();
    const providerMessageId = `fake_${Date.now().toString(36)}_${counter}`;
    const sent: FakeSentEmail = { ...email, providerMessageId, acceptedAt };
    this.outbox.push(sent);
    this.byIdempotencyKey.set(email.idempotencyKey, sent);

    const event = (type: ProviderEvent['type'], extra: Partial<ProviderEvent> = {}): ProviderEvent => ({
      providerEventId: `${providerMessageId}:${type}`,
      providerMessageId,
      type,
      occurredAt: acceptedAt,
      recipient: address,
      ...extra,
    });

    let simulatedEvents: ProviderEvent[];
    if (local.endsWith('+bounce') || local === 'bounce') {
      simulatedEvents = [event('bounced', { bounceType: 'hard', reason: '550 5.1.1 User unknown (simulated)' })];
    } else if (local.endsWith('+softbounce')) {
      simulatedEvents = [event('bounced', { bounceType: 'soft', reason: '452 4.2.2 Mailbox full (simulated)' })];
    } else if (local.endsWith('+complaint')) {
      simulatedEvents = [event('delivered'), event('complained', { reason: 'abuse (simulated)' })];
    } else {
      simulatedEvents = [event('delivered')];
    }
    return { providerMessageId, acceptedAt, simulatedEvents };
  }

  async verify() {
    return { ok: true, message: 'Development provider: messages are stored locally and never delivered.' };
  }

  /** Test helper: last message sent to an address. */
  lastTo(address: string): FakeSentEmail | undefined {
    const a = address.toLowerCase();
    for (let i = this.outbox.length - 1; i >= 0; i--) if (this.outbox[i]!.to.email.toLowerCase() === a) return this.outbox[i];
    return undefined;
  }

  clear(): void {
    this.outbox.length = 0;
    this.attempts.clear();
    this.byIdempotencyKey.clear();
  }
}
