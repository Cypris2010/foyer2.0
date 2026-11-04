// Plays the slides of a manifest. Only the active and the next slide are in the
// DOM (plus keepAlive slides, hidden), so memory stays flat on weak devices.
import type { PlayerContext, SlideInstance } from '@foyer/slide-sdk';
import { renderers } from './registry.ts';
import type { Manifest, ManifestSlide } from './types.ts';

const TRANSITION_MS = 1500;

interface Mounted {
  key: string;
  slide: ManifestSlide;
  el: HTMLElement;
  instance: SlideInstance;
}

// Cheap content signature: a slide is re-mounted only when its content changed.
function signature(slide: ManifestSlide): string {
  const text = JSON.stringify([slide.type, slide.config, slide.data, slide.documentUrl, slide.background]);
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
    entering.instance.start?.();
    this.current = entering;
    this.hooks.onSlideChange(slide);

    if (leaving) {
      leaving.el.classList.remove('is-active');
      leaving.el.classList.add('is-leaving');
      setTimeout(() => {
        leaving.el.classList.remove('is-leaving');
        leaving.instance.stop?.();
        // With two slides the one that just left is also the next one: prepare it again.
        if (leaving.el.classList.contains('is-next')) leaving.instance.prepare?.();
        this.cleanup();
      }, TRANSITION_MS);
    }

    const next = this.slides[(this.index + 1) % this.slides.length];
    if (next && next.id !== slide.id) {
      const prepared = this.mount(next);
      if (prepared) {
        prepared.el.classList.add('is-next');
        prepared.instance.prepare?.();
      }
    }

    this.startProgress(slide.duration);
    this.timer = setTimeout(this.advance, slide.duration * 1000);
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
    if (slide.background?.kind === 'color') el.style.background = slide.background.value;
    this.stage.appendChild(el);

    const ctx: PlayerContext = {
      locale: this.manifest.settings.locale,
      timeZone: this.manifest.settings.timeZone,
      displayName: this.manifest.display.name,
      done: () => {
        if (this.current?.key === key) this.advance();
      },
      reportError: (error) => this.hooks.onError(`${slide.title}: ${String((error as Error)?.message ?? error)}`),
    };
    try {
      const instance = renderer(el, { config: slide.config, data: slide.data, ctx, documentUrl: slide.documentUrl }) || {};
      const mounted = { key, slide, el, instance };
      this.mounted.set(key, mounted);
      return mounted;
    } catch (err) {
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
      mounted.el.remove();
      this.mounted.delete(key);
    }
  }

  private idle() {
    clearTimeout(this.timer);
    this.current?.el.classList.remove('is-active');
    this.current?.instance.stop?.();
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
