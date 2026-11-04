import { join } from 'node:path';
import { createApp } from '../apps/server/src/app.ts';
import { openDbAt } from '../apps/server/src/db.ts';
import { loadRegistry } from '../apps/server/src/registry.ts';
import { EventHub } from '../apps/server/src/events.ts';
import { hashPassword, randomToken, sha256 } from '../apps/server/src/crypto.ts';
import { resetLoginThrottle } from '../apps/server/src/auth.ts';
import { clearDataCache } from '../apps/server/src/manifest.ts';
import type { AppContext } from '../apps/server/src/context.ts';

const slideTypesDir = join(import.meta.dirname, '../slide-types');
export const PASSWORD = 'correct-horse-battery';

export async function setup(now = Date.parse('2026-11-04T10:00:00Z')) {
  resetLoginThrottle();
  clearDataCache();
  const db = openDbAt(':memory:');
  const ctx: AppContext = {
    db,
    registry: await loadRegistry(slideTypesDir),
    events: new EventHub(),
    secret: 'test-secret',
    locale: 'de-DE',
    timeZone: 'Europe/Berlin',
    playerNetworks: ['10.0.0.0/8', '127.0.0.0/8'],
    trustedProxies: ['127.0.0.1'],
    now: () => now,
  };
  // Tests choose the socket address via a header the real server never reads.
  const app = createApp(ctx, { remoteAddress: (c) => c.req.header('x-test-remote') ?? '10.1.2.3' });

  const hash = await hashPassword(PASSWORD);
  for (const role of ['admin', 'editor', 'viewer']) {
    db.prepare('INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      role, `${role}@schule.de`, role, hash, role, now,
    );
  }

  const channelId = 'ch1';
  db.prepare('INSERT INTO channels (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(channelId, 'Foyer', now, now);
  const insertSlide = (slideId: string, type: string, config: unknown, position: number, windowStart: number | null = null, windowEnd: number | null = null) => {
    db.prepare('INSERT INTO slides (id, title, type, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      slideId, slideId, type, JSON.stringify(config), now, now,
    );
    db.prepare('INSERT INTO channel_slides (channel_id, slide_id, position, window_start, window_end) VALUES (?, ?, ?, ?, ?)').run(
      channelId, slideId, position, windowStart, windowEnd,
    );
  };
  insertSlide('s-text', 'text', { title: 'Hallo', qrUrl: 'https://example.org' }, 0);
  insertSlide('s-html', 'html', { html: '<h1>{{display.name}}</h1>', js: 'var x = "</script>";' }, 1);
  insertSlide('s-later', 'text', { title: 'Später' }, 2, now + 3600_000, null);
  insertSlide('s-expired', 'text', { title: 'Vorbei' }, 3, null, now - 1000);

  const token = randomToken();
  db.prepare('INSERT INTO displays (id, name, token_hash, default_channel_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    'd1', 'Aula', sha256(token), channelId, now, now,
  );

  async function loginAs(role: string): Promise<string> {
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ email: `${role}@schule.de`, password: PASSWORD }),
    });
    if (res.status !== 200) throw new Error(`login ${role}: ${res.status}`);
    const cookie = res.headers.get('set-cookie') ?? '';
    return cookie.split(';')[0];
  }

  return { app, ctx, db, token, now, loginAs };
}

export function json(method: string, body: unknown, cookie?: string): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  };
}
