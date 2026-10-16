import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { permissionsFor, PreconditionError, type AuthResultDTO, type SetupStatusDTO, type WhoAmIDTO } from '@morrow/core';
import { MORROW_VERSION, type Engine } from '@morrow/engine';
import { checkCsrf, clearSessionCookie, requireAuth, requireSession, requireWorkspace, setSessionCookie } from '../http/auth';
import { rateLimited } from '../http/errors';
import { readJson } from '../http/input';
import { RATE_RULES, type RateLimiter } from '../http/rate-limit';
import type { AppEnv } from '../types';

const credentials = z.object({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
  /** Return a bearer token instead of (only) setting the cookie — for the CLI and scripts. */
  issueToken: z.boolean().optional(),
});

const signupBody = z.object({
  email: z.string().min(1).max(320),
  name: z.string().min(1).max(100),
  password: z.string().min(1).max(1024),
  workspaceName: z.string().min(1).max(100),
  timezone: z.string().max(64).optional(),
  issueToken: z.boolean().optional(),
});

export function authRoutes(engine: Engine, limiter: RateLimiter): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const meta = (c: Context<AppEnv>) => ({ ip: c.get('ip'), userAgent: c.req.header('user-agent') ?? null });
  const limit = (key: string, rule: (typeof RATE_RULES)[keyof typeof RATE_RULES]) => {
    const d = limiter.hit(key, rule);
    if (!d.allowed) throw rateLimited(d.retryAfterSeconds);
  };

  async function result(c: Context<AppEnv>, token: string, issueToken?: boolean): Promise<AuthResultDTO> {
    const resolved = await engine.auth.resolveSession(token);
    if (!resolved) throw new PreconditionError('The session could not be created.');
    if (!issueToken) setSessionCookie(c, engine, token);
    const session = await engine.auth.sessionInfo(resolved);
    return issueToken ? { session, token } : { session };
  }

  app.get('/setup', async (c) => {
    const hasUsers = (await engine.auth.userCount()) > 0;
    const body: SetupStatusDTO = { version: MORROW_VERSION, hasUsers, signupAllowed: await engine.auth.signupAllowed() };
    return c.json(body);
  });

  app.post('/signup', async (c) => {
    limit(`signup:${c.get('ip') ?? 'unknown'}`, RATE_RULES.signup);
    const input = await readJson(c, signupBody);
    const { token } = await engine.auth.signup(input, meta(c));
    return c.json(await result(c, token, input.issueToken), 201);
  });

  app.post('/login', async (c) => {
    const input = await readJson(c, credentials);
    const key = `login:${c.get('ip') ?? 'unknown'}:${input.email.trim().toLowerCase()}`;
    limit(key, RATE_RULES.login);
    const { token } = await engine.auth.login(input.email, input.password, meta(c));
    limiter.reset(key);
    return c.json(await result(c, token, input.issueToken));
  });

  // Public invitation lookup and acceptance (new accounts are rate limited like sign-up).
  app.get('/invitations/:token', async (c) => {
    limit(`public:${c.get('ip') ?? 'unknown'}`, RATE_RULES.public);
    const info = await engine.workspaces.inspectInvitation(c.req.param('token'));
    if (!info) throw new PreconditionError('This invitation is invalid or has expired.');
    return c.json(info);
  });

  app.post('/invitations/:token/accept', async (c) => {
    const token = c.req.param('token');
    const p = c.get('principal');
    if (p?.kind === 'session') {
      checkCsrf(c, p);
      const joined = await engine.workspaces.acceptInvitation(token, { userId: p.userId });
      await engine.auth.switchWorkspace(p.sessionId, p.userId, joined.workspaceId);
      return c.json(await result(c, p.token, p.via === 'bearer'));
    }
    limit(`signup:${c.get('ip') ?? 'unknown'}`, RATE_RULES.signup);
    const input = await readJson(c, z.object({ name: z.string().min(1).max(100), password: z.string().min(1).max(1024), issueToken: z.boolean().optional() }));
    const joined = await engine.workspaces.acceptInvitation(token, { name: input.name, password: input.password });
    const session = await engine.auth.createSession(joined.userId, joined.workspaceId, meta(c));
    return c.json(await result(c, session, input.issueToken), 201);
  });

  // Everything below needs a signed-in caller.
  app.use('/*', requireAuth(limiter));

  app.get('/session', async (c) => {
    const p = requireSession(c);
    const resolved = await engine.auth.resolveSession(p.token);
    if (!resolved) throw new PreconditionError('Your session has ended. Sign in again.');
    return c.json(await engine.auth.sessionInfo(resolved));
  });

  app.get('/whoami', requireWorkspace(engine), async (c) => {
    const ctx = c.get('ctx');
    const p = c.get('principal')!;
    const workspace = await engine.workspaces.get(ctx);
    let user: WhoAmIDTO['user'] = null;
    if (p.kind === 'session') {
      const resolved = await engine.auth.resolveSession(p.token);
      user = resolved ? (await engine.auth.sessionInfo(resolved)).user : null;
    }
    const body: WhoAmIDTO = {
      kind: p.kind,
      user,
      apiKey: p.kind === 'api_key' ? { id: p.keyId, name: p.keyName } : null,
      workspace,
      role: ctx.role,
      permissions: permissionsFor(ctx.role),
    };
    return c.json(body);
  });

  app.post('/logout', async (c) => {
    const p = requireSession(c);
    await engine.auth.logout(p.token);
    clearSessionCookie(c);
    return c.json({ ok: true });
  });

  app.post('/switch-workspace', async (c) => {
    const p = requireSession(c);
    const { workspaceId } = await readJson(c, z.object({ workspaceId: z.string().min(1).max(64) }));
    await engine.auth.switchWorkspace(p.sessionId, p.userId, workspaceId);
    const resolved = await engine.auth.resolveSession(p.token);
    return c.json(await engine.auth.sessionInfo(resolved!));
  });

  app.post('/password', async (c) => {
    const p = requireSession(c);
    const input = await readJson(c, z.object({ currentPassword: z.string().max(1024), newPassword: z.string().max(1024) }));
    await engine.auth.changePassword(p.userId, input.currentPassword, input.newPassword, p.sessionId);
    return c.json({ ok: true });
  });

  app.post('/workspaces', async (c) => {
    const p = requireSession(c);
    const input = await readJson(c, z.object({ name: z.string().min(1).max(100), timezone: z.string().max(64).optional(), companyName: z.string().max(120).optional() }));
    const user = await engine.db.selectFrom('users').selectAll().where('id', '=', p.userId).executeTakeFirstOrThrow();
    const ws = await engine.workspaces.create(user, input);
    await engine.auth.switchWorkspace(p.sessionId, p.userId, ws.id);
    const resolved = await engine.auth.resolveSession(p.token);
    return c.json(await engine.auth.sessionInfo(resolved!), 201);
  });

  return app;
}
