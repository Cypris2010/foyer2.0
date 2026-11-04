// Admin API of the media library. Files are served by app.ts (/media/<file>).
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AppContext } from './context.ts';
import type { AuthEnv } from './auth.ts';
import { audit } from './db.ts';
import { cleanName, MediaError, mediaUrl, type MediaRow, type MediaVariant } from './media.ts';

const patchBody = z.object({ name: z.string().min(1).max(200) });

/** Slides that reference a media item (background or a media field in the config). */
export function mediaUsage(ctx: AppContext, mediaId: string): Array<{ id: string; title: string }> {
  const pattern = `%"${mediaId}"%`;
  return ctx.db
    .prepare('SELECT id, title FROM slides WHERE background_json LIKE ? OR config_json LIKE ? ORDER BY title')
    .all(pattern, pattern) as Array<{ id: string; title: string }>;
}

export function mediaOut(ctx: AppContext, row: MediaRow, usageCount?: number) {
  const variants = JSON.parse(row.variants_json) as Record<string, MediaVariant>;
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
    const result = db.prepare('UPDATE media SET name = ?, updated_at = ? WHERE id = ?').run(cleanName(body.data.name), ctx.now(), c.req.param('id'));
    if (!result.changes) return c.json({ error: 'Nicht gefunden' }, 404);
    audit(db, c.get('user').id, 'update', 'media', c.req.param('id'), body.data);
    return c.json({ ok: true });
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
