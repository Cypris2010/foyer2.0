/**
 * Reloads every `seconds` while the slide runs (0: never). start() may come
 * again for the slide already on screen: a display with only this slide shows
 * it anew at every slot boundary. A running timer is then kept, otherwise
 * slots shorter than the interval would restart it before it ever fires.
 */
export function createRefresh(reload: () => void, seconds: number) {
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  return {
    start() {
      if (timer === null && seconds > 0) timer = setInterval(reload, seconds * 1000);
    },
    stop,
  };
}
