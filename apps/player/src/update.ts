// Reload after a Foyer update: the server names the player bundle it serves in
// every manifest. A player running an older bundle reloads at the next slide
// boundary, so displays pick up new slide types without anyone pressing a button.

const RETRY_KEY = 'foyer-update-reload';
// Do not reload again for the same build within this time (e.g. a proxy still serving the old page).
const RETRY_MS = 10 * 60_000;

/** File name of the bundle this page runs, e.g. "index-B2m0qTK9.js"; null in development. */
export function ownBuild(): string | null {
  const script = document.querySelector('script[src*="/player/assets/"]');
  const src = script ? script.getAttribute('src') || '' : '';
  return src ? src.split('/').pop() || null : null;
}

export function createUpdateCheck(onError: (message: string) => void) {
  const own = ownBuild();
  let pending = false;

  const mayReload = (target: string): boolean => {
    try {
      const last = JSON.parse(sessionStorage.getItem(RETRY_KEY) || 'null') as { build: string; at: number } | null;
      if (last && last.build === target && Date.now() - last.at < RETRY_MS) return false;
      sessionStorage.setItem(RETRY_KEY, JSON.stringify({ build: target, at: Date.now() }));
    } catch {
      // No storage: reload anyway; the 8 h full reload stays the fallback.
    }
    return true;
  };

  return {
    /** Call with every fetched manifest's playerBuild. */
    check(serverBuild: string | null | undefined) {
      if (pending || !own || !serverBuild || serverBuild === own) return;
      if (!mayReload(serverBuild)) {
        onError(`Player veraltet (${own}, Server: ${serverBuild}), Neuladen hat nicht geholfen`);
        return;
      }
      pending = true;
    },
    /** True when the page should reload now (call at a slide boundary or while idle). */
    get due(): boolean {
      return pending;
    },
  };
}
