// Renderers and styles of all slide types, bundled at build time. Adding a
// folder in slide-types/ is enough; nothing to register here.
import type { SlideRenderer } from '@foyer/slide-sdk';

const modules = import.meta.glob<{ default: SlideRenderer }>('../../../slide-types/*/render.ts', { eager: true });
import.meta.glob('../../../slide-types/*/style.css', { eager: true });

export const renderers = new Map<string, SlideRenderer>();
for (const [path, module] of Object.entries(modules)) {
  const type = path.split('/').slice(-2, -1)[0];
  renderers.set(type, module.default);
}
