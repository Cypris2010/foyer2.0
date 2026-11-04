import { defineRenderer } from '@foyer/slide-sdk';
import type { HtmlConfig } from './index.ts';

type Phase = 'prepare' | 'start' | 'stop';

export default defineRenderer<HtmlConfig>((root, { config, ctx, documentUrl }) => {
  const frame = document.createElement('iframe');
  // allow-scripts without allow-same-origin: the slide gets an opaque origin and
  // cannot read the player's token, storage or API. The document itself is
  // served by the server with its own CSP.
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('scrolling', 'no');
  frame.className = 'foyer-html__frame';

  let ready = false;
  let phase: Phase | null = null;
  const send = (next: Phase) => {
    phase = next;
    if (ready) frame.contentWindow?.postMessage({ foyer: next }, '*');
  };

  const onMessage = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow || !event.data || typeof event.data.foyer !== 'string') return;
    const type = event.data.foyer;
    if (type === 'ready') {
      ready = true;
      // Replay the phase the player reached while the document was loading.
      if (phase) send(phase);
    } else if (type === 'done' && config.durationMode === 'done' && phase === 'start') {
      ctx.done();
    } else if (type === 'error') {
      ctx.reportError(new Error(`HTML-Folie: ${event.data.detail}`));
    }
  };
  window.addEventListener('message', onMessage);

  if (documentUrl) frame.src = documentUrl;
  root.appendChild(frame);

  return {
    prepare: () => send('prepare'),
    start: () => send('start'),
    stop: () => send('stop'),
    destroy: () => {
      window.removeEventListener('message', onMessage);
      frame.remove();
    },
  };
});
