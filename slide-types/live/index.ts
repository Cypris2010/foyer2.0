import { z } from 'zod';
import { defineSlideType } from '@foyer/slide-sdk';

// Protocols ffmpeg pulls from; the server converts every source to the display profile.
const STREAM_URL = /^(rtsps?|rtmps?|srt|udp|rtp|https?):\/\/\S+$/i;

export const config = z
  .object({
    source: z
      .enum(['ndi', 'url'])
      .default('ndi')
      .describe('Quelle')
      // "NDI" with ndi.video next to it: required by the NDI SDK licence wherever NDI is selected.
      .meta({ labels: { ndi: 'NDI im Schulnetz (NDI® · ndi.video)', url: 'Stream-Adresse (RTSP, SRT, RTMP, HLS, UDP …)' } }),
    ndiName: z
      .string()
      .max(300)
      .default('')
      .describe('NDI-Quelle (aus der Liste wählen oder Namen eintragen)')
      .meta({ widget: 'suggest', options: 'ndiSources', visibleIf: { source: 'ndi' } }),
    url: z
      .string()
      .max(2000)
      .default('')
      .describe('Adresse, z. B. rtsp://10.0.0.20/stream1, srt://10.0.0.30:9000 oder https://…/index.m3u8')
      .meta({ visibleIf: { source: 'url' } }),
    quality: z
      .enum(['720p30', '1080p30'])
      .default('720p30')
      .describe('Qualität')
      .meta({ labels: { '720p30': '720p, 30 fps (empfohlen, läuft auf Airtame sauber)', '1080p30': '1080p, 30 fps (auf Airtame ca. 5 % Bildverlust)' } }),
    fill: z.boolean().default(true).describe('Bildschirm füllen (Ränder abschneiden, sonst schwarze Balken)'),
    sound: z.boolean().default(false).describe('Mit Ton (nur auf Displays, bei denen „Ton erlaubt“ an ist)'),
    onError: z
      .enum(['message', 'skip'])
      .default('message')
      .describe('Wenn das Live-Bild ausfällt')
      .meta({ labels: { message: 'Hinweis zeigen und neu verbinden', skip: 'Folie überspringen' } }),
  })
  .superRefine((value, ctx) => {
    if (value.source === 'ndi' && !value.ndiName.trim()) {
      ctx.addIssue({ code: 'custom', path: ['ndiName'], message: 'Bitte eine NDI-Quelle wählen' });
    }
    if (value.source === 'url' && !STREAM_URL.test(value.url.trim())) {
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'Bitte eine Adresse mit rtsp://, srt://, rtmp://, udp://, rtp:// oder http(s):// eintragen' });
    }
  });

export type LiveConfig = z.infer<typeof config>;

export default defineSlideType({
  id: 'live',
  name: 'Live-Video',
  description: 'Ein Live-Bild (NDI, Kamera, Stream) im Vollbild, mit unter einer Sekunde Verzögerung.',
  category: 'media',
  config,
  backgrounds: false,
  defaultDuration: 60,
});
