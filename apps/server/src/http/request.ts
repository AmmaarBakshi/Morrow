import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { MorrowError, randomToken } from '@morrow/core';
import type { Logger } from '@morrow/engine';
import type { AppEnv, ServerOptions } from '../types';
import { badRequest } from './errors';
import { clientIp } from './security';

const REQUEST_ID = /^[A-Za-z0-9._-]{8,80}$/;

/** Node adapter: the remote socket address. */
export function nodeSocketIp(_raw: Request, env: unknown): string | null {
  const incoming = (env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return incoming?.socket?.remoteAddress ?? null;
}

/** Request ID, client IP and an access log line (route patterns only, so tokens never reach logs). */
export function requestContext(options: Pick<ServerOptions, 'trustProxy' | 'socketIp'>, log: Logger): MiddlewareHandler<AppEnv> {
  const socketIp = options.socketIp ?? nodeSocketIp;
  return async (c, next) => {
    const incoming = c.req.header('x-request-id');
    const requestId = incoming && REQUEST_ID.test(incoming) ? incoming : randomToken(10);
    c.set('requestId', requestId);
    c.set('ip', clientIp(c.req.raw.headers, socketIp(c.req.raw, c.env), Boolean(options.trustProxy)));
    const started = performance.now();
    await next();
    c.res.headers.set('X-Request-Id', requestId);
    const ms = Math.round(performance.now() - started);
    const status = c.res.status;
    const entry = { requestId, method: c.req.method, route: c.req.routePath, status, ms };
    if (status >= 500) log.error('request', entry);
    else if (c.req.path.startsWith('/api/')) log.info('request', entry);
    else log.debug('request', entry);
  };
}

const MB = 1024 * 1024;

/** Cap request bodies: generous for CSV uploads, tight everywhere else. */
export function bodyLimits(): MiddlewareHandler<AppEnv> {
  const regular = bodyLimit({ maxSize: 2 * MB, onError: () => { throw new MorrowError('payload_too_large', 'The request body is too large (2 MB maximum).'); } });
  const uploads = bodyLimit({ maxSize: 30 * MB, onError: () => { throw new MorrowError('payload_too_large', 'The file is too large (30 MB maximum).'); } });
  return (c, next) => (/\/imports\/?$/.test(c.req.path) ? uploads(c, next) : regular(c, next));
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * API bodies must be JSON (CSV for uploads). Browsers cannot send JSON
 * cross-site without a CORS preflight, which closes form-based CSRF even on
 * endpoints that run before a session exists (sign-in, sign-up).
 */
export function requireJsonBodies(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (UNSAFE.has(c.req.method)) {
      const length = Number(c.req.header('content-length') ?? '0');
      const hasBody = length > 0 || c.req.header('transfer-encoding') !== undefined;
      const type = (c.req.header('content-type') ?? '').toLowerCase();
      const csvUpload = /\/imports\/?$/.test(c.req.path) && (type.startsWith('text/csv') || type.startsWith('text/plain'));
      if (hasBody && !type.startsWith('application/json') && !csvUpload) {
        throw badRequest('Send request bodies as application/json.');
      }
    }
    await next();
  };
}
