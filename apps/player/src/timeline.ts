// Fixed timeline: which slide is on screen follows from the clock alone, so
// displays with the same slides and the same (server) clock show the same
// slide at the same moment. The loop restarts every `total` ms since 1970.

export interface Slot {
  index: number;
  /** Clock time (ms) the slot begins and ends. */
  start: number;
  end: number;
}

const MIN_SLOT_MS = 1000;

const slotMs = (seconds: number) => Math.max(MIN_SLOT_MS, Math.round(seconds * 1000));

/** The slot at clock time t, or null without slides. */
export function slotAt(durations: number[], t: number): Slot | null {
  if (!durations.length) return null;
  const lengths = durations.map(slotMs);
  const total = lengths.reduce((sum, ms) => sum + ms, 0);
  let start = t - (((t % total) + total) % total);
  for (let index = 0; ; index = (index + 1) % lengths.length) {
    const end = start + lengths[index];
    if (t < end) return { index, start, end };
    start = end;
  }
}

// Within this, a video counts as on time; beyond SEEK_S it jumps instead of
// catching up by speed (which would take too long and sound odd).
const ON_TIME_S = 0.04;
const SEEK_S = 1;
const MAX_RATE_CHANGE = 0.05;
const CHECK_MS = 1000;
const SEEK_COOLDOWN_MS = 3000;

/** Where a video should be after `seconds` on screen (null: past its end). */
export function videoTarget(seconds: number, length: number, loop: boolean): number | null {
  if (!Number.isFinite(length) || length <= 0) return seconds;
  if (loop) return seconds % length;
  return seconds < length ? seconds : null;
}

/** Playback rate that closes the gap: ahead (positive) → slower, behind → faster. */
export function catchUpRate(ahead: number): number {
  if (Math.abs(ahead) <= ON_TIME_S) return 1;
  return 1 - Math.max(-MAX_RATE_CHANGE, Math.min(MAX_RATE_CHANGE, ahead * 0.5));
}

/** Moves every video of a slide (content and background) to the given time. */
export function seekVideos(el: HTMLElement, seconds: number) {
  for (const video of Array.from(el.querySelectorAll('video'))) {
    const seek = () => {
      const target = videoTarget(seconds, video.duration, video.loop) ?? video.duration - 0.1;
      try {
        video.currentTime = target;
      } catch {
        // not seekable; keeps playing from where it is
      }
    };
    if (video.readyState >= 1) seek();
    else video.addEventListener('loadedmetadata', seek, { once: true });
  }
}

/**
 * Keeps the videos of a visible slide on the clock: small gaps by playback
 * speed, large ones (stalls, slow start) by seeking. Returns the stop function.
 */
export function keepVideosOnClock(el: HTMLElement, elapsedSeconds: () => number): () => void {
  let seekedAt = -Infinity;
  const check = () => {
    for (const video of Array.from(el.querySelectorAll('video'))) {
      if (video.paused || video.readyState < 2) continue;
      const target = videoTarget(elapsedSeconds(), video.duration, video.loop);
      if (target === null) continue;
      let ahead = video.currentTime - target;
      // Looping: 0.1 s after the wrap is close to 9.9 s, not 9.8 s behind.
      if (video.loop && Number.isFinite(video.duration)) {
        if (ahead > video.duration / 2) ahead -= video.duration;
        else if (ahead < -video.duration / 2) ahead += video.duration;
      }
      if (Math.abs(ahead) >= SEEK_S) {
        if (performance.now() - seekedAt < SEEK_COOLDOWN_MS) continue;
        seekedAt = performance.now();
        video.playbackRate = 1;
        try {
          video.currentTime = target;
        } catch {
          // not seekable
        }
      } else {
        const rate = catchUpRate(ahead);
        if (video.playbackRate !== rate) video.playbackRate = rate;
      }
    }
  };
  const timer = setInterval(check, CHECK_MS);
  return () => {
    clearInterval(timer);
    for (const video of Array.from(el.querySelectorAll('video'))) video.playbackRate = 1;
  };
}
