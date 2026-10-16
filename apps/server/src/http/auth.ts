import { timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { ForbiddenError, UnauthorizedError } from '@morrow/core';
import type { Engine, WorkspaceContext } from '@morrow/engine';
import { CSRF_HEADER, SESSION_COOKIE, WORKSPACE_HEADER, type AppEnv, type Principal } from '../types';
import { rateLimited } from './errors';
import { RATE_RULES, type RateLimiter } from './rate-limit';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function bearer(c: Context): string | null {
  const h = c.req.header('authorization');
  if (!h) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m ? m[1]! : null;
}

/** Resolve the caller from an API key, a bearer session token or the session cookie. Never rejects. */
export function authenticate(engine: Engine): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set('principal', null);
    const token = bearer(c);
    if (token?.startsWith('mrw_')) {
      const key = await engine.auth.resolveApiKey(token);
      if (key) c.set('principal', { kind: 'api_key', keyId: key.key.id, keyName: key.key.name, workspaceId: key.workspaceId, role: key.role });
    } else {
      const raw = token ?? getCookie(c, SESSION_COOKIE) ?? null;
      const resolved = raw ? await engine.auth.resolveSession(raw) : null;
      if (resolved) {
        c.set('principal', {
          kind: 'session',
          via: token ? 'bearer' : 'cookie',
          token: raw!,
          sessionId: resolved.session.id,
          userId: resolved.user.id,
          userName: resolved.user.name,
          workspaceId: resolved.session.workspace_id,
          csrfToken: resolved.session.csrf_token,
        });
      } else if (!token && raw) {
        deleteCookie(c, SESSION_COOKIE, { path: '/' });
      }
    }
    await next();
  };
}

/** Cookie sessions must echo their CSRF token on unsafe methods. */
export function checkCsrf(c: Context, p: Principal): void {
  if (p.kind === 'session' && p.via === 'cookie' && UNSAFE.has(c.req.method)) {
    const sent = c.req.header(CSRF_HEADER) ?? '';
    if (!sent || !safeEqual(sent, p.csrfToken)) throw new ForbiddenError('Missing or invalid CSRF token. Reload the page and try again.');
  }
}

/**
 * Require a caller. Cookie sessions must echo their CSRF token on unsafe
 * methods; bearer credentials are not sent automatically by browsers, so
 * they need no CSRF token.
 */
export function requireAuth(limiter: RateLimiter): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const p = c.get('principal');
    if (!p) throw new UnauthorizedError('Sign in or provide an API key.');
    checkCsrf(c, p);
    const decision = limiter.hit(`api:${p.kind === 'session' ? p.userId : p.keyId}`, RATE_RULES.api);
    if (!decision.allowed) throw rateLimited(decision.retryAfterSeconds);
    await next();
  };
}

export function requireSession(c: Context<AppEnv>): Extract<Principal, { kind: 'session' }> {
  const p = c.get('principal');
  if (!p || p.kind !== 'session') throw new ForbiddenError('This action must be performed by a signed-in person, not an API key.');
  return p;
}

/** Resolve the workspace and role for this request and expose it as `ctx`. */
export function requireWorkspace(engine: Engine): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const p = c.get('principal');
    if (!p) throw new UnauthorizedError();
    const ip = c.get('ip');
    let ctx: WorkspaceContext;
    if (p.kind === 'api_key') {
      ctx = { workspaceId: p.workspaceId, role: p.role, actor: { type: 'api_key', id: p.keyId, label: `API key "${p.keyName}"` }, ip };
    } else {
      const wanted = c.req.header(WORKSPACE_HEADER) || p.workspaceId;
      let workspaceId = wanted;
      let role = workspaceId ? await engine.auth.roleIn(p.userId, workspaceId) : null;
      if (!role && !c.req.header(WORKSPACE_HEADER)) {
        // The session's workspace may have been deleted or left; fall back to any membership.
        const first = (await engine.workspaces.listForUser(p.userId))[0];
        if (first) {
          workspaceId = first.id;
          role = first.role;
          await engine.auth.switchWorkspace(p.sessionId, p.userId, first.id);
        }
      }
      if (!role || !workspaceId) throw new ForbiddenError(wanted ? 'You are not a member of that workspace.' : 'Create or join a workspace first.');
      ctx = { workspaceId, role, actor: { type: 'user', id: p.userId, label: p.userName }, ip };
    }
    c.set('ctx', ctx);
    await next();
  };
}

export function setSessionCookie(c: Context, engine: Engine, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: engine.config.appUrl.startsWith('https://'),
    path: '/',
    maxAge: engine.config.sessionTtlDays * 86_400,
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}
