// QR codes with a motif (text, icon or hand-painted pixels) computed into them.
// Shared by the server (slide data) and the admin (live editor preview).
import jsQRModule from 'jsqr';
import { type Ecc, sizeOf, skeleton } from './encoder.ts';
import { type Grid, parseMotif } from './motif.ts';
import { type QrStyle, toRgba, toSvg } from './render.ts';
import { fits, solve } from './solver.ts';

// jsQR is CommonJS: Node hands over the function, TypeScript and some bundlers a namespace.
type Decode = (data: Uint8ClampedArray, width: number, height: number, opts?: { inversionAttempts?: 'dontInvert' }) => { data: string } | null;
const jsQR = ((jsQRModule as unknown as { default?: Decode }).default ?? jsQRModule) as unknown as Decode;

export type { Ecc } from './encoder.ts';
export type { QrStyle } from './render.ts';
export { ICON_NAMES, ICONS, MAX_TEXT, type Grid, type IconName, composeMotif, emptyGrid, formatMotif, parseMotif } from './motif.ts';

export interface ArtQrOptions {
  url: string;
  ecc: Ecc;
  /** Motif grid as text ('#', '.', '-'); empty = plain code. */
  motif: string;
  style: QrStyle;
}

export interface ArtQr {
  svg: string;
  version: number;
  size: number;
  modules: Uint8Array;
  /** Motif per module, -1 outside the motif. */
  target: Int8Array;
  /** Where the motif's top left cell sits in the matrix. */
  offset: { x: number; y: number };
  /** Share of motif pixels on data modules that show as wanted. */
  match: number;
  readable: boolean;
}

// Position with the fewest motif pixels on function patterns, nearest to the centre.
function place(grid: Grid, version: number): { x: number; y: number; blocked: number } | null {
  const { size, reserved } = skeleton(version);
  if (grid.width > size || grid.height > size) return null;
  const cx = (size - grid.width) / 2, cy = (size - grid.height) / 2;
  let best: { x: number; y: number; blocked: number; dist: number } | null = null;
  for (let y = 0; y + grid.height <= size; y++) {
    for (let x = 0; x + grid.width <= size; x++) {
      let blocked = 0;
      for (let gy = 0; gy < grid.height; gy++) {
        for (let gx = 0; gx < grid.width; gx++) {
          if (grid.cells[gy * grid.width + gx] >= 0 && reserved[(y + gy) * size + x + gx]) blocked++;
        }
      }
      const dist = (x - cx) ** 2 + (y - cy) ** 2;
      if (!best || blocked < best.blocked || (blocked === best.blocked && dist < best.dist)) best = { x, y, blocked, dist };
    }
  }
  return best;
}

/** Decodes the code like a camera would and compares it with the link. */
export function isReadable(code: { version: number; modules: Uint8Array; target?: Int8Array }, style: QrStyle, url: string): boolean {
  const { data, width } = toRgba(code, style, style === 'halftone' ? 9 : style === 'dots' ? 8 : 5);
  return jsQR(data, width, width, { inversionAttempts: 'dontInvert' })?.data === url;
}

function minVersion(url: string, ecc: Ecc): number {
  for (let v = 1; v <= 40; v++) if (fits(url, v, ecc)) return v;
  throw new Error('Der Link ist zu lang für einen QR-Code.');
}

export function artQr(opts: ArtQrOptions): ArtQr | null {
  const grid = parseMotif(opts.motif);
  const start = minVersion(opts.url, opts.ecc);
  let first = start;
  // The motif should fit between the finder patterns.
  while (first < 40 && sizeOf(first) - 16 < Math.max(grid.width, grid.height)) first++;
  let best: ArtQr | null = null;
  for (let v = first; v <= Math.min(40, first + 3); v++) {
    const pos = place(grid, v);
    if (!pos) continue;
    const size = sizeOf(v);
    const target = new Int8Array(size * size).fill(-1);
    for (let gy = 0; gy < grid.height; gy++) {
      for (let gx = 0; gx < grid.width; gx++) target[(pos.y + gy) * size + pos.x + gx] = grid.cells[gy * grid.width + gx];
    }
    // Spending error correction makes the motif crisper; halftone shows it anyway.
    for (const ecBudget of opts.style === 'halftone' ? [0] : [0.4, 0]) {
      const sol = solve({ text: opts.url, version: v, ecc: opts.ecc, target, ecBudget });
      const code = { version: v, modules: sol.modules, target };
      if (!isReadable(code, opts.style, opts.url)) continue;
      const match = sol.wanted ? sol.matched / sol.wanted : 1;
      if (!best || match > best.match + 0.01) {
        best = { svg: toSvg(code, opts.style), version: v, size, modules: sol.modules, target, offset: { x: pos.x, y: pos.y }, match, readable: true };
      }
      break;
    }
    if (best && best.match >= 0.98) break;
  }
  return best;
}
