import { Hono } from 'hono';
import { z } from 'zod';
import { STANDARD_VARIABLES, type MessageCategory, type TemplatePurpose, type VariableDefinition } from '@morrow/core';
import type { Engine } from '@morrow/engine';
import { rateLimited } from '../http/errors';
import { anyObject, readJson, readQuery } from '../http/input';
import { RATE_RULES, type RateLimiter } from '../http/rate-limit';
import type { AppEnv } from '../types';

const content = {
  subject: z.string().max(1000).optional(),
  previewText: z.string().max(1000).nullable().optional(),
  html: z.string().max(1_000_000).optional(),
  text: z.string().max(500_000).nullable().optional(),
  missingPolicy: z.enum(['fallback', 'skip']).optional(),
};
const meta = {
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  category: z.string().max(20).optional(),
  purpose: z.string().max(40).optional(),
};
const templateBody = z.object({ ...content, ...meta });
const which = z.enum(['draft', 'published']).optional();

type TemplateWrite = z.infer<typeof templateBody>;
const typed = (b: TemplateWrite) => ({ ...b, category: b.category as MessageCategory | undefined, purpose: b.purpose as TemplatePurpose | undefined });

/** Template studio: templates, versions, previews, test sends, snippets and the variable catalogue. */
export function templateRoutes(engine: Engine, limiter: RateLimiter): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/templates', async (c) => {
    const q = readQuery(c, z.object({ status: z.string().max(20).optional(), purpose: z.string().max(40).optional(), category: z.string().max(20).optional(), q: z.string().max(200).optional() }));
    return c.json({ items: await engine.templates.list(c.get('ctx'), q) });
  });

  app.post('/templates', async (c) => {
    const body = await readJson(c, templateBody.extend({ name: z.string().min(1).max(120) }));
    return c.json(await engine.templates.create(c.get('ctx'), { ...typed(body), name: body.name }), 201);
  });

  /** Render unsaved content: powers the live preview while editing. */
  app.post('/templates/render', async (c) => {
    const body = await readJson(
      c,
      z.object({
        subject: z.string().max(1000),
        previewText: z.string().max(1000).nullable().optional(),
        html: z.string().max(1_000_000),
        text: z.string().max(500_000).nullable().optional(),
        missingPolicy: z.enum(['fallback', 'skip']).optional(),
        category: z.string().max(20).optional(),
        contactId: z.string().max(64).nullable().optional(),
        data: anyObject.optional(),
      }),
    );
    const { category, contactId, data, ...source } = body;
    return c.json(await engine.templates.renderContent(c.get('ctx'), source, { category: category as MessageCategory | undefined, contactId, data }));
  });

  app.get('/variables', async (c) => {
    const ctx = c.get('ctx');
    const [{ settings }, fields] = await Promise.all([engine.workspaces.settings(ctx.workspaceId), engine.fields.list(ctx)]);
    // A workspace value for a standard key (e.g. collaboration_url) is already listed once.
    const standard = new Set(STANDARD_VARIABLES.map((v) => v.key));
    const items: VariableDefinition[] = [
      ...STANDARD_VARIABLES,
      ...Object.entries(settings.variables)
        .filter(([key]) => !standard.has(key))
        .map(([key, value]) => ({ key, label: key.replace(/_/g, ' '), group: 'workspace' as const, sample: String(value), description: 'Workspace variable' })),
      ...fields.map((f) => ({ key: `custom.${f.key}`, label: f.label, group: 'custom' as const, sample: f.type === 'number' ? 42 : f.label })),
    ];
    return c.json({ items });
  });

  app.get('/templates/:id', async (c) => c.json(await engine.templates.get(c.get('ctx'), c.req.param('id'))));
  app.patch('/templates/:id', async (c) => c.json(await engine.templates.update(c.get('ctx'), c.req.param('id'), typed(await readJson(c, templateBody)))));
  app.post('/templates/:id/publish', async (c) => c.json(await engine.templates.publish(c.get('ctx'), c.req.param('id'))));
  app.get('/templates/:id/versions', async (c) => c.json({ items: await engine.templates.versions(c.get('ctx'), c.req.param('id')) }));
  app.post('/templates/:id/versions/:versionId/restore', async (c) => c.json(await engine.templates.restoreVersion(c.get('ctx'), c.req.param('id'), c.req.param('versionId'))));
  app.post('/templates/:id/duplicate', async (c) => c.json(await engine.templates.duplicate(c.get('ctx'), c.req.param('id')), 201));
  app.post('/templates/:id/restore', async (c) => c.json(await engine.templates.restore(c.get('ctx'), c.req.param('id'))));
  app.post('/templates/:id/archive', async (c) => {
    await engine.templates.archive(c.get('ctx'), c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/templates/:id/render', async (c) => {
    const body = await readJson(c, z.object({ which, versionId: z.string().max(64).optional(), contactId: z.string().max(64).nullable().optional() }));
    return c.json(await engine.templates.render(c.get('ctx'), c.req.param('id'), body));
  });

  app.post('/templates/:id/test', async (c) => {
    const ctx = c.get('ctx');
    const d = limiter.hit(`test-send:${ctx.workspaceId}`, RATE_RULES.expensive);
    if (!d.allowed) throw rateLimited(d.retryAfterSeconds);
    const body = await readJson(c, z.object({ to: z.string().max(320).optional(), contactId: z.string().max(64).nullable().optional(), which }));
    const result = await engine.templates.testSend(ctx, c.req.param('id'), body);
    engine.nudgeWorker();
    return c.json(result, 202);
  });

  // ------------------------------------------------------------ snippets

  const kind = z.enum(['header', 'footer', 'signature', 'custom']);
  app.get('/snippets', async (c) => c.json({ items: await engine.templates.snippets(c.get('ctx')) }));
  app.post('/snippets', async (c) => {
    const body = await readJson(c, z.object({ key: z.string().min(1).max(48), name: z.string().min(1).max(80), kind: kind.optional(), html: z.string().max(200_000), text: z.string().max(100_000).nullable().optional() }));
    return c.json(await engine.templates.createSnippet(c.get('ctx'), body), 201);
  });
  app.patch('/snippets/:id', async (c) => {
    const body = await readJson(c, z.object({ name: z.string().min(1).max(80).optional(), html: z.string().max(200_000).optional(), text: z.string().max(100_000).nullable().optional() }));
    return c.json(await engine.templates.updateSnippet(c.get('ctx'), c.req.param('id'), body));
  });
  app.delete('/snippets/:id', async (c) => {
    await engine.templates.deleteSnippet(c.get('ctx'), c.req.param('id'));
    return c.json({ ok: true });
  });

  return app;
}
