import { defineRenderer } from '@foyer/slide-sdk';
import type { WebsiteConfig } from './index.ts';
import { freshUrl, isImageUrl } from './url.ts';
import { createRefresh } from './refresh.ts';

function imageSlide(root: HTMLElement, url: string, onError: (error: unknown) => void): () => void {
  const image = document.createElement('img');
  image.className = 'foyer-website foyer-website--image';
  image.alt = '';
  image.addEventListener('error', () => onError(`Bild nicht geladen: ${url}`));
  image.src = freshUrl(url, Date.now());
  root.appendChild(image);
  // Swapped once loaded: no flicker, and a failed reload keeps the last image.
  return () => {
    const next = new Image();
    next.onload = () => {
      image.src = next.src;
    };
    next.src = freshUrl(url, Date.now());
  };
}

function pageSlide(root: HTMLElement, url: string): () => void {
  const frame = document.createElement('iframe');
  frame.className = 'foyer-website foyer-website--page';
  // No popups, no navigating the player away.
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.src = url;
  root.appendChild(frame);
  return () => {
    frame.src = url;
  };
}

export default defineRenderer<WebsiteConfig>((root, { config, ctx }) => {
  const reload = isImageUrl(config.url) ? imageSlide(root, config.url, ctx.reportError) : pageSlide(root, config.url);
  const refresh = createRefresh(reload, config.refresh);
  return { start: refresh.start, stop: refresh.stop, destroy: refresh.stop };
});
