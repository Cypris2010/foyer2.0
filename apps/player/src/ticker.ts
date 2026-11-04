// Plays the slides of a manifest. Only the active and the next slide are in the
// DOM (plus keepAlive slides, hidden), so memory stays flat on weak devices.
import type { PlayerContext, SlideInstance } from '@foyer/slide-sdk';
import { renderers } from './registry.ts';
import type { Manifest, ManifestSlide } from './types.ts';
import { mountBackground, type BackgroundControl } from './background.ts';

const TRANSITION_MS = 1500;
// Slides that end with their media get this much extra before the timer takes over.
const END_GRACE_S = 3;
// Live preview: seek media only when the display is clearly ahead.
const CATCH_UP_MIN_S = 1;

interface Mounted {
  key: string;
  slide: ManifestSlide;
  el: HTMLElement;
  instance: SlideInstance;
  background: BackgroundControl;
}

// Cheap content signature: a slide is re-mounted only when its content changed.
function signature(slide: ManifestSlide): string {
  const text = JSON.stringify([slide.type, slide.config, slide.data, slide.documentUrl, slide.background, slide.media, slide.playsToEnd]);
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return `${slide.id}:${hash}`;
}

export interface TickerHooks {
  onError(message: string): void;
  onSlideChange(slide: ManifestSlide | null): void;
}

export class Ticker {
  private manifest: Manifest | null = null;
  private pending: Manifest | null = null;
  private slides: ManifestSlide[] = [];
  private index = -1;
  private current: Mounted | null = null;
  private mounted = new Map<string, Mounted>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private shownAt = 0;
  /** Live preview: slides change only when follow() is called, never by timer. */
  private following = false;
  private readonly stage: HTMLElement;
  private readonly progress: HTMLElement;
  private readonly hooks: TickerHooks;

  constructor(stage: HTMLElement, progress: HTMLElement, hooks: TickerHooks) {
    this.stage = stage;
    this.progress = progress;
    this.hooks = hooks;
  }

  get version(): string | null {
    return this.manifest?.version ?? null;
  }

  get currentSlideId(): string | null {
    return this.current?.slide.id ?? null;
  }

  /** How long the current slide has been on screen. */
  get elapsedMs(): number {
    return this.current ? Math.round(performance.now() - this.shownAt) : 0;
  }

  get displayName(): string {
    return this.manifest?.display.name ?? '';
  }

  /** New manifests take effect at the next slide boundary, never mid-slide. */
  setManifest(manifest: Manifest) {
    if (this.manifest && manifest.version === this.manifest.version && !this.pending) return;
    if (!this.manifest || !this.current) {
      this.apply(manifest);
      this.advance();
    } else {
      this.pending = manifest;
    }
  }

  /**
   * Shows the slide a real display reported (live preview). Returns false when
   * the slide is unknown, so the caller can re-fetch the manifest. elapsedMs:
   * how long the display has shown it already; videos jump to the same point.
   */
  follow(slideId: string, elapsedMs = 0): boolean {
    // Just started following: what is on screen ran on our own clock so far.
    const joining = !this.following;
    this.following = true;
    clearTimeout(this.timer);
    if (this.pending) this.apply(this.pending);
    const index = this.slides.findIndex((slide) => slide.id === slideId);
    if (index < 0) return false;
    if (this.current?.slide.id !== slideId) {
      this.index = index;
      if (!this.show(this.slides[index])) return false;
    } else if (!joining) {
      return true;
    }
    if (elapsedMs / 1000 >= CATCH_UP_MIN_S && this.current) seekVideos(this.current.el, elapsedMs / 1000);
    return true;
  }

  /** Stops playback and forgets the manifest (display busy, released or not allowed). */
  clear() {
    this.manifest = null;
    this.pending = null;
    this.slides = [];
    this.idle();
  }

  /** Back to playing on its own (live preview while the display is offline). */
  autonomous() {
    if (!this.following) return;
    this.following = false;
    this.advance();
  }

  private apply(manifest: Manifest) {
    this.manifest = manifest;
    this.pending = null;
    this.slides = manifest.slides.filter((slide) => {
      if (slide.error) this.hooks.onError(`${slide.title}: ${slide.error}`);
      if (!renderers.has(slide.type)) this.hooks.onError(`Unbekannter Folientyp: ${slide.type}`);
      return !slide.error && renderers.has(slide.type);
    });
    this.stage.setAttribute('data-transition', manifest.channel?.transition ?? 'fade');
    this.progress.hidden = !manifest.display.showProgress;
  }

  private advance = () => {
    clearTimeout(this.timer);
    const previousId = this.current?.slide.id;
    if (this.pending) {
      this.apply(this.pending);
      // Continue after the slide that was showing, if it still exists.
      const at = this.slides.findIndex((slide) => slide.id === previousId);
      this.index = at;
    }
    if (!this.slides.length) return this.idle();

    // Skip slides whose renderer fails, but never loop forever.
    for (let attempt = 0; attempt < this.slides.length; attempt++) {
      this.index = (this.index + 1) % this.slides.length;
      if (this.show(this.slides[this.index])) return;
    }
    this.idle();
  };

  private show(slide: ManifestSlide): boolean {
    const entering = this.mount(slide);
    if (!entering) return false;
    const leaving = this.current && this.current !== entering ? this.current : null;

    entering.el.classList.remove('is-next', 'is-leaving');
    entering.el.classList.add('is-active');
    entering.background.start();
    entering.instance.start?.();
    this.current = entering;
    this.shownAt = performance.now();
    this.hooks.onSlideChange(slide);

    if (leaving) {
      leaving.el.classList.remove('is-active');
      leaving.el.classList.add('is-leaving');
      setTimeout(() => {
        leaving.el.classList.remove('is-leaving');
        leaving.instance.stop?.();
        leaving.background.stop();
        // With two slides the one that just left is also the next one: prepare it again.
        if (leaving.el.classList.contains('is-next')) {
          leaving.background.prepare();
          leaving.instance.prepare?.();
        }
        this.cleanup();
      }, TRANSITION_MS);
    }

    const next = this.slides[(this.index + 1) % this.slides.length];
    if (next && next.id !== slide.id) {
      const prepared = this.mount(next);
      if (prepared) {
        prepared.el.classList.add('is-next');
        prepared.background.prepare();
        prepared.instance.prepare?.();
      }
    }

    if (!this.following) {
      this.startProgress(slide.duration);
      // Media slides end themselves via done(); the timer only catches a stalled video.
      this.timer = setTimeout(this.advance, (slide.duration + (slide.playsToEnd ? END_GRACE_S : 0)) * 1000);
    }
    return true;
  }

  private mount(slide: ManifestSlide): Mounted | null {
    const key = signature(slide);
    const existing = this.mounted.get(key);
    if (existing) return existing;
    const renderer = renderers.get(slide.type);
    if (!renderer || !this.manifest) return null;

    const el = document.createElement('div');
    el.className = `foyer-slide foyer-slide--${slide.type}`;
    this.stage.appendChild(el);
    const background = mountBackground(el, slide.background, (message) => this.hooks.onError(`${slide.title}: ${message}`));

    const ctx: PlayerContext = {
      locale: this.manifest.settings.locale,
      timeZone: this.manifest.settings.timeZone,
      displayName: this.manifest.display.name,
      soundAllowed: this.manifest.display.soundAllowed === true,
      // While following, only the real display decides when a slide ends.
      done: () => {
        if (this.current?.key === key && !this.following) this.advance();
      },
      reportError: (error) => this.hooks.onError(`${slide.title}: ${String((error as Error)?.message ?? error)}`),
    };
    try {
      const instance =
        renderer(el, { config: slide.config, data: slide.data, ctx, documentUrl: slide.documentUrl, media: slide.media ?? {}, playsToEnd: slide.playsToEnd === true }) || {};
      const mounted = { key, slide, el, instance, background };
      this.mounted.set(key, mounted);
      return mounted;
    } catch (err) {
      background.destroy();
      el.remove();
      this.hooks.onError(`${slide.title}: ${String((err as Error)?.message ?? err)}`);
      return null;
    }
  }

  /** Destroys everything that is neither active, next, nor a keepAlive slide still in the channel. */
  private cleanup() {
    const keep = new Set<string>();
    if (this.current) keep.add(this.current.key);
    const next = this.slides[(this.index + 1) % this.slides.length];
    if (next) keep.add(signature(next));
    for (const slide of this.slides) if (slide.keepAlive) keep.add(signature(slide));
    for (const [key, mounted] of this.mounted) {
      if (keep.has(key) || mounted.el.classList.contains('is-leaving')) continue;
      try {
        mounted.instance.destroy?.();
      } catch (err) {
        this.hooks.onError(String(err));
      }
      mounted.background.destroy();
      mounted.el.remove();
      this.mounted.delete(key);
    }
  }

  private idle() {
    clearTimeout(this.timer);
    this.current?.el.classList.remove('is-active');
    this.current?.instance.stop?.();
    this.current?.background.stop();
    this.current = null;
    this.index = -1;
    this.cleanup();
    this.progress.hidden = true;
    this.hooks.onSlideChange(null);
  }

  private startProgress(seconds: number) {
    const bar = this.progress;
    bar.style.transition = 'none';
    bar.style.transform = 'scaleX(0)';
    void bar.offsetWidth; // restart the transition
    bar.style.transition = `transform ${seconds}s linear`;
    bar.style.transform = 'scaleX(1)';
  }
}

/** Moves every video of a slide (content and background) to the given time. */
function seekVideos(el: HTMLElement, seconds: number) {
  for (const video of Array.from(el.querySelectorAll('video'))) {
    const seek = () => {
      const length = video.duration;
      const target = !Number.isFinite(length) ? seconds : video.loop ? seconds % length : Math.min(seconds, length - 0.1);
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
