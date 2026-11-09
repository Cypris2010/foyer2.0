// Slide backgrounds: what the admin stores and what the player gets.
import { z } from 'zod';
import type { BackgroundKind, MediaInfo } from '@foyer/slide-sdk';
import type { AppContext } from './context.ts';
import { mediaPlaceholderIds } from '@foyer/slide-sdk/runtime';
import { creditText, mediaUrl, type MediaSource, type MediaVariant } from './media.ts';
import { hmac } from './crypto.ts';

/** Darkens the background so text on top stays readable, in percent. */
const dim = z.number().int().min(0).max(80).default(0);

export const backgroundSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('color'), value: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Farbe als #rrggbb') }),
    z.object({ kind: z.literal('image'), mediaId: z.string().min(1).max(64), fit: z.enum(['cover', 'contain']).default('cover'), dim, zoom: z.boolean().default(false) }),
    z.object({ kind: z.literal('video'), mediaId: z.string().min(1).max(64), dim }),
  ])
  .nullable()
  .default(null);

export type Background = z.infer<typeof backgroundSchema>;

export type ManifestBackground =
  | { kind: 'color'; value: string }
  | { kind: 'image'; url: string; fit: 'cover' | 'contain'; dim: number; zoom: boolean }
  | { kind: 'video'; url: string; poster: string | null; dim: number };

/** Checks a background against the slide type and the media library; returns an error text. */
export function checkBackground(ctx: AppContext, background: Background, allowed: BackgroundKind[] | false | undefined): string | null {
  if (!background) return null;
  if (!allowed || !allowed.includes(background.kind)) return 'Dieser Folientyp unterstützt diesen Hintergrund nicht';
  if (background.kind === 'color') return null;
  const media = ctx.media.get(background.mediaId);
  if (!media) return 'Die gewählte Datei gibt es nicht mehr';
  if (media.kind !== background.kind) return background.kind === 'image' ? 'Bitte ein Bild wählen' : 'Bitte ein Video wählen';
  return null;
}

/** Resolves media references to file URLs. Media that is not ready yet shows no background. */
/** Video variant a display plays. Keys of the media's variants; see VIDEO_PROFILES. */
export type VideoQuality = 'main' | 'sd';

// Images and small sources have no 720p variant: they stay what they are.
function pickVariant(variantsJson: string, quality: VideoQuality): MediaVariant | undefined {
  const variants = JSON.parse(variantsJson) as Record<string, MediaVariant>;
  return variants[quality] ?? variants.main;
}

export function resolveBackground(ctx: AppContext, stored: unknown, quality: VideoQuality = 'main'): ManifestBackground | null {
  const parsed = backgroundSchema.safeParse(stored);
  const background = parsed.success ? parsed.data : null;
  if (!background) return null;
  if (background.kind === 'color') return background;
  const media = ctx.media.get(background.mediaId);
  if (!media || media.status !== 'ready' || media.kind !== background.kind) return null;
  const variant = pickVariant(media.variants_json, quality);
  if (!variant) return null;
  if (background.kind === 'image') return { kind: 'image', url: mediaUrl(variant.file), fit: background.fit, dim: background.dim, zoom: background.zoom };
  return { kind: 'video', url: mediaUrl(variant.file), poster: media.poster ? mediaUrl(media.poster) : null, dim: background.dim };
}

/** A media item as renderers get it; 'pending' while it is still being processed. */
export function mediaInfo(ctx: AppContext, id: string, quality: VideoQuality = 'main'): MediaInfo | 'pending' | null {
  const media = ctx.media.get(id);
  if (!media || media.status === 'failed') return null;
  if (media.status !== 'ready') return 'pending';
  const variant = pickVariant(media.variants_json, quality);
  if (!variant) return null;
  return {
    kind: media.kind,
    url: mediaUrl(variant.file),
    poster: media.poster ? mediaUrl(media.poster) : null,
    width: variant.width,
    height: variant.height,
    duration: media.duration_s,
  };
}

/** Credit line the displays show with a media item (imported, credit switched on). */
export function mediaCredit(ctx: AppContext, id: string): string | null {
  const media = ctx.media.get(id);
  if (!media?.show_credit || !media.source_json) return null;
  return creditText(media.kind, JSON.parse(media.source_json) as MediaSource);
}

/** Names of config fields that hold a media id (`.meta({ widget: 'media' })`). */
export function mediaFields(jsonSchema: unknown): Array<{ name: string; accept: 'image' | 'video' }> {
  const properties = (jsonSchema as { properties?: Record<string, { widget?: string; accept?: 'image' | 'video' }> }).properties ?? {};
  return Object.entries(properties)
    .filter(([, prop]) => prop.widget === 'media')
    .map(([name, prop]) => ({ name, accept: prop.accept ?? 'image' }));
}

/** Media ids a document slide (HTML) references with {{media:<id>}} in any text field. */
export function placeholderMedia(config: Record<string, unknown>): string[] {
  return [...new Set(Object.values(config).flatMap((value) => (typeof value === 'string' ? mediaPlaceholderIds(value) : [])))];
}

export const mediaFileSignature = (ctx: AppContext, file: string) => hmac(ctx.secret, `media-file:${file}`);

/**
 * URL for {{media:<id>}} in sandboxed documents. Signed, because the sandbox
 * sends no login cookie: admin previews outside the school network need it.
 */
export function signedMediaUrl(ctx: AppContext, id: string): string | null {
  const info = mediaInfo(ctx, id);
  if (!info || info === 'pending') return null;
  const file = info.url.slice('/media/'.length);
  return `${info.url}?s=${mediaFileSignature(ctx, file)}`;
}
