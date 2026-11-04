// Mirrors apps/server/src/manifest.ts (kept separate so the player bundle has no server imports).
export interface ManifestSlide {
  id: string;
  type: string;
  title: string;
  duration: number;
  keepAlive: boolean;
  config: unknown;
  data: unknown;
  documentUrl?: string;
  background: { kind: 'color'; value: string } | null;
  error?: string;
}

export interface Manifest {
  version: string;
  generatedAt: string;
  display: { id: string; name: string; showProgress: boolean; orientation: string };
  channel: { id: string; name: string; transition: 'fade' | 'slide' | 'none' } | null;
  slides: ManifestSlide[];
  nextChange: string | null;
  settings: { locale: string; timeZone: string };
}
