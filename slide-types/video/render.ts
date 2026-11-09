import { defineRenderer } from '@foyer/slide-sdk';
import type { VideoConfig } from './index.ts';

// Full-screen video. Plays once and ends the slide when the slide's duration is
// the video length; with a fixed slide duration it loops until the slide ends.
export default defineRenderer<VideoConfig>((root, { config, media, ctx, playsToEnd }) => {
  const info = media[config.mediaId];
  if (!info) throw new Error('Video nicht verfügbar');

  const video = document.createElement('video');
  video.className = `foyer-video foyer-video--${config.fill ? 'cover' : 'contain'}`;
  const withSound = config.sound && ctx.soundAllowed;
  // Set muted explicitly either way: Airtame plays sound otherwise (KONZEPT 6.2).
  video.muted = !withSound;
  video.defaultMuted = !withSound;
  if (!withSound) video.setAttribute('muted', '');
  video.loop = !playsToEnd;
  video.playsInline = true;
  video.preload = 'auto';
  if (info.poster) video.poster = info.poster;
  video.src = info.url;
  root.appendChild(video);

  let active = false;
  video.addEventListener('ended', () => active && ctx.done());
  video.addEventListener('error', () => ctx.reportError(`MediaError ${video.error?.code ?? '?'}`));

  // Only when needed: even a seek to where the video already is flushes the
  // decoder, and the video would stall right as it starts. Rewound in prepare(),
  // while hidden, so start() finds the first frame ready.
  const rewind = () => {
    if (video.currentTime === 0) return;
    try {
      video.currentTime = 0;
    } catch {
      // not seekable yet; starts from the beginning anyway
    }
  };

  const play = () => {
    const played = video.play();
    // Older Chromium returns undefined; newer a promise that rejects when autoplay is blocked.
    if (!played || typeof played.catch !== 'function') return;
    played.catch((err: Error) => {
      if (!active) return;
      if (!video.muted) {
        // Sound blocked by the browser: play silently rather than not at all.
        ctx.reportError(`Ton blockiert, Video läuft stumm (${err.message})`);
        video.muted = true;
        play();
      } else {
        ctx.reportError(err);
      }
    });
  };

  return {
    prepare() {
      if (video.readyState === 0) video.load();
      rewind();
    },
    start() {
      active = true;
      rewind();
      play();
    },
    stop() {
      active = false;
      video.pause();
    },
    destroy() {
      active = false;
      video.pause();
      // Frees the decoder right away instead of waiting for garbage collection.
      video.removeAttribute('src');
      video.load();
    },
  };
});
