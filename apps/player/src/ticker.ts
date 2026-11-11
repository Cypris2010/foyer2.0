// Plays the slides of a manifest. Only the active and the next slide are in the
// DOM (plus keepAlive slides, hidden), so memory stays flat on weak devices.
import type { PlayerContext, SlideInstance } from '@foyer/slide-sdk';
import { renderers } from './registry.ts';
import type { Manifest, ManifestSlide } from './types.ts';
import { mountBackground, type BackgroundControl } from './background.ts';
import { keepVideosOnClock, seekVideos, slotAt, type Slot } from './timeline.ts';
import type { Stack } from './wall.ts';

const TRANSITION_MS = 1500;
// Joining a slide that already runs: seek media only when clearly behind.
const CATCH_UP_MIN_S = 1;
// The next slide loads once the old one is gone: weak devices stutter when a
// video starts while another one loads. Not later, it needs the time to buffer.
const PREPARE_NEXT_MS = TRANSITION_MS;

interface Mounted {
  key: string;
  /** Hash of the data the instance shows. */
  data: number;
  slide: ManifestSlide;
  el: HTMLElement;
  instance: SlideInstance;
  background: BackgroundControl;
}

function hash(text: string): number {
  let value = 5381;
  for (let i = 0; i < text.length; i++) value = ((value << 5) + value + text.charCodeAt(i)) | 0;
  return value;
}

// Cheap content signature: a slide is re-mounted only when its content changed.
// Data is left out: new data goes to update() of the mounted slide (see mount()).
function signature(slide: ManifestSlide): string {
  return `${slide.id}:${hash(JSON.stringify([slide.type, slide.config, slide.documentUrl, slide.liveUrl, slide.background, slide.media, slide.playsToEnd, slide.credits]))}`;
}

const dataHash = (slide: ManifestSlide) => hash(JSON.stringify(slide.data ?? null));

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
  private prepareTimer: ReturnType<typeof setTimeout> | undefined;
  /** Clock time the current slide began, and the slot it fills on the timeline. */
  private startedAt = 0;
  private slot: Slot | null = null;
  private stopVideoSync = () => {};
  /** Live preview: slides change only when follow() is called, never by timer. */
  private following = false;
  /** Screen of a stack wall: shows the slide `position` places behind the timeline. */
  private stack: Stack | null = null;
  private readonly stage: HTMLElement;
  private readonly progress: HTMLElement;
  private readonly hooks: TickerHooks;
  /** Epoch ms that decide the timeline (displays: the server's clock, clock.ts). */
  private readonly clock: () => number;

  constructor(stage: HTMLElement, progress: HTMLElement, hooks: TickerHooks, clock: () => number = Date.now) {
    this.stage = stage;
    this.progress = progress;
    this.hooks = hooks;
    this.clock = clock;
  }

  get version(): string | null {
    return this.manifest?.version ?? null;
  }

  get currentSlideId(): string | null {
    return this.current?.slide.id ?? null;
  }

  /** How long the current slide has been on screen. */
  get elapsedMs(): number {
    return this.current ? Math.max(0, Math.round(this.clock() - this.startedAt)) : 0;
  }

  get displayName(): string {
    return this.manifest?.display.name ?? '';
  }

  /**
   * Stack wall: every screen keeps the timeline (all of them change together)
   * but shows an older slide, so each slide moves on one screen per change.
   */
  setStack(stack: Stack | null) {
    if (stack?.position === this.stack?.position && stack?.direction === this.stack?.direction) return;
    this.stack = stack;
    if (this.manifest) this.applyTransition(this.manifest);
    // Another place in the stack: show the right slide now, not at the next change.
    this.slot = null;
    if (this.manifest) this.schedule();
  }

  /** New manifests take effect at the next slide boundary, never mid-slide. */
  setManifest(manifest: Manifest) {
    if (this.manifest && manifest.version === this.manifest.version && !this.pending) return;
    if (!this.manifest || !this.current) {
      this.apply(manifest);
      this.schedule();
    } else {
      this.pending = manifest;
      // New data (refreshSeconds) shows right away, not only at the next slide.
      for (const slide of manifest.slides) {
        // A slide whose data failed has none to show: keep what is on screen.
        if (slide.error) continue;
        const mounted = this.mounted.get(signature(slide));
        if (mounted?.instance.update) this.mount(slide);
      }
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
      if (!this.show(this.slides[index], this.clock() - elapsedMs)) return false;
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
    this.resync();
  }

  /** The clock moved (first contact with the server): show what it says now. */
  resync() {
    if (this.following || !this.manifest) return;
    const slot = slotAt(this.durations(), this.clock());
    if (slot && !this.pending && this.current && this.current.slide.id === this.slides[this.slideIndex(slot)]?.id) {
      // Same slide on screen: only its end moves, nothing restarts.
      clearTimeout(this.timer);
      this.slot = slot;
      this.timer = setTimeout(this.schedule, Math.max(0, slot.end - this.clock()));
      return;
    }
    this.slot = null;
    this.schedule();
  }

  private apply(manifest: Manifest) {
    this.manifest = manifest;
    this.pending = null;
    this.slides = manifest.slides.filter((slide) => {
      if (slide.error) this.hooks.onError(`${slide.title}: ${slide.error}`);
      if (!renderers.has(slide.type)) this.hooks.onError(`Unbekannter Folientyp: ${slide.type}`);
      return !slide.error && renderers.has(slide.type);
    });
    this.applyTransition(manifest);
    this.progress.hidden = !manifest.display.showProgress;
  }

  // A stack moves its slides on to the next screen, whatever the channel says.
  private applyTransition(manifest: Manifest) {
    this.stage.setAttribute('data-transition', this.stack ? `stack-${this.stack.direction}` : (manifest.channel?.transition ?? 'fade'));
  }

  /** The slide a slot shows here: in a stack, the one `position` places earlier. */
  private slideIndex(slot: Slot): number {
    const count = this.slides.length;
    return this.stack ? (((slot.index - this.stack.position) % count) + count) % count : slot.index;
  }

  private durations() {
    return this.slides.map((slide) => slide.duration);
  }

  /** Shows the slide the timeline has for now and waits for the end of its slot. */
  private schedule = () => {
    clearTimeout(this.timer);
    if (this.following) return;
    const now = this.clock();
    // Woken early (timer jitter) or a slide that came early via done(): its slot holds.
    if (this.current && this.slot && now < this.slot.end - 1) {
      this.timer = setTimeout(this.schedule, this.slot.end - now);
      return;
    }
    if (this.pending) this.apply(this.pending);
    // Woken in the last millisecond of the slot: that is its end, or the slide would restart.
    const slot = slotAt(this.durations(), this.current && this.slot ? Math.max(now, this.slot.end) : now);
    if (!slot) return this.idle();
    this.play(slot);
  };

  private play(slot: Slot) {
    this.index = this.slideIndex(slot);
    this.slot = slot;
    // A slide that fails to render leaves the previous one on screen for this slot.
    this.show(this.slides[this.index], Math.min(slot.start, this.clock()), slot.end);
    this.timer = setTimeout(this.schedule, Math.max(0, slot.end - this.clock()));
  }

  /**
   * done(): the next slide comes early and runs to the end of its own slot, so
   * the timeline (and every display on it) stays where it was.
   */
  private finishEarly() {
    if (!this.slot) return;
    clearTimeout(this.timer);
    if (this.pending) this.apply(this.pending);
    const next = slotAt(this.durations(), this.slot.end);
    if (!next) return this.idle();
    this.play(next);
  }

  /** start/end: clock time the slide began and its slot ends (end: not when following). */
  private show(slide: ManifestSlide, start: number, end?: number): boolean {
    const entering = this.mount(slide);
    if (!entering) return false;
    const leaving = this.current && this.current !== entering ? this.current : null;

    entering.el.classList.remove('is-next', 'is-leaving');
    entering.el.classList.add('is-active');
    entering.background.start();
    entering.instance.start?.();
    this.current = entering;
    this.startedAt = start;
    this.stopVideoSync();
    this.stopVideoSync = () => {};
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

    // Short slides: early enough that the next one is ready when its turn comes.
    const remaining = end === undefined ? Infinity : Math.max(0, end - this.clock());
    clearTimeout(this.prepareTimer);
    this.prepareTimer = setTimeout(this.prepareNext, Math.min(PREPARE_NEXT_MS, remaining / 2));

    if (!this.following && end !== undefined) {
      const elapsed = Math.max(0, this.clock() - start);
      this.startProgress((end - start) / 1000, elapsed / (end - start));
      // Joined mid-slide (start-up, wall neighbours): videos jump to the same point.
      if (elapsed >= CATCH_UP_MIN_S * 1000) seekVideos(entering.el, elapsed / 1000);
      this.stopVideoSync = keepVideosOnClock(entering.el, () => (this.clock() - start) / 1000);
    }
    return true;
  }

  private prepareNext = () => {
    if (!this.current) return;
    const next = this.slides[(this.index + 1) % this.slides.length];
    if (!next || next.id === this.current.slide.id) return;
    const prepared = this.mount(next);
    if (prepared) {
      prepared.el.classList.add('is-next');
      prepared.background.prepare();
      prepared.instance.prepare?.();
    }
  };

  private mount(slide: ManifestSlide): Mounted | null {
    const key = signature(slide);
    const existing = this.mounted.get(key);
    if (existing) {
      const data = dataHash(slide);
      if (data === existing.data) return existing;
      if (existing.instance.update) {
        try {
          existing.instance.update(slide.data);
        } catch (err) {
          this.hooks.onError(`${slide.title}: ${String((err as Error)?.message ?? err)}`);
        }
        existing.slide = slide;
        existing.data = data;
        return existing;
      }
      // Without update(): the visible slide keeps its data, a hidden one is rebuilt.
      if (existing === this.current || existing.el.classList.contains('is-leaving')) return existing;
      this.unmount(existing);
    }
    const renderer = renderers.get(slide.type);
    if (!renderer || !this.manifest) return null;

    const el = document.createElement('div');
    el.className = `foyer-slide foyer-slide--${slide.type}`;
    this.stage.appendChild(el);
    const background = mountBackground(el, slide.background, slide.duration, (message) => this.hooks.onError(`${slide.title}: ${message}`));

    const ctx: PlayerContext = {
      locale: this.manifest.settings.locale,
      timeZone: this.manifest.settings.timeZone,
      displayName: this.manifest.display.name,
      soundAllowed: this.manifest.display.soundAllowed === true,
      // While following, only the real display decides when a slide ends; in a
      // stack only the timeline, or one screen would move on without the others.
      done: () => {
        if (this.current?.key === key && !this.following && !this.stack) this.finishEarly();
      },
      reportError: (error) => this.hooks.onError(`${slide.title}: ${String((error as Error)?.message ?? error)}`),
    };
    try {
      const instance =
        renderer(el, { config: slide.config, data: slide.data, ctx, documentUrl: slide.documentUrl, liveUrl: slide.liveUrl, media: slide.media ?? {}, playsToEnd: slide.playsToEnd === true }) || {};
      if (slide.credits && slide.credits.length) {
        const credit = document.createElement('div');
        credit.className = 'foyer-credit';
        credit.textContent = slide.credits.join('  |  ');
        el.appendChild(credit);
      }
      const mounted = { key, data: dataHash(slide), slide, el, instance, background };
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
      this.unmount(mounted);
    }
  }

  private unmount(mounted: Mounted) {
    try {
      mounted.instance.destroy?.();
    } catch (err) {
      this.hooks.onError(String(err));
    }
    mounted.background.destroy();
    mounted.el.remove();
    this.mounted.delete(mounted.key);
  }

  private idle() {
    clearTimeout(this.timer);
    clearTimeout(this.prepareTimer);
    this.stopVideoSync();
    this.stopVideoSync = () => {};
    this.slot = null;
    this.current?.el.classList.remove('is-active');
    this.current?.instance.stop?.();
    this.current?.background.stop();
    this.current = null;
    this.index = -1;
    this.cleanup();
    this.progress.hidden = true;
    this.hooks.onSlideChange(null);
  }

  /** from: share of the slot already gone (joined mid-slide). */
  private startProgress(seconds: number, from = 0) {
    const bar = this.progress;
    bar.style.transition = 'none';
    bar.style.transform = `scaleX(${Math.min(1, from)})`;
    void bar.offsetWidth; // restart the transition
    bar.style.transition = `transform ${seconds * (1 - Math.min(1, from))}s linear`;
    bar.style.transform = 'scaleX(1)';
  }
}
