// Untis data for the room display and the teacher dashboard (server only).
//
// A source delivers one day's lessons as normalized rows; the slide types only
// see these rows, never where they came from. The rows come from the
// pipe-separated TXT exports (raeume_ganzer_tag.txt, lehrer.txt) or, in the same
// shape, from the WebUntis-Datendienst (api.ts).
//
// Lessons contain personal data (teacher codes, absences): they are kept in
// memory only, never written to the database or logs.

export interface UntisLesson {
  /** Room (room export) or teacher code (teacher export) the row belongs to. */
  key: string;
  /** Local time, "YYYY-MM-DD HH:MM:SS". */
  start: string;
  end: string;
  rooms: string;
  teachers: string;
  classes: string;
  subject: string;
  /** None, cancelled, irregular, NoData, Gone. */
  status: string;
  /** Unterricht, Veranstaltung, Konferenz. */
  type: string;
  substitutionText: string;
  bookingText: string;
}

export interface UntisDay {
  lessons: UntisLesson[];
  /** When the source last changed (Last-Modified, else the fetch time); ISO. */
  lastModified: string | null;
}

export interface UntisSource {
  /** Cached lessons, at most `maxAgeMs` old; keeps the last good data when a refresh fails. */
  load(maxAgeMs: number): Promise<UntisDay>;
}

const FETCH_TIMEOUT_MS = 10_000;
const MAX_BYTES = 5 * 1048576;
/** Last good data is shown for this long while the source fails. */
const STALE_MS = 60 * 60_000;

/** Parses the pipe-separated TXT export: key|start|end|rooms|teachers|classes|subject|status|type|text|booking. */
export function parseUntisText(text: string): UntisLesson[] {
  const lessons: UntisLesson[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split('|').map((part) => part.trim());
    // Same threshold as the old teacher dashboard: shorter rows are noise.
    if (parts.length < 8 || !parts[0]) continue;
    // Values stay as exported ("-" included): the ported renderers expect them so.
    const field = (i: number) => parts[i] ?? '';
    lessons.push({
      key: parts[0],
      start: field(1),
      end: field(2),
      rooms: field(3),
      teachers: field(4),
      classes: field(5),
      subject: field(6),
      status: field(7),
      type: field(8),
      substitutionText: field(9),
      bookingText: field(10),
    });
  }
  return lessons;
}

/** Rows in the column order of the TXT export, which the ported renderers read. */
export function toRows(lessons: UntisLesson[]): string[][] {
  return lessons.map((l) => [l.key, l.start, l.end, l.rooms, l.teachers, l.classes, l.subject, l.status, l.type, l.substitutionText, l.bookingText]);
}

const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });

/** Distinct keys (rooms or teacher codes), naturally sorted: "A2" before "A10". */
export function distinctKeys(keys: Iterable<string>): string[] {
  const unique = new Set([...keys].map((key) => key.replace(/\s+/g, ' ').trim()).filter(Boolean));
  return [...unique].sort(collator.compare);
}

export class UntisError extends Error {}

export function checkSourceUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UntisError('Keine gültige Adresse');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new UntisError('Nur http- und https-Adressen');
  return parsed;
}

async function readLimited(response: Response): Promise<string> {
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > MAX_BYTES) throw new UntisError('Datei ist zu groß');
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength > MAX_BYTES) throw new UntisError('Datei ist zu groß');
  return new TextDecoder('utf-8').decode(body);
}

/** Reads a TXT export from a URL. */
export class TxtSource implements UntisSource {
  private readonly url: string;
  private readonly now: () => number;
  private day: UntisDay | null = null;
  private fetchedAt = 0;
  private inflight: Promise<UntisDay> | null = null;

  constructor(url: string, now: () => number = Date.now) {
    this.url = checkSourceUrl(url).href;
    this.now = now;
  }

  async load(maxAgeMs: number): Promise<UntisDay> {
    if (this.day && this.now() - this.fetchedAt < maxAgeMs) return this.day;
    // Several slides (and displays) share one request.
    this.inflight ??= this.fetch().finally(() => {
      this.inflight = null;
    });
    try {
      return await this.inflight;
    } catch (err) {
      if (this.day && this.now() - this.fetchedAt < STALE_MS) return this.day;
      throw err;
    }
  }

  private async fetch(): Promise<UntisDay> {
    let response: Response;
    try {
      response = await fetch(this.url, {
        headers: { Accept: 'text/plain' },
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw new UntisError(`Datenquelle nicht erreichbar (${(err as Error).name === 'TimeoutError' ? 'Zeitüberschreitung' : 'Netzwerkfehler'})`);
    }
    if (!response.ok) throw new UntisError(`Antwort der Datenquelle: HTTP ${response.status}`);
    const lessons = parseUntisText(await readLimited(response));
    const modified = Date.parse(response.headers.get('last-modified') ?? response.headers.get('date') ?? '');
    this.fetchedAt = this.now();
    this.day = { lessons, lastModified: new Date(Number.isNaN(modified) ? this.fetchedAt : modified).toISOString() };
    return this.day;
  }
}

const sources = new Map<string, UntisSource>();

/** The (shared, cached) source for a slide's configured URL. */
export function untisSource(url: string): UntisSource {
  const key = checkSourceUrl(url).href;
  let source = sources.get(key);
  if (!source) {
    source = new TxtSource(key);
    sources.set(key, source);
  }
  return source;
}

/** Forgets all cached data (tests). */
export function clearUntisSources() {
  sources.clear();
}
