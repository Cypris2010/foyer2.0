import { defineRenderer } from '@foyer/slide-sdk';
import { fillPlaceholders } from '@foyer/slide-sdk/runtime';
import type { TextConfig, TextData } from './index.ts';

export default defineRenderer<TextConfig, TextData>((root, { config, data, ctx }) => {
  const fill = (text: string) => fillPlaceholders(text, ctx);
  const container = document.createElement('div');
  container.className = 'foyer-text';

  const body = document.createElement('div');
  body.className = 'foyer-text__body';
  const parts: Array<[string, string]> = [
    ['pretitle', config.pretitle],
    ['title', config.title],
    ['subtitle', config.subtitle],
    ['content', config.content],
  ];
  for (const [name, value] of parts) {
    if (!value) continue;
    const node = document.createElement(name === 'title' ? 'h1' : 'div');
    node.className = `foyer-text__${name}`;
    node.textContent = fill(value);
    body.appendChild(node);
  }
  container.appendChild(body);

  if (data?.qrSvg) {
    const qr = document.createElement('div');
    qr.className = data.qrArt ? 'foyer-text__qr foyer-text__qr--art' : 'foyer-text__qr';
    // Server-generated SVG from the qrcode library, not user HTML.
    qr.innerHTML = data.qrSvg;
    container.appendChild(qr);
  }
  root.appendChild(container);
});
