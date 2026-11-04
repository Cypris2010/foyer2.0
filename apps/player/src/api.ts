import type { Manifest } from './types.ts';

export interface Endpoints {
  mode: 'display' | 'preview';
  manifest: string;
  events: string | null;
  heartbeat: string | null;
  cacheKey: string | null;
}

/** /p/<token> for displays, /p/preview/<slideId> for admin previews. */
export function endpointsFromPath(pathname: string): Endpoints | null {
  const preview = pathname.match(/^\/p\/preview\/([^/]+)/);
  if (preview) {
    return { mode: 'preview', manifest: `/api/preview/slides/${preview[1]}/manifest`, events: null, heartbeat: null, cacheKey: null };
  }
  const display = pathname.match(/^\/p\/([^/]+)/);
  if (!display) return null;
  const base = `/api/player/${display[1]}`;
  return { mode: 'display', manifest: `${base}/manifest`, events: `${base}/events`, heartbeat: `${base}/heartbeat`, cacheKey: 'foyer.manifest' };
}

export async function fetchManifest(url: string): Promise<Manifest> {
  const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
  if (!res.ok) throw new Error(`Manifest: HTTP ${res.status}`);
  return res.json();
}

// The last manifest is kept so a cold start (Airtame reboots and reloads after
// every screen share) shows content immediately, even before the network answers.
export function loadCachedManifest(key: string | null): Manifest | null {
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Manifest) : null;
  } catch {
    return null;
  }
}

export function storeManifest(key: string | null, manifest: Manifest) {
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(manifest));
  } catch {
    // Storage full or unavailable: the player still works, just without a warm start.
  }
}

export function clearCachedManifest(key: string | null) {
  if (!key) return;
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

export function postJson(url: string, body: unknown) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  });
}
