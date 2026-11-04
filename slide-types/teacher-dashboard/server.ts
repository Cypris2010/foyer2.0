import { defineSlideServer } from '@foyer/slide-sdk';
import { distinctKeys, toRows, untisSource } from '../_untis/source.ts';
import type { TeacherDashboardConfig, TeacherDashboardData } from './index.ts';

// The old dashboard reloaded every 30 seconds.
const REFRESH_SECONDS = 30;
const OPTIONS_MAX_AGE_MS = 5 * 60_000;

export default defineSlideServer<TeacherDashboardConfig, TeacherDashboardData>({
  async data(config) {
    if (!config.source) return { rows: [], noSource: true, error: null };
    try {
      const day = await untisSource(config.source).load(REFRESH_SECONDS * 1000);
      // With a selection only those teachers leave the server.
      const wanted = new Set(config.teachers.map((t) => t.trim()));
      const lessons = wanted.size ? day.lessons.filter((lesson) => wanted.has(lesson.key.trim())) : day.lessons;
      return { rows: toRows(lessons), noSource: false, error: null };
    } catch (err) {
      return { rows: [], noSource: false, error: (err as Error).message };
    }
  },
  refreshSeconds: REFRESH_SECONDS,
  options: {
    async teachers(config) {
      if (!config.source) return [];
      const day = await untisSource(config.source).load(OPTIONS_MAX_AGE_MS);
      return distinctKeys(day.lessons).map((teacher) => ({ value: teacher, label: teacher }));
    },
  },
});
