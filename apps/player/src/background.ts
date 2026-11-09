// Image and video backgrounds behind a slide. Videos are prepared muted while
// the slide is next, play only while it is visible, and release their decoder
// when the slide leaves the DOM (weak devices hold few video decoders).
import type { Background } from './types.ts';

export interface BackgroundControl {
  prepare(): void;
  start(): void;
  stop(): void;
  destroy(): void;
}

const NONE: BackgroundControl = { prepare() {}, start() {}, stop() {}, destroy() {} };

/** Slow zoom over the whole slide, as in wp-foyer. */
const ZOOM_SCALE = 1.15;

function zoomControl(img: HTMLImageElement, seconds: number): BackgroundControl {
  const reset = () => {
    img.style.transition = 'none';
    img.style.transform = 'scale(1)';
  };
  reset();
  return {
    prepare: reset,
    start() {
      reset();
      void img.offsetWidth; // Applies the start state, or nothing would animate.
      img.style.transition = `transform ${seconds}s ease-in-out`;
      img.style.transform = `scale(${ZOOM_SCALE})`;
    },
    stop: reset,
    destroy() {},
  };
}

export function mountBackground(slideEl: HTMLElement, background: Background | null, seconds: number, onError: (message: string) => void): BackgroundControl {
  if (!background) return NONE;
  if (background.kind === 'color') {
    slideEl.style.background = background.value;
    return NONE;
  }

  slideEl.classList.add('has-bg');
  const layer = document.createElement('div');
  layer.className = 'foyer-bg';
  slideEl.appendChild(layer);
  if (background.dim > 0) {
    const shade = document.createElement('div');
    shade.className = 'foyer-bg__dim';
    shade.style.opacity = String(background.dim / 100);
    layer.appendChild(shade);
  }

  if (background.kind === 'image') {
    const img = document.createElement('img');
    img.className = `foyer-bg__media foyer-bg__media--${background.fit}`;
    img.alt = '';
    img.decoding = 'async';
    img.src = background.url;
    layer.insertBefore(img, layer.firstChild);
    return background.zoom ? zoomControl(img, seconds) : NONE;
  }

  const video = document.createElement('video');
  video.className = 'foyer-bg__media foyer-bg__media--cover';
  // Muted explicitly: Airtame plays sound otherwise (KONZEPT 6.2).
  video.muted = true;
  video.defaultMuted = true;
  video.setAttribute('muted', '');
  video.loop = true;
  video.playsInline = true;
  video.preload = 'auto';
  if (background.poster) video.poster = background.poster;
  video.src = background.url;
  video.addEventListener('error', () => onError(`Hintergrundvideo: MediaError ${video.error?.code ?? '?'}`));
  layer.insertBefore(video, layer.firstChild);

  let visible = false;
  return {
    prepare() {
      if (video.readyState === 0) video.load();
    },
    start() {
      visible = true;
      const played = video.play();
      // Older Chromium returns undefined; newer a promise that rejects on autoplay blocks.
      if (played && typeof played.catch === 'function') played.catch((err: Error) => visible && onError(`Hintergrundvideo: ${err.message}`));
    },
    stop() {
      visible = false;
      video.pause();
      try {
        video.currentTime = 0;
      } catch {
        // not seekable yet
      }
    },
    destroy() {
      visible = false;
      video.pause();
      video.removeAttribute('src');
      video.load();
    },
  };
}
