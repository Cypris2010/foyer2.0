// Turns a module matrix into SVG or an RGBA bitmap (for checking with jsQR).
//   square   – classic modules
//   dots     – round data modules, square function patterns
//   halftone – 3×3 sub-cells: the centre carries the bit, the rest shows the motif
import { skeleton } from './encoder.ts';

export type QrStyle = 'square' | 'dots' | 'halftone';

type Shape = { k: 'r'; x: number; y: number; w: number; h: number } | { k: 'c'; x: number; y: number; r: number };

export interface Drawable {
  version: number;
  modules: Uint8Array;
  /** Motif per module (1/0/-1), needed for halftone. */
  target?: Int8Array;
}

function shapes(code: Drawable, style: QrStyle): Shape[] {
  const { size, reserved } = skeleton(code.version);
  const out: Shape[] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p = y * size + x;
      const dark = code.modules[p] === 1;
      const fn = reserved[p] === 1;
      if (style === 'halftone' && !fn && code.target && code.target[p] >= 0) {
        const t = code.target[p] === 1;
        for (let sy = 0; sy < 3; sy++) {
          for (let sx = 0; sx < 3; sx++) {
            if (sx === 1 && sy === 1 ? dark : t) out.push({ k: 'r', x: x + sx / 3, y: y + sy / 3, w: 1 / 3, h: 1 / 3 });
          }
        }
        continue;
      }
      if (!dark) continue;
      if (style === 'dots' && !fn) out.push({ k: 'c', x: x + 0.5, y: y + 0.5, r: 0.42 });
      else out.push({ k: 'r', x, y, w: 1, h: 1 });
    }
  }
  return out;
}

export function toSvg(code: Drawable, style: QrStyle, quiet = 0): string {
  const { size } = skeleton(code.version);
  const W = size + quiet * 2;
  const f = (n: number) => +n.toFixed(4);
  let path = '';
  let circles = '';
  for (const s of shapes(code, style)) {
    if (s.k === 'r') path += `M${f(s.x + quiet)} ${f(s.y + quiet)}h${f(s.w)}v${f(s.h)}h${f(-s.w)}z`;
    else circles += `<circle cx="${f(s.x + quiet)}" cy="${f(s.y + quiet)}" r="${s.r}"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${W}" shape-rendering="crispEdges">` +
    `<rect width="${W}" height="${W}" fill="#fff"/><path fill="#000" d="${path}"/>${circles ? `<g fill="#000">${circles}</g>` : ''}</svg>`;
}

/** White background, black shapes, `px` pixels per module, 4 modules quiet zone. */
export function toRgba(code: Drawable, style: QrStyle, px: number): { data: Uint8ClampedArray; width: number } {
  const { size } = skeleton(code.version);
  const quiet = 4;
  const width = (size + quiet * 2) * px;
  const data = new Uint8ClampedArray(width * width * 4).fill(255);
  const fill = (x0: number, y0: number, x1: number, y1: number, inside: (x: number, y: number) => boolean) => {
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(width, Math.ceil(y1)); y++) {
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(width, Math.ceil(x1)); x++) {
        if (!inside(x + 0.5, y + 0.5)) continue;
        const i = (y * width + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = 0;
      }
    }
  };
  const o = quiet * px;
  for (const s of shapes(code, style)) {
    if (s.k === 'r') {
      fill(Math.round(o + s.x * px), Math.round(o + s.y * px), Math.round(o + (s.x + s.w) * px), Math.round(o + (s.y + s.h) * px), () => true);
    } else {
      const cx = o + s.x * px, cy = o + s.y * px, r = s.r * px;
      fill(cx - r, cy - r, cx + r, cy + r, (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r);
    }
  }
  return { data, width };
}
