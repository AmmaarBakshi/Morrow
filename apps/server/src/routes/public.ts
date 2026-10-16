import { Hono, type Context } from 'hono';
import { WebhookVerificationError } from '@morrow/email';
import type { Engine } from '@morrow/engine';
import { maskEmail, renderPage } from '../http/pages';
import { RATE_RULES, type RateLimiter } from '../http/rate-limit';
import { PUBLIC_PAGE_CSP } from '../http/security';
import type { AppEnv } from '../types';

/** 1×1 transparent GIF. */
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/**
 * Endpoints recipients and providers reach without signing in: unsubscribe
 * (link and RFC 8058 one-click), open/click tracking, sender verification
 * and provider webhooks. Every capability comes from an HMAC-signed token.
 */
export function publicRoutes(engine: Engine, limiter: RateLimiter): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const page = (c: Context<AppEnv>, html: string, status: 200 | 400 | 404 | 429 = 200) =>
    c.html(html, status, { 'Content-Security-Policy': PUBLIC_PAGE_CSP, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });

  const tooMany = (c: Context<AppEnv>) => {
    const d = limiter.hit(`public:${c.get('ip') ?? 'unknown'}`, RATE_RULES.public);
    return d.allowed ? null : page(c, renderPage({ title: 'Slow down', heading: 'Too many requests', body: ['Please wait a minute and try again.'] }), 429);
  };

  const invalid = (c: Context<AppEnv>) =>
    page(c, renderPage({ title: 'Link expired', heading: 'This link is not valid', body: ['It may have been copied incompletely or has expired. If you keep receiving e-mail you do not want, reply to it and ask to be removed.'] }), 404);

  // ------------------------------------------------------------ unsubscribe

  app.get('/u/:token', async (c) => {
    const limited = tooMany(c);
    if (limited) return limited;
    const token = c.req.param('token');
    if (token === 'preview') {
      return page(c, renderPage({ title: 'Unsubscribe preview', heading: 'Unsubscribe page preview', body: ['This is a preview link. Recipients see a one-click unsubscribe confirmation here.'] }));
    }
    const info = await engine.delivery.unsubscribeInfo(token);
    if (!info) return invalid(c);
    const who = maskEmail(info.email);
    if (info.unsubscribed) {
      return page(
        c,
        renderPage({
          title: 'Unsubscribed',
          heading: `You're unsubscribed`,
          body: [`${who} will no longer receive marketing or relationship e-mail from ${info.workspaceName}.`, 'Changed your mind?'],
          actions: [{ label: 'Subscribe again', action: 'resubscribe' }],
        }),
      );
    }
    return page(
      c,
      renderPage({
        title: 'Unsubscribe',
        heading: `Unsubscribe from ${info.workspaceName}?`,
        body: [`Stop marketing and relationship e-mail to ${who}. Receipts and account messages you asked for may still arrive.`],
        actions: [{ label: 'Unsubscribe', action: 'unsubscribe', primary: true }],
      }),
    );
  });

  app.post('/u/:token', async (c) => {
    const token = c.req.param('token');
    if (token === 'preview') return c.text('Preview only.', 200);
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    // RFC 8058: mail clients POST "List-Unsubscribe=One-Click" with no further interaction.
    if (form['List-Unsubscribe'] === 'One-Click') {
      const ok = await engine.delivery.unsubscribe(token, 'one_click');
      return c.text(ok ? 'Unsubscribed.' : 'Invalid link.', ok ? 200 : 404);
    }
    const limited = tooMany(c);
    if (limited) return limited;
    const info = await engine.delivery.unsubscribeInfo(token);
    if (!info) return invalid(c);
    if (form.action === 'resubscribe') {
      const ok = await engine.delivery.resubscribe(token);
      return page(
        c,
        renderPage(
          ok
            ? { title: 'Subscribed', heading: 'Welcome back', body: [`${maskEmail(info.email)} will receive e-mail from ${info.workspaceName} again.`] }
            : { title: 'Cannot resubscribe', heading: 'This address cannot be resubscribed here', body: ['It was removed because messages bounced or were reported. Contact the sender directly.'] },
        ),
        ok ? 200 : 400,
      );
    }
    await engine.delivery.unsubscribe(token, 'link');
    return page(
      c,
      renderPage({
        title: 'Unsubscribed',
        heading: `You're unsubscribed`,
        body: [`${maskEmail(info.email)} will no longer receive marketing or relationship e-mail from ${info.workspaceName}.`],
        actions: [{ label: 'Undo', action: 'resubscribe' }],
      }),
    );
  });

  // ------------------------------------------------------------ tracking

  // Image proxies share IPs, so tracking is not rate limited per IP; tokens are signed.
  app.get('/t/o/:token', async (c) => {
    await engine.delivery.recordOpen(c.req.param('token').replace(/\.gif$/, ''), c.req.header('user-agent') ?? null).catch((err: Error) => engine.log.warn('open tracking failed', { error: err }));
    return c.body(PIXEL, 200, { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache, must-revalidate, private', Pragma: 'no-cache' });
  });

  app.get('/t/c/:token', async (c) => {
    const url = await engine.delivery.recordClick(c.req.param('token'), c.req.header('user-agent') ?? null).catch((err: Error) => {
      engine.log.warn('click tracking failed', { error: err });
      return null;
    });
    if (!url) return invalid(c);
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    return c.redirect(url, 302);
  });

  // ------------------------------------------------------------ sender verification

  app.get('/verify-sender/:token', async (c) => {
    const limited = tooMany(c);
    if (limited) return limited;
    const sender = await engine.senders.verifyToken(c.req.param('token'));
    if (!sender) return invalid(c);
    return page(c, renderPage({ title: 'Sender verified', heading: 'Sender address verified', body: [`${sender.email} can now send from Morrow. You can close this tab.`] }));
  });

  // ------------------------------------------------------------ provider webhooks

  app.post('/webhooks/:provider/:integrationId', async (c) => {
    const { provider: name, integrationId } = c.req.param();
    const d = limiter.hit(`webhook:${name}:${integrationId}`, RATE_RULES.webhook);
    if (!d.allowed) return c.json({ error: { code: 'rate_limited', message: 'Too many webhook calls.' } }, 429);
    const target = await engine.integrations.webhookProvider(name, integrationId).catch(() => null);
    if (!target?.provider.parseWebhook) return c.json({ error: { code: 'not_found', message: 'Unknown webhook endpoint.' } }, 404);
    const rawBody = await c.req.text();
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    try {
      const { events } = await target.provider.parseWebhook({ headers, rawBody, query: c.req.query() });
      if (events.length) {
        await engine.queue.enqueue('email.events', { workspaceId: target.workspaceId, provider: name, events: events as unknown as Record<string, unknown>[] }, { workspaceId: target.workspaceId, maxAttempts: 5 });
        engine.nudgeWorker();
      }
      return c.json({ received: events.length });
    } catch (err) {
      if (err instanceof WebhookVerificationError) {
        engine.log.warn('webhook signature rejected', { provider: name, integrationId });
        return c.json({ error: { code: 'unauthorized', message: 'Signature verification failed.' } }, 401);
      }
      engine.log.warn('webhook payload rejected', { provider: name, error: err as Error });
      return c.json({ error: { code: 'bad_request', message: 'Unrecognised webhook payload.' } }, 400);
    }
  });

  return app;
}
