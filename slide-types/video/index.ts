import { z } from 'zod';
import { defineSlideType } from '@foyer/slide-sdk';

export const config = z.object({
  mediaId: z.string().min(1, 'Bitte ein Video wählen').max(64).describe('Video').meta({ widget: 'media', accept: 'video' }),
  fill: z.boolean().default(true).describe('Bildschirm füllen (Ränder abschneiden, sonst schwarze Balken)'),
  sound: z.boolean().default(false).describe('Mit Ton (nur auf Displays, bei denen „Ton erlaubt“ an ist)'),
});

export type VideoConfig = z.infer<typeof config>;

export default defineSlideType({
  id: 'video',
  name: 'Video',
  description: 'Ein Video aus der Mediathek im Vollbild. Die Folie läuft so lange wie das Video.',
  category: 'media',
  config,
  backgrounds: false,
  durationFromMedia: 'mediaId',
});
