import { defineSlideServer } from '@foyer/slide-sdk';
import type { LiveConfig } from './index.ts';

export default defineSlideServer<LiveConfig, null>({
  live(config) {
    const value = (config.source === 'ndi' ? config.ndiName : config.url).trim();
    if (!value) return null;
    return { kind: config.source, value, profile: config.quality, audio: config.sound };
  },
  options: {
    // NDI sources the server sees right now (mDNS, plus FOYER_NDI_EXTRA_IPS).
    async ndiSources(_config, ctx) {
      if (!ctx.live) throw new Error('Live-Video ist auf dem Server nicht eingerichtet');
      const sources = await ctx.live.ndiSources();
      return sources.map((s) => ({ value: s.name, label: `${s.name} (${s.address})` }));
    },
  },
});
