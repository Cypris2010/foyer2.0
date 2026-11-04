import type { MiddlewareHandler } from 'hono';

// Strict defaults; HTML slide documents set their own CSP (see app.ts).
const ADMIN_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

const PLAYER_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "frame-src 'self'",
  // The admin embeds the player for previews.
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cross-Origin-Opener-Policy', 'same-origin');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    if (c.req.header('x-forwarded-proto') === 'https') c.header('Strict-Transport-Security', 'max-age=31536000');
    const path = c.req.path;
    if (path.startsWith('/content/')) return; // own CSP
    if (path.startsWith('/p/') || path.startsWith('/player/')) {
      c.header('Content-Security-Policy', PLAYER_CSP);
    } else {
      c.header('Content-Security-Policy', ADMIN_CSP);
      c.header('X-Frame-Options', 'DENY');
    }
  };
}
