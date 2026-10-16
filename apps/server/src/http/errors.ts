import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { isMorrowError, MorrowError, type ErrorCode } from '@morrow/core';
import type { Logger } from '@morrow/engine';

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

export function badRequest(message: string, details?: unknown): MorrowError {
  return new MorrowError('bad_request', message, details);
}

export function rateLimited(retryAfterSeconds: number): MorrowError {
  return new MorrowError('rate_limited', 'Too many requests. Slow down and try again shortly.', { retryAfterSeconds });
}

/**
 * Translate any thrown value into the API error envelope. Morrow errors carry
 * safe, user-facing messages; anything else is logged and reported generically
 * so stack traces, SQL and secrets never reach the client.
 */
export function errorResponse(c: Context, err: unknown, log: Logger): Response {
  const requestId = c.get('requestId') as string | undefined;
  if (isMorrowError(err) && err.expose) {
    if (err.code === 'rate_limited') {
      const retry = (err.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
      if (retry) c.header('Retry-After', String(retry));
    }
    const body: ErrorBody = { error: { code: err.code, message: err.message, details: err.details, requestId } };
    return c.json(body, err.status as ContentfulStatusCode);
  }
  log.error('unhandled request error', { requestId, method: c.req.method, route: c.req.routePath, error: err as Error });
  const body: ErrorBody = { error: { code: 'internal_error', message: 'Something went wrong on our side. The error has been logged.', requestId } };
  return c.json(body, 500);
}
