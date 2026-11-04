import './styles.css';
import { clearCachedManifest, endpointsFromPath, fetchManifest, HttpError, loadCachedManifest, postJson, storeManifest } from './api.ts';
import { Ticker } from './ticker.ts';
import type { Manifest } from './types.ts';

const HEARTBEAT_MS = 30_000;
const POLL_WITH_SSE_MS = 5 * 60_000;
const POLL_WITHOUT_SSE_MS = 60_000;
// While another device holds the display, check again this often.
const BUSY_RETRY_MS = 60_000;
// After an admin released this device, stay away so another one can take over.
const RELEASED_PAUSE_MS = 2 * 60_000;
// Periodic full reload as memory hygiene, like wp-foyer (8 h).
const FULL_RELOAD_MS = 8 * 3600_000;

const stage = document.getElementById('stage')!;
const progress = document.getElementById('progress')!;
const overlay = document.getElementById('overlay')!;
const badge = document.getElementById('badge')!;

function showOverlay(text: string, ms?: number) {
  overlay.textContent = text;
  overlay.hidden = false;
  if (ms) setTimeout(() => (overlay.hidden = true), ms);
}

const errors: string[] = [];
function recordError(message: string) {
  errors.push(message.slice(0, 500));
  if (errors.length > 20) errors.shift();
  console.warn('[foyer]', message);
}

const endpoints = endpointsFromPath(location.pathname);
if (!endpoints) {
  showOverlay('Ungültige Player-Adresse');
} else {
  /** active: holds the display; blocked: busy elsewhere, not allowed, or released. */
  let active = false;
  let pausedUntil = 0;
  let source: EventSource | null = null;

  const ticker = new Ticker(stage, progress, {
    onError: recordError,
    onSlideChange: (slide) => {
      // Lets the admin's live preview follow this display.
      if (endpoints.nowPlaying && active) {
        postJson(endpoints.nowPlaying, { slideId: slide?.id ?? null, version: ticker.version }).catch(() => undefined);
      }
    },
  });

  const cached = loadCachedManifest(endpoints.cacheKey);
  if (cached) ticker.setManifest(cached);

  const block = (message: string) => {
    active = false;
    source?.close();
    source = null;
    ticker.clear();
    showOverlay(message);
  };

  // Live preview: mirror the real display, or play the plan while it is offline.
  const followDisplay = (manifest: Manifest) => {
    const slideId = manifest.nowPlaying?.slideId;
    if (slideId && ticker.follow(slideId)) {
      badge.hidden = true;
    } else if (!manifest.nowPlaying) {
      ticker.autonomous();
      badge.textContent = 'Display nicht verbunden – Vorschau des Plans';
      badge.hidden = false;
    }
  };

  let nextChangeTimer: ReturnType<typeof setTimeout> | undefined;
  const refresh = async () => {
    if (Date.now() < pausedUntil) return;
    try {
      const manifest = await fetchManifest(endpoints.manifest);
      // Released while this request was in flight: keep the notice, drop the answer.
      if (Date.now() < pausedUntil) return;
      const wasActive = active;
      active = true;
      overlay.hidden = true;
      storeManifest(endpoints.cacheKey, manifest);
      ticker.setManifest(manifest);
      if (endpoints.mode === 'live') followDisplay(manifest);
      if (!wasActive) openEvents();
      clearTimeout(nextChangeTimer);
      if (manifest.nextChange) {
        const delay = Math.max(1000, Date.parse(manifest.nextChange) - Date.now() + 1000);
        nextChangeTimer = setTimeout(refresh, Math.min(delay, 2 ** 31 - 1));
      }
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 0;
      if (status === 409) {
        block('Dieses Display ist bereits auf einem anderen Gerät geöffnet.');
      } else if (status === 401 || status === 403) {
        // Token rotated, display deleted or wrong network: stop showing cached content.
        clearCachedManifest(endpoints.cacheKey);
        block('Dieses Display ist nicht freigegeben.');
      } else {
        recordError(String((err as Error).message));
      }
    }
  };

  const hasSse = typeof EventSource !== 'undefined';
  function openEvents() {
    if (!hasSse || !endpoints?.events || source) return;
    source = new EventSource(endpoints.events);
    source.addEventListener('manifest-changed', () => void refresh());
    // Reconnects are automatic; refresh afterwards in case events were missed.
    source.addEventListener('hello', () => void refresh());
    if (endpoints.mode === 'display') {
      source.addEventListener('reload', () => location.reload());
      source.addEventListener('identify', () => showOverlay(ticker.displayName || 'Foyer', 10_000));
      source.addEventListener('released', () => {
        block('Dieses Display wurde für ein anderes Gerät freigegeben.');
        pausedUntil = Date.now() + RELEASED_PAUSE_MS;
      });
    } else if (endpoints.mode === 'live') {
      source.addEventListener('now-playing', (event) => {
        const { slideId } = JSON.parse((event as MessageEvent).data);
        // Unknown slide: the display already runs a newer manifest.
        if (slideId && ticker.follow(slideId)) badge.hidden = true;
        else void refresh();
      });
    }
  }

  void refresh();
  if (endpoints.pollMs) setInterval(() => void refresh(), endpoints.pollMs);

  if (endpoints.mode === 'display') {
    // Active: rare safety polls (SSE does the rest). Blocked: retry every minute.
    setInterval(() => {
      if (!active) void refresh();
    }, BUSY_RETRY_MS);
    setInterval(() => {
      if (active) void refresh();
    }, hasSse ? POLL_WITH_SSE_MS : POLL_WITHOUT_SSE_MS);

    const heartbeat = () => {
      if (!endpoints.heartbeat || !active) return;
      postJson(endpoints.heartbeat, {
        version: ticker.version,
        slideId: ticker.currentSlideId,
        errors: errors.splice(0, errors.length),
        screen: `${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio || 1}`,
        userAgent: navigator.userAgent.slice(0, 400),
      }).catch(() => undefined);
    };
    setTimeout(heartbeat, 3000);
    setInterval(heartbeat, HEARTBEAT_MS);
    setTimeout(() => location.reload(), FULL_RELOAD_MS);
  }
}
