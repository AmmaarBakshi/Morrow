import { Hono } from 'hono';
import { z } from 'zod';
import { SUPPRESSION_REASONS } from '@morrow/core';
import { authorize, type Engine } from '@morrow/engine';
import { rateLimited } from '../http/errors';
import { anyObject, pageQuery, queryBool, readJson, readQuery } from '../http/input';
import { RATE_RULES, type RateLimiter } from '../http/rate-limit';
import type { AppEnv } from '../types';

const secrets = z.record(z.string(), z.string().max(4000).nullable());

/** Sending settings (senders, providers, suppressions), AI assistance and system operations. */
export function settingsRoutes(engine: Engine, limiter: RateLimiter): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const expensive = (key: string) => {
    const d = limiter.hit(key, RATE_RULES.expensive);
    if (!d.allowed) throw rateLimited(d.retryAfterSeconds);
  };

  // ------------------------------------------------------------ senders

  app.get('/senders', async (c) => c.json({ items: await engine.senders.list(c.get('ctx')) }));
  app.post('/senders', async (c) => {
    const body = await readJson(c, z.object({ name: z.string().min(1).max(100), email: z.string().min(1).max(320), replyTo: z.string().max(320).nullable().optional(), isDefault: z.boolean().optional() }));
    const sender = await engine.senders.create(c.get('ctx'), body);
    engine.nudgeWorker();
    return c.json(sender, 201);
  });
  app.patch('/senders/:id', async (c) => {
    const body = await readJson(c, z.object({ name: z.string().min(1).max(100).optional(), replyTo: z.string().max(320).nullable().optional(), isDefault: z.boolean().optional() }));
    return c.json(await engine.senders.update(c.get('ctx'), c.req.param('id'), body));
  });
  app.delete('/senders/:id', async (c) => {
    await engine.senders.remove(c.get('ctx'), c.req.param('id'));
    return c.json({ ok: true });
  });
  app.post('/senders/:id/send-verification', async (c) => {
    const ctx = c.get('ctx');
    expensive(`verify:${ctx.workspaceId}`);
    const result = await engine.senders.sendVerification(ctx, c.req.param('id'));
    engine.nudgeWorker();
    return c.json(result, 202);
  });
  /** Mark verified after confirming domain ownership at the provider (admins only). */
  app.post('/senders/:id/mark-verified', async (c) => {
    const { note } = await readJson(c, z.object({ note: z.string().min(1).max(500) }));
    return c.json(await engine.senders.markVerified(c.get('ctx'), c.req.param('id'), note));
  });
  app.get('/senders/:id/dns', async (c) => {
    expensive(`dns:${c.get('ctx').workspaceId}`);
    return c.json(await engine.senders.dnsCheck(c.get('ctx'), c.req.param('id')));
  });

  // ------------------------------------------------------------ e-mail provider

  app.get('/integrations/providers', async (c) => {
    authorize(c.get('ctx'), 'workspace:read');
    return c.json({ items: engine.integrations.availableProviders() });
  });
  app.get('/integrations/email', async (c) => c.json(await engine.integrations.getEmail(c.get('ctx'))));
  app.put('/integrations/email', async (c) => {
    const body = await readJson(c, z.object({ provider: z.string().min(1).max(40), config: anyObject.optional(), secrets: secrets.optional() }));
    return c.json(await engine.integrations.setEmail(c.get('ctx'), body));
  });
  app.post('/integrations/email/test', async (c) => {
    expensive(`provider-test:${c.get('ctx').workspaceId}`);
    return c.json(await engine.integrations.testEmail(c.get('ctx')));
  });
  app.delete('/integrations/email', async (c) => {
    await engine.integrations.removeEmail(c.get('ctx'));
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------ AI assistance

  app.get('/integrations/ai', async (c) => {
    const ctx = c.get('ctx');
    authorize(ctx, 'workspace:read');
    return c.json({ ...(await engine.ai.status(ctx.workspaceId)), providers: engine.ai.providers() });
  });
  app.put('/integrations/ai', async (c) => {
    const body = await readJson(c, z.object({ provider: z.string().max(40).nullable(), config: anyObject.optional(), secrets: secrets.optional() }));
    await engine.integrations.setAi(c.get('ctx'), body);
    return c.json(await engine.ai.status(c.get('ctx').workspaceId));
  });

  const tone = z.string().max(40).optional();
  app.post('/ai/draft', async (c) => {
    expensive(`ai:${c.get('ctx').workspaceId}`);
    const body = await readJson(c, z.object({ purpose: z.string().min(1).max(2000), audience: z.string().max(2000).optional(), keyPoints: z.string().max(4000).optional(), tone, category: z.enum(['transactional', 'relationship', 'marketing']).optional() }));
    return c.json(await engine.ai.draft(c.get('ctx'), body));
  });
  app.post('/ai/rewrite', async (c) => {
    expensive(`ai:${c.get('ctx').workspaceId}`);
    const body = await readJson(c, z.object({ subject: z.string().max(1000), html: z.string().max(200_000), tone, instructions: z.string().max(2000).optional() }));
    return c.json(await engine.ai.rewrite(c.get('ctx'), body));
  });
  app.post('/ai/adapt', async (c) => {
    expensive(`ai:${c.get('ctx').workspaceId}`);
    const body = await readJson(c, z.object({ subject: z.string().max(1000), html: z.string().max(200_000), segmentId: z.string().min(1).max(64) }));
    return c.json(await engine.ai.adapt(c.get('ctx'), body));
  });
  app.post('/ai/subjects', async (c) => {
    expensive(`ai:${c.get('ctx').workspaceId}`);
    const body = await readJson(c, z.object({ html: z.string().max(200_000), current: z.string().max(1000).optional(), count: z.number().int().min(1).max(10).optional() }));
    return c.json({ items: await engine.ai.subjects(c.get('ctx'), body) });
  });
  app.post('/campaigns/:id/summary', async (c) => {
    expensive(`ai:${c.get('ctx').workspaceId}`);
    return c.json(await engine.ai.summarizeCampaign(c.get('ctx'), c.req.param('id')));
  });

  // ------------------------------------------------------------ suppressions

  app.get('/suppressions', async (c) => {
    const q = readQuery(c, z.object({ q: z.string().max(200).optional(), reason: z.string().max(40).optional(), includeLifted: queryBool, ...pageQuery }));
    return c.json(await engine.suppressions.list(c.get('ctx'), q));
  });
  app.post('/suppressions', async (c) => {
    const body = await readJson(c, z.object({ email: z.string().min(1).max(320), reason: z.enum(SUPPRESSION_REASONS).optional(), note: z.string().max(1000).nullable().optional() }));
    return c.json(await engine.suppressions.add(c.get('ctx'), body), 201);
  });
  app.post('/suppressions/:id/lift', async (c) => {
    const { note } = await readJson(c, z.object({ note: z.string().min(1).max(1000) }));
    await engine.suppressions.lift(c.get('ctx'), c.req.param('id'), note);
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------ system

  app.get('/system/health', async (c) => {
    const ctx = c.get('ctx');
    authorize(ctx, 'system:read');
    return c.json(await engine.system.health(ctx.workspaceId));
  });
  app.get('/system/jobs', async (c) => {
    const q = readQuery(c, z.object({ status: z.string().max(20).optional(), type: z.string().max(60).optional(), limit: z.coerce.number().int().min(1).max(500).optional() }));
    return c.json({ items: await engine.system.jobs(c.get('ctx'), q) });
  });
  app.post('/system/jobs/:id/retry', async (c) => {
    const retried = await engine.system.retryJob(c.get('ctx'), c.req.param('id'));
    engine.nudgeWorker();
    return c.json({ ok: retried });
  });
  app.post('/system/jobs/:id/cancel', async (c) => c.json({ ok: await engine.system.cancelJob(c.get('ctx'), c.req.param('id')) }));

  return app;
}
