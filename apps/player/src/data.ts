// Slide data with personal data (Untis) is not part of the manifest: it is
// fetched separately and kept in memory only, never in the offline cache
// (KONZEPT 3.1). Unchanged data (same dataVersion) is not fetched again.
import type { Manifest, ManifestSlide } from './types.ts';

const memory = new Map<string, unknown>();
/** Last data each slide showed: a failed fetch keeps it on screen instead of dropping the slide. */
const lastGood = new Map<string, unknown>();
const keyOf = (slide: ManifestSlide) => `${slide.dataUrl}#${slide.dataVersion}`;

async function fetchData(url: string): Promise<unknown> {
  const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body.data;
}

export interface SlideDataResult {
  manifest: Manifest;
  /** Some data failed to load: the caller should try again soon. */
  retry: boolean;
  /** Slides that kept their last data after a failed fetch ("<title>: <reason>"); slides without any carry `error` instead. */
  stale: string[];
}

/**
 * The manifest with the data of personalData slides filled in. A failed fetch
 * keeps the slide's last data (still the old version), or, without any, gives
 * the slide an error. Either way the manifest gets its own version: the same
 * manifest fetched again once the network is back must not count as unchanged,
 * or the slide would stay stale or missing until the Untis data changes.
 */
export async function withSlideData(manifest: Manifest): Promise<SlideDataResult> {
  const needed = manifest.slides.filter((slide) => slide.dataUrl);
  if (!needed.length) return { manifest, retry: false, stale: [] };
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
        if (lastGood.has(slide.id)) filled.set(slide.id, lastGood.get(slide.id));
      }
    }),
  );
  for (const [id, data] of filled) if (!failed.has(id)) lastGood.set(id, data);
  // Forget data no slide uses any more.
  const live = new Set(needed.map(keyOf));
  for (const key of memory.keys()) if (!live.has(key)) memory.delete(key);
  const liveIds = new Set(needed.map((slide) => slide.id));
  for (const id of lastGood.keys()) if (!liveIds.has(id)) lastGood.delete(id);

  const retry = failed.size > 0;
  const stale = needed.filter((slide) => failed.has(slide.id) && filled.has(slide.id)).map((slide) => `${slide.title}: ${failed.get(slide.id)}`);
  return {
    retry,
    stale,
    manifest: {
      ...manifest,
      version: retry ? `${manifest.version}-daten-unvollstaendig` : manifest.version,
      slides: manifest.slides.map((slide) => {
        if (!slide.dataUrl) return slide;
        if (filled.has(slide.id)) return { ...slide, data: filled.get(slide.id) };
        return { ...slide, error: failed.get(slide.id) };
      }),
    },
  };
}

/** Cold start from the offline cache: personalData slides wait for the network. */
export function withoutSlideData(manifest: Manifest): Manifest {
  if (!manifest.slides.some((slide) => slide.dataUrl)) return manifest;
  // Own version, so the fresh manifest (same version) is not ignored as unchanged.
  return { ...manifest, version: `${manifest.version}-ohne-daten`, slides: manifest.slides.filter((slide) => !slide.dataUrl) };
}
