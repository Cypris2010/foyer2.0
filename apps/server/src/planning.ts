// Calendar entries and what they mean right now.
//
// Display level (scope "display"), in this order:
//   1. Any exclusive entry running → only the exclusive entries play (coupled).
//   2. Else scheduled channels replace the default channel; several running at
//      once are coupled (their slides play one after another).
//   3. Scheduled single slides are added to whatever channel content plays.
// Channel level (scope "channel"): a slide plays only while it has an entry.
import type { Db } from './db.ts';
import { expand, nextBoundary, type Occurrence, type ScheduleSpec } from './schedule-engine.ts';

export interface ScheduleRow {
  id: string;
  scope: 'display' | 'channel';
  channel_id: string | null;
  content_kind: 'channel' | 'slide';
  content_id: string;
  start_local: string;
  end_local: string | null;
  rrule: string | null;
  exdates_json: string;
  overrides_json: string;
  exclusive: number;
  updated_at: number;
}

export function specOf(row: ScheduleRow): ScheduleSpec {
  return {
    startLocal: row.start_local,
    endLocal: row.end_local,
    rrule: row.rrule,
    exdates: JSON.parse(row.exdates_json),
    overrides: JSON.parse(row.overrides_json),
  };
}

/** How far ahead "next change" is searched; players re-fetch at least that often anyway. */
const HORIZON_MS = 14 * 86400_000;

export function displaySchedules(db: Db, displayId: string): ScheduleRow[] {
  return db
    .prepare(
      `SELECT s.* FROM schedules s JOIN schedule_displays sd ON sd.schedule_id = s.id
       WHERE s.scope = 'display' AND sd.display_id = ?`,
    )
    .all(displayId) as unknown as ScheduleRow[];
}

export function channelSchedules(db: Db, channelId: string): ScheduleRow[] {
  return db.prepare("SELECT * FROM schedules WHERE scope = 'channel' AND channel_id = ?").all(channelId) as unknown as ScheduleRow[];
}

interface Running {
  row: ScheduleRow;
  occurrence: Occurrence;
}

function running(rows: ScheduleRow[], now: number, timeZone: string): { active: Running[]; nextChange: number | null } {
  const active: Running[] = [];
  let nextChange: number | null = null;
  for (const row of rows) {
    const occurrences = expand(specOf(row), now - 1, now + HORIZON_MS, timeZone);
    for (const occurrence of occurrences) {
      if (occurrence.startUtc <= now && (occurrence.endUtc === null || occurrence.endUtc > now)) active.push({ row, occurrence });
    }
    const boundary = nextBoundary(occurrences, now);
    if (boundary !== null && (nextChange === null || boundary < nextChange)) nextChange = boundary;
  }
  active.sort((a, b) => a.occurrence.startUtc - b.occurrence.startUtc);
  return { active, nextChange };
}

export interface DisplayContentItem {
  kind: 'channel' | 'slide';
  id: string;
}

export interface DisplayContent {
  source: 'default' | 'scheduled' | 'exclusive';
  items: DisplayContentItem[];
  nextChange: number | null;
}

export function displayContent(db: Db, displayId: string, defaultChannelId: string | null, now: number, timeZone: string): DisplayContent {
  const { active, nextChange } = running(displaySchedules(db, displayId), now, timeZone);
  const item = (r: Running): DisplayContentItem => ({ kind: r.row.content_kind, id: r.row.content_id });
  const exclusive = active.filter((r) => r.row.exclusive === 1);
  if (exclusive.length) return { source: 'exclusive', items: exclusive.map(item), nextChange };

  const channels = active.filter((r) => r.row.content_kind === 'channel').map(item);
  const slides = active.filter((r) => r.row.content_kind === 'slide').map(item);
  const base = channels.length ? channels : defaultChannelId ? [{ kind: 'channel' as const, id: defaultChannelId }] : [];
  return { source: channels.length || slides.length ? 'scheduled' : 'default', items: [...base, ...slides], nextChange };
}

export function activeChannelSlides(db: Db, channelId: string, now: number, timeZone: string): { slideIds: Set<string>; nextChange: number | null } {
  const { active, nextChange } = running(channelSchedules(db, channelId), now, timeZone);
  return { slideIds: new Set(active.map((r) => r.row.content_id)), nextChange };
}

export function minTime(...values: Array<number | null>): number | null {
  let min: number | null = null;
  for (const v of values) if (v !== null && (min === null || v < min)) min = v;
  return min;
}
