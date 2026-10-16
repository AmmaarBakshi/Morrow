/**
 * The provider-independent delivery contract. Every provider (fake, SMTP,
 * Resend, Postmark, …) implements {@link EmailProvider}; the engine never
 * depends on provider-specific details.
 */

export interface Mailbox {
  email: string;
  name?: string | null;
}

export interface OutboundEmail {
  /** Morrow message ID (also sent as a header for correlation). */
  messageId: string;
  /** Stable key for the intended send; providers that support it de-duplicate on it. */
  idempotencyKey: string;
  from: Mailbox;
  to: Mailbox;
  replyTo?: string | null;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
  /** Small non-sensitive labels (workspace, campaign) for provider dashboards. */
  tags?: Record<string, string>;
  /** Lets providers route marketing separately (e.g. Postmark broadcast streams). */
  category?: 'transactional' | 'relationship' | 'marketing';
}

export interface SendResult {
  providerMessageId: string;
  acceptedAt: string;
  /**
   * Events the provider already knows will follow (used by the fake provider
   * to simulate asynchronous webhooks through the normal ingestion path).
   */
  simulatedEvents?: ProviderEvent[];
}

export type ProviderEventType =
  | 'accepted'
  | 'delivered'
  | 'deferred'
  | 'bounced'
  | 'complained'
  | 'opened'
  | 'clicked'
  | 'unsubscribed'
  | 'rejected'
  | 'failed';

export interface ProviderEvent {
  /** Unique per provider event, used to ignore repeated webhook deliveries. */
  providerEventId: string | null;
  providerMessageId: string;
  type: ProviderEventType;
  occurredAt: string;
  bounceType?: 'hard' | 'soft';
  reason?: string;
  url?: string;
  recipient?: string;
}

export interface ProviderCapabilities {
  /** Provider reports actual delivery (not just acceptance). */
  deliveryEvents: boolean;
  bounceEvents: boolean;
  complaintEvents: boolean;
  /** Provider natively tracks opens/clicks (Morrow can also track itself). */
  openTracking: boolean;
  clickTracking: boolean;
  /** Provider de-duplicates requests by idempotency key — safe to retry after a crash. */
  idempotencyKeys: boolean;
  webhooks: boolean;
  customHeaders: boolean;
}

export interface VerifyResult {
  ok: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export interface WebhookRequest {
  headers: Record<string, string | undefined>;
  rawBody: string;
  query?: Record<string, string | undefined>;
}

export interface WebhookResult {
  events: ProviderEvent[];
}

export interface EmailProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  send(email: OutboundEmail): Promise<SendResult>;
  /** Check credentials/connectivity without sending a message. */
  verify(): Promise<VerifyResult>;
  /** Verify and parse a webhook. Throws WebhookVerificationError on a bad signature. */
  parseWebhook?(request: WebhookRequest): Promise<WebhookResult>;
}

export type ErrorClass = 'transient' | 'permanent';

/**
 * A classified provider failure. `transient` errors are retried with backoff;
 * `permanent` ones (invalid address, rejection) never are.
 */
export class ProviderError extends Error {
  readonly errorClass: ErrorClass;
  readonly code: string;
  readonly retryAfterMs?: number;
  /** The recipient address itself is bad (suppress it). */
  readonly invalidRecipient: boolean;

  constructor(
    message: string,
    options: { errorClass: ErrorClass; code: string; retryAfterMs?: number; invalidRecipient?: boolean },
  ) {
    super(message);
    this.name = 'ProviderError';
    this.errorClass = options.errorClass;
    this.code = options.code;
    this.retryAfterMs = options.retryAfterMs;
    this.invalidRecipient = options.invalidRecipient ?? false;
  }

  get retryable(): boolean {
    return this.errorClass === 'transient';
  }
}

export class WebhookVerificationError extends Error {
  constructor(message = 'Webhook signature verification failed') {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}
