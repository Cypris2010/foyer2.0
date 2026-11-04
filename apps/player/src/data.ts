// Slide data with personal data (Untis) is not part of the manifest: it is
// fetched separately and kept in memory only, never in the offline cache
// (KONZEPT 3.1). Unchanged data (same dataVersion) is not fetched again.
import type { Manifest, ManifestSlide } from './types.ts';

const memory = new Map<string, unknown>();
const keyOf = (slide: ManifestSlide) => `${slide.dataUrl}#${slide.dataVersion}`;

async function fetchData(url: string): Promise<unknown> {
  const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body.data;
}

/** The manifest with the data of personalData slides filled in; slides whose data failed get an error. */
export async function withSlideData(manifest: Manifest): Promise<Manifest> {
  const needed = manifest.slides.filter((slide) => slide.dataUrl);
  if (!needed.length) return manifest;
  const filled = new Map<string, unknown>();
  const failed = new Map<string, string>();
  await Promise.all(
    needed.map(async (slide) => {
      const key = keyOf(slide);
      if (memory.has(key)) return filled.set(slide.id, memory.get(key));
      try {
        const data = await fetchData(slide.dataUrl!);
        memory.set(key, data);
        filled.set(slide.id, data);
      } catch (err) {
        failed.set(slide.id, `Daten nicht verfügbar: ${(err as Error).message}`);
      }
    }),
  );
  // Forget data no slide uses any more.
  const live = new Set(needed.map(keyOf));
  for (const key of memory.keys()) if (!live.has(key)) memory.delete(key);
  return {
    ...manifest,
    slides: manifest.slides.map((slide) => {
      if (!slide.dataUrl) return slide;
      const error = failed.get(slide.id);
      return error ? { ...slide, error } : { ...slide, data: filled.get(slide.id) };
    }),
  };
}

/** Cold start from the offline cache: personalData slides wait for the network. */
export function withoutSlideData(manifest: Manifest): Manifest {
  if (!manifest.slides.some((slide) => slide.dataUrl)) return manifest;
  // Own version, so the fresh manifest (same version) is not ignored as unchanged.
  return { ...manifest, version: `${manifest.version}-ohne-daten`, slides: manifest.slides.filter((slide) => !slide.dataUrl) };
}
