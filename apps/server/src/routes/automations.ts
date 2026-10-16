import { Hono } from 'hono';
import { z } from 'zod';
import { authorize, type Engine } from '@morrow/engine';
import { idList, pageQuery, readJson, readQuery } from '../http/input';
import type { AppEnv } from '../types';

const deliveryMode = z.enum(['review', 'auto']);

/** Automations: definitions, activation, dry runs, manual runs and run history. */
export function automationRoutes(engine: Engine): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/automations', async (c) => {
    const q = readQuery(c, z.object({ status: z.string().max(20).optional() }));
    return c.json({ items: await engine.automations.list(c.get('ctx'), q) });
  });

  app.post('/automations', async (c) => {
    const body = await readJson(c, z.object({ name: z.string().min(1).max(120), description: z.string().max(500).nullable().optional(), definition: z.unknown() }));
    return c.json(await engine.automations.create(c.get('ctx'), body), 201);
  });

  /** Check a definition without saving it (the builder calls this as you edit). */
  app.post('/automations/validate', async (c) => {
    const ctx = c.get('ctx');
    authorize(ctx, 'automations:read');
    const { definition } = await readJson(c, z.object({ definition: z.unknown() }));
    const parsed = engine.automations.parse(definition);
    return c.json({ definition: parsed, problems: await engine.automations.check(ctx.workspaceId, parsed) });
  });

  app.get('/automations/:id', async (c) => c.json(await engine.automations.get(c.get('ctx'), c.req.param('id'))));

  app.patch('/automations/:id', async (c) => {
    const body = await readJson(c, z.object({ name: z.string().min(1).max(120).optional(), description: z.string().max(500).nullable().optional(), definition: z.unknown().optional() }));
    return c.json(await engine.automations.update(c.get('ctx'), c.req.param('id'), body));
  });

  app.post('/automations/:id/activate', async (c) => {
    const body = await readJson(c, z.object({ deliveryMode: deliveryMode.optional() }));
    return c.json(await engine.automations.activate(c.get('ctx'), c.req.param('id'), body));
  });

  app.post('/automations/:id/delivery-mode', async (c) => {
    const { mode } = await readJson(c, z.object({ mode: deliveryMode }));
    return c.json(await engine.automations.setDeliveryMode(c.get('ctx'), c.req.param('id'), mode));
  });

  app.post('/automations/:id/pause', async (c) => c.json(await engine.automations.pause(c.get('ctx'), c.req.param('id'))));
  app.post('/automations/:id/resume', async (c) => c.json(await engine.automations.resume(c.get('ctx'), c.req.param('id'))));
  app.post('/automations/:id/restore', async (c) => c.json(await engine.automations.restore(c.get('ctx'), c.req.param('id'))));
  app.post('/automations/:id/duplicate', async (c) => c.json(await engine.automations.duplicate(c.get('ctx'), c.req.param('id')), 201));
  app.post('/automations/:id/archive', async (c) => {
    await engine.automations.archive(c.get('ctx'), c.req.param('id'));
    return c.json({ ok: true });
  });

  /** Simulate who would qualify and what each step would do — writes nothing. */
  app.post('/automations/:id/dry-run', async (c) => {
    const body = await readJson(
      c,
      z.object({ at: z.string().max(40).optional(), contactIds: idList.max(200).optional(), limit: z.number().int().min(1).max(200).optional(), definition: z.unknown().optional() }),
    );
    return c.json(await engine.automations.dryRun(c.get('ctx'), c.req.param('id'), body));
  });

  /** Start a manual automation for chosen contacts or a segment. */
  app.post('/automations/:id/run', async (c) => {
    const body = await readJson(c, z.object({ contactIds: idList.optional(), segmentId: z.string().max(64).nullable().optional() }));
    const result = await engine.automations.runManual(c.get('ctx'), c.req.param('id'), body);
    engine.nudgeWorker();
    return c.json(result, 202);
  });

  app.get('/automations/:id/runs', async (c) => {
    const q = readQuery(c, z.object({ status: z.string().max(20).optional(), ...pageQuery }));
    return c.json(await engine.automations.runs(c.get('ctx'), c.req.param('id'), q));
  });

  app.get('/automation-runs/:runId', async (c) => c.json(await engine.automations.run(c.get('ctx'), c.req.param('runId'))));
  app.post('/automation-runs/:runId/cancel', async (c) => {
    await engine.automations.cancelRun(c.get('ctx'), c.req.param('runId'));
    return c.json({ ok: true });
  });

  return app;
}
