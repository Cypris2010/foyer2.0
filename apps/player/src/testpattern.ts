// Test patterns over the programme, started and stepped through in the admin.
// Drawn for the real screen (1 px is one device pixel) and, inside a wall, over
// the whole wall: lines run across the seams, while each screen keeps its own
// border, caption and info. Ends by itself at `until` (server clock).
import { TEST_PATTERNS, type TestPatternState } from '@foyer/slide-sdk/test-patterns';
import type { Wall } from './wall.ts';

export interface TestPatternInfo {
  name: string;
  wall: Wall | null;
  build: string | null;
  /** Server clock minus device clock, ms. */
  clockOffset: number;
}

interface Cell {
  x: number;
  y: number;
  w: number;
  h: number;
  row: number;
  col: number;
}

const MOTION_PERIOD_MS = 4000;
// Solid colours lose their caption after a moment, so the whole screen is clean.
const SOLID_CAPTION_MS = 4000;
const SOLIDS: Record<string, string> = { white: '#fff', black: '#000', red: '#f00', green: '#0f0', blue: '#00f' };
// EBU 100/0/75/0 colour bars.
const BARS = ['#ffffff', '#bfbf00', '#00bfbf', '#00bf00', '#bf00bf', '#bf0000', '#0000bf', '#000000'];

/** The screens of the canvas: one, or the wall's grid with bezels in between. */
export function wallCells(width: number, height: number, wall: Wall | null): Cell[] {
  if (!wall) return [{ x: 0, y: 0, w: width, h: height, row: 0, col: 0 }];
  const w = (width - (wall.cols - 1) * wall.bezel) / wall.cols;
  const h = (height - (wall.rows - 1) * wall.bezel) / wall.rows;
  const cells: Cell[] = [];
  for (let row = 0; row < wall.rows; row++) {
    for (let col = 0; col < wall.cols; col++) cells.push({ x: col * (w + wall.bezel), y: row * (h + wall.bezel), w, h, row, col });
  }
  return cells;
}

export function createTestPattern(now: () => number, info: () => TestPatternInfo) {
  const canvas = document.createElement('canvas');
  canvas.className = 'foyer-test';
  canvas.hidden = true;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d')!;

  let state: TestPatternState | null = null;
  let shownAt = 0;
  let frame = 0;
  let endTimer: ReturnType<typeof setTimeout> | undefined;
  let captionTimer: ReturnType<typeof setTimeout> | undefined;

  const draw = () => {
    cancelAnimationFrame(frame);
    if (!state) return;
    const pattern = TEST_PATTERNS[state.index] ?? TEST_PATTERNS[0];
    const dpr = window.devicePixelRatio || 1;
    const width = window.innerWidth;
    const height = window.innerHeight;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const { wall } = info();
    const cells = wallCells(width, height, wall);
    const own = cells.find((cell) => cell.row === (wall?.row ?? 0) && cell.col === (wall?.col ?? 0)) ?? cells[0];

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    switch (pattern.id) {
      case 'grid':
        drawGrid(ctx, width, height, cells);
        break;
      case 'edges':
        for (const cell of cells) drawEdges(ctx, cell, dpr);
        break;
      case 'bars':
        for (const cell of cells) drawBars(ctx, cell);
        break;
      case 'motion':
        drawMotion(ctx, width, cells, now());
        frame = requestAnimationFrame(draw);
        break;
      case 'info':
        for (const cell of cells) drawInfo(ctx, cell, cell === own ? info() : null, now());
        break;
      default:
        ctx.fillStyle = SOLIDS[pattern.id] ?? '#000';
        ctx.fillRect(0, 0, width, height);
    }
    const solid = pattern.id in SOLIDS;
    if (!solid || performance.now() - shownAt < SOLID_CAPTION_MS) {
      caption(ctx, own, `${state.index + 1}/${TEST_PATTERNS.length}  ${pattern.name}`, pattern.hint);
    }
  };

  window.addEventListener('resize', draw);

  return {
    /** null ends the test; the programme was running underneath all along. */
    show(next: TestPatternState | null) {
      clearTimeout(endTimer);
      clearTimeout(captionTimer);
      state = next && next.until > now() ? next : null;
      canvas.hidden = !state;
      if (!state) return cancelAnimationFrame(frame);
      shownAt = performance.now();
      endTimer = setTimeout(() => this.show(null), Math.min(state.until - now(), 2 ** 31 - 1));
      if ((TEST_PATTERNS[state.index]?.id ?? '') in SOLIDS) captionTimer = setTimeout(draw, SOLID_CAPTION_MS + 50);
      draw();
    },
  };
}

function line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

/** Square grid over the whole canvas (bezels included), diagonals and circles. */
function drawGrid(ctx: CanvasRenderingContext2D, width: number, height: number, cells: Cell[]) {
  const step = Math.max(8, Math.round(cells[0].h / 12));
  const cx = width / 2;
  const cy = height / 2;
  ctx.lineWidth = 1;
  for (let i = -Math.ceil(cx / step); i <= Math.ceil(cx / step); i++) {
    const x = Math.round(cx + i * step) + 0.5;
    ctx.strokeStyle = i % 4 === 0 ? '#bbb' : '#555';
    line(ctx, x, 0, x, height);
  }
  for (let i = -Math.ceil(cy / step); i <= Math.ceil(cy / step); i++) {
    const y = Math.round(cy + i * step) + 0.5;
    ctx.strokeStyle = i % 4 === 0 ? '#bbb' : '#555';
    line(ctx, 0, y, width, y);
  }
  // Across the whole wall: kinks at a seam mean the bezel setting is off.
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 3;
  line(ctx, 0, 0, width, height);
  line(ctx, width, 0, 0, height);
  ctx.strokeStyle = '#0ff';
  ctx.beginPath();
  ctx.arc(cx, cy, Math.min(width, height) * 0.45, 0, Math.PI * 2);
  ctx.stroke();
  // Per screen: centre cross and circle (round = right aspect ratio).
  ctx.lineWidth = 2;
  for (const cell of cells) {
    const mx = cell.x + cell.w / 2;
    const my = cell.y + cell.h / 2;
    ctx.strokeStyle = '#ff0';
    ctx.beginPath();
    ctx.arc(mx, my, Math.min(cell.w, cell.h) * 0.35, 0, Math.PI * 2);
    ctx.stroke();
    line(ctx, mx - cell.h * 0.05, my, mx + cell.h * 0.05, my);
    line(ctx, mx, my - cell.h * 0.05, mx, my + cell.h * 0.05);
  }
}

/** Border, overscan marks and 1-device-pixel fields of one screen. */
function drawEdges(ctx: CanvasRenderingContext2D, cell: Cell, dpr: number) {
  const { x, y, w, h } = cell;
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#fff';
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.setLineDash([6, 6]);
  ctx.strokeStyle = '#888';
  ctx.font = `${Math.round(h * 0.022)}px system-ui, sans-serif`;
  ctx.fillStyle = '#888';
  for (const share of [0.025, 0.05]) {
    const dx = Math.round(w * share);
    const dy = Math.round(h * share);
    ctx.strokeRect(x + dx + 0.5, y + dy + 0.5, w - 2 * dx - 1, h - 2 * dy - 1);
    ctx.fillText(`${share * 100} %`.replace('.', ','), x + dx + 6, y + dy + h * 0.03);
  }
  ctx.setLineDash([]);
  // Arrows pointing at the very edge: all four tips visible = nothing cut off.
  ctx.fillStyle = '#f00';
  const a = h * 0.04;
  const arrow = (points: number[]) => {
    ctx.beginPath();
    ctx.moveTo(points[0], points[1]);
    for (let i = 2; i < points.length; i += 2) ctx.lineTo(points[i], points[i + 1]);
    ctx.fill();
  };
  arrow([x + w / 2, y, x + w / 2 - a / 2, y + a, x + w / 2 + a / 2, y + a]);
  arrow([x + w / 2, y + h, x + w / 2 - a / 2, y + h - a, x + w / 2 + a / 2, y + h - a]);
  arrow([x, y + h / 2, x + a, y + h / 2 - a / 2, x + a, y + h / 2 + a / 2]);
  arrow([x + w, y + h / 2, x + w - a, y + h / 2 - a / 2, x + w - a, y + h / 2 + a / 2]);

  // Fields in device pixels: checkerboard, vertical and horizontal 1 px lines.
  // A scaling device turns them grey, blurry or moiré.
  const size = Math.round(Math.min(w, h) * 0.2 * dpr);
  const top = Math.round((y + h / 2) * dpr - size / 2);
  const left = Math.round((x + w / 2) * dpr - size * 1.75);
  const kinds = [(i: number, j: number) => (i + j) % 2, (i: number) => i % 2, (_i: number, j: number) => j % 2];
  kinds.forEach((on, k) => {
    const image = ctx.createImageData(size, size);
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const v = on(i, j) ? 255 : 0;
        const p = (j * size + i) * 4;
        image.data[p] = image.data[p + 1] = image.data[p + 2] = v;
        image.data[p + 3] = 255;
      }
    }
    ctx.putImageData(image, left + k * Math.round(size * 1.25), top);
  });
}

/** Colour bars, grey steps and near-black / near-white steps of one screen. */
function drawBars(ctx: CanvasRenderingContext2D, cell: Cell) {
  const { x, y, w, h } = cell;
  const barW = w / BARS.length;
  BARS.forEach((color, i) => {
    ctx.fillStyle = color;
    ctx.fillRect(Math.floor(x + i * barW), y, Math.ceil(barW), h * 0.6);
  });
  const steps = 11;
  for (let i = 0; i < steps; i++) {
    const v = Math.round((255 * i) / (steps - 1));
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect(Math.floor(x + (i * w) / steps), y + h * 0.6, Math.ceil(w / steps), h * 0.2);
  }
  // Each half: six steps that a well-set screen still tells apart.
  const near = [0, 4, 8, 12, 16, 20];
  near.forEach((v, i) => {
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect(Math.floor(x + (i * w) / 12), y + h * 0.8, Math.ceil(w / 12), h * 0.2);
    const bright = 255 - 20 + v;
    ctx.fillStyle = `rgb(${bright},${bright},${bright})`;
    ctx.fillRect(Math.floor(x + w / 2 + (i * w) / 12), y + h * 0.8, Math.ceil(w / 12), h * 0.2);
  });
}

/** A bar crossing the whole canvas and the server clock on every screen. */
function drawMotion(ctx: CanvasRenderingContext2D, width: number, cells: Cell[], t: number) {
  const barW = Math.max(4, cells[0].w * 0.04);
  const x = ((t % MOTION_PERIOD_MS) / MOTION_PERIOD_MS) * (width + barW) - barW;
  ctx.fillStyle = '#fff';
  ctx.fillRect(x, 0, barW, window.innerHeight);
  const seconds = Math.floor(t / 1000) % 60;
  const text = `${String(seconds).padStart(2, '0')}.${String(Math.floor(t % 1000)).padStart(3, '0')}`;
  for (const cell of cells) {
    ctx.font = `bold ${Math.round(cell.h * 0.2)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#0f0';
    ctx.fillText(text, cell.x + cell.w / 2, cell.y + cell.h / 2);
  }
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
}

/** Details on this screen; the other screens of a wall only show their field. */
function drawInfo(ctx: CanvasRenderingContext2D, cell: Cell, info: TestPatternInfo | null, t: number) {
  const size = Math.round(cell.h * 0.045);
  const left = cell.x + cell.w * 0.08;
  let top = cell.y + cell.h * 0.2;
  const write = (text: string, color = '#fff') => {
    ctx.fillStyle = color;
    ctx.fillText(text, left, top);
    top += size * 1.5;
  };
  ctx.font = `bold ${size * 1.6}px system-ui, sans-serif`;
  write(info ? info.name : `Zeile ${cell.row + 1}, Spalte ${cell.col + 1}`);
  if (!info) return;
  ctx.font = `${size}px system-ui, sans-serif`;
  top += size * 0.5;
  if (info.wall) write(`Wand „${info.wall.name}“, Zeile ${cell.row + 1}, Spalte ${cell.col + 1} von ${info.wall.rows} × ${info.wall.cols}`);
  const dpr = window.devicePixelRatio || 1;
  write(`Bildschirm ${Math.round(cell.w * dpr)} × ${Math.round(cell.h * dpr)} Pixel (devicePixelRatio ${dpr})`);
  if (info.wall) write(`Ganze Wand ${Math.round(window.innerWidth * dpr)} × ${Math.round(window.innerHeight * dpr)} Pixel, Rahmenausgleich ${info.wall.bezel} px`);
  write(`Player ${info.build ?? 'Entwicklung'}`);
  write(`Uhr ${new Date(t).toLocaleTimeString('de-DE')} · Abweichung des Geräts ${Math.round(info.clockOffset)} ms`);
  ctx.font = `${Math.round(size * 0.7)}px system-ui, sans-serif`;
  let agent = navigator.userAgent;
  const room = cell.w * 0.84;
  if (ctx.measureText(agent).width > room) {
    while (agent.length > 20 && ctx.measureText(`${agent}…`).width > room) agent = agent.slice(0, -1);
    agent += '…';
  }
  write(agent, '#888');
}

function caption(ctx: CanvasRenderingContext2D, cell: Cell, title: string, hint: string) {
  const size = Math.max(12, Math.round(cell.h * 0.028));
  const bold = `bold ${size}px system-ui, sans-serif`;
  const normal = `${size}px system-ui, sans-serif`;
  ctx.font = bold;
  const titleWidth = ctx.measureText(title).width;
  ctx.font = normal;
  const width = Math.max(titleWidth, ctx.measureText(hint).width);
  const x = cell.x + cell.w * 0.06;
  const y = cell.y + cell.h * 0.07;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
  ctx.fillRect(x - size * 0.5, y - size * 1.2, width + size, size * 3);
  ctx.fillStyle = '#fff';
  ctx.font = bold;
  ctx.fillText(title, x, y);
  ctx.font = normal;
  ctx.fillStyle = '#ccc';
  ctx.fillText(hint, x, y + size * 1.3);
}
