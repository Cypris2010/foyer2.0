import type { Manifest } from './types.ts';

export interface Endpoints {
  /** display: a real screen; preview: one slide; live: follows a real display. */
  mode: 'display' | 'preview' | 'live';
  manifest: string;
  events: string | null;
  heartbeat: string | null;
  /** Where a display reports slide changes (display mode). */
  nowPlaying: string | null;
  cacheKey: string | null;
  /** Re-fetch interval for previews, which only get events in live mode. */
  pollMs: number | null;
}

/**
 * /p/<token> for displays; admin previews: /p/preview/<slideId> (one slide) and
 * /p/preview-display/<displayId> (follows what that display shows, live).
 */
export function endpointsFromPath(pathname: string): Endpoints | null {
  const live = pathname.match(/^\/p\/preview-display\/([^/]+)/);
  if (live) {
    const base = `/api/preview/displays/${live[1]}`;
    return { mode: 'live', manifest: `${base}/manifest`, events: `${base}/events`, heartbeat: null, nowPlaying: null, cacheKey: null, pollMs: 30_000 };
  }
  const preview = pathname.match(/^\/p\/preview\/([^/]+)/);
  if (preview) {
    return {
      mode: 'preview',
      manifest: `/api/preview/slides/${preview[1]}/manifest`,
      events: null,
      heartbeat: null,
      nowPlaying: null,
      cacheKey: null,
      pollMs: null,
    };
  }
  const display = pathname.match(/^\/p\/([^/]+)/);
  if (!display) return null;
  const base = `/api/player/${display[1]}`;
  return {
    mode: 'display',
    manifest: `${base}/manifest`,
    events: `${base}/events?session=${sessionId}`,
    heartbeat: `${base}/heartbeat`,
    nowPlaying: `${base}/now-playing`,
    cacheKey: 'foyer.manifest',
    pollMs: null,
  };
}

// Random per page load; the server allows one session per display (one device).
export const sessionId = (() => {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.prototype.map.call(bytes, (b: number) => (b < 16 ? '0' : '') + b.toString(16)).join('');
})();

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function fetchManifest(url: string): Promise<Manifest> {
  const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin', headers: { 'X-Foyer-Session': sessionId } });
  if (!res.ok) throw new HttpError(res.status, `Manifest: HTTP ${res.status}`);
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
    headers: { 'Content-Type': 'application/json', 'X-Foyer-Session': sessionId },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  });
}
