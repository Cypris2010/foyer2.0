import { defineSlideServer, type ServerContext } from '@foyer/slide-sdk';
import { localNow, roomLessons, untisApi } from '../_untis/api.ts';
import { distinctKeys, toRows, untisSource, type UntisDay } from '../_untis/source.ts';
import type { RoomDisplayConfig, RoomDisplayData } from './index.ts';

// Option lists may be a little older than the slide data.
const OPTIONS_MAX_AGE_MS = 5 * 60_000;

const normaliseRoom = (value: string) => value.replace(/\s+/g, ' ').trim();

/** The day's lessons keyed by room: from the slide's TXT export, else from the WebUntis API in the settings (null: neither). */
async function loadDay(source: string, maxAgeMs: number, ctx: ServerContext): Promise<UntisDay | null> {
  if (source) return untisSource(source).load(maxAgeMs);
  const api = untisApi(ctx.untisApi);
  if (!api) return null;
  const day = await api.load(localNow(ctx.timeZone).slice(0, 10), maxAgeMs);
  return { lessons: roomLessons(day.lessons), lastModified: day.lastModified };
}

export default defineSlideServer<RoomDisplayConfig, RoomDisplayData>({
  async data(config, ctx) {
    try {
      const day = await loadDay(config.source, config.refresh * 1000, ctx);
      if (!day) return { rows: [], lastModified: null, error: 'Keine Datenquelle eingestellt' };
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
    async rooms(config, ctx) {
      const api = untisApi(ctx.untisApi);
      // The API knows all rooms, not only today's.
      if (!config.source && api) return distinctKeys(await api.rooms(OPTIONS_MAX_AGE_MS)).map((room) => ({ value: room, label: room }));
      const day = await loadDay(config.source ?? '', OPTIONS_MAX_AGE_MS, ctx);
      return distinctKeys(day?.lessons.map((l) => l.key) ?? []).map((room) => ({ value: room, label: room }));
    },
  },
});
