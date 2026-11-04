import { defineSlideServer } from '@foyer/slide-sdk';
import { distinctKeys, toRows, untisSource } from '../_untis/source.ts';
import type { RoomDisplayConfig, RoomDisplayData } from './index.ts';

// Option lists may be a little older than the slide data.
const OPTIONS_MAX_AGE_MS = 5 * 60_000;

const normaliseRoom = (value: string) => value.replace(/\s+/g, ' ').trim();

export default defineSlideServer<RoomDisplayConfig, RoomDisplayData>({
  async data(config) {
    if (!config.source) return { rows: [], lastModified: null, error: 'Keine Datenquelle eingestellt' };
    try {
      const day = await untisSource(config.source).load(config.refresh * 1000);
      // Only the slide's rooms leave the server.
      const wanted = new Set(config.rooms.map(normaliseRoom));
      const lessons = day.lessons.filter((lesson) => wanted.has(normaliseRoom(lesson.key)));
      return { rows: toRows(lessons), lastModified: day.lastModified, error: null };
    } catch (err) {
      return { rows: [], lastModified: null, error: (err as Error).message };
    }
  },
  refreshSeconds: (config) => config.refresh,
  options: {
    async rooms(config) {
      if (!config.source) return [];
      const day = await untisSource(config.source).load(OPTIONS_MAX_AGE_MS);
      return distinctKeys(day.lessons).map((room) => ({ value: room, label: room }));
    },
  },
});
