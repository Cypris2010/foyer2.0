import { defineSlideServer } from '@foyer/slide-sdk';
import { NDI_GROUP, ndiGroupList, type LiveConfig } from './index.ts';

export default defineSlideServer<LiveConfig, null>({
  live(config) {
    const value = (config.source === 'ndi' ? config.ndiName : config.url).trim();
    if (!value) return null;
    const groups = config.source === 'ndi' ? ndiGroupList(config.ndiGroups) : [];
    return { kind: config.source, value, ...(groups.length ? { groups } : {}), profile: config.quality, audio: config.sound };
  },
  options: {
    // NDI sources the server sees right now (mDNS, plus FOYER_NDI_EXTRA_IPS), in the slide's groups.
    async ndiSources(config, ctx) {
      if (!ctx.live) throw new Error('Live-Video ist auf dem Server nicht eingerichtet');
      // Unsaved form values, not validated yet.
      const groups = ndiGroupList(typeof config.ndiGroups === 'string' ? config.ndiGroups : '');
      if (!groups.every((g) => NDI_GROUP.test(g))) throw new Error('Ungültiger Gruppenname (erlaubt: Buchstaben, Ziffern, Leerzeichen, - _ .)');
      const sources = await ctx.live.ndiSources({ groups });
      return sources.map((s) => ({ value: s.name, label: `${s.name} (${s.address})` }));
    },
  },
});
