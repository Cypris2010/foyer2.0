// Central connections to outside services, set by admins in the settings page.
//
// WebUntis-Datendienst: address and key are stored once in the settings table
// and used by every Untis slide. The key is encrypted with the token key (it
// lives outside the database, keys.ts) and never sent back to a browser.
import type { Hono, MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { ServerContext } from '@foyer/slide-sdk';
import type { AppContext } from './context.ts';
import type { AuthEnv } from './auth.ts';
import { audit, getSetting, setSetting } from './db.ts';
import { decrypt, encrypt } from './crypto.ts';
import { ApiSource, localNow } from '../../../slide-types/_untis/api.ts';

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

/** What slide servers get to see. */
export function slideServerContext(ctx: AppContext, displayId?: string): ServerContext {
  return { displayId, locale: ctx.locale, timeZone: ctx.timeZone, untisApi: untisApiSettings(ctx) };
}

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
