import { createHmac, timingSafeEqual } from 'node:crypto';
import { WebhookVerificationError } from './types';

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function header(headers: Record<string, string | undefined>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

/**
 * Verify a Svix-style signature (used by Resend and others).
 * Signed content is `${id}.${timestamp}.${body}`, HMAC-SHA256 with the
 * base64 secret after the `whsec_` prefix. Rejects stale timestamps to
 * prevent replay.
 */
export function verifySvixSignature(
  secret: string,
  headers: Record<string, string | undefined>,
  rawBody: string,
  options: { toleranceSeconds?: number; now?: number } = {},
): { id: string; timestamp: number } {
  const id = header(headers, 'svix-id') ?? header(headers, 'webhook-id');
  const ts = header(headers, 'svix-timestamp') ?? header(headers, 'webhook-timestamp');
  const sig = header(headers, 'svix-signature') ?? header(headers, 'webhook-signature');
  if (!id || !ts || !sig) throw new WebhookVerificationError('Missing webhook signature headers');
  const timestamp = Number(ts);
  if (!Number.isFinite(timestamp)) throw new WebhookVerificationError('Invalid webhook timestamp');
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  const tolerance = options.toleranceSeconds ?? 300;
  if (Math.abs(now - timestamp) > tolerance) throw new WebhookVerificationError('Webhook timestamp is outside the allowed window');

  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`).digest('base64');
  const candidates = sig
    .split(' ')
    .map((part) => part.split(',', 2))
    .filter(([version]) => version === 'v1')
    .map(([, value]) => value ?? '');
  if (!candidates.some((c) => safeEqual(c, expected))) throw new WebhookVerificationError();
  return { id, timestamp };
}

/** Produce Svix headers for a body (used by tests and the dev webhook simulator). */
export function signSvix(secret: string, id: string, rawBody: string, timestamp = Math.floor(Date.now() / 1000)): Record<string, string> {
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': String(timestamp), 'svix-signature': `v1,${signature}` };
}

/** Verify HTTP Basic credentials configured on a provider webhook (Postmark). */
export function verifyBasicAuth(headers: Record<string, string | undefined>, username: string, password: string): void {
  const value = header(headers, 'authorization');
  if (!value || !value.startsWith('Basic ')) throw new WebhookVerificationError('Missing webhook credentials');
  const expected = Buffer.from(`${username}:${password}`).toString('base64');
  if (!safeEqual(value.slice(6).trim(), expected)) throw new WebhookVerificationError('Invalid webhook credentials');
}
