// QR code encoder (ISO/IEC 18004, byte mode) that exposes the steps the art
// solver needs: block layout, Reed-Solomon, module order and masks.
export type Ecc = 'L' | 'M' | 'Q' | 'H';

// Error correction codewords per block and number of blocks, index = version.
const ECC_PER_BLOCK: Record<Ecc, number[]> = {
  L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};
const NUM_BLOCKS: Record<Ecc, number[]> = {
  L: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};
const FORMAT_ECC_BITS: Record<Ecc, number> = { L: 1, M: 0, Q: 3, H: 2 };

// --- GF(256) with x^8+x^4+x^3+x^2+1 ------------------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];

export function gfMul(a: number, b: number): number {
  return a && b ? EXP[LOG[a] + LOG[b]] : 0;
}

const generators = new Map<number, Uint8Array>();
// Coefficients of (x - a^0)…(x - a^(n-1)) without the leading 1, highest first.
function generator(degree: number): Uint8Array {
  let g = generators.get(degree);
  if (g) return g;
  g = new Uint8Array(degree);
  g[degree - 1] = 1;
  for (let i = 0, root = 1; i < degree; i++, root = gfMul(root, 2)) {
    for (let j = 0; j < degree; j++) {
      g[j] = gfMul(g[j], root);
      if (j + 1 < degree) g[j] ^= g[j + 1];
    }
  }
  generators.set(degree, g);
  return g;
}

export function rsEncode(data: Uint8Array, degree: number): Uint8Array {
  const g = generator(degree);
  const out = new Uint8Array(degree);
  for (const byte of data) {
    const factor = byte ^ out[0];
    out.copyWithin(0, 1);
    out[degree - 1] = 0;
    for (let i = 0; i < degree; i++) out[i] ^= gfMul(g[i], factor);
  }
  return out;
}

// --- Capacity and block layout ---------------------------------------------

export function sizeOf(version: number): number {
  return version * 4 + 17;
}

function rawDataModules(v: number): number {
  let n = (16 * v + 128) * v + 64;
  if (v >= 2) {
    const align = Math.floor(v / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (v >= 7) n -= 36;
  }
  return n;
}

export interface Block {
  /** Index of the block's first data codeword in the whole message. */
  dataStart: number;
  dataLen: number;
  eccLen: number;
}

export interface Layout {
  blocks: Block[];
  dataCodewords: number;
  totalCodewords: number;
}

export function layout(v: number, ecc: Ecc): Layout {
  const count = NUM_BLOCKS[ecc][v];
  const eccLen = ECC_PER_BLOCK[ecc][v];
  const total = Math.floor(rawDataModules(v) / 8);
  const shortLen = Math.floor(total / count);
  const numShort = count - (total % count);
  const blocks: Block[] = [];
  let start = 0;
  for (let i = 0; i < count; i++) {
    const dataLen = shortLen - eccLen + (i < numShort ? 0 : 1);
    blocks.push({ dataStart: start, dataLen, eccLen });
    start += dataLen;
  }
  return { blocks, dataCodewords: start, totalCodewords: total };
}

/** Bits of mode indicator, length and payload (no terminator). */
export function messageBits(text: string, v: number): number[] {
  const bytes = new TextEncoder().encode(text);
  const bits: number[] = [];
  const push = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, v < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  return bits;
}

/** Interleaved final codeword sequence from the data codewords. */
export function codewords(lay: Layout, data: Uint8Array): Uint8Array {
  const blocks = lay.blocks.map((b) => {
    const d = data.subarray(b.dataStart, b.dataStart + b.dataLen);
    return { d, e: rsEncode(d, b.eccLen) };
  });
  const out = new Uint8Array(lay.totalCodewords);
  let k = 0;
  const maxData = Math.max(...lay.blocks.map((b) => b.dataLen));
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.d.length) out[k++] = b.d[i];
  for (let i = 0; i < lay.blocks[0].eccLen; i++) for (const b of blocks) out[k++] = b.e[i];
  return out;
}

/** Where codeword c of the interleaved sequence comes from. */
export function interleaveSource(lay: Layout): Array<{ block: number; index: number }> {
  const src: Array<{ block: number; index: number }> = [];
  const maxData = Math.max(...lay.blocks.map((b) => b.dataLen));
  for (let i = 0; i < maxData; i++) lay.blocks.forEach((b, block) => { if (i < b.dataLen) src.push({ block, index: i }); });
  for (let i = 0; i < lay.blocks[0].eccLen; i++) lay.blocks.forEach((b, block) => src.push({ block, index: b.dataLen + i }));
  return src;
}

// --- Matrix -----------------------------------------------------------------

export interface Skeleton {
  size: number;
  /** Function pattern modules (1 = dark), only meaningful where reserved. */
  modules: Uint8Array;
  reserved: Uint8Array;
  /** Data modules in placement order (index = y * size + x). */
  order: number[];
}

function alignmentPositions(v: number): number[] {
  if (v === 1) return [];
  const count = Math.floor(v / 7) + 2;
  const step = v === 32 ? 26 : Math.ceil((v * 4 + 4) / (count * 2 - 2)) * 2;
  const out = [6];
  for (let pos = sizeOf(v) - 7; out.length < count; pos -= step) out.splice(1, 0, pos);
  return out;
}

const skeletons = new Map<number, Skeleton>();
export function skeleton(v: number): Skeleton {
  const cached = skeletons.get(v);
  if (cached) return cached;
  const size = sizeOf(v);
  const modules = new Uint8Array(size * size);
  const reserved = new Uint8Array(size * size);
  const set = (x: number, y: number, dark: boolean) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    modules[y * size + x] = dark ? 1 : 0;
    reserved[y * size + x] = 1;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(cx + dx, cy + dy, d !== 2 && d !== 4);
      }
    }
  }
  const align = alignmentPositions(v);
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) set(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  // Format and version areas are reserved here and drawn by drawFormat.
  for (let i = 0; i < 9; i++) {
    if (!reserved[8 * size + i]) set(i, 8, false);
    if (!reserved[i * size + 8]) set(8, i, false);
  }
  for (let i = 0; i < 8; i++) {
    set(size - 1 - i, 8, false);
    set(8, size - 1 - i, false);
  }
  set(8, size - 8, true);
  if (v >= 7) {
    for (let i = 0; i < 18; i++) {
      set(size - 11 + (i % 3), Math.floor(i / 3), false);
      set(Math.floor(i / 3), size - 11 + (i % 3), false);
    }
  }
  const order: number[] = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (!reserved[y * size + x]) order.push(y * size + x);
      }
    }
  }
  const sk = { size, modules, reserved, order };
  skeletons.set(v, sk);
  return sk;
}

export function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

/** Full module matrix (1 = dark) from the interleaved codewords. */
export function buildMatrix(v: number, ecc: Ecc, finalCodewords: Uint8Array, mask: number): Uint8Array {
  const sk = skeleton(v);
  const size = sk.size;
  const m = sk.modules.slice();
  const bits = finalCodewords.length * 8;
  sk.order.forEach((p, i) => {
    let dark = i < bits ? (finalCodewords[i >> 3] >> (7 - (i & 7))) & 1 : 0;
    if (maskBit(mask, p % size, Math.floor(p / size))) dark ^= 1;
    m[p] = dark;
  });
  drawFormat(m, v, ecc, mask);
  return m;
}

function drawFormat(m: Uint8Array, v: number, ecc: Ecc, mask: number) {
  const size = sizeOf(v);
  const set = (x: number, y: number, bit: number) => { m[y * size + x] = bit; };
  const data = (FORMAT_ECC_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i: number) => (bits >>> i) & 1;
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, 1);
  if (v >= 7) {
    let r = v;
    for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    const vbits = (v << 12) | r;
    for (let i = 0; i < 18; i++) {
      const b = (vbits >>> i) & 1;
      set(size - 11 + (i % 3), Math.floor(i / 3), b);
      set(Math.floor(i / 3), size - 11 + (i % 3), b);
    }
  }
}

/** ISO 18004 mask penalty (runs, 2×2 blocks, finder-like patterns, dark balance). */
export function penalty(m: Uint8Array, size: number): number {
  let score = 0;
  const line = (get: (i: number) => number) => {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && get(i) === get(i - 1)) run++;
      else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    // 1:1:3:1:1 with four light modules on one side; outside the matrix counts as light.
    const at = (i: number) => (i < 0 || i >= size ? 0 : get(i));
    for (let i = -4; i < size; i++) {
      if (at(i) || at(i + 1) || at(i + 2) || at(i + 3)) {
        if (at(i) && !at(i + 1) && at(i + 2) && at(i + 3) && at(i + 4) && !at(i + 5) && at(i + 6) &&
          !at(i + 7) && !at(i + 8) && !at(i + 9) && !at(i + 10)) score += 40;
        continue;
      }
      if (at(i + 4) && !at(i + 5) && at(i + 6) && at(i + 7) && at(i + 8) && !at(i + 9) && at(i + 10)) score += 40;
    }
  };
  for (let y = 0; y < size; y++) line((x) => m[y * size + x]);
  for (let x = 0; x < size; x++) line((y) => m[y * size + x]);
  let dark = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = m[y * size + x];
      dark += c;
      if (x + 1 < size && y + 1 < size && c === m[y * size + x + 1] && c === m[(y + 1) * size + x] && c === m[(y + 1) * size + x + 1]) score += 3;
    }
  }
  const total = size * size;
  score += Math.max(0, Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}
