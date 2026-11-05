// Central connections to outside services, set by admins in the settings page.
//
// WebUntis-Datendienst: address and key are stored once in the settings table
// and used by every Untis slide. The key is encrypted with the token key (it
// lives outside the database, keys.ts) and never sent back to a browser.
// Image databases (media-sources.ts): the keys of those that need one, the same way.
import type { Hono, MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { ServerContext } from '@foyer/slide-sdk';
import type { AppContext } from './context.ts';
import type { AuthEnv } from './auth.ts';
import { audit, getSetting, setSetting } from './db.ts';
import { decrypt, encrypt } from './crypto.ts';
import { ApiSource, localNow } from '../../../slide-types/_untis/api.ts';
import { clearSourceCache, provider, PROVIDERS } from './media-sources.ts';

const URL_KEY = 'untis_api_url';
const SECRET_KEY = 'untis_api_key';

export function untisApiSettings(ctx: AppContext): { url: string; key: string } | null {
  const url = getSetting(ctx.db, URL_KEY);
  const sealed = getSetting(ctx.db, SECRET_KEY);
  if (!url || !sealed) return null;
  try {
    return { url, key: decrypt(ctx.tokenKey, sealed) };
  } catch {
    // Token key replaced: the key has to be entered again.
    return null;
  }
}

const sourceSetting = (id: string) => `media_source_${id}_key`;

/** Decrypted key of an image database; null when none is stored or it is unreadable. */
export function mediaSourceKey(ctx: AppContext, id: string): string | null {
  const sealed = getSetting(ctx.db, sourceSetting(id));
  if (!sealed) return null;
  try {
    return decrypt(ctx.tokenKey, sealed);
  } catch {
    return null;
  }
}

/** What slide servers get to see. */
export function slideServerContext(ctx: AppContext, displayId?: string): ServerContext {
  return { displayId, locale: ctx.locale, timeZone: ctx.timeZone, untisApi: untisApiSettings(ctx) };
}

const sourceKeyBody = z.object({ key: z.string().trim().max(500) });

const untisBody = z.object({
  url: z.union([z.url({ protocol: /^https?$/ }), z.literal('')]),
  // Absent: keep the stored key; empty: remove it.
  key: z.string().trim().max(500).optional(),
});

/** Shows a stored key only by its end, enough to tell keys apart. */
const hint = (key: string) => (key.length > 8 ? `…${key.slice(-4)}` : '…');

export function registerIntegrationRoutes(admin: Hono<AuthEnv>, ctx: AppContext, adminOnly: MiddlewareHandler<AuthEnv>) {
  const { db } = ctx;

  const untisState = () => {
    const sealed = getSetting(db, SECRET_KEY);
    const settings = untisApiSettings(ctx);
    return {
      url: getSetting(db, URL_KEY) ?? '',
      keySet: !!settings,
      keyHint: settings ? hint(settings.key) : null,
      // Stored but unreadable (token key changed).
      keyUnreadable: !!sealed && !settings,
    };
  };

  admin.get('/settings/untis-api', adminOnly, (c) => c.json(untisState()));

  admin.put('/settings/untis-api', adminOnly, async (c) => {
    const body = untisBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Ungültige Eingabe', issues: body.error.issues }, 400);
    setSetting(db, URL_KEY, body.data.url.replace(/\/+$/, ''));
    if (body.data.key !== undefined) setSetting(db, SECRET_KEY, body.data.key ? encrypt(ctx.tokenKey, body.data.key) : '');
    // Never the key itself in the audit log.
    audit(db, c.get('user').id, 'update', 'settings', 'untis-api', { url: body.data.url, keyChanged: body.data.key !== undefined });
    // Slides pick the new connection up with their next refresh.
    ctx.events.broadcast('manifest-changed');
    return c.json(untisState());
  });

  const sourceState = () =>
    PROVIDERS.map((p) => {
      const sealed = getSetting(db, sourceSetting(p.id));
      const key = mediaSourceKey(ctx, p.id);
      return {
        id: p.id,
        name: p.name,
        kinds: p.kinds,
        terms: p.terms,
        homepage: p.homepage,
        needsKey: !!p.key,
        signup: p.key?.signup ?? null,
        placeholder: p.key?.placeholder ?? null,
        keySet: !!key,
        keyHint: key ? hint(key) : null,
        keyUnreadable: !!sealed && !key,
      };
    });

  admin.get('/settings/media-sources', adminOnly, (c) => c.json(sourceState()));

  // Empty key: remove it.
  admin.put('/settings/media-sources/:id', adminOnly, async (c) => {
    const p = provider(c.req.param('id'));
    if (!p?.key) return c.json({ error: 'Diese Bilddatenbank braucht keinen Schlüssel' }, 404);
    const body = sourceKeyBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Ungültige Eingabe', issues: body.error.issues }, 400);
    setSetting(db, sourceSetting(p.id), body.data.key ? encrypt(ctx.tokenKey, body.data.key) : '');
    clearSourceCache();
    audit(db, c.get('user').id, 'update', 'settings', `media-source:${p.id}`, { keySet: !!body.data.key });
    return c.json(sourceState());
  });

  // One small search: reachable and key accepted.
  admin.post('/settings/media-sources/:id/test', adminOnly, async (c) => {
    const p = provider(c.req.param('id'));
    if (!p) return c.json({ error: 'Unbekannte Bilddatenbank' }, 404);
    const key = mediaSourceKey(ctx, p.id);
    if (p.key && !key) return c.json({ error: 'Schlüssel zuerst speichern' }, 400);
    try {
      const result = await p.search('Schule', p.kinds[0], 1, key);
      // Commons gives no total: then the first page, marked as "more".
      return c.json({ ok: true, count: result.total ?? result.hits.length, more: result.total === null && result.hasMore });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message });
    }
  });

  // Checks the stored connection: reachable, key valid, which scopes work.
  admin.post('/settings/untis-api/test', adminOnly, async (c) => {
    const settings = untisApiSettings(ctx);
    if (!settings?.url) return c.json({ error: 'Adresse und Schlüssel zuerst speichern' }, 400);
    const source = new ApiSource(settings.url, settings.key);
    const check = async (run: () => Promise<number>) => {
      try {
        return { ok: true, count: await run() };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    };
    const today = localNow(ctx.timeZone).slice(0, 10);
    const [lessons, rooms, teachers] = await Promise.all([
      check(async () => (await source.load(today, 0)).lessons.length),
      check(async () => (await source.rooms(0)).length),
      check(async () => (await source.teachers(0)).length),
    ]);
    return c.json({ lessons, rooms, teachers });
  });
}
