import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { securityHeaders } from '../apps/server/src/headers.ts';
import { config } from '../slide-types/website/index.ts';
import { freshUrl, isImageUrl } from '../slide-types/website/url.ts';

const LIBRENMS = 'https://bigbrother2.lgsit.de/dashboard/1.png';

describe('website slide', () => {
  it('accepts an https address and does not reload by default', () => {
    expect(config.parse({ url: LIBRENMS })).toEqual({ url: LIBRENMS, refresh: 0 });
  });

  it.each(['http://example.org/', 'javascript:alert(1)', 'data:text/html,x', 'example.org', ''])('rejects %s', (url) => {
    expect(config.safeParse({ url }).success).toBe(false);
  });

  it('tells image files from web pages', () => {
    expect(isImageUrl(LIBRENMS)).toBe(true);
    expect(isImageUrl('https://example.org/a/B.JPEG?x=1')).toBe(true);
    expect(isImageUrl('https://example.org/plan.html?bild=1.png')).toBe(false);
    expect(isImageUrl('https://example.org/')).toBe(false);
  });

  it('asks for a fresh image and keeps the query', () => {
    expect(freshUrl(LIBRENMS, 42)).toBe(`${LIBRENMS}?foyer=42`);
    expect(freshUrl('https://example.org/a.png?x=1', 42)).toBe('https://example.org/a.png?x=1&foyer=42');
  });
});

describe('content policy for external addresses', () => {
  const app = new Hono();
  app.use('*', securityHeaders());
  app.get('*', (c) => c.text('ok'));
  const policy = async (path: string) => (await app.request(path)).headers.get('Content-Security-Policy') ?? '';

  it('lets the player show https pages and images', async () => {
    const csp = await policy('/p/abc');
    expect(csp).toContain("frame-src 'self' https:");
    expect(csp).toContain('img-src \'self\' data: blob: https:');
  });

  it('keeps scripts and connections of the player to its own server', async () => {
    const csp = await policy('/p/abc');
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("connect-src 'self';");
  });

  it('keeps the admin closed', async () => {
    const csp = await policy('/admin/');
    expect(csp).toContain("frame-src 'self';");
    expect(csp).toContain("img-src 'self' data: blob:;");
  });
});
