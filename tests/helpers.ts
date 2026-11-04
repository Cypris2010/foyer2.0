import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createApp } from '../apps/server/src/app.ts';
import { openDbAt } from '../apps/server/src/db.ts';
import { loadRegistry } from '../apps/server/src/registry.ts';
import { EventHub } from '../apps/server/src/events.ts';
import { hashPassword, randomToken, sha256 } from '../apps/server/src/crypto.ts';
import { resetLoginThrottle } from '../apps/server/src/auth.ts';
import { clearDataCache } from '../apps/server/src/manifest.ts';
import { utcToLocal } from '../apps/server/src/schedule-engine.ts';
import type { AppContext } from '../apps/server/src/context.ts';

const slideTypesDir = join(import.meta.dirname, '../slide-types');
export const PASSWORD = 'correct-horse-battery';

export async function setup(now = Date.parse('2026-11-04T10:00:00Z')) {
  resetLoginThrottle();
  clearDataCache();
  let clock = now;
  const db = openDbAt(':memory:');
  const ctx: AppContext = {
    db,
    registry: await loadRegistry(slideTypesDir),
    events: new EventHub(),
    secret: 'test-secret',
    tokenKey: randomBytes(32),
    locale: 'de-DE',
    timeZone: 'Europe/Berlin',
    playerNetworks: ['10.0.0.0/8', '127.0.0.0/8'],
    trustedProxies: ['127.0.0.1'],
    startedAt: now - 3600_000,
    now: () => clock,
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
  const local = (ms: number) => utcToLocal(ms, 'Europe/Berlin');
  // Slides play only with a channel calendar entry; null start/end = open-ended.
  const insertSlide = (slideId: string, type: string, config: unknown, position: number, start: number | null = null, end: number | null = null) => {
    db.prepare('INSERT INTO slides (id, title, type, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      slideId, slideId, type, JSON.stringify(config), now, now,
    );
    db.prepare('INSERT INTO channel_slides (channel_id, slide_id, position) VALUES (?, ?, ?)').run(channelId, slideId, position);
    db.prepare(
      `INSERT INTO schedules (id, scope, channel_id, content_kind, content_id, start_local, end_local, created_at, updated_at)
       VALUES (?, 'channel', ?, 'slide', ?, ?, ?, ?, ?)`,
    ).run(`plan-${slideId}`, channelId, slideId, start === null ? '2000-01-01T00:00' : local(start), end === null ? null : local(end), now, now);
  };
  insertSlide('s-text', 'text', { title: 'Hallo', qrUrl: 'https://example.org' }, 0);
  insertSlide('s-html', 'html', { html: '<h1>{{display.name}}</h1>', js: 'var x = "</script>";' }, 1);
  insertSlide('s-later', 'text', { title: 'Später' }, 2, now + 3600_000, null);
  insertSlide('s-expired', 'text', { title: 'Vorbei' }, 3, now - 7200_000, now - 60_000);

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

  const advance = (ms: number) => {
    clock += ms;
  };

  return { app, ctx, db, token, now, local, loginAs, advance, channelId };
}

export function json(method: string, body: unknown, cookie?: string): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  };
}
