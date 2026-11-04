import './styles.css';
import { clearCachedManifest, endpointsFromPath, fetchManifest, loadCachedManifest, postJson, storeManifest } from './api.ts';
import { Ticker } from './ticker.ts';

const HEARTBEAT_MS = 30_000;
const POLL_WITH_SSE_MS = 5 * 60_000;
const POLL_WITHOUT_SSE_MS = 60_000;
// Periodic full reload as memory hygiene, like wp-foyer (8 h).
const FULL_RELOAD_MS = 8 * 3600_000;

const stage = document.getElementById('stage')!;
const progress = document.getElementById('progress')!;
const overlay = document.getElementById('overlay')!;

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
  const ticker = new Ticker(stage, progress, {
    onError: recordError,
    onSlideChange: () => undefined,
  });

  const cached = loadCachedManifest(endpoints.cacheKey);
  if (cached) ticker.setManifest(cached);

  let nextChangeTimer: ReturnType<typeof setTimeout> | undefined;
  const refresh = async () => {
    try {
      const manifest = await fetchManifest(endpoints.manifest);
      overlay.hidden = true;
      storeManifest(endpoints.cacheKey, manifest);
      ticker.setManifest(manifest);
      clearTimeout(nextChangeTimer);
      if (manifest.nextChange) {
        const delay = Math.max(1000, Date.parse(manifest.nextChange) - Date.now() + 1000);
        nextChangeTimer = setTimeout(refresh, Math.min(delay, 2 ** 31 - 1));
      }
    } catch (err) {
      const message = String((err as Error).message);
      // 401/403: token rotated, display deleted or wrong network. Stop showing cached content.
      if (/HTTP 40[13]/.test(message)) {
        clearCachedManifest(endpoints.cacheKey);
        showOverlay('Dieses Display ist nicht freigegeben.');
        stage.textContent = '';
      } else {
        recordError(message);
      }
    }
  };
  void refresh();

  if (endpoints.mode === 'display') {
    const hasSse = typeof EventSource !== 'undefined';
    if (hasSse && endpoints.events) {
      const source = new EventSource(endpoints.events);
      source.addEventListener('manifest-changed', () => void refresh());
      source.addEventListener('reload', () => location.reload());
      source.addEventListener('identify', () => showOverlay(ticker.displayName || 'Foyer', 10_000));
      // Reconnects are automatic; refresh afterwards in case events were missed.
      source.addEventListener('hello', () => void refresh());
    }
    setInterval(() => void refresh(), hasSse ? POLL_WITH_SSE_MS : POLL_WITHOUT_SSE_MS);

    const heartbeat = () => {
      if (!endpoints.heartbeat) return;
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
