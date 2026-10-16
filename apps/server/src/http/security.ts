import type { MiddlewareHandler } from 'hono';

/** Content Security Policy for Morrow's own HTML (the web app and public pages). */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: https: blob:",
  "connect-src 'self'",
  // Template previews render in sandboxed srcdoc iframes.
  "frame-src 'self' blob: data:",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

/** Stricter policy for the small server-rendered recipient pages. */
export const PUBLIC_PAGE_CSP = ["default-src 'none'", "style-src 'unsafe-inline'", "img-src 'self' data: https:", "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'"].join('; ');

export function securityHeaders(options: { https: boolean }): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const h = c.res.headers;
    h.set('X-Content-Type-Options', 'nosniff');
    h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    h.set('X-Frame-Options', 'DENY');
    h.set('Cross-Origin-Opener-Policy', 'same-origin');
    h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    if (options.https) h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    const type = h.get('Content-Type') ?? '';
    if (type.includes('text/html') && !h.has('Content-Security-Policy')) h.set('Content-Security-Policy', APP_CSP);
    if (type.includes('application/json') && !h.has('Cache-Control')) h.set('Cache-Control', 'no-store');
  };
}

/** Best-effort client IP: the socket address, or the first forwarded hop when behind a trusted proxy. */
export function clientIp(headers: Headers, socketIp: string | null, trustProxy: boolean): string | null {
  if (trustProxy) {
    const fwd = headers.get('x-forwarded-for');
    if (fwd) return fwd.split(',')[0]!.trim().slice(0, 64) || socketIp;
    const real = headers.get('x-real-ip');
    if (real) return real.trim().slice(0, 64);
  }
  return socketIp;
}
