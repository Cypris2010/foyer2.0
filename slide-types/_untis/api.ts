// WebUntis-Datendienst (https://webuntis-api.lgsit.de/docs) as an Untis source.
//
// The API delivers lessons as JSON; this module turns them into the rows of the
// old TXT exports, so the ported renderers stay unchanged:
//   - room view: every lesson of the day under each of its rooms (raeume_ganzer_tag.txt),
//   - teacher view: per teacher the current or next lesson(s), else NoData/Gone (lehrer.txt).
//
// Address and key are set once in the admin settings (apps/server/src/integrations.ts)
// and reach the slide servers as ctx.untisApi, never through a slide's config.
// The key needs the scope "stundenplan"; with "stammdaten" the teacher list also
// contains teachers without lessons today.
// Like the TXT source, lessons are kept in memory only.

import { UntisError, type UntisLesson } from './source.ts';

/** A lesson as /v1/stunden returns it (only the fields used here). */
export interface ApiLesson {
  datum: string;
  beginn: string;
  ende: string | null;
  klassen: { name: string }[];
  lehrkraefte: { kuerzel: string }[];
  lehrkraefte_original: { kuerzel: string }[];
  faecher: { kuerzel: string }[];
  raeume: { name: string }[];
  raeume_original: { name: string }[];
  status: 'regulaer' | 'entfall' | 'geaendert';
  art: 'unterricht' | 'aufsicht' | 'bereitschaft' | 'sprechstunde' | 'pruefung' | 'sonstiges';
  text: string | null;
}

export interface ApiDay {
  /** Local date, YYYY-MM-DD. */
  date: string;
  lessons: ApiLesson[];
  /** Last import of the lessons (/v1/stunden/stand), else the fetch time; ISO. */
  lastModified: string | null;
}

const FETCH_TIMEOUT_MS = 10_000;
// A whole school day as JSON is larger than the TXT exports.
const MAX_BYTES = 20 * 1048576;
const STALE_MS = 60 * 60_000;

// Status and type in the words of the TXT export, which the renderers check.
const STATUS: Record<ApiLesson['status'], string> = { regulaer: 'None', entfall: 'cancelled', geaendert: 'irregular' };
const TYPE: Record<ApiLesson['art'], string> = {
  unterricht: 'Unterricht',
  aufsicht: 'Aufsicht',
  bereitschaft: 'Bereitschaft',
  sprechstunde: 'Sprechstunde',
  pruefung: 'Prüfung',
  sonstiges: 'Sonstiges',
};
// Duties without a class do not occupy a room.
const NOT_IN_ROOM_VIEW = new Set<ApiLesson['art']>(['aufsicht', 'bereitschaft']);

const time = (value: string) => (value.length === 5 ? `${value}:00` : value.slice(0, 8));

/** "Now" as local "YYYY-MM-DD HH:MM:SS", comparable with the rows' start/end. */
export function localNow(timeZone: string, now = Date.now()): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(now);
}

/** Current and original value in the export's notation: "+A 1.17(D 1.16)". */
function changed(current: string[], original: string[]): string {
  if (!original.length) return current.join(',');
  return `+${current.join(',')}(${original.join(',')})`;
}

/** One row of the export, keyed by a room or teacher. */
function toLesson(key: string, l: ApiLesson): UntisLesson {
  return {
    key,
    start: `${l.datum} ${time(l.beginn)}`,
    end: l.ende ? `${l.datum} ${time(l.ende)}` : '',
    rooms: changed(l.raeume.map((r) => r.name), l.raeume_original.map((r) => r.name)),
    teachers: changed(l.lehrkraefte.map((t) => t.kuerzel), l.lehrkraefte_original.map((t) => t.kuerzel)),
    classes: l.klassen.map((k) => k.name).join(','),
    subject: l.faecher.map((f) => f.kuerzel).join('/'),
    status: STATUS[l.status] ?? 'None',
    type: TYPE[l.art] ?? '',
    substitutionText: l.text?.trim() ?? '',
    // The API has no room bookings.
    bookingText: '',
  };
}

const noLesson = (key: string, status: 'NoData' | 'Gone'): UntisLesson => ({
  key,
  start: '-',
  end: '-',
  rooms: '-',
  teachers: '-',
  classes: '-',
  subject: '-',
  status,
  type: '-',
  substitutionText: '-',
  bookingText: '',
});

/** Rows of raeume_ganzer_tag.txt: each lesson under its rooms and, like the export, its original rooms. */
export function roomLessons(lessons: ApiLesson[]): UntisLesson[] {
  const rows: UntisLesson[] = [];
  for (const lesson of lessons) {
    if (NOT_IN_ROOM_VIEW.has(lesson.art)) continue;
    const rooms = new Set([...lesson.raeume, ...lesson.raeume_original].map((r) => r.name.trim()).filter(Boolean));
    for (const room of rooms) rows.push(toLesson(room, lesson));
  }
  return rows.sort((a, b) => a.start.localeCompare(b.start));
}

/**
 * Rows of lehrer.txt at `now` (local "YYYY-MM-DD HH:MM:SS"): per teacher the
 * lessons with the earliest start that have not ended yet. A teacher who had
 * lessons today but has none left is done for the day (Gone); one without any
 * lessons today: NoData. Lessons taken over by a substitute do not count for
 * the original teacher.
 */
export function teacherLessons(lessons: ApiLesson[], teachers: string[], now: string): UntisLesson[] {
  const holds = new Map<string, ApiLesson[]>();
  for (const lesson of lessons) {
    for (const { kuerzel } of lesson.lehrkraefte) {
      const key = kuerzel.trim();
      if (!holds.has(key)) holds.set(key, []);
      holds.get(key)!.push(lesson);
    }
  }

  const keys = new Set([...teachers.map((t) => t.trim()), ...holds.keys()]);
  const rows: UntisLesson[] = [];
  for (const key of keys) {
    if (!key) continue;
    const own = (holds.get(key) ?? []).map((l) => toLesson(key, l));
    const open = own.filter((l) => (l.end || l.start) > now);
    const first = open.reduce((min, l) => (l.start < min ? l.start : min), '￿');
    const next = open.filter((l) => l.start === first);
    if (next.length) rows.push(...next);
    else rows.push(noLesson(key, own.length ? 'Gone' : 'NoData'));
  }
  return rows;
}

class ApiError extends UntisError {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Reads the WebUntis-Datendienst. */
export class ApiSource {
  private readonly base: string;
  private readonly key: string;
  private readonly now: () => number;
  private day: ApiDay | null = null;
  private fetchedAt = 0;
  private inflight: Promise<ApiDay> | null = null;
  private lists = new Map<string, { at: number; values: string[]; error?: ApiError }>();

  constructor(baseUrl: string, key: string, now: () => number = Date.now) {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new UntisError('Keine gültige Adresse der WebUntis-API');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new UntisError('Nur http- und https-Adressen');
    this.base = parsed.href.replace(/\/+$/, '');
    this.key = key;
    this.now = now;
  }

  /** The lessons of `date` (local YYYY-MM-DD), at most `maxAgeMs` old; keeps the last good data when a refresh fails. */
  async load(date: string, maxAgeMs: number): Promise<ApiDay> {
    if (this.day?.date === date && this.now() - this.fetchedAt < maxAgeMs) return this.day;
    this.inflight ??= this.refresh(date).finally(() => {
      this.inflight = null;
    });
    try {
      return await this.inflight;
    } catch (err) {
      if (this.day?.date === date && this.now() - this.fetchedAt < STALE_MS) return this.day;
      throw err;
    }
  }

  /** Room names (scope "stundenplan"). */
  rooms(maxAgeMs: number): Promise<string[]> {
    return this.list('/v1/raeume', maxAgeMs, (r: { name: string }) => r.name);
  }

  /** Teacher codes (scope "stammdaten"); only the code is kept. */
  teachers(maxAgeMs: number): Promise<string[]> {
    return this.list('/v1/lehrkraefte', maxAgeMs, (t: { short_name: string }) => t.short_name);
  }

  private async refresh(date: string): Promise<ApiDay> {
    // Ask the cheap "stand" first: unchanged lessons are not fetched again.
    const { stand } = await this.get<{ stand: string | null }>('/v1/stunden/stand');
    if (this.day?.date === date && stand && stand === this.day.lastModified) {
      this.fetchedAt = this.now();
      return this.day;
    }
    const lessons = await this.get<ApiLesson[]>(`/v1/stunden?von=${date}`);
    this.fetchedAt = this.now();
    this.day = { date, lessons, lastModified: stand ?? new Date(this.fetchedAt).toISOString() };
    return this.day;
  }

  private async list<T>(path: string, maxAgeMs: number, pick: (item: T) => string): Promise<string[]> {
    const cached = this.lists.get(path);
    if (cached && this.now() - cached.at < maxAgeMs) {
      if (cached.error) throw cached.error;
      return cached.values;
    }
    let values: string[];
    try {
      values = (await this.get<T[]>(path)).map(pick).filter(Boolean);
    } catch (err) {
      // A missing scope does not go away by asking every 30 seconds.
      if (err instanceof ApiError && err.status === 403) this.lists.set(path, { at: this.now(), values: [], error: err });
      throw err;
    }
    this.lists.set(path, { at: this.now(), values });
    return values;
  }

  private async get<T>(path: string): Promise<T> {
    let response: Response;
    try {
      response = await fetch(this.base + path, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${this.key}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw new UntisError(`WebUntis-API nicht erreichbar (${(err as Error).name === 'TimeoutError' ? 'Zeitüberschreitung' : 'Netzwerkfehler'})`);
    }
    if (!response.ok) {
      // The API explains refusals in German ("API-Schlüssel ungültig oder gesperrt.").
      const detail = await response
        .json()
        .then((body: { detail?: unknown }) => (typeof body?.detail === 'string' ? body.detail : ''))
        .catch(() => '');
      throw new ApiError(`Antwort der WebUntis-API: HTTP ${response.status}${detail ? ` – ${detail}` : ''}`, response.status);
    }
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > MAX_BYTES) throw new UntisError('Antwort der WebUntis-API ist zu groß');
    const body = await response.arrayBuffer();
    if (body.byteLength > MAX_BYTES) throw new UntisError('Antwort der WebUntis-API ist zu groß');
    try {
      return JSON.parse(new TextDecoder('utf-8').decode(body)) as T;
    } catch {
      throw new UntisError('Antwort der WebUntis-API ist kein JSON');
    }
  }
}

const sources = new Map<string, ApiSource>();

/** The (shared, cached) source for the server's API settings (ctx.untisApi), or null when not set up. */
export function untisApi(settings: { url: string; key: string } | null): ApiSource | null {
  if (!settings?.url || !settings.key) return null;
  // A new address or key starts with an empty cache.
  const id = `${settings.url}\n${settings.key}`;
  let source = sources.get(id);
  if (!source) {
    sources.clear();
    source = new ApiSource(settings.url, settings.key);
    sources.set(id, source);
  }
  return source;
}

/** Forgets the API source and its data (tests). */
export function clearUntisApi() {
  sources.clear();
}
