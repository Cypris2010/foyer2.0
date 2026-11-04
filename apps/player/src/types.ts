// Mirrors apps/server/src/manifest.ts (kept separate so the player bundle has no server imports).
import type { MediaInfo } from '@foyer/slide-sdk';
export type Background =
  | { kind: 'color'; value: string }
  | { kind: 'image'; url: string; fit: 'cover' | 'contain'; dim: number }
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
  /** personalData types: `data` comes from here (data.ts), not from the manifest. */
  dataUrl?: string;
  dataVersion?: string;
  background: Background | null;
  media: Record<string, MediaInfo>;
  playsToEnd: boolean;
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
  /** Display previews only: the slide the real player reported last; null = offline. */
  nowPlaying?: { slideId: string | null; version: string | null; at: number; elapsedMs?: number } | null;
}
