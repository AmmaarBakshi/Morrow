import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { MiddlewareHandler } from 'hono';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/** Paths owned by the server; never answered with the web app. */
const RESERVED = /^\/(api|u|t|webhooks|verify-sender|metrics|healthz|readyz)(\/|$)/;

/**
 * Serve the built single-page web app. Hashed assets are cached forever,
 * everything else falls back to index.html so client-side routes work.
 */
export function webApp(distDir: string): MiddlewareHandler {
  const root = resolve(distDir);
  const indexPath = join(root, 'index.html');
  const cache = new Map<string, Buffer>();
  const read = (file: string) => {
    let buf = cache.get(file);
    if (!buf) {
      buf = readFileSync(file);
      if (buf.length < 2_000_000) cache.set(file, buf);
    }
    return buf;
  };

  return async (c, next) => {
    if ((c.req.method !== 'GET' && c.req.method !== 'HEAD') || RESERVED.test(c.req.path)) return next();
    if (!existsSync(indexPath)) return next();
    let rel: string;
    try {
      rel = decodeURIComponent(c.req.path);
    } catch {
      return next();
    }
    const candidate = normalize(join(root, rel));
    const inside = candidate === root || candidate.startsWith(root + sep);
    if (inside && candidate !== root && existsSync(candidate) && statSync(candidate).isFile()) {
      const type = TYPES[extname(candidate).toLowerCase()] ?? 'application/octet-stream';
      const immutable = rel.startsWith('/assets/');
      return c.body(new Uint8Array(read(candidate)), 200, {
        'Content-Type': type,
        'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
      });
    }
    // Unknown file-like paths are real 404s; everything else is a client route.
    if (extname(rel)) return next();
    return c.body(new Uint8Array(read(indexPath)), 200, { 'Content-Type': TYPES['.html']!, 'Cache-Control': 'no-cache' });
  };
}
