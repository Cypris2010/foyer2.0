// Contract every slide type implements. A slide type is one folder in
// `slide-types/<id>/` with:
//   index.ts   – definition (metadata + Zod config schema), shared by server and admin
//   render.ts  – player renderer (plain DOM, no framework, ES2017 target)
//   server.ts  – optional server hooks (data resolution, admin option lists)
//   style.css  – optional styles, loaded by the player
import type { z } from 'zod';

export type BackgroundKind = 'color' | 'image' | 'video';
export type Role = 'admin' | 'editor' | 'viewer';

export interface SlideTypeDefinition<S extends z.ZodType = z.ZodType> {
  id: string;
  name: string;
  description?: string;
  category?: 'content' | 'media' | 'data' | 'school';
  /** Drives admin form generation, validation and the config type. */
  config: S;
  /** Backgrounds this type may be combined with; false = none. */
  backgrounds?: BackgroundKind[] | false;
  /** Seconds; falls back to the channel default. */
  defaultDuration?: number;
  /**
   * Config field (a media widget) whose length is the slide's duration when the
   * slide sets none: the media plays once and the slide ends with it (KONZEPT 6.2).
   */
  durationFromMedia?: string;
  /** Keep mounted (hidden) between appearances instead of re-creating it. */
  keepAlive?: boolean;
  /**
   * `data` contains personal data (e.g. Untis): it is not put into the manifest
   * (which players cache offline) but fetched separately and only kept in memory
   * (KONZEPT 3.1).
   */
  personalData?: boolean;
  /** Minimum role to create or edit slides of this type. */
  editRole?: Role;
}

export function defineSlideType<S extends z.ZodType>(definition: SlideTypeDefinition<S>): SlideTypeDefinition<S> {
  return definition;
}

// --- Server hooks ------------------------------------------------------------

export interface ServerContext {
  displayId?: string;
  timeZone: string;
  locale: string;
  /** Live gateway services (set when the server has them). */
  live?: LiveServices;
}

/** A live source the server's gateway converts for the displays (KONZEPT 6.5). */
export interface LiveInput {
  /** `ndi`: an NDI source name; `url`: anything ffmpeg reads (rtsp, rtmp, srt, hls, udp …). */
  kind: 'ndi' | 'url';
  value: string;
  /** `ndi`: groups to search for the source instead of the server's default. */
  groups?: string[];
  /** Output profile; 720p30 is what Airtame 2 decodes cleanly over WebRTC. */
  profile: '720p30' | '1080p30';
  audio: boolean;
}

export interface LiveServices {
  /** NDI sources the server sees (in `groups`, else its default groups); throws when the server has no NDI input. */
  ndiSources(options?: { groups?: string[] }): Promise<Array<{ name: string; address: string }>>;
}

export interface Option {
  value: string;
  label: string;
}

export interface SlideDocument {
  html: string;
  /** Content-Security-Policy sent with the document. */
  csp: string;
}

export interface DocumentContext extends ServerContext {
  displayName: string;
}

export interface SlideServer<C = unknown, D = unknown> {
  /** Computes the data the renderer gets. Must not return personal data that the slide does not show. */
  data?(config: C, ctx: ServerContext): Promise<D> | D;
  /**
   * Serves a standalone document for sandboxed iframes (own origin-less URL
   * with its own CSP). The renderer receives its URL as `documentUrl`.
   */
  document?(config: C, ctx: DocumentContext): SlideDocument;
  /** Re-run `data` this often (seconds) and push changes to players. */
  refreshSeconds?: number | ((config: C) => number);
  /** Option lists for admin select widgets, keyed by the widget's `options` name. */
  options?: Record<string, (config: Partial<C>, ctx: ServerContext) => Promise<Option[]>>;
  /**
   * The slide shows a live source: the server converts it and the renderer gets
   * a WebRTC (WHEP) address as `liveUrl`. null = not configured yet.
   */
  live?(config: C): LiveInput | null;
}

export function defineSlideServer<C, D>(server: SlideServer<C, D>): SlideServer<C, D> {
  return server;
}

// --- Player renderer ---------------------------------------------------------

export interface PlayerContext {
  locale: string;
  timeZone: string;
  displayName: string;
  /** The display may play sound (set per display; off in admin previews). */
  soundAllowed: boolean;
  /** Lets the slide end early, e.g. when an animation or video finished. */
  done(): void;
  reportError(error: unknown): void;
}

/**
 * Lifecycle, driven by the player:
 *   mount → prepare (hidden, about to show) → start (visible) → stop (hidden)
 *   → start … (keepAlive) or → destroy.
 */
export interface SlideInstance {
  prepare?(): void;
  start?(): void;
  stop?(): void;
  /** New data from the server (refreshSeconds); re-render without remounting. */
  update?(data: unknown): void;
  destroy?(): void;
}

/** A media library file referenced by a `widget: 'media'` config field. */
export interface MediaInfo {
  kind: 'image' | 'video';
  url: string;
  poster: string | null;
  width: number;
  height: number;
  /** Seconds (videos). */
  duration: number | null;
}

export interface RenderProps<C, D> {
  config: C;
  data: D;
  ctx: PlayerContext;
  /** Files of the config's media fields, keyed by media id; only ready ones. */
  media: Record<string, MediaInfo>;
  /** Duration is the media length (durationFromMedia): play once, call done() at the end. */
  playsToEnd: boolean;
  /** Set when the type's server implements `document()`. */
  documentUrl?: string;
  /** WHEP endpoint of the slide's live source, when the type's server implements `live()`. */
  liveUrl?: string;
}

export type SlideRenderer<C = any, D = any> = (root: HTMLElement, props: RenderProps<C, D>) => SlideInstance | void;

export function defineRenderer<C = any, D = any>(renderer: SlideRenderer<C, D>): SlideRenderer<C, D> {
  return renderer;
}
