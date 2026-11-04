import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { AppContext } from './context.ts';
import {
  csrfProtection,
  hasRole,
  login,
  logout,
  requireUser,
  setSessionCookie,
  sessionUser,
  SESSION_COOKIE,
  type AuthEnv,
} from './auth.ts';
import { getCookie } from 'hono/cookie';
import { clientIp, ipAllowed } from './net.ts';
import { audit, transaction } from './db.ts';
import { decrypt, encrypt, randomToken, safeEqual, sha256 } from './crypto.ts';
import { buildManifest, buildSlideEntry, documentSignature, type DisplayRow } from './manifest.ts';
import { parseConfig } from './registry.ts';
import { hashPassword } from './crypto.ts';
import { securityHeaders } from './headers.ts';
import { displayState } from './status.ts';
import { LeaseTable } from './leases.ts';

type Env = AuthEnv;

const id = () => crypto.randomUUID();

// --- Request validation ------------------------------------------------------

const loginBody = z.object({ email: z.string().min(1).max(320), password: z.string().min(1).max(1000) });
const displayCreate = z.object({ name: z.string().min(1).max(200) });
const cidrList = z
  .string()
  .max(2000)
  .refine((v) => v.split(',').every((p) => !p.trim() || /^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(p.trim())), 'Ungültige Netzangabe');
const displayPatch = z.object({
  name: z.string().min(1).max(200).optional(),
  defaultChannelId: z.string().nullable().optional(),
  showProgress: z.boolean().optional(),
  orientation: z.enum(['landscape', 'portrait']).optional(),
  networks: cidrList.optional(),
});
const channelBody = z.object({
  name: z.string().min(1).max(200),
  transition: z.enum(['fade', 'slide', 'none']).default('fade'),
  defaultDuration: z.number().int().min(1).max(3600).default(10),
  isFavorite: z.boolean().default(false),
  published: z.boolean().default(true),
});
const channelSlides = z.array(
  z.object({
    slideId: z.string(),
    windowStart: z.number().int().nullable().default(null),
    windowEnd: z.number().int().nullable().default(null),
  }),
);
const slideBody = z.object({
  title: z.string().min(1).max(300),
  type: z.string().min(1).max(100),
  config: z.unknown(),
  background: z.unknown().nullable().default(null),
  duration: z.number().int().min(1).max(86400).nullable().default(null),
  published: z.boolean().default(true),
});
const userCreate = z.object({
  email: z.email().max(320),
  name: z.string().min(1).max(200),
  role: z.enum(['admin', 'editor', 'viewer']),
  password: z.string().min(12).max(1000),
});
const nowPlayingBody = z.object({
  slideId: z.string().max(64).nullable(),
  version: z.string().max(64).nullable(),
});
const heartbeatBody = z.object({
  version: z.string().max(64).nullable(),
  slideId: z.string().max(64).nullable(),
  errors: z.array(z.string().max(500)).max(20).default([]),
  screen: z.string().max(40).optional(),
  userAgent: z.string().max(400).optional(),
});

function badRequest(c: Context, error: unknown) {
  if (error instanceof z.ZodError) return c.json({ error: 'Ungültige Eingabe', issues: error.issues }, 400);
  return c.json({ error: (error as Error).message }, 400);
}

// --- Logging: never write display tokens to logs (KONZEPT 3.3) ---------------

export function maskPath(path: string): string {
  return path.replace(/^\/p\/(?!preview(-display)?\/)[^/]+/, '/p/***').replace(/^\/api\/player\/[^/]+/, '/api/player/***');
}

function requestLogger(): MiddlewareHandler {
  return async (c, next) => {
    const start = Date.now();
    await next();
    if (process.env.FOYER_QUIET !== '1') {
      console.log(`${c.req.method} ${maskPath(c.req.path)} ${c.res.status} ${Date.now() - start}ms`);
    }
  };
}

// --- App ---------------------------------------------------------------------

export interface AppOptions {
  /** Serves the built player/admin; omitted in tests. */
  staticRoutes?: (app: Hono<Env>) => void;
  /** Socket address of the request; injected by the Node adapter. */
  remoteAddress?: (c: Context) => string;
}

export function createApp(ctx: AppContext, options: AppOptions = {}) {
  const { db, registry, events } = ctx;
  const app = new Hono<Env>();
  const remote = options.remoteAddress ?? (() => '127.0.0.1');
  // Last slide each display reported; in memory only, it is live state.
  const nowPlaying = new Map<string, { slideId: string | null; version: string | null; at: number }>();
  const leases = new LeaseTable();

  const sseStream = (c: Context, key: string) =>
    streamSSE(c, async (stream) => {
      const unsubscribe = events.subscribe(key, (event, data) => {
        void stream.writeSSE({ event, data: JSON.stringify(data ?? {}) });
      });
      stream.onAbort(unsubscribe);
      await stream.writeSSE({ event: 'hello', data: '{}' });
      while (!stream.aborted) {
        await stream.sleep(25_000);
        if (!stream.aborted) await stream.writeSSE({ event: 'ping', data: '{}' });
      }
      unsubscribe();
    });

  app.use('*', requestLogger());
  app.use('*', async (c, next) => {
    c.set('clientIp', clientIp(remote(c), c.req.header('x-forwarded-for'), ctx.trustedProxies));
    await next();
  });
  app.use('*', securityHeaders());
  app.use('/api/*', csrfProtection());

  app.get('/healthz', (c) => c.json({ ok: true }));

  // --- Auth ------------------------------------------------------------------

  app.post('/api/auth/login', async (c) => {
    const body = loginBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return badRequest(c, body.error);
    const result = await login(db, body.data.email, body.data.password, c.get('clientIp'));
    if (!result.ok) {
      audit(db, null, 'login-failed', 'user', null, { email: body.data.email, reason: result.reason, ip: c.get('clientIp') });
      const status = result.reason === 'invalid' ? 401 : 429;
      return c.json({ error: result.reason === 'invalid' ? 'E-Mail oder Passwort falsch' : 'Zu viele Versuche, bitte später erneut' }, status);
    }
    setSessionCookie(c, result.sessionId);
    audit(db, result.user.id, 'login', 'user', result.user.id, { ip: c.get('clientIp') });
    return c.json({ user: result.user });
  });

  app.post('/api/auth/logout', (c) => {
    logout(c, db);
    return c.json({ ok: true });
  });

  app.get('/api/auth/me', (c) => {
    const user = sessionUser(db, getCookie(c, SESSION_COOKIE));
    return user ? c.json({ user }) : c.json({ error: 'Nicht angemeldet' }, 401);
  });

  // --- Admin API -------------------------------------------------------------

  const admin = new Hono<Env>();
  admin.use('*', requireUser(db, 'viewer'));
  const editor = requireUser(db, 'editor');
  const adminOnly = requireUser(db, 'admin');

  admin.get('/slide-types', (c) =>
    c.json(
      [...registry.values()].map(({ definition, jsonSchema }) => ({
        id: definition.id,
        name: definition.name,
        description: definition.description ?? '',
        category: definition.category ?? 'content',
        backgrounds: definition.backgrounds ?? false,
        editRole: definition.editRole ?? 'editor',
        schema: jsonSchema,
      })),
    ),
  );

  admin.get('/slide-types/:type/options/:name', editor, async (c) => {
    const entry = registry.get(c.req.param('type'));
    const provider = entry?.server.options?.[c.req.param('name')];
    if (!provider) return c.json({ error: 'Nicht gefunden' }, 404);
    const partial = JSON.parse(c.req.query('config') ?? '{}');
    return c.json(await provider(partial, { locale: ctx.locale, timeZone: ctx.timeZone }));
  });

  // Displays
  admin.get('/displays', (c) => {
    const rows = db.prepare('SELECT id, name, default_channel_id, show_progress, orientation, networks, last_seen_at, status_json FROM displays ORDER BY name').all() as any[];
    const titleOf = db.prepare('SELECT title FROM slides WHERE id = ?');
    return c.json(
      rows.map((r) => {
        const status = r.status_json ? JSON.parse(r.status_json) : null;
        const state = displayState({
          connected: events.connected(r.id) > 0,
          lastSeenAt: r.last_seen_at,
          now: ctx.now(),
          serverStartedAt: ctx.startedAt,
        });
        const current = state === 'online' && status?.slideId ? (titleOf.get(status.slideId) as { title: string } | undefined) : undefined;
        const holder = leases.holder(r.id, ctx.now());
        return {
          id: r.id,
          name: r.name,
          defaultChannelId: r.default_channel_id,
          showProgress: r.show_progress === 1,
          orientation: r.orientation,
          networks: r.networks,
          lastSeenAt: r.last_seen_at,
          status,
          state,
          currentSlideTitle: current?.title ?? null,
          device: holder ? { ip: holder.ip, since: holder.since } : null,
        };
      }),
    );
  });

  // What a display shows, for the live preview in the admin: the manifest plus
  // the slide the real player reported last (null while the display is offline).
  admin.get('/preview/displays/:id/manifest', async (c) => {
    const display = db
      .prepare('SELECT id, name, default_channel_id, show_progress, orientation, networks, last_seen_at FROM displays WHERE id = ?')
      .get(c.req.param('id')) as (DisplayRow & { last_seen_at: number | null }) | undefined;
    if (!display) return c.json({ error: 'Nicht gefunden' }, 404);
    const manifest = await buildManifest(ctx, display, { preview: true });
    const online =
      displayState({ connected: events.connected(display.id) > 0, lastSeenAt: display.last_seen_at, now: ctx.now(), serverStartedAt: ctx.startedAt }) === 'online';
    return c.json({
      ...manifest,
      display: { ...manifest.display, showProgress: false },
      nowPlaying: online ? (nowPlaying.get(display.id) ?? null) : null,
    });
  });

  admin.get('/preview/displays/:id/events', (c) => sseStream(c, `watch:${c.req.param('id')}`));

  admin.post('/displays', adminOnly, async (c) => {
    const body = displayCreate.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return badRequest(c, body.error);
    const displayId = id();
    const token = randomToken();
    const now = ctx.now();
    db.prepare('INSERT INTO displays (id, name, token_hash, token_enc, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      displayId, body.data.name, sha256(token), encrypt(ctx.tokenKey, token), now, now,
    );
    audit(db, c.get('user').id, 'create', 'display', displayId, { name: body.data.name });
    return c.json({ id: displayId, token, playerPath: `/p/${token}` }, 201);
  });

  // Admins can look the player URL up again; every lookup is audited.
  admin.post('/displays/:id/reveal-url', adminOnly, (c) => {
    const row = db.prepare('SELECT token_enc FROM displays WHERE id = ?').get(c.req.param('id')) as { token_enc: string | null } | undefined;
    if (!row) return c.json({ error: 'Nicht gefunden' }, 404);
    if (!row.token_enc) {
      return c.json({ error: 'Für dieses Display ist keine URL gespeichert (vor dem Update angelegt). Bitte einmal „Neue URL“ erzeugen.' }, 409);
    }
    let token: string;
    try {
      token = decrypt(ctx.tokenKey, row.token_enc);
    } catch {
      return c.json({ error: 'URL kann nicht entschlüsselt werden (Schlüssel geändert?). Bitte „Neue URL“ erzeugen.' }, 409);
    }
    audit(db, c.get('user').id, 'reveal-url', 'display', c.req.param('id'), { ip: c.get('clientIp') });
    return c.json({ playerPath: `/p/${token}` });
  });

  admin.patch('/displays/:id', editor, async (c) => {
    const body = displayPatch.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return badRequest(c, body.error);
    if (body.data.networks !== undefined && !hasRole(c.get('user'), 'admin')) return c.json({ error: 'Keine Berechtigung' }, 403);
    const fields: string[] = [];
    const values: Array<string | number | null> = [];
    const set = (column: string, value: string | number | null) => {
      fields.push(`${column} = ?`);
      values.push(value);
    };
    if (body.data.name !== undefined) set('name', body.data.name);
    if (body.data.defaultChannelId !== undefined) set('default_channel_id', body.data.defaultChannelId);
    if (body.data.showProgress !== undefined) set('show_progress', body.data.showProgress ? 1 : 0);
    if (body.data.orientation !== undefined) set('orientation', body.data.orientation);
    if (body.data.networks !== undefined) set('networks', body.data.networks);
    if (!fields.length) return c.json({ ok: true });
    set('updated_at', ctx.now());
    const result = db.prepare(`UPDATE displays SET ${fields.join(', ')} WHERE id = ?`).run(...values, c.req.param('id'));
    if (!result.changes) return c.json({ error: 'Nicht gefunden' }, 404);
    audit(db, c.get('user').id, 'update', 'display', c.req.param('id'), body.data);
    events.send(c.req.param('id'), 'manifest-changed');
    return c.json({ ok: true });
  });

  admin.post('/displays/:id/rotate-token', adminOnly, (c) => {
    const token = randomToken();
    const result = db
      .prepare('UPDATE displays SET token_hash = ?, token_enc = ?, updated_at = ? WHERE id = ?')
      .run(sha256(token), encrypt(ctx.tokenKey, token), ctx.now(), c.req.param('id'));
    if (!result.changes) return c.json({ error: 'Nicht gefunden' }, 404);
    audit(db, c.get('user').id, 'rotate-token', 'display', c.req.param('id'));
    // Connected players with the old token reload and are rejected from then on.
    events.send(c.req.param('id'), 'reload');
    return c.json({ token, playerPath: `/p/${token}` });
  });

  // Frees the display for another device; the current one shows a notice and steps back.
  admin.post('/displays/:id/release', adminOnly, (c) => {
    const released = leases.release(c.req.param('id'));
    events.send(c.req.param('id'), 'released');
    audit(db, c.get('user').id, 'release-device', 'display', c.req.param('id'), { ip: released?.ip ?? null });
    return c.json({ ok: true });
  });

  admin.post('/displays/:id/reload', editor, (c) => {
    events.send(c.req.param('id'), 'reload');
    return c.json({ ok: true, connected: events.connected(c.req.param('id')) });
  });

  admin.post('/displays/:id/identify', editor, (c) => {
    events.send(c.req.param('id'), 'identify');
    return c.json({ ok: true, connected: events.connected(c.req.param('id')) });
  });

  admin.delete('/displays/:id', adminOnly, (c) => {
    const result = db.prepare('DELETE FROM displays WHERE id = ?').run(c.req.param('id'));
    if (!result.changes) return c.json({ error: 'Nicht gefunden' }, 404);
    audit(db, c.get('user').id, 'delete', 'display', c.req.param('id'));
    events.send(c.req.param('id'), 'reload');
    return c.json({ ok: true });
  });

  // Channels
  const channelOut = (r: any) => ({
    id: r.id,
    name: r.name,
    transition: r.transition,
    defaultDuration: r.default_duration,
    isFavorite: r.is_favorite === 1,
    published: r.published === 1,
    slideCount: r.slide_count ?? undefined,
  });

  admin.get('/channels', (c) => {
    const rows = db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM channel_slides cs WHERE cs.channel_id = c.id) AS slide_count
         FROM channels c ORDER BY c.is_favorite DESC, c.name`,
      )
      .all();
    return c.json(rows.map(channelOut));
  });

  admin.get('/channels/:id', (c) => {
    const row = db.prepare('SELECT * FROM channels WHERE id = ?').get(c.req.param('id'));
    if (!row) return c.json({ error: 'Nicht gefunden' }, 404);
    const slides = db
      .prepare('SELECT slide_id, window_start, window_end FROM channel_slides WHERE channel_id = ? ORDER BY position')
      .all(c.req.param('id')) as any[];
    return c.json({
      ...channelOut(row),
      slides: slides.map((s) => ({ slideId: s.slide_id, windowStart: s.window_start, windowEnd: s.window_end })),
    });
  });

  admin.post('/channels', editor, async (c) => {
    const body = channelBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return badRequest(c, body.error);
    const channelId = id();
    const now = ctx.now();
    const d = body.data;
    db.prepare(
      'INSERT INTO channels (id, name, transition, default_duration, is_favorite, published, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(channelId, d.name, d.transition, d.defaultDuration, d.isFavorite ? 1 : 0, d.published ? 1 : 0, now, now);
    audit(db, c.get('user').id, 'create', 'channel', channelId, { name: d.name });
    return c.json({ id: channelId }, 201);
  });

  admin.put('/channels/:id', editor, async (c) => {
    const body = channelBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return badRequest(c, body.error);
    const d = body.data;
    const result = db
      .prepare('UPDATE channels SET name = ?, transition = ?, default_duration = ?, is_favorite = ?, published = ?, updated_at = ? WHERE id = ?')
      .run(d.name, d.transition, d.defaultDuration, d.isFavorite ? 1 : 0, d.published ? 1 : 0, ctx.now(), c.req.param('id'));
    if (!result.changes) return c.json({ error: 'Nicht gefunden' }, 404);
    audit(db, c.get('user').id, 'update', 'channel', c.req.param('id'), d);
    events.broadcast('manifest-changed');
    return c.json({ ok: true });
  });

  admin.put('/channels/:id/slides', editor, async (c) => {
    const body = channelSlides.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return badRequest(c, body.error);
    const channelId = c.req.param('id');
    if (!db.prepare('SELECT 1 FROM channels WHERE id = ?').get(channelId)) return c.json({ error: 'Nicht gefunden' }, 404);
    try {
      transaction(db, () => {
        db.prepare('DELETE FROM channel_slides WHERE channel_id = ?').run(channelId);
        const insert = db.prepare('INSERT INTO channel_slides (channel_id, slide_id, position, window_start, window_end) VALUES (?, ?, ?, ?, ?)');
        body.data.forEach((s, position) => insert.run(channelId, s.slideId, position, s.windowStart, s.windowEnd));
        db.prepare('UPDATE channels SET updated_at = ? WHERE id = ?').run(ctx.now(), channelId);
      });
    } catch (err) {
      return badRequest(c, new Error('Unbekannte Folie in der Liste'));
    }
    audit(db, c.get('user').id, 'update-slides', 'channel', channelId, { count: body.data.length });
    events.broadcast('manifest-changed');
    return c.json({ ok: true });
  });

  admin.delete('/channels/:id', editor, (c) => {
    const result = db.prepare('DELETE FROM channels WHERE id = ?').run(c.req.param('id'));
    if (!result.changes) return c.json({ error: 'Nicht gefunden' }, 404);
    audit(db, c.get('user').id, 'delete', 'channel', c.req.param('id'));
    events.broadcast('manifest-changed');
    return c.json({ ok: true });
  });

  // Slides
  const slideOut = (r: any) => ({
    id: r.id,
    title: r.title,
    type: r.type,
    config: JSON.parse(r.config_json),
    background: r.background_json ? JSON.parse(r.background_json) : null,
    duration: r.duration,
    published: r.published === 1,
    updatedAt: r.updated_at,
  });

  const mayEditType = (c: Context<Env>, type: string) => {
    const role = registry.get(type)?.definition.editRole ?? 'editor';
    return hasRole(c.get('user'), role);
  };

  admin.get('/slides', (c) => c.json((db.prepare('SELECT * FROM slides ORDER BY updated_at DESC').all() as any[]).map(slideOut)));

  admin.get('/slides/:id', (c) => {
    const row = db.prepare('SELECT * FROM slides WHERE id = ?').get(c.req.param('id'));
    return row ? c.json(slideOut(row)) : c.json({ error: 'Nicht gefunden' }, 404);
  });

  const saveSlide = async (c: Context<Env>, slideId: string | null) => {
    const body = slideBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return badRequest(c, body.error);
    const d = body.data;
    if (!registry.has(d.type)) return c.json({ error: `Unbekannter Folientyp: ${d.type}` }, 400);
    if (!mayEditType(c, d.type)) return c.json({ error: 'Dieser Folientyp erfordert Admin-Rechte' }, 403);
    let config: unknown;
    try {
      config = parseConfig(registry, d.type, d.config);
    } catch (err) {
      return badRequest(c, err);
    }
    const now = ctx.now();
    if (slideId) {
      const existing = db.prepare('SELECT type FROM slides WHERE id = ?').get(slideId) as { type: string } | undefined;
      if (!existing) return c.json({ error: 'Nicht gefunden' }, 404);
      if (!mayEditType(c, existing.type)) return c.json({ error: 'Dieser Folientyp erfordert Admin-Rechte' }, 403);
      db.prepare('UPDATE slides SET title = ?, type = ?, config_json = ?, background_json = ?, duration = ?, published = ?, updated_at = ? WHERE id = ?').run(
        d.title, d.type, JSON.stringify(config), d.background ? JSON.stringify(d.background) : null, d.duration, d.published ? 1 : 0, now, slideId,
      );
      audit(db, c.get('user').id, 'update', 'slide', slideId, { title: d.title, type: d.type });
      events.broadcast('manifest-changed');
      return c.json({ id: slideId });
    }
    const newId = id();
    db.prepare('INSERT INTO slides (id, title, type, config_json, background_json, duration, published, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      newId, d.title, d.type, JSON.stringify(config), d.background ? JSON.stringify(d.background) : null, d.duration, d.published ? 1 : 0, now, now,
    );
    audit(db, c.get('user').id, 'create', 'slide', newId, { title: d.title, type: d.type });
    return c.json({ id: newId }, 201);
  };

  admin.post('/slides', editor, (c) => saveSlide(c, null));
  admin.put('/slides/:id', editor, (c) => saveSlide(c, c.req.param('id')));

  admin.delete('/slides/:id', editor, (c) => {
    const existing = db.prepare('SELECT type FROM slides WHERE id = ?').get(c.req.param('id')) as { type: string } | undefined;
    if (!existing) return c.json({ error: 'Nicht gefunden' }, 404);
    if (!mayEditType(c, existing.type)) return c.json({ error: 'Dieser Folientyp erfordert Admin-Rechte' }, 403);
    db.prepare('DELETE FROM slides WHERE id = ?').run(c.req.param('id'));
    audit(db, c.get('user').id, 'delete', 'slide', c.req.param('id'));
    events.broadcast('manifest-changed');
    return c.json({ ok: true });
  });

  // Preview manifest for one slide (admin preview player at /p/preview/<slideId>).
  admin.get('/preview/slides/:id/manifest', async (c) => {
    const row = db.prepare('SELECT *, NULL AS window_start, NULL AS window_end FROM slides WHERE id = ?').get(c.req.param('id')) as any;
    if (!row) return c.json({ error: 'Nicht gefunden' }, 404);
    const slide = await buildSlideEntry(ctx, row, 10, 'preview');
    return c.json({
      version: `preview-${row.updated_at}`,
      generatedAt: new Date(ctx.now()).toISOString(),
      display: { id: 'preview', name: 'Vorschau', showProgress: false, orientation: 'landscape' },
      channel: { id: 'preview', name: 'Vorschau', transition: 'none' },
      slides: slide ? [slide] : [],
      nextChange: null,
      settings: { locale: ctx.locale, timeZone: ctx.timeZone },
    });
  });

  // Users
  admin.get('/users', adminOnly, (c) => c.json(db.prepare('SELECT id, email, name, role, created_at FROM users ORDER BY email').all()));

  admin.post('/users', adminOnly, async (c) => {
    const body = userCreate.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return badRequest(c, body.error);
    const userId = id();
    try {
      db.prepare('INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        userId, body.data.email, body.data.name, await hashPassword(body.data.password), body.data.role, ctx.now(),
      );
    } catch {
      return c.json({ error: 'E-Mail bereits vergeben' }, 409);
    }
    audit(db, c.get('user').id, 'create', 'user', userId, { email: body.data.email, role: body.data.role });
    return c.json({ id: userId }, 201);
  });

  admin.delete('/users/:id', adminOnly, (c) => {
    if (c.req.param('id') === c.get('user').id) return c.json({ error: 'Eigenes Konto kann nicht gelöscht werden' }, 400);
    const result = db.prepare('DELETE FROM users WHERE id = ?').run(c.req.param('id'));
    if (!result.changes) return c.json({ error: 'Nicht gefunden' }, 404);
    audit(db, c.get('user').id, 'delete', 'user', c.req.param('id'));
    return c.json({ ok: true });
  });


  // --- Player API: token + network allowlist (KONZEPT 3.3) --------------------

  const player = new Hono<Env & { Variables: { display: DisplayRow } }>();
  player.use('/:token/*', async (c, next) => {
    const ip = c.get('clientIp');
    if (!ipAllowed(ip, ctx.playerNetworks)) return c.json({ error: 'Nicht erlaubt' }, 403);
    const display = db
      .prepare('SELECT id, name, default_channel_id, show_progress, orientation, networks FROM displays WHERE token_hash = ?')
      .get(sha256(c.req.param('token'))) as DisplayRow | undefined;
    // Same response for unknown token and foreign network: nothing to enumerate.
    if (!display) return c.json({ error: 'Nicht erlaubt' }, 403);
    const own = display.networks.split(',').map((n) => n.trim()).filter(Boolean);
    if (own.length && !ipAllowed(ip, own)) return c.json({ error: 'Nicht erlaubt' }, 403);
    // One device per display. Players send a random per-page-load session id;
    // clients without one (curl, old bundles) count as one session per IP.
    const sessionId = (c.req.header('x-foyer-session') ?? c.req.query('session') ?? `ip:${ip}`).slice(0, 64);
    const lease = leases.acquire(display.id, sessionId, ip, ctx.now());
    if (!lease.ok) {
      return c.json({ error: 'Dieses Display ist bereits auf einem anderen Gerät geöffnet.', code: 'display-busy' }, 409);
    }
    if (lease.tookOver) audit(db, null, 'device-takeover', 'display', display.id, { from: lease.tookOver.ip, to: ip });
    c.set('display', display);
    c.header('Cache-Control', 'no-store');
    await next();
  });

  player.get('/:token/manifest', async (c) => c.json(await buildManifest(ctx, c.get('display'))));

  player.post('/:token/heartbeat', async (c) => {
    const body = heartbeatBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return badRequest(c, body.error);
    db.prepare('UPDATE displays SET last_seen_at = ?, status_json = ? WHERE id = ?').run(
      ctx.now(),
      JSON.stringify({ ...body.data, ip: c.get('clientIp') }),
      c.get('display').id,
    );
    return c.json({ ok: true });
  });

  // Sent by the player on every slide change; drives the live preview in the admin.
  player.post('/:token/now-playing', async (c) => {
    const body = nowPlayingBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return badRequest(c, body.error);
    const display = c.get('display');
    const entry = { ...body.data, at: ctx.now() };
    nowPlaying.set(display.id, entry);
    db.prepare('UPDATE displays SET last_seen_at = ? WHERE id = ?').run(entry.at, display.id);
    events.send(`watch:${display.id}`, 'now-playing', entry);
    return c.json({ ok: true });
  });

  player.get('/:token/events', (c) => {
    const display = c.get('display');
    db.prepare('UPDATE displays SET last_seen_at = ? WHERE id = ?').run(ctx.now(), display.id);
    return sseStream(c, display.id);
  });

  app.route('/api/player', player);
  // Mounted after the player routes: the admin middleware matches all of /api/*.
  app.route('/api', admin);

  // --- Sandboxed slide documents (HTML slides) --------------------------------

  app.get('/content/slides/:id/:version', (c) => {
    const slideId = c.req.param('id');
    const version = Number(c.req.param('version'));
    const displayId = c.req.query('d') ?? '';
    const signature = c.req.query('s') ?? '';
    if (!safeEqual(signature, documentSignature(ctx, slideId, version, displayId))) return c.text('Nicht erlaubt', 403);
    // "preview" (single slide) and "preview:<displayId>" (display preview) are admin previews.
    const isPreview = displayId === 'preview' || displayId.startsWith('preview:');
    if (!isPreview && !ipAllowed(c.get('clientIp'), ctx.playerNetworks)) return c.text('Nicht erlaubt', 403);
    const row = db.prepare('SELECT type, config_json, updated_at FROM slides WHERE id = ?').get(slideId) as any;
    if (!row || row.updated_at !== version) return c.text('Nicht gefunden', 404);
    const entry = registry.get(row.type);
    if (!entry?.server.document) return c.text('Nicht gefunden', 404);
    const realDisplayId = displayId.startsWith('preview:') ? displayId.slice('preview:'.length) : displayId;
    const display = displayId === 'preview' ? { name: 'Vorschau' } : (db.prepare('SELECT name FROM displays WHERE id = ?').get(realDisplayId) as { name: string } | undefined);
    const doc = entry.server.document(entry.definition.config.parse(JSON.parse(row.config_json)), {
      displayId,
      displayName: display?.name ?? '',
      locale: ctx.locale,
      timeZone: ctx.timeZone,
    });
    c.header('Content-Security-Policy', doc.csp);
    c.header('Cache-Control', 'no-store');
    return c.html(doc.html);
  });

  options.staticRoutes?.(app);
  return app;
}
