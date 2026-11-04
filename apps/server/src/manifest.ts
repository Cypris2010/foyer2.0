// Resolves what a display shows right now and packs it into the player manifest.
import type { AppContext } from './context.ts';
import { hmac, sha256 } from './crypto.ts';

export interface DisplayRow {
  id: string;
  name: string;
  default_channel_id: string | null;
  show_progress: number;
  orientation: 'landscape' | 'portrait';
  networks: string;
}

interface ChannelRow {
  id: string;
  name: string;
  transition: 'fade' | 'slide' | 'none';
  default_duration: number;
}

interface SlideRow {
  id: string;
  title: string;
  type: string;
  config_json: string;
  background_json: string | null;
  duration: number | null;
  updated_at: number;
  window_start: number | null;
  window_end: number | null;
}

export interface ManifestSlide {
  id: string;
  type: string;
  title: string;
  duration: number;
  keepAlive: boolean;
  config: unknown;
  data: unknown;
  documentUrl?: string;
  background: unknown;
  error?: string;
}

export interface Manifest {
  version: string;
  generatedAt: string;
  display: { id: string; name: string; showProgress: boolean; orientation: string };
  channel: { id: string; name: string; transition: string } | null;
  slides: ManifestSlide[];
  /** When the content changes next (slide windows); the player re-fetches then. */
  nextChange: string | null;
  settings: { locale: string; timeZone: string };
}

const dataCache = new Map<string, { value: unknown; expires: number }>();

export function clearDataCache() {
  dataCache.clear();
}

async function resolveData(ctx: AppContext, slide: SlideRow, config: unknown, displayId: string): Promise<unknown> {
  const entry = ctx.registry.get(slide.type);
  if (!entry?.server.data) return null;
  const key = `${slide.id}:${slide.updated_at}`;
  const now = ctx.now();
  const cached = dataCache.get(key);
  if (cached && cached.expires > now) return cached.value;
  const refresh = entry.server.refreshSeconds;
  const ttlSeconds = typeof refresh === 'function' ? refresh(config) : (refresh ?? Infinity);
  const value = await entry.server.data(config, { displayId, locale: ctx.locale, timeZone: ctx.timeZone });
  dataCache.set(key, { value, expires: now + ttlSeconds * 1000 });
  return value;
}

export function documentSignature(ctx: AppContext, slideId: string, version: number, displayId: string): string {
  return hmac(ctx.secret, `${slideId}:${version}:${displayId}`);
}

export function documentUrl(ctx: AppContext, slideId: string, version: number, displayId: string): string {
  const sig = documentSignature(ctx, slideId, version, displayId);
  return `/content/slides/${encodeURIComponent(slideId)}/${version}?d=${encodeURIComponent(displayId)}&s=${sig}`;
}

export async function buildSlideEntry(ctx: AppContext, slide: SlideRow, channelDefault: number, displayId: string): Promise<ManifestSlide | null> {
  const entry = ctx.registry.get(slide.type);
  if (!entry) return null;
  const parsed = entry.definition.config.safeParse(JSON.parse(slide.config_json));
  const result: ManifestSlide = {
    id: slide.id,
    type: slide.type,
    title: slide.title,
    duration: slide.duration ?? entry.definition.defaultDuration ?? channelDefault,
    keepAlive: entry.definition.keepAlive ?? false,
    config: parsed.success ? parsed.data : null,
    data: null,
    background: slide.background_json ? JSON.parse(slide.background_json) : null,
  };
  if (!parsed.success) {
    result.error = 'Ungültige Konfiguration';
    return result;
  }
  try {
    result.data = await resolveData(ctx, slide, parsed.data, displayId);
  } catch (err) {
    result.error = `Daten nicht verfügbar: ${(err as Error).message}`;
  }
  if (entry.server.document) result.documentUrl = documentUrl(ctx, slide.id, slide.updated_at, displayId);
  return result;
}

export async function buildManifest(ctx: AppContext, display: DisplayRow): Promise<Manifest> {
  const now = ctx.now();
  // Phase 3 adds schedules here; until then the default channel is active.
  const channel = display.default_channel_id
    ? (ctx.db
        .prepare('SELECT id, name, transition, default_duration FROM channels WHERE id = ? AND published = 1')
        .get(display.default_channel_id) as ChannelRow | undefined)
    : undefined;

  const slides: ManifestSlide[] = [];
  let nextChange: number | null = null;
  const consider = (t: number | null) => {
    if (t !== null && t > now && (nextChange === null || t < nextChange)) nextChange = t;
  };

  if (channel) {
    const rows = ctx.db
      .prepare(
        `SELECT s.id, s.title, s.type, s.config_json, s.background_json, s.duration, s.updated_at,
                cs.window_start, cs.window_end
         FROM channel_slides cs JOIN slides s ON s.id = cs.slide_id
         WHERE cs.channel_id = ? AND s.published = 1
         ORDER BY cs.position`,
      )
      .all(channel.id) as unknown as SlideRow[];
    for (const row of rows) {
      consider(row.window_start);
      consider(row.window_end);
      if (row.window_start !== null && row.window_start > now) continue;
      if (row.window_end !== null && row.window_end <= now) continue;
      const entry = await buildSlideEntry(ctx, row, channel.default_duration, display.id);
      if (entry) slides.push(entry);
    }
  }

  const body = {
    display: { id: display.id, name: display.name, showProgress: display.show_progress === 1, orientation: display.orientation },
    channel: channel ? { id: channel.id, name: channel.name, transition: channel.transition } : null,
    slides,
    nextChange: nextChange === null ? null : new Date(nextChange).toISOString(),
    settings: { locale: ctx.locale, timeZone: ctx.timeZone },
  };
  return { version: sha256(JSON.stringify(body)).slice(0, 16), generatedAt: new Date(now).toISOString(), ...body };
}
