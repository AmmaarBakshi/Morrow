import { ProviderError } from './types';

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ESOCKET',
  'ECONNECTION',
  'EAI_AGAIN',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
]);

/** Parse a Retry-After header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 3_600_000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - now, 3_600_000));
  return undefined;
}

/** Classify an HTTP API response from a provider. */
export function classifyHttpStatus(status: number, message: string, retryAfter?: string | null): ProviderError {
  if (status === 429) {
    return new ProviderError(message || 'Rate limited by provider', {
      errorClass: 'transient',
      code: 'rate_limited',
      retryAfterMs: parseRetryAfter(retryAfter) ?? 30_000,
    });
  }
  if (status === 401 || status === 403) {
    // Bad credentials affect every message; keep retrying so fixing the key resumes delivery.
    return new ProviderError(message || 'Provider rejected the credentials', { errorClass: 'transient', code: 'provider_auth', retryAfterMs: 300_000 });
  }
  if (status === 408 || status >= 500) {
    return new ProviderError(message || `Provider error ${status}`, { errorClass: 'transient', code: `http_${status}` });
  }
  return new ProviderError(message || `Provider rejected the message (${status})`, { errorClass: 'permanent', code: `http_${status}` });
}

/**
 * Classify an SMTP failure. 4xx replies are temporary; 5xx are permanent,
 * except "mailbox full"-type 5.2.x codes, which many servers use for
 * temporary conditions.
 */
export function classifySmtpError(err: { responseCode?: number; code?: string; response?: string; message?: string }): ProviderError {
  const message = err.response || err.message || 'SMTP error';
  if (err.code && TRANSIENT_NETWORK_CODES.has(err.code)) {
    return new ProviderError(message, { errorClass: 'transient', code: err.code.toLowerCase() });
  }
  if (err.code === 'EAUTH') {
    return new ProviderError(message, { errorClass: 'transient', code: 'provider_auth', retryAfterMs: 300_000 });
  }
  const rc = err.responseCode;
  if (rc && rc >= 400 && rc < 500) return new ProviderError(message, { errorClass: 'transient', code: `smtp_${rc}` });
  if (rc && rc >= 500) {
    if (/\b5\.2\.[0-9]\b/.test(message)) return new ProviderError(message, { errorClass: 'transient', code: `smtp_${rc}` });
    const invalid = rc === 550 || rc === 551 || rc === 553 || /\b5\.1\.[0-9]\b/.test(message);
    return new ProviderError(message, { errorClass: 'permanent', code: `smtp_${rc}`, invalidRecipient: invalid });
  }
  if (err.code === 'EENVELOPE') return new ProviderError(message, { errorClass: 'permanent', code: 'envelope', invalidRecipient: true });
  return new ProviderError(message, { errorClass: 'transient', code: 'smtp_unknown' });
}

/** Wrap anything thrown by a provider into a classified ProviderError. */
export function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  const e = err as { code?: string; name?: string; message?: string; cause?: { code?: string } };
  const code = e?.code ?? e?.cause?.code;
  if ((code && TRANSIENT_NETWORK_CODES.has(code)) || e?.name === 'AbortError' || e?.name === 'TimeoutError') {
    return new ProviderError(e?.message ?? 'Network error', { errorClass: 'transient', code: (code ?? 'timeout').toLowerCase() });
  }
  if (e?.name === 'TypeError' && /fetch failed/i.test(e.message ?? '')) {
    return new ProviderError('Could not reach the provider', { errorClass: 'transient', code: 'network' });
  }
  return new ProviderError(e?.message ?? 'Unknown provider error', { errorClass: 'transient', code: 'unknown' });
}
