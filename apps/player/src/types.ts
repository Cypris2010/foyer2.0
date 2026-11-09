// Mirrors apps/server/src/manifest.ts (kept separate so the player bundle has no server imports).
import type { MediaInfo } from '@foyer/slide-sdk';
export type Background =
  | { kind: 'color'; value: string }
  | { kind: 'image'; url: string; fit: 'cover' | 'contain'; dim: number; zoom: boolean }
  | { kind: 'video'; url: string; poster: string | null; dim: number };

export interface ManifestSlide {
  id: string;
  type: string;
  title: string;
  duration: number;
  keepAlive: boolean;
  config: unknown;
  data: unknown;
  documentUrl?: string;
  /** Live types: signed WHEP endpoint of the gateway. */
  liveUrl?: string;
  /** personalData types: `data` comes from here (data.ts), not from the manifest. */
  dataUrl?: string;
  dataVersion?: string;
  background: Background | null;
  media: Record<string, MediaInfo>;
  playsToEnd: boolean;
  /** Credit lines of imported media (license terms), shown in a corner. */
  credits?: string[];
  error?: string;
}

export interface Manifest {
  version: string;
  generatedAt: string;
  display: { id: string; name: string; showProgress: boolean; orientation: string; soundAllowed?: boolean };
  channel: { id: string; name: string; transition: 'fade' | 'slide' | 'none' } | null;
  slides: ManifestSlide[];
  nextChange: string | null;
  settings: { locale: string; timeZone: string };
  /** Player bundle the server serves; when it differs from ours, reload (update.ts). */
  playerBuild?: string | null;
  /** Part of a wall: where this screen sits (wall.ts). */
  wall?: {
    id: string;
    name: string;
    rows: number;
    cols: number;
    row: number;
    col: number;
    bezel: number;
    screen: string;
    /** span: one big picture (wall shell); stack: one slide per screen (ticker offset). */
    mode?: 'span' | 'stack';
    position?: number;
    screens?: number;
  } | null;
  /** Display previews only: the slide the real player reported last; null = offline. */
  nowPlaying?: { slideId: string | null; version: string | null; at: number; elapsedMs?: number } | null;
}
