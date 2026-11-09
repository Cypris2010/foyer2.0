import { z } from 'zod';
import { defineSlideType } from '@foyer/slide-sdk';

export const config = z.object({
  title: z.string().max(120).default('').describe('Überschrift (optional), z. B. W-Bau'),
  // No built-in address (KONZEPT 3.4): empty uses the WebUntis API from the settings.
  source: z
    .union([z.url({ protocol: /^https?$/ }), z.literal('')])
    .default('')
    .describe('Datenquelle: leer = WebUntis-API aus den Einstellungen, sonst Adresse eines Untis-TXT-Exports (raeume_ganzer_tag.txt)'),
  rooms: z
    .array(z.string().min(1).max(100))
    .max(50)
    .default([])
    .describe('Räume auf dieser Folie (ohne Auswahl wird kein Inhalt angezeigt). Räume mit gleicher Belegung werden zusammengefasst.')
    .meta({ widget: 'options', options: 'rooms' }),
  refresh: z.number().int().min(15).max(3600).default(60).describe('Aktualisierungsintervall in Sekunden (empfohlen: 30–120)'),
  hideUpcoming: z.boolean().default(false).describe('Nächste Belegungen ausblenden (nur die aktuelle Belegung anzeigen)'),
});

export type RoomDisplayConfig = z.infer<typeof config>;

export interface RoomDisplayData {
  /** Rows of the Untis export (column order of the TXT file), only the slide's rooms. */
  rows: string[][];
  lastModified: string | null;
  error: string | null;
}

export default defineSlideType({
  id: 'webuntis-room-display',
  name: 'Raumanzeige (WebUntis)',
  description: 'Aktuelle und nächste Belegungen ausgewählter Räume aus WebUntis.',
  category: 'school',
  config,
  backgrounds: false,
  keepAlive: true,
  // Teacher codes, absences: never in the manifest or the player's offline cache.
  personalData: true,
});
