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
import { TEST_PATTERNS, type TestPatternState } from '@foyer/slide-sdk/test-patterns';
import { affectedDisplays, MAX_WALL_SIDE, setWallCells, trimWall, WallError, wallScreens } from './walls.ts';
import { buildManifest, buildSlideEntry, dataSignature, documentSignature, DISPLAY_COLUMNS, liveSignature, slideData, type DisplayRow, type SlideRow } from './manifest.ts';
import { parseConfig } from './registry.ts';
import { securityHeaders } from './headers.ts';
import { displayState } from './status.ts';
import { LeaseTable } from './leases.ts';
import { registerScheduleRoutes } from './schedule-routes.ts';
import { registerMediaRoutes } from './media-routes.ts';
import { registerIntegrationRoutes, slideServerContext } from './integrations.ts';
import { backgroundSchema, checkBackground, mediaFields, mediaFileSignature, placeholderMedia, signedMediaUrl } from './background.ts';
import { registerApiKeyRoutes } from './api-keys.ts';
import { registerUserRoutes } from './users.ts';
import { registerMcp } from './mcp.ts';

type Env = AuthEnv;

const id = () => crypto.randomUUID();

// --- Request validation ------------------------------------------------------

const loginBody = z.object({ email: z.string().min(1).max(320), password: z.string().min(1).max(1000) });
const wallSide = z.number().int().min(1).max(MAX_WALL_SIDE);
const displayCreate = z.object({
  name: z.string().min(1).max(200),
  // A wall: a grid that normal displays are assigned to (walls.ts).
  kind: z.enum(['screen', 'wall']).default('screen'),
  rows: wallSide.default(1),
  cols: wallSide.default(2),
});
const testPatternBody = z.object({ action: z.enum(['start', 'next', 'prev', 'stop']) });
// A forgotten test pattern ends by itself and the programme continues.
const TEST_PATTERN_MS = 10 * 60_000;
const wallCells = z.object({
  cells: z.array(z.object({ displayId: z.string(), row: z.number().int().min(0), col: z.number().int().min(0) })).max(MAX_WALL_SIDE ** 2),
});
const cidrList = z
  .string()
  .max(2000)
  .refine((v) => v.split(',').every((p) => !p.trim() || /^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(p.trim())), 'Ungültige Netzangabe');
const displayPatch = z.object({
  name: z.string().min(1).max(200).optional(),
  defaultChannelId: z.string().nullable().optional(),
  showProgress: z.boolean().optional(),
  soundAllowed: z.boolean().optional(),
  orientation: z.enum(['landscape', 'portrait']).optional(),
  networks: cidrList.optional(),
  wallRows: wallSide.optional(),
  wallCols: wallSide.optional(),
  wallBezel: z.number().int().min(0).max(500).optional(),
  wallMode: z.enum(['span', 'stack']).optional(),
});
const channelBody = z.object({
  name: z.string().min(1).max(200),
  transition: z.enum(['fade', 'slide', 'none']).default('fade'),
  defaultDuration: z.number().int().min(1).max(3600).default(10),
  isFavorite: z.boolean().default(false),
  published: z.boolean().default(true),
});
const channelSlides = z.array(z.object({ slideId: z.string() }));
const slideBody = z.object({
  title: z.string().min(1).max(300),
  type: z.string().min(1).max(100),
  config: z.unknown(),
  background: backgroundSchema,
  duration: z.number().int().min(1).max(86400).nullable().default(null),
  published: z.boolean().default(true),
});
const nowPlayingBody = z.object({
  slideId: z.string().max(64).nullable(),
  version: z.string().max(64).nullable(),
  // How long the slide has been on screen already (re-reports after reconnects).
  elapsedMs: z.number().int().min(0).max(86_400_000).default(0),
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

/** For the admin: which test pattern runs, by name. */
function testPatternInfo(state: TestPatternState | null) {
  if (!state) return null;
  const pattern = TEST_PATTERNS[state.index];
  return { index: state.index, count: TEST_PATTERNS.length, name: pattern.name, hint: pattern.hint, until: state.until };
}

export function createApp(ctx: AppContext, options: AppOptions = {}) {
  const { db, registry, events } = ctx;
  const app = new Hono<Env>();
  const remote = options.remoteAddress ?? (() => '127.0.0.1');
  // Test patterns by the display (or wall) the admin started them on; live state.
  const testPatterns = new Map<string, TestPatternState>();
  const activeTest = (displayId: string): TestPatternState | null => {
    const state = testPatterns.get(displayId);
    if (state && state.until > ctx.now()) return state;
    testPatterns.delete(displayId);
    return null;
  };

  // Last slide each display reported; in memory only, it is live state.
  const nowPlaying = new Map<string, { slideId: string | null; version: string | null; at: number }>();
  const leases = new LeaseTable();
  // Finished transcodes change what slides show: players fetch the manifest again.
  ctx.media.onReady = () => events.broadcast('manifest-changed');

  /**
   * initial: events a (re)connecting client must not miss, sent after "hello".
   * keys as an object (stream label → event key): one stream for several keys,
   * every event carries its label as "key".
   */
  const sseStream = (c: Context, keys: string | Record<string, string>, initial: () => Array<{ event: string; data: unknown }> = () => []) =>
    streamSSE(c, async (stream) => {
      const labelled = typeof keys !== 'string';
      const unsubscribes = Object.entries(labelled ? keys : { '': keys }).map(([label, key]) =>
        events.subscribe(key, (event, data) => {
          const payload = labelled ? { ...(data as object | undefined), key: label } : (data ?? {});
          void stream.writeSSE({ event, data: JSON.stringify(payload) });
        }),
      );
      const unsubscribe = () => unsubscribes.forEach((off) => off());
      stream.onAbort(unsubscribe);
      await stream.writeSSE({ event: 'hello', data: '{}' });
      for (const { event, data } of initial()) await stream.writeSSE({ event, data: JSON.stringify(data) });
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
        durationFromMedia: definition.durationFromMedia ?? null,
        editRole: definition.editRole ?? 'editor',
        schema: jsonSchema,
      })),
    ),
  );

  admin.get('/slide-types/:type/options/:name', editor, async (c) => {
    const entry = registry.get(c.req.param('type'));
    const provider = entry?.server.options?.[c.req.param('name')];
    if (!provider) return c.json({ error: 'Nicht gefunden' }, 404);
    let partial: unknown;
    try {
      partial = JSON.parse(c.req.query('config') ?? '{}');
    } catch {
      return c.json({ error: 'Ungültige Konfiguration' }, 400);
    }
    try {
      return c.json(await provider(partial && typeof partial === 'object' ? partial : {}, slideServerContext(ctx)));
    } catch (err) {
      // E.g. the data source is unreachable; the admin shows the message.
      return c.json({ error: (err as Error).message }, 502);
    }
  });

  // Displays
  admin.get('/displays', (c) => {
    const rows = db.prepare(`SELECT ${DISPLAY_COLUMNS}, last_seen_at, status_json FROM displays ORDER BY name`).all() as any[];
    const titleOf = db.prepare('SELECT title FROM slides WHERE id = ?');
    const stateOf = (r: any) =>
      displayState({ connected: events.connected(r.id) > 0, lastSeenAt: r.last_seen_at, now: ctx.now(), serverStartedAt: ctx.startedAt });
    return c.json(
      rows.map((r) => {
        const status = r.status_json ? JSON.parse(r.status_json) : null;
        // A wall has no device: it is online when all of its screens are.
        const screens = r.kind === 'wall' ? rows.filter((s) => s.wall_id === r.id) : [];
        const screenStates = screens.map(stateOf);
        const state =
          r.kind !== 'wall'
            ? stateOf(r)
            : !screens.length
              ? 'never'
              : screenStates.every((s) => s === 'online')
                ? 'online'
                : screenStates.includes('checking')
                  ? 'checking'
                  : screenStates.every((s) => s === 'never')
                    ? 'never'
                    : 'offline';
        const lead = screens.find((s, i) => screenStates[i] === 'online' && s.status_json);
        const slideId = r.kind === 'wall' ? (lead ? JSON.parse(lead.status_json).slideId : null) : status?.slideId;
        const current = state !== 'never' && slideId ? (titleOf.get(slideId) as { title: string } | undefined) : undefined;
        const holder = leases.holder(r.id, ctx.now());
        // Wall: the newest "offline since" of a screen that is down.
        const offlineSince = Math.max(0, ...screens.filter((_, i) => screenStates[i] === 'offline').map((s) => s.last_seen_at ?? 0)) || null;
        return {
          id: r.id,
          name: r.name,
          defaultChannelId: r.default_channel_id,
          showProgress: r.show_progress === 1,
          soundAllowed: r.sound_allowed === 1,
          orientation: r.orientation,
          networks: r.networks,
          lastSeenAt: r.kind === 'wall' ? offlineSince : r.last_seen_at,
          status,
          state,
          currentSlideTitle: current?.title ?? null,
          device: holder ? { ip: holder.ip, since: holder.since } : null,
          kind: r.kind,
          wall:
            r.kind === 'wall'
              ? {
                  rows: r.wall_rows,
                  cols: r.wall_cols,
                  bezel: r.wall_bezel,
                  mode: r.wall_mode,
                  screens: screens.length,
                  online: screenStates.filter((s) => s === 'online').length,
                }
              : null,
          wallId: r.wall_id,
          wallRow: r.wall_row,
          wallCol: r.wall_col,
          testPattern: testPatternInfo(activeTest(r.id)),
        };
      }),
    );
  });

  // What a display shows, for the live preview in the admin: the manifest plus
  // the slide the real player reported last (null while the display is offline).
  admin.get('/preview/displays/:id/manifest', async (c) => {
    const display = db
      .prepare(`SELECT ${DISPLAY_COLUMNS}, last_seen_at FROM displays WHERE id = ?`)
      .get(c.req.param('id')) as (DisplayRow & { last_seen_at: number | null }) | undefined;
    if (!display) return c.json({ error: 'Nicht gefunden' }, 404);
    const manifest = await buildManifest(ctx, display, { preview: true });
    const isOnline = (row: { id: string; last_seen_at: number | null }) =>
      displayState({ connected: events.connected(row.id) > 0, lastSeenAt: row.last_seen_at, now: ctx.now(), serverStartedAt: ctx.startedAt }) === 'online';
    // A wall is followed while any of its screens runs (they report for it).
    const online =
      display.kind === 'wall'
        ? (db.prepare('SELECT id, last_seen_at FROM displays WHERE wall_id = ?').all(display.id) as Array<{ id: string; last_seen_at: number | null }>).some(isOnline)
        : isOnline(display);
    const current = online ? nowPlaying.get(display.id) : undefined;
    return c.json({
      ...manifest,
      display: { ...manifest.display, showProgress: false },
      // elapsedMs from the server's clock, so admin and display clocks may differ.
      nowPlaying: current ? { ...current, elapsedMs: ctx.now() - current.at } : null,
    });
  });

  admin.get('/preview/displays/:id/events', (c) => sseStream(c, `watch:${c.req.param('id')}`));
  // All live thumbnails of an admin page on one stream: without HTTP/2 a browser
  // opens only 6 connections per host, and every open stream holds one.
  admin.get('/preview/events', (c) => {
    const ids = (c.req.query('displays') ?? '').split(',').filter((displayId) => /^[\w-]{1,64}$/.test(displayId)).slice(0, 200);
    return sseStream(c, Object.fromEntries(ids.map((displayId) => [displayId, `watch:${displayId}`])));
  });

  admin.post('/displays', adminOnly, async (c) => {
    const body = displayCreate.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return badRequest(c, body.error);
    const displayId = id();
    const token = randomToken();
    const now = ctx.now();
    const { name, kind, rows, cols } = body.data;
    // Walls get a token too (the column is required), but it is never handed out.
    db.prepare(
      'INSERT INTO displays (id, name, token_hash, token_enc, kind, wall_rows, wall_cols, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(displayId, name, sha256(token), kind === 'wall' ? null : encrypt(ctx.tokenKey, token), kind, kind === 'wall' ? rows : null, kind === 'wall' ? cols : null, now, now);
    audit(db, c.get('user').id, 'create', 'display', displayId, kind === 'wall' ? { name, kind, rows, cols } : { name });
    if (kind === 'wall') return c.json({ id: displayId }, 201);
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
    if (body.data.soundAllowed !== undefined) set('sound_allowed', body.data.soundAllowed ? 1 : 0);
    if (body.data.orientation !== undefined) set('orientation', body.data.orientation);
    if (body.data.networks !== undefined) set('networks', body.data.networks);
    const displayId = c.req.param('id');
    const current = db.prepare('SELECT kind, wall_rows, wall_cols FROM displays WHERE id = ?').get(displayId) as
      | { kind: string; wall_rows: number | null; wall_cols: number | null }
      | undefined;
    if (!current) return c.json({ error: 'Nicht gefunden' }, 404);
    const { wallRows, wallCols, wallBezel, wallMode } = body.data;
    if ((wallRows ?? wallCols ?? wallBezel ?? wallMode) !== undefined && current.kind !== 'wall') return c.json({ error: 'Kein Wand-Display' }, 400);
    if (wallRows !== undefined) set('wall_rows', wallRows);
    if (wallCols !== undefined) set('wall_cols', wallCols);
    if (wallBezel !== undefined) set('wall_bezel', wallBezel);
    if (wallMode !== undefined) set('wall_mode', wallMode);
    if (!fields.length) return c.json({ ok: true });
    set('updated_at', ctx.now());
    // Screens outside a smaller grid leave the wall (and play their own channel again).
    const left = transaction(db, () => {
      db.prepare(`UPDATE displays SET ${fields.join(', ')} WHERE id = ?`).run(...values, displayId);
      if (wallRows === undefined && wallCols === undefined) return [];
      return trimWall(db, displayId, wallRows ?? current.wall_rows ?? 1, wallCols ?? current.wall_cols ?? 1, ctx.now());
    });
    audit(db, c.get('user').id, 'update', 'display', displayId, body.data);
    for (const target of [...affectedDisplays(db, displayId), ...left]) events.send(target, 'manifest-changed');
    return c.json({ ok: true });
  });

  // Which display fills which cell of a wall; the whole grid at once.
  admin.put('/displays/:id/cells', editor, async (c) => {
    const body = wallCells.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return badRequest(c, body.error);
    let changed: string[];
    try {
      changed = setWallCells(db, c.req.param('id'), body.data.cells, ctx.now());
    } catch (err) {
      if (err instanceof WallError) return c.json({ error: err.message }, err.status);
      throw err;
    }
    audit(db, c.get('user').id, 'update-wall', 'display', c.req.param('id'), body.data);
    for (const target of changed) events.send(target, 'manifest-changed');
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

  // A wall passes these on to its screens.
  admin.post('/displays/:id/reload', editor, (c) => {
    const targets = affectedDisplays(db, c.req.param('id'));
    for (const target of targets) events.send(target, 'reload');
    return c.json({ ok: true, connected: targets.reduce((sum, target) => sum + events.connected(target), 0) });
  });

  // Test patterns, stepped through by hand; a wall passes them to its screens.
  admin.post('/displays/:id/test-pattern', editor, async (c) => {
    const body = testPatternBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return badRequest(c, body.error);
    const displayId = c.req.param('id');
    if (!db.prepare('SELECT 1 FROM displays WHERE id = ?').get(displayId)) return c.json({ error: 'Nicht gefunden' }, 404);
    const current = activeTest(displayId);
    const count = TEST_PATTERNS.length;
    const { action } = body.data;
    const state: TestPatternState | null =
      action === 'stop'
        ? null
        : {
            index: action === 'start' || !current ? 0 : (current.index + (action === 'next' ? 1 : count - 1)) % count,
            until: ctx.now() + TEST_PATTERN_MS,
          };
    if (state) testPatterns.set(displayId, state);
    else testPatterns.delete(displayId);
    for (const target of affectedDisplays(db, displayId)) events.send(target, 'test-pattern', state);
    return c.json({ testPattern: testPatternInfo(state) });
  });

  admin.post('/displays/:id/identify', editor, (c) => {
    const targets = affectedDisplays(db, c.req.param('id'));
    for (const target of targets) events.send(target, 'identify');
    return c.json({ ok: true, connected: targets.reduce((sum, target) => sum + events.connected(target), 0) });
  });

  admin.delete('/displays/:id', adminOnly, (c) => {
    const displayId = c.req.param('id');
    // A deleted wall hands its screens back; they play their own channel again.
    const screens = wallScreens(db, displayId).map((screen) => screen.id);
    const result = transaction(db, () => {
      db.prepare('UPDATE displays SET wall_id = NULL, wall_row = NULL, wall_col = NULL, updated_at = ? WHERE wall_id = ?').run(ctx.now(), displayId);
      return db.prepare('DELETE FROM displays WHERE id = ?').run(displayId);
    });
    if (!result.changes) return c.json({ error: 'Nicht gefunden' }, 404);
    audit(db, c.get('user').id, 'delete', 'display', displayId);
    events.send(displayId, 'reload');
    for (const screen of screens) events.send(screen, 'manifest-changed');
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
    const slides = db.prepare('SELECT slide_id FROM channel_slides WHERE channel_id = ? ORDER BY position').all(c.req.param('id')) as any[];
    return c.json({ ...channelOut(row), slides: slides.map((s) => ({ slideId: s.slide_id })) });
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
    // A slide appears once per channel; when it plays is up to the channel calendar.
    const slideIds = [...new Set(body.data.map((s) => s.slideId))];
    try {
      transaction(db, () => {
        db.prepare('DELETE FROM channel_slides WHERE channel_id = ?').run(channelId);
        const insert = db.prepare('INSERT INTO channel_slides (channel_id, slide_id, position) VALUES (?, ?, ?)');
        slideIds.forEach((slideId, position) => insert.run(channelId, slideId, position));
        // Calendar entries of slides that left the channel go with them.
        const placeholders = slideIds.map(() => '?').join(',') || "''";
        db.prepare(`DELETE FROM schedules WHERE scope = 'channel' AND channel_id = ? AND content_id NOT IN (${placeholders})`).run(channelId, ...slideIds);
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
    db.prepare("DELETE FROM schedules WHERE content_kind = 'channel' AND content_id = ?").run(c.req.param('id'));
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
    const backgroundError = checkBackground(ctx, d.background, registry.get(d.type)!.definition.backgrounds);
    if (backgroundError) return c.json({ error: backgroundError }, 400);
    let config: unknown;
    try {
      config = parseConfig(registry, d.type, d.config);
    } catch (err) {
      return badRequest(c, err);
    }
    for (const field of mediaFields(registry.get(d.type)!.jsonSchema)) {
      const mediaId = (config as Record<string, unknown>)[field.name];
      if (typeof mediaId !== 'string' || !mediaId) continue;
      const item = ctx.media.get(mediaId);
      if (!item) return c.json({ error: 'Die gewählte Datei gibt es nicht mehr' }, 400);
      if (item.kind !== field.accept) return c.json({ error: field.accept === 'video' ? 'Bitte ein Video wählen' : 'Bitte ein Bild wählen' }, 400);
    }
    if (registry.get(d.type)!.server.document) {
      const missing = placeholderMedia(config as Record<string, unknown>).filter((mediaId) => !ctx.media.get(mediaId));
      if (missing.length) return c.json({ error: `Unbekanntes Medium in {{media:…}}: ${missing.join(', ')}` }, 400);
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
    db.prepare("DELETE FROM schedules WHERE content_kind = 'slide' AND content_id = ?").run(c.req.param('id'));
    audit(db, c.get('user').id, 'delete', 'slide', c.req.param('id'));
    events.broadcast('manifest-changed');
    return c.json({ ok: true });
  });

  registerScheduleRoutes(admin, ctx, editor);
  registerMediaRoutes(admin, ctx, editor);
  registerIntegrationRoutes(admin, ctx, adminOnly);
  registerApiKeyRoutes(admin, ctx);

  // Preview manifest for one slide (admin preview player at /p/preview/<slideId>).
  admin.get('/preview/slides/:id/manifest', async (c) => {
    const row = db.prepare('SELECT *, NULL AS window_start, NULL AS window_end FROM slides WHERE id = ?').get(c.req.param('id')) as any;
    if (!row) return c.json({ error: 'Nicht gefunden' }, 404);
    const slide = await buildSlideEntry(ctx, row, 10, 'preview');
    return c.json({
      version: `preview-${row.updated_at}`,
      generatedAt: new Date(ctx.now()).toISOString(),
      display: { id: 'preview', name: 'Vorschau', showProgress: false, orientation: 'landscape', soundAllowed: false },
      channel: { id: 'preview', name: 'Vorschau', transition: 'none' },
      slides: slide ? [slide] : [],
      nextChange: null,
      settings: { locale: ctx.locale, timeZone: ctx.timeZone },
      playerBuild: ctx.playerBuild(),
    });
  });

  // Users and the own account
  registerUserRoutes(admin, ctx);

  // --- Player API: token + network allowlist (KONZEPT 3.3) --------------------

  const player = new Hono<Env & { Variables: { display: DisplayRow } }>();
  player.use('/:token/*', async (c, next) => {
    const ip = c.get('clientIp');
    if (!ipAllowed(ip, ctx.playerNetworks)) return c.json({ error: 'Nicht erlaubt' }, 403);
    const display = db
      .prepare(`SELECT ${DISPLAY_COLUMNS} FROM displays WHERE token_hash = ?`)
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

  // Clock for synchronous displays (player clock.ts): tiny, no database write.
  player.get('/:token/time', (c) => c.json({ now: ctx.now() }));

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
    const { elapsedMs, ...slide } = body.data;
    const now = ctx.now();
    // at: when the slide appeared, so previews opened later can catch up.
    const entry = { ...slide, at: now - elapsedMs };
    nowPlaying.set(display.id, entry);
    db.prepare('UPDATE displays SET last_seen_at = ? WHERE id = ?').run(now, display.id);
    events.send(`watch:${display.id}`, 'now-playing', { ...entry, elapsedMs });
    // The wall's preview follows its screens (they all show the same slide).
    if (display.wall_id) {
      nowPlaying.set(display.wall_id, entry);
      events.send(`watch:${display.wall_id}`, 'now-playing', { ...entry, elapsedMs });
    }
    return c.json({ ok: true });
  });

  player.get('/:token/events', (c) => {
    const display = c.get('display');
    db.prepare('UPDATE displays SET last_seen_at = ? WHERE id = ?').run(ctx.now(), display.id);
    // Reconnected during a test: show it again (its own, else its wall's).
    return sseStream(c, display.id, () => {
      const test = activeTest(display.id) ?? (display.wall_id ? activeTest(display.wall_id) : null);
      return test ? [{ event: 'test-pattern', data: test }] : [];
    });
  });

  app.route('/api/player', player);
  // Mounted after the player routes: the admin middleware matches all of /api/*.
  app.route('/api', admin);
  // AI assistants (MCP) with a personal API key; uses the admin API above.
  registerMcp(app, ctx);

  // --- Media files --------------------------------------------------------------
  // Players (school networks) and logged-in admins only: uploads may show people.
  // Signed URLs come from HTML slide documents ({{media:<id>}}). Names are
  // content hashes, so responses are cached for good.
  app.get('/media/:file', async (c) => {
    const signed = safeEqual(c.req.query('s') ?? '', mediaFileSignature(ctx, c.req.param('file')));
    if (!signed && !ipAllowed(c.get('clientIp'), ctx.playerNetworks) && !sessionUser(db, getCookie(c, SESSION_COOKIE))) {
      return c.text('Nicht erlaubt', 403);
    }
    return (await ctx.media.serve(c.req.param('file'), c.req.header('range'))) ?? c.notFound();
  });

  // --- Personal slide data (personalData types, e.g. Untis) ---------------------
  // Kept out of the manifest so players never cache it offline (KONZEPT 3.1).
  // Displays: signed URL from their manifest, school networks only. Admin
  // previews: signed URL plus a session.
  app.get('/content/data/:id/:version', async (c) => {
    const slideId = c.req.param('id');
    const version = Number(c.req.param('version'));
    const displayId = c.req.query('d') ?? '';
    if (!safeEqual(c.req.query('s') ?? '', dataSignature(ctx, slideId, version, displayId))) return c.json({ error: 'Nicht erlaubt' }, 403);
    const isPreview = displayId === 'preview' || displayId.startsWith('preview:');
    const allowed = isPreview ? sessionUser(db, getCookie(c, SESSION_COOKIE)) : ipAllowed(c.get('clientIp'), ctx.playerNetworks);
    if (!allowed) return c.json({ error: 'Nicht erlaubt' }, 403);
    const row = db.prepare('SELECT * FROM slides WHERE id = ?').get(slideId) as SlideRow | undefined;
    if (!row || row.updated_at !== version || !registry.get(row.type)?.definition.personalData) return c.json({ error: 'Nicht gefunden' }, 404);
    c.header('Cache-Control', 'no-store');
    try {
      return c.json({ data: await slideData(ctx, row, displayId) });
    } catch (err) {
      return c.json({ error: `Daten nicht verfügbar: ${(err as Error).message}` }, 502);
    }
  });

  // --- Live video (live slides) --------------------------------------------------
  // WHEP signalling for the live gateway (live.ts): signed URL from the manifest,
  // then school networks (displays) or a session (admin previews), like slide data.
  // The SDP offer goes to the gateway with the slide's source; the media flows
  // directly from the gateway's WebRTC port to the display.
  app.post('/content/live/:id/:version/whep', async (c) => {
    const slideId = c.req.param('id');
    const version = Number(c.req.param('version'));
    const displayId = c.req.query('d') ?? '';
    if (!safeEqual(c.req.query('s') ?? '', liveSignature(ctx, slideId, version, displayId))) return c.text('Nicht erlaubt', 403);
    const isPreview = displayId === 'preview' || displayId.startsWith('preview:');
    const allowed = isPreview ? sessionUser(db, getCookie(c, SESSION_COOKIE)) : ipAllowed(c.get('clientIp'), ctx.playerNetworks);
    if (!allowed) return c.text('Nicht erlaubt', 403);
    const row = db.prepare('SELECT type, config_json, updated_at FROM slides WHERE id = ?').get(slideId) as
      | Pick<SlideRow, 'type' | 'config_json' | 'updated_at'>
      | undefined;
    const entry = row && registry.get(row.type);
    if (!row || row.updated_at !== version || !entry?.server.live) return c.text('Nicht gefunden', 404);
    if (!c.req.header('content-type')?.startsWith('application/sdp')) return c.text('SDP erwartet', 415);
    const offer = await c.req.text();
    if (!offer || offer.length > 64_000) return c.text('Ungültiges Angebot', 400);
    const input = entry.server.live(entry.definition.config.parse(JSON.parse(row.config_json)));
    if (!input || !ctx.live) return c.text('Keine Live-Quelle', 404);
    c.header('Cache-Control', 'no-store');
    try {
      const answer = await ctx.live.whep(input, offer);
      return c.body(answer, 201, { 'Content-Type': 'application/sdp' });
    } catch (err) {
      return c.text(`Live-Quelle nicht verfügbar: ${(err as Error).message}`, 502);
    }
  });

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
      mediaUrl: (mediaId) => signedMediaUrl(ctx, mediaId),
    });
    c.header('Content-Security-Policy', doc.csp);
    c.header('Cache-Control', 'no-store');
    return c.html(doc.html);
  });

  options.staticRoutes?.(app);
  return app;
}
