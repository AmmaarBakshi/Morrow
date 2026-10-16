import { Hono } from 'hono';
import { z } from 'zod';
import type { MessageCategory } from '@morrow/core';
import type { CampaignInput, Engine } from '@morrow/engine';
import { rateLimited } from '../http/errors';
import { idList, pageQuery, readJson, readQuery } from '../http/input';
import { RATE_RULES, type RateLimiter } from '../http/rate-limit';
import type { AppEnv } from '../types';

const campaignBody = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  category: z.string().max(20).optional(),
  segmentId: z.string().max(64).nullable().optional(),
  templateId: z.string().max(64).nullable().optional(),
  subject: z.string().max(300).nullable().optional(),
  previewText: z.string().max(300).nullable().optional(),
  senderId: z.string().max(64).nullable().optional(),
  replyTo: z.string().max(320).nullable().optional(),
  scheduledAt: z.string().max(40).nullable().optional(),
  timezone: z.string().max(64).nullable().optional(),
  requiresApproval: z.boolean().optional(),
});
const input = (b: z.infer<typeof campaignBody>): CampaignInput => ({ ...b, category: b.category as MessageCategory | undefined });

/** Campaigns plus the message log and the approval queue for reviewed automation e-mail. */
export function campaignRoutes(engine: Engine, limiter: RateLimiter): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/campaigns', async (c) => {
    const q = readQuery(c, z.object({ status: z.string().max(20).optional() }));
    return c.json({ items: await engine.campaigns.list(c.get('ctx'), q) });
  });
  app.post('/campaigns', async (c) => c.json(await engine.campaigns.create(c.get('ctx'), input(await readJson(c, campaignBody))), 201));
  app.get('/campaigns/:id', async (c) => c.json(await engine.campaigns.get(c.get('ctx'), c.req.param('id'))));
  app.patch('/campaigns/:id', async (c) => c.json(await engine.campaigns.update(c.get('ctx'), c.req.param('id'), input(await readJson(c, campaignBody)))));
  app.delete('/campaigns/:id', async (c) => {
    await engine.campaigns.remove(c.get('ctx'), c.req.param('id'));
    return c.json({ ok: true });
  });
  app.post('/campaigns/:id/duplicate', async (c) => c.json(await engine.campaigns.duplicate(c.get('ctx'), c.req.param('id')), 201));

  /** Who will receive it, who is excluded and why, and anything blocking launch. */
  app.get('/campaigns/:id/preflight', async (c) => c.json(await engine.campaigns.preflight(c.get('ctx'), c.req.param('id'))));

  app.post('/campaigns/:id/test', async (c) => {
    const ctx = c.get('ctx');
    const d = limiter.hit(`test-send:${ctx.workspaceId}`, RATE_RULES.expensive);
    if (!d.allowed) throw rateLimited(d.retryAfterSeconds);
    const body = await readJson(c, z.object({ to: z.string().max(320).optional() }));
    const result = await engine.campaigns.testSend(ctx, c.req.param('id'), body);
    engine.nudgeWorker();
    return c.json(result, 202);
  });

  app.post('/campaigns/:id/schedule', async (c) => {
    const body = await readJson(c, z.object({ scheduledAt: z.string().max(40).nullable().optional(), timezone: z.string().max(64).nullable().optional() }));
    const result = await engine.campaigns.schedule(c.get('ctx'), c.req.param('id'), body);
    engine.nudgeWorker();
    return c.json(result);
  });

  app.post('/campaigns/:id/launch', async (c) => {
    const result = await engine.campaigns.launch(c.get('ctx'), c.req.param('id'));
    engine.nudgeWorker();
    return c.json(result);
  });

  app.post('/campaigns/:id/approve', async (c) => {
    const { note } = await readJson(c, z.object({ note: z.string().max(1000).nullable().optional() }));
    const result = await engine.campaigns.approve(c.get('ctx'), c.req.param('id'), note);
    engine.nudgeWorker();
    return c.json(result);
  });

  app.post('/campaigns/:id/reject', async (c) => {
    const { note } = await readJson(c, z.object({ note: z.string().min(1).max(1000) }));
    return c.json(await engine.campaigns.reject(c.get('ctx'), c.req.param('id'), note));
  });

  app.post('/campaigns/:id/pause', async (c) => c.json(await engine.campaigns.pause(c.get('ctx'), c.req.param('id'))));
  app.post('/campaigns/:id/resume', async (c) => {
    const result = await engine.campaigns.resume(c.get('ctx'), c.req.param('id'));
    engine.nudgeWorker();
    return c.json(result);
  });
  app.post('/campaigns/:id/cancel', async (c) => c.json(await engine.campaigns.cancel(c.get('ctx'), c.req.param('id'))));

  app.get('/campaigns/:id/recipients', async (c) => {
    const q = readQuery(c, z.object({ status: z.string().max(20).optional(), ...pageQuery }));
    return c.json(await engine.campaigns.recipients(c.get('ctx'), c.req.param('id'), q));
  });

  // ------------------------------------------------------------ messages

  app.get('/messages', async (c) => {
    const q = readQuery(
      c,
      z.object({
        status: z.string().max(20).optional(),
        kind: z.string().max(20).optional(),
        campaignId: z.string().max(64).optional(),
        automationId: z.string().max(64).optional(),
        contactId: z.string().max(64).optional(),
        provider: z.string().max(40).optional(),
        q: z.string().max(200).optional(),
        from: z.string().max(40).optional(),
        to: z.string().max(40).optional(),
        ...pageQuery,
      }),
    );
    return c.json(await engine.messages.list(c.get('ctx'), q));
  });
  app.get('/messages/:id', async (c) => c.json(await engine.messages.get(c.get('ctx'), c.req.param('id'))));
  app.post('/messages/:id/cancel', async (c) => c.json(await engine.messages.cancel(c.get('ctx'), c.req.param('id'))));

  // ------------------------------------------------------------ approvals

  app.get('/approvals', async (c) => {
    const q = readQuery(c, z.object({ automationId: z.string().max(64).optional(), ...pageQuery }));
    return c.json(await engine.messages.pendingApprovals(c.get('ctx'), q));
  });
  app.post('/approvals/approve', async (c) => {
    const { ids } = await readJson(c, z.object({ ids: idList.min(1) }));
    const result = await engine.messages.approve(c.get('ctx'), ids);
    engine.nudgeWorker();
    return c.json(result);
  });
  app.post('/approvals/reject', async (c) => {
    const { ids, note } = await readJson(c, z.object({ ids: idList.min(1), note: z.string().max(1000).optional() }));
    return c.json(await engine.messages.reject(c.get('ctx'), ids, note));
  });

  return app;
}
