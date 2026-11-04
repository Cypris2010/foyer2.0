// Resolves what a display shows right now and packs it into the player manifest.
import type { AppContext } from './context.ts';
import { hmac, sha256 } from './crypto.ts';
import { slideServerContext } from './integrations.ts';
import { activeChannelSlides, displayContent, minTime } from './planning.ts';
import { mediaFields, mediaInfo, resolveBackground, type ManifestBackground } from './background.ts';
import type { MediaInfo } from '@foyer/slide-sdk';

/** Seconds for single slides scheduled without a channel around them. */
const DEFAULT_DURATION = 10;

export interface DisplayRow {
  id: string;
  name: string;
  default_channel_id: string | null;
  show_progress: number;
  orientation: 'landscape' | 'portrait';
  networks: string;
  sound_allowed: number;
}

interface ChannelRow {
  id: string;
  name: string;
  transition: 'fade' | 'slide' | 'none';
  default_duration: number;
}

export interface SlideRow {
  id: string;
  title: string;
  type: string;
  config_json: string;
  background_json: string | null;
  duration: number | null;
  updated_at: number;
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
  /** personalData types: `data` is null here and fetched from this URL instead. */
  dataUrl?: string;
  /** Changes with the data, so players fetch it again (and the manifest version changes). */
  dataVersion?: string;
  background: ManifestBackground | null;
  /** Files of the config's media fields, keyed by media id. */
  media: Record<string, MediaInfo>;
  /** Duration is the media length: the slide ends when the media ends (timer is a safety net). */
  playsToEnd: boolean;
  error?: string;
}

export interface Manifest {
  version: string;
  generatedAt: string;
  display: { id: string; name: string; showProgress: boolean; orientation: string; soundAllowed: boolean };
  channel: { id: string; name: string; transition: string } | null;
  slides: ManifestSlide[];
  /** When the content changes next (calendar); the player re-fetches then. */
  nextChange: string | null;
  settings: { locale: string; timeZone: string };
  /** Player bundle the server serves; outdated players reload (not part of `version`). */
  playerBuild: string | null;
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
  const value = await entry.server.data(config, slideServerContext(ctx, displayId));
  dataCache.set(key, { value, expires: now + ttlSeconds * 1000 });
  return value;
}

/**
 * Re-resolves the data of published slides whose type refreshes (refreshSeconds)
 * once it expired. True when any slide's data changed: players then fetch the
 * manifest again and hand the new data to the running slide (update()).
 */
export async function refreshSlideData(ctx: AppContext): Promise<boolean> {
  const types = [...ctx.registry].filter(([, entry]) => entry.server.data && entry.server.refreshSeconds).map(([id]) => id);
  if (!types.length) return false;
  const rows = ctx.db
    .prepare(`SELECT * FROM slides WHERE published = 1 AND type IN (${types.map(() => '?').join(', ')})`)
    .all(...types) as unknown as SlideRow[];
  let changed = false;
  for (const slide of rows) {
    const key = `${slide.id}:${slide.updated_at}`;
    const cached = dataCache.get(key);
    // Not shown anywhere yet, or still fresh: nothing to push.
    if (!cached || cached.expires > ctx.now()) continue;
    const parsed = ctx.registry.get(slide.type)!.definition.config.safeParse(JSON.parse(slide.config_json));
    if (!parsed.success) continue;
    const before = JSON.stringify(cached.value);
    try {
      dataCache.delete(key);
      const value = await resolveData(ctx, slide, parsed.data, '');
      if (JSON.stringify(value) !== before) changed = true;
    } catch {
      // The next manifest request reports the error on the slide.
      changed = true;
    }
  }
  return changed;
}

/** Runs refreshSlideData every `intervalMs` and notifies players of changes. */
export function startDataRefresh(ctx: AppContext, intervalMs = 15_000): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      if (await refreshSlideData(ctx)) ctx.events.broadcast('manifest-changed');
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Data of a slide as its renderer gets it (cached, see resolveData). */
export async function slideData(ctx: AppContext, slide: SlideRow, displayId: string): Promise<unknown> {
  const entry = ctx.registry.get(slide.type);
  if (!entry) return null;
  return resolveData(ctx, slide, entry.definition.config.parse(JSON.parse(slide.config_json)), displayId);
}

export function dataSignature(ctx: AppContext, slideId: string, version: number, displayId: string): string {
  return hmac(ctx.secret, `data:${slideId}:${version}:${displayId}`);
}

export function dataUrl(ctx: AppContext, slideId: string, version: number, displayId: string): string {
  const sig = dataSignature(ctx, slideId, version, displayId);
  return `/content/data/${encodeURIComponent(slideId)}/${version}?d=${encodeURIComponent(displayId)}&s=${sig}`;
}

export function documentSignature(ctx: AppContext, slideId: string, version: number, displayId: string): string {
  return hmac(ctx.secret, `${slideId}:${version}:${displayId}`);
}

export function documentUrl(ctx: AppContext, slideId: string, version: number, displayId: string): string {
  const sig = documentSignature(ctx, slideId, version, displayId);
  return `/content/slides/${encodeURIComponent(slideId)}/${version}?d=${encodeURIComponent(displayId)}&s=${sig}`;
}

export async function buildSlideEntry(
  ctx: AppContext,
  slide: SlideRow,
  channelDefault: number,
  displayId: string,
  documentDisplayId = displayId,
): Promise<ManifestSlide | null> {
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
    background: slide.background_json ? resolveBackground(ctx, JSON.parse(slide.background_json)) : null,
    media: {},
    playsToEnd: false,
  };
  if (!parsed.success) {
    result.error = 'Ungültige Konfiguration';
    return result;
  }
  const config = parsed.data as Record<string, unknown>;
  for (const field of mediaFields(entry.jsonSchema)) {
    const id = config[field.name];
    if (typeof id !== 'string' || !id) continue;
    const info = mediaInfo(ctx, id);
    // Still being converted: leave the slide out until it is ready (players are notified then).
    if (info === 'pending') return null;
    if (!info) {
      result.error = 'Die gewählte Datei fehlt oder konnte nicht umgewandelt werden';
      return result;
    }
    result.media[id] = info;
  }
  const lengthField = entry.definition.durationFromMedia;
  const length = lengthField ? result.media[config[lengthField] as string]?.duration : null;
  if (slide.duration === null && length) {
    result.duration = Math.round(length * 10) / 10;
    result.playsToEnd = true;
  }
  try {
    result.data = await resolveData(ctx, slide, parsed.data, displayId);
  } catch (err) {
    result.error = `Daten nicht verfügbar: ${(err as Error).message}`;
  }
  if (entry.definition.personalData && !result.error) {
    // Only a keyed hash of the data goes into the manifest, never the data.
    result.dataVersion = hmac(ctx.secret, JSON.stringify(result.data ?? null)).slice(0, 16);
    result.dataUrl = dataUrl(ctx, slide.id, slide.updated_at, documentDisplayId);
    result.data = null;
  }
  if (entry.server.document) result.documentUrl = documentUrl(ctx, slide.id, slide.updated_at, documentDisplayId);
  return result;
}

/**
 * Resolves the calendar (planning.ts) into the playlist of a display.
 * `preview` signs sandbox documents as "preview:<displayId>", so admins can
 * view them from outside the player networks (they hold no personal data).
 */
export async function buildManifest(ctx: AppContext, display: DisplayRow, opts: { preview?: boolean } = {}): Promise<Manifest> {
  const documentDisplayId = opts.preview ? `preview:${display.id}` : display.id;
  const now = ctx.now();
  const content = displayContent(ctx.db, display.id, display.default_channel_id, now, ctx.timeZone);
  let nextChange = content.nextChange;

  const channelById = ctx.db.prepare('SELECT id, name, transition, default_duration FROM channels WHERE id = ? AND published = 1');
  const slideById = ctx.db.prepare('SELECT * FROM slides WHERE id = ? AND published = 1');
  const channelSlideRows = ctx.db.prepare(
    `SELECT s.* FROM channel_slides cs JOIN slides s ON s.id = cs.slide_id
     WHERE cs.channel_id = ? AND s.published = 1 ORDER BY cs.position`,
  );

  const channels: ChannelRow[] = [];
  const slides: ManifestSlide[] = [];
  const seen = new Set<string>();
  const push = async (row: SlideRow, defaultDuration: number) => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    const entry = await buildSlideEntry(ctx, row, defaultDuration, display.id, documentDisplayId);
    if (entry) slides.push(entry);
  };

  for (const item of content.items) {
    if (item.kind === 'channel') {
      const channel = channelById.get(item.id) as ChannelRow | undefined;
      if (!channel) continue;
      channels.push(channel);
      const active = activeChannelSlides(ctx.db, channel.id, now, ctx.timeZone);
      nextChange = minTime(nextChange, active.nextChange);
      for (const row of channelSlideRows.all(channel.id) as unknown as SlideRow[]) {
        if (active.slideIds.has(row.id)) await push(row, channel.default_duration);
      }
    } else {
      const row = slideById.get(item.id) as SlideRow | undefined;
      if (row) await push(row, channels[0]?.default_duration ?? DEFAULT_DURATION);
    }
  }

  const lead = channels[0];
  const body = {
    display: {
      id: display.id,
      name: display.name,
      showProgress: display.show_progress === 1,
      orientation: display.orientation,
      // Admin previews stay silent.
      soundAllowed: !opts.preview && display.sound_allowed === 1,
    },
    channel: lead ? { id: lead.id, name: channels.map((c) => c.name).join(' + '), transition: lead.transition } : null,
    slides,
    nextChange: nextChange === null ? null : new Date(nextChange).toISOString(),
    settings: { locale: ctx.locale, timeZone: ctx.timeZone },
  };
  return { version: sha256(JSON.stringify(body)).slice(0, 16), generatedAt: new Date(now).toISOString(), ...body, playerBuild: ctx.playerBuild() };
}
