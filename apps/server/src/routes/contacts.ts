import { Hono } from 'hono';
import { z } from 'zod';
import { CONSENT_STATUSES } from '@morrow/core';
import type { ContactQuery, Engine } from '@morrow/engine';
import { anyObject, csvList, idList, pageQuery, queryBool, readJson, readQuery } from '../http/input';
import { RATE_RULES, type RateLimiter } from '../http/rate-limit';
import { rateLimited } from '../http/errors';
import type { AppEnv } from '../types';

const listQuery = z.object({
  q: z.string().max(200).optional(),
  status: z.enum(['active', 'archived', 'all']).optional(),
  relationshipType: z.string().max(40).optional(),
  tag: z.string().max(80).optional(),
  consent: z.string().max(20).optional(),
  segmentId: z.string().max(64).optional(),
  hasBirthday: queryBool,
  sort: z.enum(['created_at', 'name', 'email', 'last_interaction_at', 'last_emailed_at', 'company']).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  ...pageQuery,
});

/** Contacts, consent, notes, timelines, custom events, tags, custom fields and occasions. */
export function contactRoutes(engine: Engine, limiter: RateLimiter): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/contacts', async (c) => c.json(await engine.contacts.list(c.get('ctx'), readQuery(c, listQuery))));

  // Advanced filtering with the segment criteria language (too large for a query string).
  app.post('/contacts/search', async (c) => {
    const body = await readJson(c, listQuery.extend({ criteria: z.unknown().optional(), page: z.number().int().min(1).optional(), pageSize: z.number().int().min(1).max(200).optional(), hasBirthday: z.boolean().optional() }));
    const { criteria, ...rest } = body;
    const query: ContactQuery = { ...rest, criteria: criteria !== undefined ? engine.segments.validate(criteria) : undefined };
    return c.json(await engine.contacts.list(c.get('ctx'), query));
  });

  app.get('/contacts/export', async (c) => {
    const ctx = c.get('ctx');
    const d = limiter.hit(`export:${ctx.actor.id}`, RATE_RULES.expensive);
    if (!d.allowed) throw rateLimited(d.retryAfterSeconds);
    const query = readQuery(c, listQuery);
    const chunks = engine.contacts.exportCsv(ctx, query);
    // Pull the first chunk eagerly so permission errors become proper API errors.
    const first = await chunks.next();
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (!first.done) controller.enqueue(encoder.encode(first.value));
      },
      async pull(controller) {
        const next = await chunks.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      },
      async cancel() {
        await chunks.return(undefined);
      },
    });
    const stamp = engine.nowIso().slice(0, 10);
    return c.body(body, 200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="morrow-contacts-${stamp}.csv"`, 'Cache-Control': 'no-store' });
  });

  app.post('/contacts', async (c) => {
    const input = await readJson(c, anyObject);
    return c.json(await engine.contacts.create(c.get('ctx'), input as never, { source: c.get('principal')?.kind === 'api_key' ? 'api' : 'ui' }), 201);
  });

  app.post('/contacts/bulk', async (c) => {
    const input = await readJson(c, z.object({ ids: idList.min(1), action: z.enum(['archive', 'restore', 'add_tag', 'remove_tag']), tag: z.string().max(80).optional() }));
    return c.json(await engine.contacts.bulk(c.get('ctx'), input));
  });

  app.get('/contacts/:id', async (c) => c.json(await engine.contacts.get(c.get('ctx'), c.req.param('id'))));

  app.patch('/contacts/:id', async (c) => {
    const input = await readJson(c, anyObject);
    return c.json(await engine.contacts.update(c.get('ctx'), c.req.param('id'), input, { source: c.get('principal')?.kind === 'api_key' ? 'api' : 'ui' }));
  });

  app.post('/contacts/:id/archive', async (c) => c.json(await engine.contacts.archive(c.get('ctx'), c.req.param('id'))));
  app.post('/contacts/:id/restore', async (c) => c.json(await engine.contacts.restore(c.get('ctx'), c.req.param('id'))));

  /** Permanently erase a contact's personal data (right to erasure). */
  app.post('/contacts/:id/erase', async (c) => {
    await readJson(c, z.object({ confirm: z.literal('erase') }));
    await engine.contacts.erase(c.get('ctx'), c.req.param('id'));
    return c.json({ ok: true });
  });

  app.get('/contacts/:id/consent', async (c) => c.json({ items: await engine.contacts.consentHistory(c.get('ctx'), c.req.param('id')) }));

  app.put('/contacts/:id/consent', async (c) => {
    const input = await readJson(c, z.object({ status: z.enum(CONSENT_STATUSES), source: z.string().max(200).nullable().optional(), note: z.string().max(1000).nullable().optional() }));
    return c.json(await engine.contacts.setConsent(c.get('ctx'), c.req.param('id'), input));
  });

  app.get('/contacts/:id/notes', async (c) => c.json({ items: await engine.contacts.notes(c.get('ctx'), c.req.param('id')) }));

  app.post('/contacts/:id/notes', async (c) => {
    const { body } = await readJson(c, z.object({ body: z.string().min(1).max(10_000) }));
    return c.json(await engine.contacts.addNote(c.get('ctx'), c.req.param('id'), body), 201);
  });

  app.delete('/contacts/:id/notes/:noteId', async (c) => {
    await engine.contacts.deleteNote(c.get('ctx'), c.req.param('id'), c.req.param('noteId'));
    return c.json({ ok: true });
  });

  app.get('/contacts/:id/timeline', async (c) => {
    const { limit } = readQuery(c, z.object({ limit: z.coerce.number().int().min(1).max(500).optional() }));
    return c.json({ items: await engine.contacts.timeline(c.get('ctx'), c.req.param('id'), limit) });
  });

  // ------------------------------------------------------------ events

  /** Record a custom event ("proposal.sent", "project.completed") — triggers event automations. */
  app.post('/events', async (c) => {
    const input = await readJson(
      c,
      z.object({
        contactId: z.string().max(64).optional(),
        email: z.string().max(320).optional(),
        name: z.string().min(1).max(100),
        properties: anyObject.optional(),
        occurredAt: z.string().max(40).optional(),
        dedupeKey: z.string().max(200).optional(),
        contact: anyObject.optional(),
        interaction: z.boolean().optional(),
      }),
    );
    const result = await engine.contacts.recordEvent(c.get('ctx'), { ...input, contact: input.contact as never });
    engine.nudgeWorker();
    return c.json(result, result.duplicate ? 200 : 201);
  });

  app.get('/occasions/upcoming', async (c) => {
    const q = readQuery(c, z.object({ days: z.coerce.number().int().min(1).max(366).optional(), kinds: csvList, limit: z.coerce.number().int().min(1).max(500).optional() }));
    const kinds = q.kinds?.filter((k): k is 'birthday' | 'work_anniversary' => k === 'birthday' || k === 'work_anniversary');
    return c.json({ items: await engine.contacts.upcomingOccasions(c.get('ctx'), { ...q, kinds }) });
  });

  // ------------------------------------------------------------ tags

  app.get('/tags', async (c) => c.json({ items: await engine.tags.list(c.get('ctx')) }));
  app.post('/tags', async (c) => c.json(await engine.tags.create(c.get('ctx'), await readJson(c, z.object({ name: z.string().min(1).max(80), color: z.string().max(20).nullable().optional() }))), 201));
  app.patch('/tags/:id', async (c) =>
    c.json(await engine.tags.update(c.get('ctx'), c.req.param('id'), await readJson(c, z.object({ name: z.string().min(1).max(80).optional(), color: z.string().max(20).nullable().optional() })))),
  );
  app.delete('/tags/:id', async (c) => {
    await engine.tags.remove(c.get('ctx'), c.req.param('id'));
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------ custom fields

  app.get('/fields', async (c) => {
    const { includeArchived } = readQuery(c, z.object({ includeArchived: queryBool }));
    return c.json({ items: await engine.fields.list(c.get('ctx'), includeArchived) });
  });
  app.post('/fields', async (c) => {
    const input = await readJson(
      c,
      z.object({ key: z.string().min(1).max(48), label: z.string().min(1).max(80), type: z.enum(['text', 'number', 'date', 'boolean', 'select', 'url']), options: z.array(z.string().max(80)).max(100).optional() }),
    );
    return c.json(await engine.fields.create(c.get('ctx'), input), 201);
  });
  app.patch('/fields/:id', async (c) =>
    c.json(await engine.fields.update(c.get('ctx'), c.req.param('id'), await readJson(c, z.object({ label: z.string().min(1).max(80).optional(), options: z.array(z.string().max(80)).max(100).optional() })))),
  );
  app.delete('/fields/:id', async (c) => {
    await engine.fields.archive(c.get('ctx'), c.req.param('id'));
    return c.json({ ok: true });
  });

  return app;
}
