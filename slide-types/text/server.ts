import QRCode from 'qrcode';
import { artQr, composeMotif, type IconName } from '@foyer/qr-art';
import { defineSlideServer } from '@foyer/slide-sdk';
import type { TextConfig, TextData } from './index.ts';

export default defineSlideServer<TextConfig, TextData>({
  // QR codes are rendered once on the server as SVG, as in wp-foyer.
  async data(config) {
    if (!config.qrUrl) return { qrSvg: null };
    const { text, icon, style, motif } = config.qrArt;
    const grid = motif || composeMotif(text, icon as IconName | '');
    if (grid) {
      // null when no variant decodes; the plain code below is shown instead.
      const art = artQr({ url: config.qrUrl, ecc: config.qrEcc, motif: grid, style });
      if (art) return { qrSvg: art.svg, qrArt: true };
    }
    const qrSvg = await QRCode.toString(config.qrUrl, { type: 'svg', errorCorrectionLevel: config.qrEcc, margin: 0 });
    return { qrSvg };
  },
});
