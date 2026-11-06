import { z } from 'zod';
import { defineSlideType } from '@foyer/slide-sdk';

export const config = z.object({
  html: z.string().max(200_000).default('').describe('HTML (Medien aus der Mediathek mit {{media:ID}}, auch in CSS und JS)').meta({ widget: 'code', language: 'html' }),
  css: z.string().max(200_000).default('').describe('CSS').meta({ widget: 'code', language: 'css' }),
  js: z.string().max(200_000).default('').describe('JavaScript').meta({ widget: 'code', language: 'javascript' }),
  variables: z
    .string()
    .max(10_000)
    .default('')
    .describe('Platzhalter, eine Zeile pro Wert: name=Wert (im HTML als {{name}})')
    .meta({ widget: 'textarea' }),
  durationMode: z
    .enum(['fixed', 'done'])
    .default('fixed')
    .describe('Dauer: fest oder bis die Folie foyer.done() meldet (mit Sicherheits-Timeout)'),
  allowExternal: z.boolean().default(false).describe('Externe Ressourcen (https) erlauben'),
});

export type HtmlConfig = z.infer<typeof config>;

export default defineSlideType({
  id: 'html',
  name: 'HTML',
  description: 'Freies HTML/CSS/JS mit Animationen, isoliert in einer Sandbox.',
  category: 'content',
  config,
  backgrounds: false,
  // Arbitrary code: only admins may create or change it.
  editRole: 'admin',
});
