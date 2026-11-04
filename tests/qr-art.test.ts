import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';
import { ICON_NAMES, artQr, composeMotif, formatMotif, parseMotif } from '../packages/qr-art/src/index.ts';
import { sizeOf } from '../packages/qr-art/src/encoder.ts';
import { fits, solve } from '../packages/qr-art/src/solver.ts';
import textType from '../slide-types/text/index.ts';
import textServer from '../slide-types/text/server.ts';

const URL = 'https://github.com/Cypris2010/foyer2.0';
const ctx = { locale: 'de-DE', timeZone: 'Europe/Berlin' };

describe('QR-Encoder', () => {
  it('erzeugt ohne Motiv in allen Versionen und Stufen dieselben Codes wie die qrcode-Bibliothek', () => {
    for (let v = 1; v <= 40; v++) {
      for (const ecc of ['L', 'M', 'Q', 'H'] as const) {
        const url = `https://example.org/${v}${ecc}`;
        if (!fits(url, v, ecc)) continue;
        const size = sizeOf(v);
        const { modules, mask } = solve({ text: url, version: v, ecc, target: new Int8Array(size * size).fill(-1) });
        const reference = QRCode.create(url, { version: v, errorCorrectionLevel: ecc, maskPattern: mask as QRCode.QRCodeMaskPattern });
        expect(Array.from(modules), `Version ${v} ${ecc}`).toEqual(Array.from(reference.modules.data, Number));
      }
    }
  });
});

describe('QR-Code mit Motiv', () => {
  it('rechnet Text und Symbol lesbar in den Code, in jeder Darstellung', () => {
    for (const style of ['square', 'dots', 'halftone'] as const) {
      for (const [text, icon] of [['MENSA', 'herz'], ['FOYER 2.0', ''], ['', 'wlan']] as const) {
        const art = artQr({ url: URL, ecc: 'M', motif: composeMotif(text, icon), style });
        expect(art, `${text || icon} ${style}`).not.toBeNull();
        expect(art!.readable).toBe(true);
        expect(art!.match).toBeGreaterThan(0.85);
        expect(art!.svg).toMatch(/^<svg /);
      }
    }
  });

  it('übernimmt ein gemaltes Motiv und lässt "-" frei', () => {
    const motif = ['-.....-', '.#####.', '.#...#.', '.#####.', '-.....-'].join('\n');
    const art = artQr({ url: URL, ecc: 'L', motif, style: 'square' })!;
    const { x, y } = art.offset;
    expect(art.target[y * art.size + x]).toBe(-1);
    expect(art.target[(y + 1) * art.size + x + 1]).toBe(1);
    expect(art.match).toBeGreaterThan(0.95);
  });

  it('kennt alle Symbole und liest Motive verlustfrei ein', () => {
    for (const icon of ICON_NAMES) {
      const motif = composeMotif('', icon);
      expect(parseMotif(motif).width).toBe(11);
      expect(formatMotif(parseMotif(motif))).toBe(motif);
    }
    expect(composeMotif('', '')).toBe('');
  });
});

describe('Folientyp text mit QR-Motiv', () => {
  it('liefert ein Motiv-SVG, sonst den normalen Code', async () => {
    const plain = textType.config.parse({ qrUrl: URL });
    expect(await textServer.data!(plain, ctx)).toEqual({ qrSvg: expect.stringContaining('<svg') });
    const art = textType.config.parse({ qrUrl: URL, qrArt: { text: 'Hallo', icon: 'stern' } });
    expect(await textServer.data!(art, ctx)).toEqual({ qrSvg: expect.stringContaining('<svg'), qrArt: true });
  });

  it('lehnt fremde Zeichen im Motiv und unbekannte Symbole ab', () => {
    expect(textType.config.safeParse({ qrArt: { motif: '<script>' } }).success).toBe(false);
    expect(textType.config.safeParse({ qrArt: { icon: 'totenkopf' } }).success).toBe(false);
    expect(textType.config.safeParse({ qrArt: { motif: '#.-\n.#.' } }).success).toBe(true);
  });
});
