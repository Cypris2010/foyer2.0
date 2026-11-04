// Computes a valid QR code whose modules show a motif (QArt idea, Russ Cox 2012).
//
// A decoder stops reading at the terminator, so every data bit after it is free.
// Reed-Solomon is linear over GF(2): each module is the XOR of a constant and a
// subset of the free bits. Gaussian elimination per block picks the free bits so
// that as many motif pixels as possible come out right, most important first.
// Optionally a share of each block's error correction is spent on setting
// further pixels; the decoder repairs those codewords.
import {
  type Ecc, type Layout, buildMatrix, codewords, gfMul, interleaveSource, layout, maskBit, messageBits, penalty, rsEncode, skeleton,
} from './encoder.ts';

interface BlockSystem {
  nVars: number;
  /** Words per row bitset. */
  W: number;
  /** One bitset over the free bits per block bit (data bits, then EC bits). */
  rows: Uint32Array;
  /** Value of each block bit with all free bits 0. */
  konst: Uint8Array;
  /** Block-local data bit -> variable index or -1. */
  varOf: Int32Array;
  dataStart: number;
  dataLen: number;
  eccLen: number;
}

interface Prepared {
  version: number;
  ecc: Ecc;
  size: number;
  lay: Layout;
  fixed: number[];
  /** Standard pad bits per data bit, used for free bits the motif leaves open. */
  padding: Uint8Array;
  blocks: BlockSystem[];
  /** Module -> block, -1 for function and remainder modules. */
  modBlock: Int16Array;
  /** Module -> bit index inside its block. */
  modBit: Int32Array;
}

export function fits(text: string, version: number, ecc: Ecc): boolean {
  return messageBits(text, version).length <= layout(version, ecc).dataCodewords * 8;
}

function prepare(text: string, version: number, ecc: Ecc): Prepared {
  const lay = layout(version, ecc);
  const capacity = lay.dataCodewords * 8;
  const fixed = messageBits(text, version);
  if (fixed.length > capacity) throw new Error('Der Link ist zu lang für diese QR-Version.');
  for (let i = 0; i < 4 && fixed.length < capacity; i++) fixed.push(0);
  // Standard filling of the free bits: zeros to the byte boundary, then 0xEC 0x11 …
  const padding = new Uint8Array(capacity);
  for (let g = Math.ceil(fixed.length / 8) * 8, k = 0; g < capacity; g += 8, k++) {
    const byte = k % 2 ? 0x11 : 0xec;
    for (let t = 0; t < 8; t++) padding[g + t] = (byte >> (7 - t)) & 1;
  }

  const sk = skeleton(version);
  const size = sk.size;
  const src = interleaveSource(lay);
  const modBlock = new Int16Array(size * size).fill(-1);
  const modBit = new Int32Array(size * size).fill(-1);
  for (let i = 0; i < lay.totalCodewords * 8; i++) {
    const s = src[i >> 3];
    modBlock[sk.order[i]] = s.block;
    modBit[sk.order[i]] = s.index * 8 + (i & 7);
  }

  const blocks = lay.blocks.map((b): BlockSystem => {
    const dataBits = b.dataLen * 8;
    const varOf = new Int32Array(dataBits).fill(-1);
    let nVars = 0;
    for (let j = 0; j < dataBits; j++) if (b.dataStart * 8 + j >= fixed.length) varOf[j] = nVars++;
    const W = Math.max(1, Math.ceil(nVars / 32));
    const nBits = dataBits + b.eccLen * 8;
    const rows = new Uint32Array(nBits * W);

    const data0 = new Uint8Array(b.dataLen);
    for (let j = 0; j < dataBits; j++) {
      const g = b.dataStart * 8 + j;
      if (g < fixed.length && fixed[g]) data0[j >> 3] |= 0x80 >> (j & 7);
    }
    const ecc0 = rsEncode(data0, b.eccLen);
    const konst = new Uint8Array(nBits);
    for (let j = 0; j < dataBits; j++) konst[j] = (data0[j >> 3] >> (7 - (j & 7))) & 1;
    for (let j = 0; j < b.eccLen * 8; j++) konst[dataBits + j] = (ecc0[j >> 3] >> (7 - (j & 7))) & 1;

    const unit = new Uint8Array(b.dataLen);
    for (let byte = 0; byte < b.dataLen; byte++) {
      if (varOf[byte * 8 + 7] < 0) continue; // the last bit of a byte is free whenever any is
      unit.fill(0);
      unit[byte] = 1;
      const effect = rsEncode(unit, b.eccLen);
      for (let k = 0; k < 8; k++) {
        const vi = varOf[byte * 8 + k];
        if (vi < 0) continue;
        const word = vi >> 5, mask = 1 << (vi & 31);
        rows[(byte * 8 + k) * W + word] |= mask;
        const value = 0x80 >> k;
        for (let e = 0; e < b.eccLen; e++) {
          const ecByte = gfMul(effect[e], value);
          if (!ecByte) continue;
          for (let t = 0; t < 8; t++) if ((ecByte >> (7 - t)) & 1) rows[(dataBits + e * 8 + t) * W + word] |= mask;
        }
      }
    }
    return { nVars, W, rows, konst, varOf, dataStart: b.dataStart, dataLen: b.dataLen, eccLen: b.eccLen };
  });
  return { version, ecc, size, lay, fixed, padding, blocks, modBlock, modBit };
}

// Small deterministic random generator (mulberry32) for tie-breaking, so a config always gives the same code.
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parity(x: number): number {
  x ^= x >>> 16;
  x ^= x >>> 8;
  x ^= x >>> 4;
  x ^= x >>> 2;
  x ^= x >>> 1;
  return x & 1;
}

/** Data codewords that put as many wanted modules in `order` as possible. */
function solveMask(prep: Prepared, target: Int8Array, order: number[], mask: number): Uint8Array {
  const { size, blocks, modBlock, modBit, fixed } = prep;
  const bases = blocks.map((b) => ({ rows: [] as Uint32Array[], pivots: [] as number[], values: [] as number[], full: b.nVars === 0 }));
  const scratch = blocks.map((b) => new Uint32Array(b.W));
  for (const p of order) {
    const bi = modBlock[p];
    const basis = bases[bi];
    if (basis.full) continue;
    const blk = blocks[bi];
    const row = scratch[bi];
    const bit = modBit[p];
    row.set(blk.rows.subarray(bit * blk.W, bit * blk.W + blk.W));
    let value = target[p] ^ blk.konst[bit] ^ (maskBit(mask, p % size, Math.floor(p / size)) ? 1 : 0);
    for (let i = 0; i < basis.pivots.length; i++) {
      const pv = basis.pivots[i];
      if ((row[pv >> 5] >>> (pv & 31)) & 1) {
        const br = basis.rows[i];
        for (let w = pv >> 5; w < blk.W; w++) row[w] ^= br[w];
        value ^= basis.values[i];
      }
    }
    let pivot = -1;
    for (let w = 0; w < blk.W; w++) {
      if (row[w]) {
        pivot = w * 32 + (31 - Math.clz32(row[w] & -row[w]));
        break;
      }
    }
    if (pivot < 0) continue; // already decided by earlier, more important pixels
    basis.rows.push(row.slice());
    basis.pivots.push(pivot);
    basis.values.push(value);
    if (basis.pivots.length === blk.nVars) basis.full = true;
  }

  const data = new Uint8Array(prep.lay.dataCodewords);
  fixed.forEach((b, g) => { if (b) data[g >> 3] |= 0x80 >> (g & 7); });
  blocks.forEach((blk, bi) => {
    if (!blk.nVars) return;
    const basis = bases[bi];
    // Undetermined bits keep the standard padding, so outside the motif the code is
    // an ordinary QR code (random bits form finder-like patterns that confuse scanners).
    const xs = new Uint32Array(blk.W);
    for (let j = 0; j < blk.dataLen * 8; j++) {
      const vi = blk.varOf[j];
      if (vi >= 0 && prep.padding[blk.dataStart * 8 + j]) xs[vi >> 5] |= 1 << (vi & 31);
    }
    for (let i = basis.pivots.length - 1; i >= 0; i--) {
      const br = basis.rows[i];
      let par = 0;
      for (let w = 0; w < blk.W; w++) par ^= parity(br[w] & xs[w]);
      if (par !== basis.values[i]) xs[basis.pivots[i] >> 5] ^= 1 << (basis.pivots[i] & 31);
    }
    for (let j = 0; j < blk.dataLen * 8; j++) {
      const vi = blk.varOf[j];
      if (vi >= 0 && (xs[vi >> 5] >>> (vi & 31)) & 1) {
        const g = blk.dataStart * 8 + j;
        data[g >> 3] |= 0x80 >> (g & 7);
      }
    }
  });
  return data;
}

// Versions 1–3 keep a few EC codewords against misdecoding (ISO 18004, table 9).
const MISDECODE: Record<number, Partial<Record<Ecc, number>>> = { 1: { L: 3, M: 2, Q: 1, H: 1 }, 2: { L: 2 }, 3: { L: 1 } };

export interface SolveOptions {
  text: string;
  version: number;
  ecc: Ecc;
  /** size*size: 1 dark, 0 light, -1 don't care. */
  target: Int8Array;
  /** Higher = more important; defaults to edges first. */
  priority?: Float32Array;
  /** Share (0..1) of each block's correction capacity spent on the motif. */
  ecBudget?: number;
}

export interface Solution {
  version: number;
  ecc: Ecc;
  size: number;
  mask: number;
  modules: Uint8Array;
  /** Modules the motif wants and gets, out of all it wants on data modules. */
  matched: number;
  wanted: number;
  /** Motif pixels that fall on function patterns and cannot be changed. */
  blocked: number;
}

function defaultPriority(target: Int8Array, size: number): Float32Array {
  const rnd = random(0x9e37);
  const pr = new Float32Array(size * size);
  for (let p = 0; p < size * size; p++) {
    const t = target[p];
    if (t < 0) continue;
    const x = p % size, y = Math.floor(p / size);
    const differs = (q: number) => target[q] >= 0 && target[q] !== t;
    const edge = (x > 0 && differs(p - 1)) || (x < size - 1 && differs(p + 1)) || (y > 0 && differs(p - size)) || (y < size - 1 && differs(p + size));
    pr[p] = (t === 1 ? 2 : 0) + (edge ? 1 : 0) + rnd();
  }
  return pr;
}

export function solve(opts: SolveOptions): Solution {
  const { text, version, ecc, target } = opts;
  const prep = prepare(text, version, ecc);
  const { size, modBlock } = prep;
  const pr = opts.priority ?? defaultPriority(target, size);
  const order: number[] = [];
  let blocked = 0;
  for (let p = 0; p < size * size; p++) {
    if (target[p] < 0) continue;
    if (modBlock[p] >= 0) order.push(p);
    else blocked++;
  }
  order.sort((a, b) => pr[b] - pr[a]);

  const candidates = [];
  for (let mask = 0; mask < 8; mask++) {
    const data = solveMask(prep, target, order, mask);
    const modules = buildMatrix(version, ecc, codewords(prep.lay, data), mask);
    let score = 0;
    for (const p of order) if (modules[p] === target[p]) score += 1 + pr[p];
    candidates.push({ mask, modules, score, penalty: penalty(modules, size) });
  }
  // Among the masks that show the motif (nearly) best, take the one with the lowest
  // penalty: random free bits easily form finder-like patterns that confuse scanners.
  const top = Math.max(...candidates.map((c) => c.score));
  const best = candidates.filter((c) => c.score >= top * 0.97).sort((a, b) => a.penalty - b.penalty)[0];
  const modules = best.modules;

  const budget = Math.max(0, Math.min(1, opts.ecBudget ?? 0));
  if (budget > 0) {
    // Per block: flip the codewords with the most important wrong pixels.
    const wrong = prep.blocks.map(() => new Map<number, { weight: number; pixels: number[] }>());
    for (const p of order) {
      if (modules[p] === target[p]) continue;
      const cw = prep.modBit[p] >> 3;
      const map = wrong[modBlock[p]];
      const entry = map.get(cw) ?? { weight: 0, pixels: [] };
      entry.weight += 1 + pr[p];
      entry.pixels.push(p);
      map.set(cw, entry);
    }
    prep.blocks.forEach((b, bi) => {
      const reserve = MISDECODE[version]?.[ecc] ?? 0;
      const max = Math.floor((Math.floor((b.eccLen - reserve) / 2)) * budget);
      [...wrong[bi].values()].sort((a, c) => c.weight - a.weight).slice(0, max)
        .forEach((e) => e.pixels.forEach((p) => { modules[p] = target[p]; }));
    });
  }

  let matched = 0;
  for (const p of order) if (modules[p] === target[p]) matched++;
  return { version, ecc, size, mask: best.mask, modules, matched, wanted: order.length, blocked };
}
