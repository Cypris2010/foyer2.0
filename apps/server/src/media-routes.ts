// Admin API of the media library. Files are served by app.ts (/media/<file>).
// Also search and import from image databases (media-sources.ts).
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AppContext } from './context.ts';
import type { AuthEnv } from './auth.ts';
import { audit } from './db.ts';
import { hmac, safeEqual } from './crypto.ts';
import { cleanName, creditText, MediaError, mediaUrl, type MediaRow, type MediaSource, type MediaVariant } from './media.ts';
import { cachedSearch, PROVIDERS, provider, safeFetch, SourceError } from './media-sources.ts';
import { mediaSourceKey } from './integrations.ts';

const patchBody = z
  .object({ name: z.string().min(1).max(200).optional(), showCredit: z.boolean().optional() })
  .refine((b) => b.name !== undefined || b.showCredit !== undefined, 'Name oder Bildnachweis angeben');
const kind = z.enum(['image', 'video']);
const searchQuery = z.object({
  q: z.string().trim().min(1, 'Suchbegriff fehlt').max(100),
  kind: kind.default('image'),
  page: z.coerce.number().int().min(1).max(50).default(1),
});
const importBody = z.object({ source: z.string().max(40), id: z.string().min(1).max(300), kind });

const THUMB_MAX_BYTES = 5 * 1048576;
// Downloads of large videos may take a while; the admin shows a spinner.
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

/** Preview of a search hit through this server; signed, so it fetches only URLs a database gave us. */
const thumbSignature = (ctx: AppContext, url: string) => hmac(ctx.secret, `source-thumb:${url}`);
const thumbUrl = (ctx: AppContext, url: string) => `/api/media-sources/thumb?${new URLSearchParams({ u: url, s: thumbSignature(ctx, url) })}`;

/** Items imported from one database, by the database's id. */
function importedIds(ctx: AppContext, providerId: string): Map<string, string> {
  const rows = ctx.db
    .prepare("SELECT id, json_extract(source_json, '$.id') AS source_id FROM media WHERE source_json IS NOT NULL AND json_extract(source_json, '$.provider') = ?")
    .all(providerId) as Array<{ id: string; source_id: string }>;
  return new Map(rows.map((r) => [r.source_id, r.id]));
}

const sourceError = (c: Context, err: unknown) => {
  if (err instanceof SourceError || err instanceof MediaError) return c.json({ error: err.message }, err.status);
  throw err;
};

/** Slides that reference a media item (background or a media field in the config). */
export function mediaUsage(ctx: AppContext, mediaId: string): Array<{ id: string; title: string }> {
  const pattern = `%"${mediaId}"%`;
  return ctx.db
    .prepare('SELECT id, title FROM slides WHERE background_json LIKE ? OR config_json LIKE ? ORDER BY title')
    .all(pattern, pattern) as Array<{ id: string; title: string }>;
}

export function mediaOut(ctx: AppContext, row: MediaRow, usageCount?: number) {
  const variants = JSON.parse(row.variants_json) as Record<string, MediaVariant>;
  const source = row.source_json ? (JSON.parse(row.source_json) as MediaSource) : null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    status: row.status,
    error: row.error,
    progress: row.status === 'processing' ? (ctx.media.progress.get(row.id) ?? 0) : null,
    size: row.size,
    width: row.width,
    height: row.height,
    duration: row.duration_s,
    url: variants.main ? mediaUrl(variants.main.file) : null,
    poster: row.poster ? mediaUrl(row.poster) : null,
    thumb: row.thumb ? mediaUrl(row.thumb) : null,
    variants: Object.fromEntries(Object.entries(variants).map(([key, v]) => [key, { url: mediaUrl(v.file), width: v.width, height: v.height }])),
    source,
    showCredit: !!row.show_credit,
    credit: source ? creditText(row.kind, source) : null,
    createdAt: row.created_at,
    usageCount: usageCount ?? mediaUsage(ctx, row.id).length,
  };
}

export function registerMediaRoutes(admin: Hono<AuthEnv>, ctx: AppContext, editor: MiddlewareHandler) {
  const { db, media } = ctx;

  admin.get('/media', (c) => {
    const kind = c.req.query('kind');
    const rows = (
      kind === 'image' || kind === 'video'
        ? db.prepare('SELECT * FROM media WHERE kind = ? ORDER BY created_at DESC').all(kind)
        : db.prepare('SELECT * FROM media ORDER BY created_at DESC').all()
    ) as unknown as MediaRow[];
    // One pass over the slides instead of one query per item.
    const slides = db.prepare('SELECT background_json, config_json FROM slides').all() as Array<{ background_json: string | null; config_json: string }>;
    const used = (id: string) => slides.filter((s) => (s.background_json ?? '').includes(`"${id}"`) || s.config_json.includes(`"${id}"`)).length;
    return c.json(rows.map((row) => mediaOut(ctx, row, used(row.id))));
  });

  admin.get('/media/:id', (c) => {
    const row = media.get(c.req.param('id'));
    if (!row) return c.json({ error: 'Nicht gefunden' }, 404);
    return c.json({ ...mediaOut(ctx, row), usage: mediaUsage(ctx, row.id) });
  });

  // Raw upload: the file is the request body, its name in ?name=. Lets the admin
  // show upload progress and streams large videos to disk without buffering.
  admin.post('/media', editor, async (c: Context<AuthEnv>) => {
    const length = Number(c.req.header('content-length') ?? 0);
    if (length > media.maxBytes) return c.json({ error: `Datei ist größer als ${Math.round(media.maxBytes / 1048576)} MB` }, 413);
    const body = c.req.raw.body;
    if (!body) return c.json({ error: 'Leere Datei' }, 400);
    try {
      const { row, existing } = await media.ingest(body, c.req.query('name'), c.get('user').id);
      if (!existing) audit(db, c.get('user').id, 'upload', 'media', row.id, { name: row.name, kind: row.kind, size: row.size });
      return c.json({ ...mediaOut(ctx, row), existing }, existing ? 200 : 201);
    } catch (err) {
      if (err instanceof MediaError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  admin.patch('/media/:id', editor, async (c) => {
    const body = patchBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Ungültige Eingabe', issues: body.error.issues }, 400);
    const row = media.get(c.req.param('id'));
    if (!row) return c.json({ error: 'Nicht gefunden' }, 404);
    const { name, showCredit } = body.data;
    if (showCredit !== undefined && !row.source_json) return c.json({ error: 'Nur übernommene Medien haben einen Bildnachweis' }, 400);
    db.prepare('UPDATE media SET name = ?, show_credit = ?, updated_at = ? WHERE id = ?').run(
      name !== undefined ? cleanName(name) : row.name,
      showCredit !== undefined ? Number(showCredit) : row.show_credit,
      ctx.now(),
      row.id,
    );
    audit(db, c.get('user').id, 'update', 'media', row.id, body.data);
    // The credit line is part of the slides in the manifest.
    if (showCredit !== undefined && showCredit !== !!row.show_credit) ctx.events.broadcast('manifest-changed');
    return c.json({ ok: true });
  });

  // --- Image databases ----------------------------------------------------------

  admin.get('/media-sources', (c) =>
    c.json(
      PROVIDERS.map((p) => ({
        id: p.id,
        name: p.name,
        kinds: p.kinds,
        terms: p.terms,
        homepage: p.homepage,
        needsKey: !!p.key,
        ready: !p.key || !!mediaSourceKey(ctx, p.id),
      })),
    ),
  );

  admin.get('/media-sources/:id/search', editor, async (c) => {
    const p = provider(c.req.param('id'));
    if (!p) return c.json({ error: 'Unbekannte Bilddatenbank' }, 404);
    const query = searchQuery.safeParse(c.req.query());
    if (!query.success) return c.json({ error: query.error.issues[0]?.message ?? 'Ungültige Suche' }, 400);
    const { q, kind, page } = query.data;
    if (!p.kinds.includes(kind)) return c.json({ error: `${p.name} liefert keine ${kind === 'video' ? 'Videos' : 'Bilder'}` }, 400);
    try {
      const result = await cachedSearch(p, q, kind, page, mediaSourceKey(ctx, p.id), ctx.now());
      const imported = importedIds(ctx, p.id);
      return c.json({
        ...result,
        hits: result.hits.map((hit) => ({ ...hit, thumb: thumbUrl(ctx, hit.thumb), mediaId: imported.get(hit.id) ?? null })),
      });
    } catch (err) {
      return sourceError(c, err);
    }
  });

  admin.get('/media-sources/thumb', async (c) => {
    const url = c.req.query('u') ?? '';
    if (!url || !safeEqual(c.req.query('s') ?? '', thumbSignature(ctx, url))) return c.json({ error: 'Ungültige Signatur' }, 403);
    try {
      // Openverse answers a bare image/* with 406.
      const res = await safeFetch(url, { headers: { Accept: 'image/*,*/*;q=0.8' } });
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || !type.startsWith('image/') || type.includes('svg')) return c.body(null, 502);
      if (Number(res.headers.get('content-length') ?? 0) > THUMB_MAX_BYTES) return c.body(null, 502);
      const data = await res.arrayBuffer();
      if (data.byteLength > THUMB_MAX_BYTES) return c.body(null, 502);
      return c.body(data, 200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=86400' });
    } catch (err) {
      if (err instanceof SourceError) return c.body(null, 502);
      throw err;
    }
  });

  // Downloads a hit and stores it like an upload: converted, with thumbnail and credit.
  admin.post('/media/import', editor, async (c: Context<AuthEnv>) => {
    const body = importBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Ungültige Eingabe', issues: body.error.issues }, 400);
    const p = provider(body.data.source);
    if (!p || !p.kinds.includes(body.data.kind)) return c.json({ error: 'Unbekannte Bilddatenbank' }, 404);
    const known = importedIds(ctx, p.id).get(body.data.id);
    const row = known ? media.get(known) : undefined;
    if (row) return c.json({ ...mediaOut(ctx, row), existing: true });
    try {
      const resolved = await p.resolve(body.data.id, body.data.kind, mediaSourceKey(ctx, p.id));
      const res = await safeFetch(resolved.download, {}, DOWNLOAD_TIMEOUT_MS);
      if (!res.ok || !res.body) throw new SourceError(502, `${p.name}: Download fehlgeschlagen (HTTP ${res.status})`);
      if (Number(res.headers.get('content-length') ?? 0) > media.maxBytes) {
        throw new MediaError(413, `Datei ist größer als ${Math.round(media.maxBytes / 1048576)} MB`);
      }
      const { row, existing } = await media.ingest(res.body, resolved.name, c.get('user').id, resolved.source);
      if (!existing) audit(db, c.get('user').id, 'import', 'media', row.id, { name: row.name, kind: row.kind, size: row.size, source: p.id, sourceId: body.data.id });
      return c.json({ ...mediaOut(ctx, row), existing }, existing ? 200 : 201);
    } catch (err) {
      return sourceError(c, err);
    }
  });

  admin.post('/media/:id/retry', editor, (c) => {
    const row = media.get(c.req.param('id'));
    if (!row) return c.json({ error: 'Nicht gefunden' }, 404);
    if (row.status !== 'failed') return c.json({ error: 'Nur fehlgeschlagene Dateien können neu verarbeitet werden' }, 409);
    db.prepare("UPDATE media SET status = 'queued', error = NULL, updated_at = ? WHERE id = ?").run(ctx.now(), row.id);
    media.enqueue(row.id);
    return c.json({ ok: true });
  });

  admin.delete('/media/:id', editor, async (c) => {
    const usage = mediaUsage(ctx, c.req.param('id'));
    if (usage.length) {
      return c.json({ error: `Wird noch verwendet in: ${usage.map((s) => `„${s.title}“`).join(', ')}`, usage }, 409);
    }
    const row = media.get(c.req.param('id'));
    if (!row) return c.json({ error: 'Nicht gefunden' }, 404);
    await media.remove(row.id);
    audit(db, c.get('user').id, 'delete', 'media', row.id, { name: row.name });
    return c.json({ ok: true });
  });
}
