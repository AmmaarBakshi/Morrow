import { Hono } from 'hono';
import { z } from 'zod';
import type { Engine } from '@morrow/engine';
import { badRequest } from '../http/errors';
import { anyObject, readJson, readQuery } from '../http/input';
import type { AppEnv } from '../types';

const segmentBody = z.object({ name: z.string().min(1).max(100), description: z.string().max(500).nullable().optional(), criteria: z.unknown() });

/** Segments and CSV imports. */
export function segmentRoutes(engine: Engine): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/segments', async (c) => c.json({ items: await engine.segments.list(c.get('ctx')) }));
  app.post('/segments', async (c) => c.json(await engine.segments.create(c.get('ctx'), await readJson(c, segmentBody)), 201));

  /** Live preview for the segment builder: count plus a sample of matching contacts. */
  app.post('/segments/preview', async (c) => {
    const input = await readJson(c, z.object({ criteria: z.unknown(), limit: z.number().int().min(1).max(50).optional() }));
    return c.json(await engine.segments.preview(c.get('ctx'), input.criteria, input.limit));
  });

  app.get('/segments/:id', async (c) => c.json(await engine.segments.get(c.get('ctx'), c.req.param('id'))));
  app.patch('/segments/:id', async (c) => c.json(await engine.segments.update(c.get('ctx'), c.req.param('id'), await readJson(c, segmentBody.partial()))));
  app.post('/segments/:id/refresh', async (c) => c.json(await engine.segments.refreshCount(c.get('ctx'), c.req.param('id'))));
  app.delete('/segments/:id', async (c) => {
    await engine.segments.archive(c.get('ctx'), c.req.param('id'));
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------ imports

  app.get('/imports', async (c) => c.json({ items: await engine.imports.list(c.get('ctx')) }));

  /** Upload a CSV either as `text/csv` (filename in the query) or as JSON `{ filename, csv }`. */
  app.post('/imports', async (c) => {
    const type = c.req.header('content-type') ?? '';
    let input: { filename: string; csv: string };
    if (type.startsWith('text/csv') || type.startsWith('text/plain')) {
      const { filename } = readQuery(c, z.object({ filename: z.string().max(200).optional() }));
      input = { filename: filename ?? 'upload.csv', csv: await c.req.text() };
    } else {
      input = await readJson(c, z.object({ filename: z.string().min(1).max(200), csv: z.string() }));
    }
    if (!input.csv.trim()) throw badRequest('The file is empty.');
    return c.json(await engine.imports.upload(c.get('ctx'), input), 201);
  });

  app.get('/imports/:id', async (c) => c.json(await engine.imports.get(c.get('ctx'), c.req.param('id'))));

  app.post('/imports/:id/preview', async (c) => {
    const input = await readJson(c, z.object({ mapping: z.unknown(), options: anyObject.optional() }));
    return c.json(await engine.imports.preview(c.get('ctx'), c.req.param('id'), input));
  });

  app.post('/imports/:id/commit', async (c) => {
    const input = await readJson(c, z.object({ mapping: z.unknown(), options: anyObject.optional(), triggerAutomations: z.boolean().optional() }));
    const report = await engine.imports.commit(c.get('ctx'), c.req.param('id'), input);
    engine.nudgeWorker();
    return c.json(report);
  });

  return app;
}
