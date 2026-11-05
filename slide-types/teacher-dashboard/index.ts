import { z } from 'zod';
import { defineSlideType } from '@foyer/slide-sdk';

export const config = z.object({
  // No built-in address (KONZEPT 3.4): empty uses the WebUntis API from the settings.
  source: z
    .union([z.url({ protocol: /^https?$/ }), z.literal('')])
    .default('')
    .describe('Datenquelle: leer = WebUntis-API aus den Einstellungen, sonst Adresse eines Untis-TXT-Exports (lehrer.txt)'),
  teachers: z
    .array(z.string().min(1).max(50))
    .max(500)
    .default([])
    .describe('Lehrkräfte auf dieser Folie (ohne Auswahl: alle)')
    .meta({ widget: 'options', options: 'teachers' }),
  theme: z.enum(['dark', 'light']).default('dark').describe('Darstellung').meta({ labels: { dark: 'Dunkel', light: 'Hell' } }),
  legend: z.boolean().default(true).describe('Legende mit Statusfilter anzeigen'),
});

export type TeacherDashboardConfig = z.infer<typeof config>;

export interface TeacherDashboardData {
  /** Rows of the Untis export (column order of the TXT file), only the slide's teachers. */
  rows: string[][];
  noSource: boolean;
  error: string | null;
}

export default defineSlideType({
  id: 'teacher-dashboard',
  name: 'Lehrkräfte-Dashboard (WebUntis)',
  description: 'Status der Lehrkräfte (anwesend, abwesend, Entfall …) aus WebUntis.',
  category: 'school',
  config,
  backgrounds: false,
  keepAlive: true,
  // Teacher codes, absences: never in the manifest or the player's offline cache.
  personalData: true,
});
