import { Hono } from 'hono';
import { z } from 'zod';
import type { Engine } from '@morrow/engine';
import { isoDate, pageQuery, queryBool, readJson, readQuery, rangeQuery } from '../http/input';
import type { AppEnv } from '../types';

/** Analytics, the relationship calendar, tasks and in-app notifications. */
export function insightRoutes(engine: Engine): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // ------------------------------------------------------------ analytics

  app.get('/analytics/overview', async (c) => {
    const q = readQuery(c, rangeQuery.extend({ campaignId: z.string().max(64).optional(), automationId: z.string().max(64).optional() }));
    return c.json(await engine.analytics.overview(c.get('ctx'), q));
  });
  app.get('/analytics/timeseries', async (c) => c.json({ items: await engine.analytics.timeseries(c.get('ctx'), readQuery(c, rangeQuery)) }));
  app.get('/analytics/campaigns', async (c) => c.json({ items: await engine.analytics.campaigns(c.get('ctx'), readQuery(c, rangeQuery)) }));
  app.get('/analytics/automations', async (c) => c.json({ items: await engine.analytics.automations(c.get('ctx'), readQuery(c, rangeQuery)) }));
  app.get('/analytics/failures', async (c) => c.json({ items: await engine.analytics.failures(c.get('ctx'), readQuery(c, rangeQuery)) }));
  app.get('/analytics/export', async (c) => {
    const range = readQuery(c, rangeQuery);
    const csv = await engine.analytics.exportCsv(c.get('ctx'), range);
    return c.body(csv, 200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="morrow-analytics-${range.from ?? 'start'}-${range.to ?? 'today'}.csv"`, 'Cache-Control': 'no-store' });
  });

  // ------------------------------------------------------------ calendar

  app.get('/calendar', async (c) => c.json({ items: await engine.calendar.events(c.get('ctx'), readQuery(c, z.object({ from: isoDate.optional(), to: isoDate.optional() }))) }));

  // ------------------------------------------------------------ tasks

  const taskStatus = z.enum(['open', 'done', 'dismissed']);
  app.get('/tasks', async (c) => {
    const q = readQuery(c, z.object({ status: z.string().max(20).optional(), contactId: z.string().max(64).optional(), assigneeId: z.string().max(64).optional(), mine: queryBool, ...pageQuery }));
    return c.json(await engine.tasks.list(c.get('ctx'), q));
  });
  app.post('/tasks', async (c) => {
    const body = await readJson(
      c,
      z.object({
        title: z.string().min(1).max(200),
        description: z.string().max(5000).nullable().optional(),
        contactId: z.string().max(64).nullable().optional(),
        dueAt: z.string().max(40).nullable().optional(),
        assigneeId: z.string().max(64).nullable().optional(),
      }),
    );
    return c.json(await engine.tasks.create(c.get('ctx'), body), 201);
  });
  app.get('/tasks/:id', async (c) => c.json(await engine.tasks.get(c.get('ctx'), c.req.param('id'))));
  app.patch('/tasks/:id', async (c) => {
    const body = await readJson(
      c,
      z.object({
        title: z.string().min(1).max(200).optional(),
        description: z.string().max(5000).nullable().optional(),
        status: taskStatus.optional(),
        dueAt: z.string().max(40).nullable().optional(),
        assigneeId: z.string().max(64).nullable().optional(),
      }),
    );
    return c.json(await engine.tasks.update(c.get('ctx'), c.req.param('id'), body));
  });
  app.delete('/tasks/:id', async (c) => {
    await engine.tasks.remove(c.get('ctx'), c.req.param('id'));
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------ notifications

  app.get('/notifications', async (c) => {
    const q = readQuery(c, z.object({ unreadOnly: queryBool, limit: z.coerce.number().int().min(1).max(100).optional() }));
    return c.json(await engine.notifications.list(c.get('ctx'), q));
  });
  app.post('/notifications/read', async (c) => {
    const { ids } = await readJson(c, z.object({ ids: z.union([z.literal('all'), z.array(z.string().max(64)).max(500)]) }));
    await engine.notifications.markRead(c.get('ctx'), ids);
    return c.json({ ok: true });
  });

  return app;
}
