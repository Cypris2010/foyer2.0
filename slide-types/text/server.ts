import QRCode from 'qrcode';
import { defineSlideServer } from '@foyer/slide-sdk';
import type { TextConfig, TextData } from './index.ts';

export default defineSlideServer<TextConfig, TextData>({
  // QR codes are rendered once on the server as SVG, as in wp-foyer.
  async data(config) {
    if (!config.qrUrl) return { qrSvg: null };
    const qrSvg = await QRCode.toString(config.qrUrl, { type: 'svg', errorCorrectionLevel: config.qrEcc, margin: 0 });
    return { qrSvg };
  },
});
