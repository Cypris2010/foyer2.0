// Display walls. A screen that is part of a wall runs as a thin shell around
// the real player: the player sits in an iframe as large as the whole wall
// (so slides lay out for the wall's format, vmin and media queries included)
// and the shell shows only this screen's part of it. Bezels: the iframe grows
// by the frames between screens, and that strip is never shown.
//
//   /p/<token>                 normal player; jumps to ?wall when the manifest says so
//   /p/<token>?wall            shell (top level)
//   /p/<token>?frame=wall&…    player inside the shell; reports the wall to it
import type { Manifest } from './types.ts';

export type Wall = NonNullable<Manifest['wall']>;

type Message = { foyer: 'wall'; wall: Wall | null } | { foyer: 'overlay'; text: string; ms?: number };

// Guarded: tests import wallGeometry() without a browser.
const browser = typeof window !== 'undefined';
const query = new URLSearchParams(browser ? location.search : '');

/** This page is the player inside a wall shell. */
export const inWallFrame = browser && query.get('frame') === 'wall' && window.parent !== window;

/** This page is the shell (top level). */
export const isWallShell = query.has('wall') && !inWallFrame;

/** Session id handed down by the shell, so shell and frame count as one device. */
export const frameSession = inWallFrame ? query.get('session') : null;

/** Called with every manifest: switches between normal player and wall. */
export function followWall(wall: Wall | null | undefined) {
  if (inWallFrame) post({ foyer: 'wall', wall: wall ?? null });
  else if (wall) location.replace(`${location.pathname}?wall`);
}

/** Overlays belong on the screen itself, not somewhere on the big wall canvas. */
export function wallOverlay(text: string, ms?: number): boolean {
  if (!inWallFrame) return false;
  post({ foyer: 'overlay', text, ms });
  return true;
}

/** Reloads the whole screen, shell included (new player version, admin "reload"). */
export function reloadScreen() {
  (inWallFrame ? window.parent : window).location.reload();
}

function post(message: Message) {
  window.parent.postMessage(message, location.origin);
}

/** Size and offset of the frame for one screen of the wall. */
export function wallGeometry(wall: Wall, screenWidth: number, screenHeight: number) {
  const stepX = screenWidth + wall.bezel;
  const stepY = screenHeight + wall.bezel;
  return {
    width: wall.cols * stepX - wall.bezel,
    height: wall.rows * stepY - wall.bezel,
    x: -wall.col * stepX,
    y: -wall.row * stepY,
  };
}

export function runWallShell(sessionId: string, overlay: HTMLElement, showOverlay: (text: string, ms?: number) => void) {
  for (const id of ['stage', 'progress', 'badge']) document.getElementById(id)?.remove();
  const frame = document.createElement('iframe');
  frame.className = 'foyer-wall-frame';
  frame.title = '';
  frame.src = `${location.pathname}?frame=wall&session=${encodeURIComponent(sessionId)}`;
  frame.allow = 'autoplay';
  // Until the player reports its wall: full screen, so a cached start shows something.
  frame.style.width = '100%';
  frame.style.height = '100%';
  document.body.insertBefore(frame, overlay);

  let wall: Wall | null = null;
  const layout = () => {
    if (!wall) return;
    const { width, height, x, y } = wallGeometry(wall, window.innerWidth, window.innerHeight);
    frame.style.width = `${width}px`;
    frame.style.height = `${height}px`;
    frame.style.transform = `translate(${x}px, ${y}px)`;
  };
  window.addEventListener('resize', layout);
  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin || event.source !== frame.contentWindow) return;
    const message = event.data as Message;
    if (message?.foyer === 'overlay') showOverlay(message.text, message.ms);
    else if (message?.foyer === 'wall') {
      // Left the wall: back to the normal player.
      if (!message.wall) return location.replace(location.pathname);
      wall = message.wall;
      layout();
    }
  });
}
