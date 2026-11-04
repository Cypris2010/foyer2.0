import { z } from 'zod';
import { defineSlideType } from '@foyer/slide-sdk';

export const config = z.object({
  pretitle: z.string().max(200).default('').describe('Dachzeile'),
  title: z.string().max(300).default('').describe('Titel'),
  subtitle: z.string().max(300).default('').describe('Untertitel'),
  content: z.string().max(5000).default('').describe('Text').meta({ widget: 'textarea' }),
  qrUrl: z.union([z.url(), z.literal('')]).default('').describe('QR-Code-Link (optional)'),
  qrEcc: z.enum(['L', 'M', 'Q', 'H']).default('M').describe('QR-Fehlerkorrektur'),
});

export type TextConfig = z.infer<typeof config>;
export interface TextData {
  qrSvg: string | null;
}

export default defineSlideType({
  id: 'text',
  name: 'Text',
  description: 'Dachzeile, Titel, Untertitel und Text, optional mit QR-Code.',
  category: 'content',
  config,
  backgrounds: ['color', 'image', 'video'],
});
