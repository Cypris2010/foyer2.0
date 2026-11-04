// Calendar API for the admin: display calendar (channels or single slides on
// displays) and channel calendars (when a slide plays inside its channel).
import type { Hono, MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AppContext } from './context.ts';
import type { AuthEnv } from './auth.ts';
import { audit, transaction } from './db.ts';
import { expand, isLocalDateTime, localToUtc, validateSpec, type Occurrence } from './schedule-engine.ts';
import { specOf, type ScheduleRow } from './planning.ts';

const local = z.string().refine(isLocalDateTime, 'Zeit im Format JJJJ-MM-TTTHH:MM erwartet');

const scheduleBody = z.object({
  scope: z.enum(['display', 'channel']),
  channelId: z.string().nullable().default(null),
  contentKind: z.enum(['channel', 'slide']),
  contentId: z.string().min(1),
  displayIds: z.array(z.string()).max(200).default([]),
  start: local,
  end: local.nullable(),
  rrule: z.string().max(500).nullable().default(null),
  exclusive: z.boolean().default(false),
});

const occurrenceBody = z.object({ start: local, end: local });

type ScheduleBody = z.infer<typeof scheduleBody>;

export function registerScheduleRoutes(admin: Hono<AuthEnv>, ctx: AppContext, editor: MiddlewareHandler<AuthEnv>) {
  const { db, events } = ctx;
  const changed = () => events.broadcast('manifest-changed');

  const displaysOf = (scheduleId: string) =>
    (db.prepare('SELECT display_id FROM schedule_displays WHERE schedule_id = ?').all(scheduleId) as Array<{ display_id: string }>).map((r) => r.display_id);

  const titleOf = (kind: 'channel' | 'slide', contentId: string): string => {
    const row =
      kind === 'channel'
        ? (db.prepare('SELECT name AS title FROM channels WHERE id = ?').get(contentId) as { title: string } | undefined)
        : (db.prepare('SELECT title FROM slides WHERE id = ?').get(contentId) as { title: string } | undefined);
    return row?.title ?? '(gelöscht)';
  };

  const scheduleOut = (row: ScheduleRow) => ({
    id: row.id,
    scope: row.scope,
    channelId: row.channel_id,
    contentKind: row.content_kind,
    contentId: row.content_id,
    title: titleOf(row.content_kind, row.content_id),
    displayIds: row.scope === 'display' ? displaysOf(row.id) : [],
    start: row.start_local,
    end: row.end_local,
    rrule: row.rrule,
    exdates: JSON.parse(row.exdates_json),
    overrides: JSON.parse(row.overrides_json),
    exclusive: row.exclusive === 1,
  });

  /** Checks references; returns an error message or null. */
  const checkBody = (b: ScheduleBody): string | null => {
    const spec = validateSpec({ startLocal: b.start, endLocal: b.end, rrule: b.rrule, exdates: [], overrides: {} });
    if (spec) return spec;
    const exists = (table: 'channels' | 'slides' | 'displays', value: string) => Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(value));
    if (!exists(b.contentKind === 'channel' ? 'channels' : 'slides', b.contentId)) return 'Inhalt nicht gefunden';
    if (b.scope === 'display') {
      if (!b.displayIds.length) return 'Bitte mindestens ein Display wählen';
      if (!b.displayIds.every((d) => exists('displays', d))) return 'Display nicht gefunden';
    } else {
      if (b.contentKind !== 'slide') return 'Im Channel-Kalender werden Folien geplant';
      if (!b.channelId || !exists('channels', b.channelId)) return 'Channel nicht gefunden';
    }
    return null;
  };

  const writeDisplays = (scheduleId: string, b: ScheduleBody) => {
    db.prepare('DELETE FROM schedule_displays WHERE schedule_id = ?').run(scheduleId);
    if (b.scope !== 'display') return;
    const insert = db.prepare('INSERT INTO schedule_displays (schedule_id, display_id) VALUES (?, ?)');
    for (const displayId of new Set(b.displayIds)) insert.run(scheduleId, displayId);
  };

  /** Planning a slide in a channel also puts it into the channel's slide list. */
  const ensureInChannel = (b: ScheduleBody) => {
    if (b.scope !== 'channel' || !b.channelId) return;
    if (db.prepare('SELECT 1 FROM channel_slides WHERE channel_id = ? AND slide_id = ?').get(b.channelId, b.contentId)) return;
    const next = (db.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM channel_slides WHERE channel_id = ?').get(b.channelId) as { p: number }).p;
    db.prepare('INSERT INTO channel_slides (channel_id, slide_id, position) VALUES (?, ?, ?)').run(b.channelId, b.contentId, next);
  };

  const loadRow = (scheduleId: string) => db.prepare('SELECT * FROM schedules WHERE id = ?').get(scheduleId) as ScheduleRow | undefined;

  // Occurrences for the calendar view. from/to are school wall times.
  admin.get('/schedules', (c) => {
    const scope = c.req.query('scope');
    const from = c.req.query('from') ?? '';
    const to = c.req.query('to') ?? '';
    if (!isLocalDateTime(from) || !isLocalDateTime(to)) return c.json({ error: 'from/to fehlen' }, 400);
    let rows: ScheduleRow[];
    if (scope === 'display') {
      rows = db.prepare("SELECT * FROM schedules WHERE scope = 'display'").all() as unknown as ScheduleRow[];
    } else if (scope === 'channel') {
      rows = db.prepare("SELECT * FROM schedules WHERE scope = 'channel' AND channel_id = ?").all(c.req.query('channelId') ?? '') as unknown as ScheduleRow[];
    } else {
      return c.json({ error: 'scope fehlt' }, 400);
    }
    const fromUtc = localToUtc(from, ctx.timeZone);
    const toUtc = localToUtc(to, ctx.timeZone);
    const filter = (c.req.query('displayIds') ?? '').split(',').filter(Boolean);

    const out: Array<ReturnType<typeof scheduleOut> & { occId: string; occStart: string; occEnd: string | null; overlaps: boolean; occ: Occurrence }> = [];
    for (const row of rows) {
      const base = scheduleOut(row);
      if (filter.length && !base.displayIds.some((d) => filter.includes(d))) continue;
      for (const occ of expand(specOf(row), fromUtc, toUtc, ctx.timeZone)) {
        out.push({ ...base, occId: occ.occId, occStart: occ.startLocal, occEnd: occ.endLocal, overlaps: false, occ });
      }
    }
    // Mark overlapping channel entries on the same display: they will be coupled.
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i];
        const b = out[j];
        if (a.scope !== 'display' || a.contentKind !== 'channel' || b.contentKind !== 'channel') continue;
        if (!a.displayIds.some((d) => b.displayIds.includes(d))) continue;
        const aEnd = a.occ.endUtc ?? Infinity;
        const bEnd = b.occ.endUtc ?? Infinity;
        if (a.occ.startUtc < bEnd && b.occ.startUtc < aEnd) a.overlaps = b.overlaps = true;
      }
    }
    return c.json(out.map(({ occ: _occ, ...rest }) => rest));
  });

  admin.get('/schedules/:id', (c) => {
    const row = loadRow(c.req.param('id'));
    return row ? c.json(scheduleOut(row)) : c.json({ error: 'Nicht gefunden' }, 404);
  });

  admin.post('/schedules', editor, async (c) => {
    const parsed = scheduleBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Ungültige Eingabe', issues: parsed.error.issues }, 400);
    const b = parsed.data;
    const problem = checkBody(b);
    if (problem) return c.json({ error: problem }, 400);
    const scheduleId = crypto.randomUUID();
    const now = ctx.now();
    transaction(db, () => {
      db.prepare(
        `INSERT INTO schedules (id, scope, channel_id, content_kind, content_id, start_local, end_local, rrule, exclusive, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(scheduleId, b.scope, b.scope === 'channel' ? b.channelId : null, b.contentKind, b.contentId, b.start, b.end, b.rrule, b.exclusive ? 1 : 0, now, now);
      writeDisplays(scheduleId, b);
      ensureInChannel(b);
    });
    audit(db, c.get('user').id, 'create', 'schedule', scheduleId, b);
    changed();
    return c.json({ id: scheduleId }, 201);
  });

  // Edits the whole entry or series. Changing start or rule resets per-occurrence changes.
  admin.put('/schedules/:id', editor, async (c) => {
    const row = loadRow(c.req.param('id'));
    if (!row) return c.json({ error: 'Nicht gefunden' }, 404);
    const parsed = scheduleBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Ungültige Eingabe', issues: parsed.error.issues }, 400);
    const b = { ...parsed.data, scope: row.scope, channelId: row.channel_id };
    const problem = checkBody(b);
    if (problem) return c.json({ error: problem }, 400);
    const keepExceptions = row.start_local === b.start && (row.rrule ?? null) === b.rrule;
    transaction(db, () => {
      db.prepare(
        `UPDATE schedules SET content_kind = ?, content_id = ?, start_local = ?, end_local = ?, rrule = ?, exclusive = ?,
           exdates_json = ?, overrides_json = ?, updated_at = ? WHERE id = ?`,
      ).run(
        b.contentKind, b.contentId, b.start, b.end, b.rrule, b.exclusive ? 1 : 0,
        keepExceptions ? row.exdates_json : '[]', keepExceptions ? row.overrides_json : '{}', ctx.now(), row.id,
      );
      writeDisplays(row.id, b);
      ensureInChannel(b);
    });
    audit(db, c.get('user').id, 'update', 'schedule', row.id, b);
    changed();
    return c.json({ ok: true });
  });

  // Moves/resizes one occurrence (drag & drop). Single entries change directly.
  admin.patch('/schedules/:id/occurrences/:occId', editor, async (c) => {
    const row = loadRow(c.req.param('id'));
    if (!row) return c.json({ error: 'Nicht gefunden' }, 404);
    const parsed = occurrenceBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Ungültige Eingabe', issues: parsed.error.issues }, 400);
    const { start, end } = parsed.data;
    const problem = validateSpec({ startLocal: start, endLocal: end, rrule: null, exdates: [], overrides: {} });
    if (problem) return c.json({ error: problem }, 400);
    if (!row.rrule) {
      db.prepare('UPDATE schedules SET start_local = ?, end_local = ?, updated_at = ? WHERE id = ?').run(start, end, ctx.now(), row.id);
    } else {
      const overrides = JSON.parse(row.overrides_json);
      overrides[c.req.param('occId')] = { startLocal: start, endLocal: end };
      db.prepare('UPDATE schedules SET overrides_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(overrides), ctx.now(), row.id);
    }
    audit(db, c.get('user').id, 'move-occurrence', 'schedule', row.id, { occId: c.req.param('occId'), start, end });
    changed();
    return c.json({ ok: true });
  });

  // Deletes one occurrence of a series (or the whole single entry).
  admin.delete('/schedules/:id/occurrences/:occId', editor, (c) => {
    const row = loadRow(c.req.param('id'));
    if (!row) return c.json({ error: 'Nicht gefunden' }, 404);
    if (!row.rrule) {
      db.prepare('DELETE FROM schedules WHERE id = ?').run(row.id);
    } else {
      const exdates: string[] = JSON.parse(row.exdates_json);
      if (!exdates.includes(c.req.param('occId'))) exdates.push(c.req.param('occId'));
      db.prepare('UPDATE schedules SET exdates_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(exdates), ctx.now(), row.id);
    }
    audit(db, c.get('user').id, 'delete-occurrence', 'schedule', row.id, { occId: c.req.param('occId') });
    changed();
    return c.json({ ok: true });
  });

  admin.delete('/schedules/:id', editor, (c) => {
    const result = db.prepare('DELETE FROM schedules WHERE id = ?').run(c.req.param('id'));
    if (!result.changes) return c.json({ error: 'Nicht gefunden' }, 404);
    audit(db, c.get('user').id, 'delete', 'schedule', c.req.param('id'));
    changed();
    return c.json({ ok: true });
  });
}
