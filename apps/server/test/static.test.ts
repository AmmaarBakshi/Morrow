import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServerHarness, type ServerHarness } from './client';

let h: ServerHarness;
let dir: string;
afterEach(async () => {
  await h?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('web app hosting', () => {
  it('serves assets, falls back to index.html for client routes and never escapes the build folder', async () => {
    dir = mkdtempSync(join(tmpdir(), 'morrow-web-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Morrow</title><div id="root"></div>');
    writeFileSync(join(dir, 'assets', 'app-1a2b3c.js'), 'console.log("morrow")');
    writeFileSync(join(dir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    h = await createServerHarness({ server: { webDist: dir } });
    const c = h.client();

    const index = await c.get('/');
    expect(index.status).toBe(200);
    expect(index.text).toContain('<div id="root">');
    expect(index.headers.get('content-security-policy')).toContain("script-src 'self'");

    const route = await c.get('/contacts/ctc_123');
    expect(route.text).toContain('<div id="root">');
    expect(route.headers.get('cache-control')).toBe('no-cache');

    const asset = await c.get('/assets/app-1a2b3c.js');
    expect(asset.headers.get('content-type')).toContain('text/javascript');
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect((await c.get('/favicon.svg')).headers.get('content-type')).toBe('image/svg+xml');

    expect((await c.get('/assets/missing.js')).status).toBe(404);
    expect((await c.get('/%2e%2e/%2e%2e/package.json')).status).toBe(404);
    // Server-owned paths are never swallowed by the SPA fallback.
    expect((await c.get('/api/v1/nope')).status).toBe(401);
    expect((await c.get('/u/forged')).status).toBe(404);
  });
});
