import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { NotFoundError } from '@morrow/core';
import { MORROW_VERSION } from '@morrow/engine';
import { authenticate, requireAuth, requireWorkspace } from './http/auth';
import { errorResponse } from './http/errors';
import { RateLimiter } from './http/rate-limit';
import { bodyLimits, requestContext, requireJsonBodies } from './http/request';
import { securityHeaders } from './http/security';
import { webApp } from './http/static';
import { authRoutes } from './routes/auth';
import { automationRoutes } from './routes/automations';
import { campaignRoutes } from './routes/campaigns';
import { contactRoutes } from './routes/contacts';
import { insightRoutes } from './routes/insights';
import { publicRoutes } from './routes/public';
import { segmentRoutes } from './routes/segments';
import { settingsRoutes } from './routes/settings';
import { templateRoutes } from './routes/templates';
import { workspaceRoutes } from './routes/workspace';
import type { AppEnv, ServerOptions } from './types';

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Build the Morrow HTTP application. It is a plain fetch handler, so it runs
 * on the Node adapter in production and directly via `app.request()` in tests.
 */
export function createApp(options: ServerOptions): Hono<AppEnv> {
  const { engine } = options;
  const limiter = options.limiter ?? new RateLimiter();
  const app = new Hono<AppEnv>();

  app.use('*', requestContext(options, engine.log));
  app.use('*', securityHeaders({ https: engine.config.publicUrl.startsWith('https://') }));
  app.onError((err, c) => errorResponse(c, err, engine.log));
  app.notFound((c) => (c.req.path.startsWith('/api/') ? errorResponse(c, new NotFoundError('Endpoint'), engine.log) : c.text('Not found', 404)));

  // ------------------------------------------------------------ operations

  app.get('/healthz', (c) => c.json({ ok: true, version: MORROW_VERSION }));

  app.get('/readyz', async (c) => {
    const h = await engine.system.health();
    const body = { ok: h.ok, version: h.version, database: h.database.ok, scheduler: h.scheduler.healthy, queueLagSeconds: h.queue.lagSeconds };
    return c.json(body, h.ok ? 200 : 503);
  });

  app.get('/metrics', async (c) => {
    const token = options.metricsToken;
    if (token) {
      const sent = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1] ?? '';
      if (!sameToken(sent, token)) return c.text('Unauthorized', 401, { 'WWW-Authenticate': 'Bearer' });
    } else if (engine.config.env === 'production') {
      return c.text('Not found', 404);
    }
    return c.body(await engine.system.metrics(), 200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' });
  });

  // ------------------------------------------------------------ public recipient & provider endpoints

  app.route('/', publicRoutes(engine, limiter));

  // ------------------------------------------------------------ JSON API

  const api = new Hono<AppEnv>();
  api.use('*', bodyLimits());
  api.use('*', requireJsonBodies());
  api.use('*', authenticate(engine));
  api.route('/auth', authRoutes(engine, limiter));

  const scoped = new Hono<AppEnv>();
  scoped.use('*', requireAuth(limiter));
  scoped.use('*', requireWorkspace(engine));
  scoped.route('/', workspaceRoutes(engine));
  scoped.route('/', contactRoutes(engine, limiter));
  scoped.route('/', segmentRoutes(engine));
  scoped.route('/', templateRoutes(engine, limiter));
  scoped.route('/', automationRoutes(engine));
  scoped.route('/', campaignRoutes(engine, limiter));
  scoped.route('/', insightRoutes(engine));
  scoped.route('/', settingsRoutes(engine, limiter));
  api.route('/', scoped);

  app.route('/api/v1', api);

  // ------------------------------------------------------------ web app

  if (options.webDist) app.use('*', webApp(options.webDist));

  return app;
}
