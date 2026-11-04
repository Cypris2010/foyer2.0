import { z } from 'zod';
import { defineSlideType } from '@foyer/slide-sdk';
import { ICON_NAMES, MAX_TEXT } from '@foyer/qr-art';

export const config = z.object({
  pretitle: z.string().max(200).default('').describe('Dachzeile'),
  title: z.string().max(300).default('').describe('Titel'),
  subtitle: z.string().max(300).default('').describe('Untertitel'),
  content: z.string().max(5000).default('').describe('Text').meta({ widget: 'textarea' }),
  qrUrl: z.union([z.url(), z.literal('')]).default('').describe('QR-Code-Link (optional)'),
  qrEcc: z.enum(['L', 'M', 'Q', 'H']).default('M').describe('QR-Fehlerkorrektur'),
  // Text/icon computed into the code (QArt). `motif` is the hand-painted pixel
  // grid; while it is empty the motif comes from text and icon.
  qrArt: z
    .object({
      text: z.string().max(MAX_TEXT).default(''),
      icon: z.enum(['', ...ICON_NAMES] as [string, ...string[]]).default(''),
      style: z.enum(['square', 'dots', 'halftone']).default('square'),
      motif: z.string().max(6000).regex(/^[#.\-\n]*$/).default(''),
    })
    .default({ text: '', icon: '', style: 'square', motif: '' })
    .describe('QR-Motiv')
    .meta({ widget: 'qr-art' }),
});

export type TextConfig = z.infer<typeof config>;
export interface TextData {
  qrSvg: string | null;
  /** The code carries a motif and is shown larger. */
  qrArt?: boolean;
}

export default defineSlideType({
  id: 'text',
  name: 'Text',
  description: 'Dachzeile, Titel, Untertitel und Text, optional mit QR-Code.',
  category: 'content',
  config,
  backgrounds: ['color', 'image', 'video'],
});
