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

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
