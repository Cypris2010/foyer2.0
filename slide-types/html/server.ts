import { defineSlideServer } from '@foyer/slide-sdk';
import { buildDocument } from './document.ts';
import type { HtmlConfig } from './index.ts';

export default defineSlideServer<HtmlConfig, null>({
  document(config, ctx) {
    return buildDocument(config, { locale: ctx.locale, timeZone: ctx.timeZone, displayName: ctx.displayName });
  },
});
