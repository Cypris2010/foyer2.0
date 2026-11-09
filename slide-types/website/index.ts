import { z } from 'zod';
import { defineSlideType } from '@foyer/slide-sdk';

export const config = z.object({
  url: z
    .url({ protocol: /^https$/, error: 'Bitte eine vollständige Adresse mit https:// angeben' })
    .max(2000)
    .describe('Adresse (https). Bilddateien werden direkt gezeigt, Webseiten eingebettet; die Webseite muss das Einbetten in Foyer erlauben.'),
  refresh: z.number().int().min(0).max(3600).default(0).describe('Neu laden alle … Sekunden, solange die Folie läuft (0 = nie)'),
});

export type WebsiteConfig = z.infer<typeof config>;

export default defineSlideType({
  id: 'website',
  name: 'Webseite',
  description: 'Bindet eine Webseite oder ein Bild über seine Adresse im Vollbild ein.',
  category: 'content',
  config,
  backgrounds: false,
  // Puts any page on the displays: only admins may create or change it.
  editRole: 'admin',
});
