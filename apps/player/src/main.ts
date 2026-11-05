import './styles.css';
import { clearCachedManifest, endpointsFromPath, fetchManifest, fetchServerTime, HttpError, loadCachedManifest, postJson, sessionId, storeManifest } from './api.ts';
import { Ticker } from './ticker.ts';
import { ServerClock } from './clock.ts';
import { followWall, inWallFrame, isWallShell, reloadScreen, runWallShell, wallOverlay, type Wall } from './wall.ts';
import { withSlideData, withoutSlideData } from './data.ts';
import { createUpdateCheck, ownBuild } from './update.ts';
import { createTestPattern } from './testpattern.ts';
import type { Manifest } from './types.ts';

const HEARTBEAT_MS = 30_000;
// Server clock: a few quick samples at start (best one wins), then one per heartbeat.
const CLOCK_START_SAMPLES = 5;
const CLOCK_START_GAP_MS = 300;
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
  overlay.hidden = !text;
  if (ms) setTimeout(() => (overlay.hidden = true), ms);
}

// Inside a wall the shell shows overlays, on this screen only.
const notice = (text: string, ms?: number) => wallOverlay(text, ms) || showOverlay(text, ms);
const hideNotice = () => {
  overlay.hidden = true;
  wallOverlay('');
};

const errors: string[] = [];
function recordError(message: string) {
  errors.push(message.slice(0, 500));
  if (errors.length > 20) errors.shift();
  console.warn('[foyer]', message);
}

const endpoints = endpointsFromPath(location.pathname);
if (!endpoints) {
  showOverlay('Ungültige Player-Adresse');
} else if (isWallShell && endpoints.mode === 'display') {
  runWallShell(sessionId, overlay, showOverlay);
} else {
  /** Set while this screen is part of a wall (from the manifest). */
  let wall: Wall | null = null;
  /** active: holds the display; blocked: busy elsewhere, not allowed, or released. */
  let active = false;
  let pausedUntil = 0;
  let eventSource: EventSource | null = null;

  // Lets the admin's live preview follow this display.
  const reportNowPlaying = () => {
    if (!endpoints.nowPlaying || !active) return;
    postJson(endpoints.nowPlaying, { slideId: ticker.currentSlideId, version: ticker.version, elapsedMs: ticker.elapsedMs }).catch(() => undefined);
  };

  const update = createUpdateCheck(recordError);
  // Displays run on the server's clock, so all of them switch slides together.
  // Previews start their own timeline at page load (from the first slide).
  const clock = endpoints.mode === 'display' ? new ServerClock() : null;
  const pageStart = Date.now();
  const now =
    endpoints.mode === 'display' ? () => clock!.now() : endpoints.mode === 'preview' ? () => Date.now() - pageStart : Date.now;
  const ticker = new Ticker(stage, progress, {
    onError: recordError,
    onSlideChange: () => {
      // New Foyer version on the server: reload between slides, never mid-slide.
      if (update.due) return reloadScreen();
      reportNowPlaying();
    },
  }, now);
  if (clock) clock.onShift = () => ticker.resync();

  const testPattern = createTestPattern(now, () => ({
    name: wall?.screen ?? (ticker.displayName || 'Foyer'),
    wall,
    build: ownBuild(),
    clockOffset: now() - Date.now(),
  }));

  const cached = loadCachedManifest(endpoints.cacheKey);
  // Part of a wall (cold start): straight into the wall shell.
  const leaving = cached?.wall && !inWallFrame && endpoints.mode === 'display';
  if (leaving) followWall(cached.wall);
  else if (cached) ticker.setManifest(withoutSlideData(cached));

  // Only while holding the display: every player request also claims it.
  const syncClock = async () => {
    if (clock && endpoints.time && active) await clock.sync(endpoints.time, fetchServerTime);
  };
  const syncClockQuickly = async () => {
    for (let i = 0; i < CLOCK_START_SAMPLES; i++) {
      await syncClock();
      await new Promise((resolve) => setTimeout(resolve, CLOCK_START_GAP_MS));
    }
  };

  const block = (message: string) => {
    active = false;
    eventSource?.close();
    eventSource = null;
    ticker.clear();
    testPattern.show(null);
    notice(message);
  };

  // Live preview: mirror the real display, or play the plan while it is offline.
  const followDisplay = (manifest: Manifest) => {
    const slideId = manifest.nowPlaying?.slideId;
    if (slideId && ticker.follow(slideId, manifest.nowPlaying?.elapsedMs)) {
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
      const fetched = await fetchManifest(endpoints.manifest);
      // Released while this request was in flight: keep the notice, drop the answer.
      if (Date.now() < pausedUntil) return;
      // Cached as delivered: without personal data.
      storeManifest(endpoints.cacheKey, fetched);
      const manifest = await withSlideData(fetched);
      if (Date.now() < pausedUntil) return;
      const wasActive = active;
      active = true;
      hideNotice();
      if (endpoints.mode === 'display') {
        wall = manifest.wall ?? null;
        followWall(wall);
        // Joined a wall: the shell takes over from here.
        if (wall && !inWallFrame) return;
      }
      // Started from the cache, the first slide went unreported.
      if (!wasActive && ticker.currentSlideId) reportNowPlaying();
      update.check(manifest.playerBuild);
      // Nothing on screen: no boundary to wait for.
      if (update.due && !ticker.currentSlideId) return reloadScreen();
      ticker.setManifest(manifest);
      if (endpoints.mode === 'live') followDisplay(manifest);
      if (!wasActive) {
        openEvents();
        void syncClockQuickly();
      }
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
  // Admin thumbnails: the page around them holds one stream for all and passes the events on.
  const relayed = endpoints.mode === 'live' && new URLSearchParams(location.search).has('relay');
  let relay: EventTarget | null = null;
  function openEvents() {
    let source: EventTarget;
    if (relayed) {
      if (relay) return;
      source = relay = new EventTarget();
      addEventListener('message', (event) => {
        if (event.origin !== location.origin || event.source !== parent || event.data?.type !== 'foyer-event') return;
        relay!.dispatchEvent(new MessageEvent(event.data.event, { data: JSON.stringify(event.data.data) }));
      });
    } else {
      if (!hasSse || !endpoints?.events || eventSource) return;
      source = eventSource = new EventSource(endpoints.events);
    }
    source.addEventListener('manifest-changed', () => void refresh());
    // Reconnects are automatic; refresh afterwards in case events were missed.
    source.addEventListener('hello', () => void refresh());
    if (endpoints.mode === 'display') {
      // Connected again (e.g. after a server restart, which forgets what we show).
      source.addEventListener('hello', reportNowPlaying);
      source.addEventListener('reload', reloadScreen);
      source.addEventListener('test-pattern', (event) => testPattern.show(JSON.parse((event as MessageEvent).data)));
      source.addEventListener('identify', () =>
        notice(wall ? `${wall.screen} · ${wall.name}, Zeile ${wall.row + 1}, Spalte ${wall.col + 1}` : ticker.displayName || 'Foyer', 10_000),
      );
      source.addEventListener('released', () => {
        block('Dieses Display wurde für ein anderes Gerät freigegeben.');
        pausedUntil = Date.now() + RELEASED_PAUSE_MS;
      });
    } else if (endpoints.mode === 'live') {
      source.addEventListener('now-playing', (event) => {
        const { slideId, elapsedMs } = JSON.parse((event as MessageEvent).data);
        // Unknown slide: the display already runs a newer manifest.
        if (slideId && ticker.follow(slideId, elapsedMs)) badge.hidden = true;
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
    setInterval(syncClock, HEARTBEAT_MS);
    setTimeout(reloadScreen, FULL_RELOAD_MS);
  }
}
