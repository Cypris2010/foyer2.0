// Expands calendar entries (single, open-ended or RRULE series) into concrete
// occurrences. All times are school wall-clock times ("YYYY-MM-DDTHH:mm" in the
// school time zone), so "08:00–09:00 every Monday" stays 08:00–09:00 across
// daylight saving changes. RRULE expansion runs on "floating" dates (wall time
// encoded as UTC) and each occurrence is converted to real UTC afterwards.
import rrulePkg from 'rrule';

const { RRule } = rrulePkg as unknown as typeof import('rrule');

export interface ScheduleSpec {
  /** First (or only) start, school wall time "YYYY-MM-DDTHH:mm". */
  startLocal: string;
  /** End of the first occurrence; null = open-ended (single entries only). */
  endLocal: string | null;
  /** RRULE without DTSTART, e.g. "FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261231T235900". */
  rrule: string | null;
  /** Occurrence ids (original local start) that are cancelled. */
  exdates: string[];
  /** Moved or resized occurrences, keyed by original local start. */
  overrides: Record<string, { startLocal: string; endLocal: string }>;
}

export interface Occurrence {
  /** Original local start; stable id of the occurrence within its series. */
  occId: string;
  startLocal: string;
  endLocal: string | null;
  startUtc: number;
  /** null = open-ended. */
  endUtc: number | null;
}

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export function isLocalDateTime(value: string): boolean {
  return LOCAL.test(value);
}

/** Wall time as if it were UTC ("floating"); only for arithmetic, never a real instant. */
export function floating(local: string): number {
  const m = local.match(LOCAL);
  if (!m) throw new Error(`Ungültige Zeitangabe: ${local}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
}

export function fromFloating(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16);
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** School wall time of a real instant, as floating ms. */
function utcToFloating(utcMs: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(utcMs))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
}

export function utcToLocal(utcMs: number, timeZone: string): string {
  return fromFloating(utcToFloating(utcMs, timeZone));
}

/**
 * Real instant of a school wall time. Times that do not exist (spring gap) move
 * forward by the gap; ambiguous times (autumn) resolve to the first instance.
 */
export function localToUtc(local: string, timeZone: string): number {
  const wall = floating(local);
  // Offsets a day before and after cover any single DST transition in between.
  const offsetBefore = utcToFloating(wall - 86400_000, timeZone) - (wall - 86400_000);
  const offsetAfter = utcToFloating(wall + 86400_000, timeZone) - (wall + 86400_000);
  const candidates = [wall - offsetBefore, wall - offsetAfter]
    .filter((utc) => utcToFloating(utc, timeZone) === wall)
    .sort((a, b) => a - b);
  if (candidates.length) return candidates[0];
  // Spring gap: with the pre-transition offset the time lands after the gap.
  return wall - offsetBefore;
}

function toOccurrence(occId: string, startLocal: string, endLocal: string | null, timeZone: string): Occurrence {
  return {
    occId,
    startLocal,
    endLocal,
    startUtc: localToUtc(startLocal, timeZone),
    endUtc: endLocal === null ? null : localToUtc(endLocal, timeZone),
  };
}

export function validateSpec(spec: ScheduleSpec): string | null {
  if (!isLocalDateTime(spec.startLocal)) return 'Ungültiger Beginn';
  if (spec.endLocal !== null) {
    if (!isLocalDateTime(spec.endLocal)) return 'Ungültiges Ende';
    if (floating(spec.endLocal) <= floating(spec.startLocal)) return 'Das Ende muss nach dem Beginn liegen';
  }
  if (spec.rrule) {
    if (spec.endLocal === null) return 'Eine Serie braucht ein Ende für jeden Termin';
    try {
      RRule.parseString(spec.rrule);
    } catch {
      return 'Ungültige Wiederholungsregel';
    }
  }
  return null;
}

const MAX_OCCURRENCES = 2000;

/** Occurrences overlapping [fromUtc, toUtc). */
export function expand(spec: ScheduleSpec, fromUtc: number, toUtc: number, timeZone: string): Occurrence[] {
  const overlaps = (o: Occurrence) => o.startUtc < toUtc && (o.endUtc === null || o.endUtc > fromUtc);
  const exdates = new Set(spec.exdates);
  const result: Occurrence[] = [];
  const add = (occId: string, startLocal: string, endLocal: string | null) => {
    if (exdates.has(occId)) return;
    const override = spec.overrides[occId];
    const occ = override
      ? toOccurrence(occId, override.startLocal, override.endLocal, timeZone)
      : toOccurrence(occId, startLocal, endLocal, timeZone);
    if (overlaps(occ)) result.push(occ);
  };

  if (!spec.rrule) {
    add(spec.startLocal, spec.startLocal, spec.endLocal);
    return result;
  }

  const durationMs = floating(spec.endLocal!) - floating(spec.startLocal);
  const options = RRule.parseString(spec.rrule);
  // UNTIL in the rule is school wall time as well (floating).
  const rule = new RRule({ ...options, dtstart: new Date(floating(spec.startLocal)) });
  // Search window in floating time, widened by one occurrence length and a day
  // for time-zone offsets; the exact check happens in overlaps().
  const searchFrom = new Date(utcToFloating(fromUtc, timeZone) - durationMs - 86400_000);
  const searchTo = new Date(utcToFloating(toUtc, timeZone) + 86400_000);
  const starts = rule.between(searchFrom, searchTo, true);
  for (const start of starts.slice(0, MAX_OCCURRENCES)) {
    const startLocal = fromFloating(start.getTime());
    add(startLocal, startLocal, fromFloating(start.getTime() + durationMs));
  }
  // Overrides can move an occurrence into the window from outside the search range.
  for (const [occId, override] of Object.entries(spec.overrides)) {
    if (result.some((o) => o.occId === occId) || exdates.has(occId)) continue;
    const occ = toOccurrence(occId, override.startLocal, override.endLocal, timeZone);
    if (overlaps(occ) && rule.between(new Date(floating(occId)), new Date(floating(occId)), true).length) result.push(occ);
  }
  return result.sort((a, b) => a.startUtc - b.startUtc);
}

/** Earliest start or end strictly after `nowUtc` within the occurrences, or null. */
export function nextBoundary(occurrences: Occurrence[], nowUtc: number): number | null {
  let next: number | null = null;
  for (const o of occurrences) {
    for (const t of [o.startUtc, o.endUtc]) {
      if (t !== null && t > nowUtc && (next === null || t < next)) next = t;
    }
  }
  return next;
}
