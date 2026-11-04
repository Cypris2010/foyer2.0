// Translates between the repetition fields of the calendar dialog and RRULE
// strings (RFC 5545, without DTSTART), plus a German summary.

export type Freq = 'none' | 'daily' | 'weekly' | 'monthly';
export type Weekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';

export interface Recurrence {
  freq: Freq;
  interval: number;
  /** Weekly: days. */
  byday: Weekday[];
  /** Monthly: same day of month, or same nth weekday (e.g. 2nd Tuesday). */
  monthly: 'monthday' | 'weekday';
  end: 'never' | 'until' | 'count';
  /** Last day, "YYYY-MM-DD" (inclusive). */
  until: string;
  count: number;
}

export const WEEKDAYS: Array<{ code: Weekday; short: string; long: string }> = [
  { code: 'MO', short: 'Mo', long: 'Montag' },
  { code: 'TU', short: 'Di', long: 'Dienstag' },
  { code: 'WE', short: 'Mi', long: 'Mittwoch' },
  { code: 'TH', short: 'Do', long: 'Donnerstag' },
  { code: 'FR', short: 'Fr', long: 'Freitag' },
  { code: 'SA', short: 'Sa', long: 'Samstag' },
  { code: 'SU', short: 'So', long: 'Sonntag' },
];

const JS_DAY_TO_CODE: Weekday[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function startDate(startLocal: string): Date {
  const [y, m, d] = startLocal.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function weekdayOf(startLocal: string): Weekday {
  return JS_DAY_TO_CODE[startDate(startLocal).getDay()];
}

/** 1–5: which occurrence of its weekday the start date is within the month. */
export function nthOf(startLocal: string): number {
  return Math.ceil(startDate(startLocal).getDate() / 7);
}

export function defaultRecurrence(startLocal: string): Recurrence {
  return { freq: 'none', interval: 1, byday: [weekdayOf(startLocal)], monthly: 'monthday', end: 'never', until: '', count: 10 };
}

export function toRRule(rec: Recurrence, startLocal: string): string | null {
  if (rec.freq === 'none') return null;
  const parts = [`FREQ=${rec.freq.toUpperCase()}`];
  if (rec.interval > 1) parts.push(`INTERVAL=${rec.interval}`);
  if (rec.freq === 'weekly') parts.push(`BYDAY=${(rec.byday.length ? rec.byday : [weekdayOf(startLocal)]).join(',')}`);
  if (rec.freq === 'monthly') {
    if (rec.monthly === 'weekday') parts.push(`BYDAY=+${nthOf(startLocal)}${weekdayOf(startLocal)}`);
    else parts.push(`BYMONTHDAY=${startDate(startLocal).getDate()}`);
  }
  // UNTIL is school wall time like everything else (see schedule-engine.ts).
  if (rec.end === 'until' && rec.until) parts.push(`UNTIL=${rec.until.replace(/-/g, '')}T235900`);
  if (rec.end === 'count' && rec.count > 0) parts.push(`COUNT=${rec.count}`);
  return parts.join(';');
}

export function fromRRule(rrule: string | null, startLocal: string): Recurrence {
  const rec = defaultRecurrence(startLocal);
  if (!rrule) return rec;
  const fields = Object.fromEntries(rrule.split(';').map((p) => p.split('=') as [string, string]));
  const freq = (fields.FREQ ?? '').toLowerCase();
  if (freq === 'daily' || freq === 'weekly' || freq === 'monthly') rec.freq = freq;
  rec.interval = Number(fields.INTERVAL ?? 1) || 1;
  if (rec.freq === 'weekly' && fields.BYDAY) rec.byday = fields.BYDAY.split(',') as Weekday[];
  if (rec.freq === 'monthly') rec.monthly = fields.BYDAY ? 'weekday' : 'monthday';
  if (fields.UNTIL) {
    rec.end = 'until';
    rec.until = `${fields.UNTIL.slice(0, 4)}-${fields.UNTIL.slice(4, 6)}-${fields.UNTIL.slice(6, 8)}`;
  } else if (fields.COUNT) {
    rec.end = 'count';
    rec.count = Number(fields.COUNT);
  }
  return rec;
}

export function describe(rec: Recurrence, startLocal: string): string {
  if (rec.freq === 'none') return 'Einmalig';
  const every = (one: string, many: string) => (rec.interval > 1 ? `Alle ${rec.interval} ${many}` : one);
  let text = '';
  if (rec.freq === 'daily') text = every('Täglich', 'Tage');
  if (rec.freq === 'weekly') {
    const days = WEEKDAYS.filter((d) => rec.byday.includes(d.code)).map((d) => d.short).join(', ');
    text = `${every('Jede Woche', 'Wochen')} am ${days || WEEKDAYS.find((d) => d.code === weekdayOf(startLocal))!.short}`;
  }
  if (rec.freq === 'monthly') {
    const day = rec.monthly === 'weekday'
      ? `am ${nthOf(startLocal)}. ${WEEKDAYS.find((d) => d.code === weekdayOf(startLocal))!.long}`
      : `am ${startDate(startLocal).getDate()}.`;
    text = `${every('Jeden Monat', 'Monate')} ${day}`;
  }
  if (rec.end === 'until' && rec.until) text += `, bis ${rec.until.split('-').reverse().join('.')}`;
  if (rec.end === 'count') text += `, ${rec.count} Termine`;
  return text;
}
