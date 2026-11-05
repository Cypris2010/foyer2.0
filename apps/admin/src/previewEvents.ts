// One event stream for all live thumbnails on the page. Without HTTP/2 a browser
// opens only 6 connections per host; one stream per thumbnail used them all up,
// and the admin's own requests then waited forever. The events go on to the
// thumbnail iframes (players with ?relay) by display id.

// The events a live preview player listens to.
const EVENTS = ['hello', 'manifest-changed', 'now-playing'];

const frames = new Map<HTMLIFrameElement, string>();
let source: EventSource | null = null;
let connectedTo = '';
let timer: ReturnType<typeof setTimeout> | undefined;

function forward(event: string, raw: string) {
  const { key, ...data } = JSON.parse(raw) as { key?: string };
  // "hello" (connected again) has no key: every thumbnail refreshes.
  for (const [frame, displayId] of frames) {
    if (!key || key === displayId) frame.contentWindow?.postMessage({ type: 'foyer-event', event, data }, location.origin);
  }
}

// Thumbnails come and go together (page change, filter): reconnect once afterwards.
function reconnect() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const ids = [...new Set(frames.values())].sort().join(',');
    if (ids === connectedTo) return;
    source?.close();
    source = null;
    connectedTo = ids;
    if (!ids) return;
    source = new EventSource(`/api/preview/events?displays=${encodeURIComponent(ids)}`);
    for (const event of EVENTS) source.addEventListener(event, (e) => forward(event, (e as MessageEvent).data));
  }, 100);
}

/** Passes the live events of a display to this iframe until the returned function is called. */
export function relayPreviewEvents(frame: HTMLIFrameElement, displayId: string): () => void {
  frames.set(frame, displayId);
  reconnect();
  return () => {
    frames.delete(frame);
    reconnect();
  };
}
