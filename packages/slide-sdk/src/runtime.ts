// Small helpers renderers share. Must stay dependency-free: it ships in the player bundle.

export interface PlaceholderContext {
  locale: string;
  timeZone: string;
  displayName: string;
  now?: Date;
  values?: Record<string, string>;
}

function format(now: Date, locale: string, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(now);
  } catch {
    return new Intl.DateTimeFormat(locale, options).format(now);
  }
}

/** Replaces {{date}}, {{time}}, {{weekday}}, {{display.name}} and {{field}} values. Unknown names stay untouched. */
export function fillPlaceholders(text: string, ctx: PlaceholderContext): string {
  const now = ctx.now ?? new Date();
  const builtIn: Record<string, () => string> = {
    date: () => format(now, ctx.locale, ctx.timeZone, { day: '2-digit', month: '2-digit', year: 'numeric' }),
    time: () => format(now, ctx.locale, ctx.timeZone, { hour: '2-digit', minute: '2-digit', hour12: false }),
    weekday: () => format(now, ctx.locale, ctx.timeZone, { weekday: 'long' }),
    'display.name': () => ctx.displayName,
  };
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, name: string) => {
    if (ctx.values && Object.prototype.hasOwnProperty.call(ctx.values, name)) return ctx.values[name];
    const resolve = builtIn[name];
    return resolve ? resolve() : match;
  });
}

/** "{{media:<id>}}": a file from the media library (HTML slides). */
const MEDIA_PLACEHOLDER = /\{\{\s*media:([\w-]{1,64})\s*\}\}/g;

/** Media ids referenced with {{media:<id>}}, in order, without duplicates. */
export function mediaPlaceholderIds(text: string): string[] {
  const ids: string[] = [];
  for (const match of text.matchAll(MEDIA_PLACEHOLDER)) if (!ids.includes(match[1])) ids.push(match[1]);
  return ids;
}

/** Replaces {{media:<id>}} with the file's URL; unknown ids become "". */
export function fillMediaPlaceholders(text: string, url: (id: string) => string | null): string {
  return text.replace(MEDIA_PLACEHOLDER, (_match, id: string) => url(id) ?? '');
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
