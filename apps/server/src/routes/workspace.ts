import { Hono } from 'hono';
import { z } from 'zod';
import { ROLES } from '@morrow/core';
import type { Engine } from '@morrow/engine';
import { anyObject, readJson, readQuery, rangeQuery } from '../http/input';
import type { AppEnv } from '../types';

const role = z.enum(ROLES);

/** Workspace settings, members, invitations, API keys, audit log and the dashboard. */
export function workspaceRoutes(engine: Engine): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/workspace', async (c) => c.json(await engine.workspaces.get(c.get('ctx'))));

  app.patch('/workspace', async (c) => {
    const input = await readJson(c, z.object({ name: z.string().max(100).optional(), timezone: z.string().max(64).optional(), settings: anyObject.optional() }));
    return c.json(await engine.workspaces.update(c.get('ctx'), input));
  });

  app.delete('/workspace', async (c) => {
    const { confirmSlug } = await readJson(c, z.object({ confirmSlug: z.string().min(1).max(100) }));
    await engine.workspaces.delete(c.get('ctx'), confirmSlug);
    return c.json({ ok: true });
  });

  app.get('/dashboard', async (c) => c.json(await engine.dashboard.summary(c.get('ctx'), readQuery(c, rangeQuery))));

  // ------------------------------------------------------------ members

  app.get('/members', async (c) => c.json({ items: await engine.workspaces.members(c.get('ctx')) }));

  app.patch('/members/:id', async (c) => {
    const input = await readJson(c, z.object({ role }));
    await engine.workspaces.updateMemberRole(c.get('ctx'), c.req.param('id'), input.role);
    return c.json({ ok: true });
  });

  app.delete('/members/:id', async (c) => {
    await engine.workspaces.removeMember(c.get('ctx'), c.req.param('id'));
    return c.json({ ok: true });
  });

  app.get('/invitations', async (c) => c.json({ items: await engine.workspaces.invitations(c.get('ctx')) }));

  app.post('/invitations', async (c) => {
    const input = await readJson(c, z.object({ email: z.string().min(1).max(320), role }));
    return c.json(await engine.workspaces.invite(c.get('ctx'), input.email, input.role), 201);
  });

  app.delete('/invitations/:id', async (c) => {
    await engine.workspaces.revokeInvitation(c.get('ctx'), c.req.param('id'));
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------ API keys

  app.get('/api-keys', async (c) => c.json({ items: await engine.workspaces.apiKeys(c.get('ctx')) }));

  app.post('/api-keys', async (c) => {
    const input = await readJson(c, z.object({ name: z.string().min(1).max(80), role, expiresInDays: z.number().int().min(1).max(3650).nullable().optional() }));
    return c.json(await engine.workspaces.createApiKey(c.get('ctx'), input), 201);
  });

  app.delete('/api-keys/:id', async (c) => {
    await engine.workspaces.revokeApiKey(c.get('ctx'), c.req.param('id'));
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------ audit

  app.get('/audit', async (c) => {
    const q = readQuery(
      c,
      z.object({
        entityType: z.string().max(40).optional(),
        entityId: z.string().max(64).optional(),
        action: z.string().max(80).optional(),
        before: z.string().max(40).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      }),
    );
    return c.json({ items: await engine.audit.list(c.get('ctx'), q) });
  });

  return app;
}
