import { defineSlideServer, type ServerContext } from '@foyer/slide-sdk';
import { localNow, teacherLessons, untisApi, type ApiSource } from '../_untis/api.ts';
import { distinctKeys, toRows, untisSource, type UntisLesson } from '../_untis/source.ts';
import type { TeacherDashboardConfig, TeacherDashboardData } from './index.ts';

// The old dashboard reloaded every 30 seconds.
const REFRESH_SECONDS = 30;
const OPTIONS_MAX_AGE_MS = 5 * 60_000;

/**
 * Rows of lehrer.txt: from the slide's TXT export, else computed from the
 * WebUntis API in the settings for the current time (null: neither). `selected`
 * teachers get a row even without lessons today.
 */
async function loadRows(source: string, maxAgeMs: number, ctx: ServerContext, selected: string[]): Promise<UntisLesson[] | null> {
  if (source) return (await untisSource(source).load(maxAgeMs)).lessons;
  const api = untisApi(ctx.untisApi);
  if (!api) return null;
  const now = localNow(ctx.timeZone);
  const day = await api.load(now.slice(0, 10), maxAgeMs);
  return teacherLessons(day.lessons, [...selected, ...(await allTeachers(api))], now);
}

/** All teacher codes, if the key may read them ("stammdaten"); otherwise today's lessons name the teachers. */
async function allTeachers(api: ApiSource): Promise<string[]> {
  try {
    return await api.teachers(OPTIONS_MAX_AGE_MS);
  } catch {
    return [];
  }
}

export default defineSlideServer<TeacherDashboardConfig, TeacherDashboardData>({
  async data(config, ctx) {
    try {
      const lessons = await loadRows(config.source, REFRESH_SECONDS * 1000, ctx, config.teachers);
      if (!lessons) return { rows: [], noSource: true, error: null };
      // With a selection only those teachers leave the server.
      const wanted = new Set(config.teachers.map((t) => t.trim()));
      const rows = wanted.size ? lessons.filter((lesson) => wanted.has(lesson.key.trim())) : lessons;
      return { rows: toRows(rows), noSource: false, error: null };
    } catch (err) {
      return { rows: [], noSource: false, error: (err as Error).message };
    }
  },
  refreshSeconds: REFRESH_SECONDS,
  options: {
    async teachers(config, ctx) {
      const lessons = await loadRows(config.source ?? '', OPTIONS_MAX_AGE_MS, ctx, []);
      return distinctKeys(lessons?.map((l) => l.key) ?? []).map((teacher) => ({ value: teacher, label: teacher }));
    },
  },
});
