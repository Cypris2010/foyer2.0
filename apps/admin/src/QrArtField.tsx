// Editor for a QR code with a motif: text and icon, or pixels painted by hand,
// with a live preview that is checked with a decoder like the server does.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type ArtQr, type Ecc, type Grid, type IconName, type QrStyle, ICON_NAMES, ICONS, MAX_TEXT,
  artQr, composeMotif, emptyGrid, formatMotif, parseMotif,
} from '@foyer/qr-art';

export interface QrArtValue {
  text: string;
  icon: string;
  style: QrStyle;
  motif: string;
}

interface Props {
  value: QrArtValue;
  onChange: (value: QrArtValue) => void;
  url: string;
  ecc: Ecc;
  disabled?: boolean;
}

const ICON_LABELS: Record<IconName, string> = {
  herz: 'Herz', stern: 'Stern', haken: 'Haken', pfeil: 'Pfeil', info: 'Info',
  smiley: 'Smiley', haus: 'Haus', wlan: 'WLAN', brief: 'Brief', kalender: 'Kalender',
};
const STYLE_LABELS: Record<QrStyle, string> = { square: 'Quadrate', dots: 'Punkte', halftone: 'Halbton (Motiv besonders deutlich)' };
type Pen = 1 | 0 | -1;
const PENS: Array<[Pen, string]> = [[1, 'Dunkel'], [0, 'Hell'], [-1, 'Radierer']];
const MAX_SIDE = 61;

function resize(grid: Grid, width: number, height: number): Grid {
  const out = emptyGrid(width, height, 0);
  const dx = Math.floor((width - grid.width) / 2), dy = Math.floor((height - grid.height) / 2);
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const tx = x + dx, ty = y + dy;
      if (tx >= 0 && ty >= 0 && tx < width && ty < height) out.cells[ty * width + tx] = grid.cells[y * grid.width + x];
    }
  }
  return out;
}

function IconPreview({ name }: { name: IconName }) {
  const rows = ICONS[name];
  return (
    <svg viewBox="0 0 9 9" width="18" height="18" shapeRendering="crispEdges" aria-hidden="true">
      {rows.flatMap((row, y) => [...row].map((c, x) => (c === '#' ? <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" /> : null)))}
    </svg>
  );
}

function PixelEditor({ grid, disabled, onPaint }: { grid: Grid; disabled?: boolean; onPaint: (cells: Array<[number, number]>) => void }) {
  const ref = useRef<SVGSVGElement>(null);
  const last = useRef<[number, number] | null>(null);
  const cellAt = (e: React.PointerEvent): [number, number] => {
    const box = ref.current!.getBoundingClientRect();
    return [Math.floor(((e.clientX - box.left) / box.width) * grid.width), Math.floor(((e.clientY - box.top) / box.height) * grid.height)];
  };
  // Pointer events skip cells on fast strokes; paint the whole line since the last one.
  const at = (e: React.PointerEvent) => {
    const [x1, y1] = cellAt(e);
    const [x0, y0] = last.current ?? [x1, y1];
    last.current = [x1, y1];
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    const cells: Array<[number, number]> = [];
    for (let i = 0; i <= steps; i++) {
      const x = Math.round(x0 + ((x1 - x0) * i) / steps), y = Math.round(y0 + ((y1 - y0) * i) / steps);
      if (x >= 0 && y >= 0 && x < grid.width && y < grid.height) cells.push([x, y]);
    }
    if (cells.length) onPaint(cells);
  };
  const end = () => { last.current = null; };
  const cell = Math.max(6, Math.min(16, Math.floor(420 / Math.max(grid.width, grid.height))));
  return (
    <svg
      ref={ref}
      className="qr-art__pixels"
      viewBox={`0 0 ${grid.width} ${grid.height}`}
      width={grid.width * cell}
      height={grid.height * cell}
      shapeRendering="crispEdges"
      onPointerDown={(e) => {
        if (disabled) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        last.current = null;
        at(e);
      }}
      onPointerMove={(e) => last.current && at(e)}
      onPointerUp={end}
      onPointerCancel={end}
    >
      {Array.from(grid.cells, (c, i) => (
        <rect
          key={i}
          x={i % grid.width}
          y={Math.floor(i / grid.width)}
          width="1"
          height="1"
          className={c === 1 ? 'qr-art__dark' : c === 0 ? 'qr-art__light' : 'qr-art__free'}
        />
      ))}
    </svg>
  );
}

export function QrArtField({ value, onChange, url, ecc, disabled }: Props) {
  const [pen, setPen] = useState<Pen>(1);
  const composed = useMemo(() => composeMotif(value.text, value.icon as IconName | ''), [value.text, value.icon]);
  const custom = value.motif !== '';
  const motif = custom ? value.motif : composed;
  const grid = useMemo(() => (motif ? parseMotif(motif) : null), [motif]);

  // Computing takes up to ~100 ms; wait until painting or typing pauses.
  const [preview, setPreview] = useState<{ result: ArtQr | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!url || !motif) {
      setPreview(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        setPreview({ result: artQr({ url, ecc, motif, style: value.style }), error: null });
      } catch (e) {
        setPreview({ result: null, error: e instanceof Error ? e.message : String(e) });
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [url, ecc, motif, value.style]);

  const set = (patch: Partial<QrArtValue>) => onChange({ ...value, ...patch });
  const editable = grid ?? emptyGrid(15, 15, 0);
  // Newest grid, also between two pointer events that come before a re-render.
  const latest = useRef(editable);
  latest.current = editable;
  const paint = (cells: Array<[number, number]>) => {
    const base = latest.current;
    const next = { ...base, cells: base.cells.slice() };
    for (const [x, y] of cells) next.cells[y * base.width + x] = pen;
    latest.current = next;
    const motif = formatMotif(next);
    if (motif !== value.motif) set({ motif });
  };
  const setSize = (width: number, height: number) => {
    const clamp = (n: number) => Math.max(1, Math.min(MAX_SIDE, Math.round(n) || 1));
    set({ motif: formatMotif(resize(editable, clamp(width), clamp(height))) });
  };

  return (
    <div className="qr-art">
      <div className="qr-art__controls">
        <label className="field">
          <span>Text im Code</span>
          <input
            type="text"
            value={value.text}
            maxLength={MAX_TEXT}
            disabled={disabled}
            placeholder="z. B. MENSA"
            onChange={(e) => set({ text: e.target.value.toUpperCase() })}
          />
        </label>
        <div className="field">
          <span>Symbol</span>
          <div className="qr-art__icons" role="radiogroup" aria-label="Symbol">
            <button type="button" role="radio" aria-checked={value.icon === ''} className={value.icon === '' ? 'active' : ''} disabled={disabled} onClick={() => set({ icon: '' })}>
              Keins
            </button>
            {ICON_NAMES.map((name) => (
              <button
                key={name}
                type="button"
                role="radio"
                aria-checked={value.icon === name}
                className={value.icon === name ? 'active' : ''}
                title={ICON_LABELS[name]}
                aria-label={ICON_LABELS[name]}
                disabled={disabled}
                onClick={() => set({ icon: name })}
              >
                <IconPreview name={name} />
              </button>
            ))}
          </div>
        </div>
        <label className="field">
          <span>Darstellung</span>
          <select value={value.style} disabled={disabled} onChange={(e) => set({ style: e.target.value as QrStyle })}>
            {(Object.keys(STYLE_LABELS) as QrStyle[]).map((s) => <option key={s} value={s}>{STYLE_LABELS[s]}</option>)}
          </select>
        </label>
      </div>

      <div className="qr-art__panes">
        <div className="qr-art__pane">
          <div className="qr-art__toolbar">
            <span>Motiv bearbeiten</span>
            {PENS.map(([p, label]) => (
              <label key={label} className="qr-art__pen">
                <input type="radio" name="qr-art-pen" checked={pen === p} disabled={disabled} onChange={() => setPen(p)} />
                {label}
              </label>
            ))}
          </div>
          <PixelEditor grid={editable} disabled={disabled} onPaint={paint} />
          <div className="qr-art__size">
            <label>
              Breite <input type="number" min={1} max={MAX_SIDE} value={editable.width} disabled={disabled} onChange={(e) => setSize(Number(e.target.value), editable.height)} />
            </label>
            <label>
              Höhe <input type="number" min={1} max={MAX_SIDE} value={editable.height} disabled={disabled} onChange={(e) => setSize(editable.width, Number(e.target.value))} />
            </label>
          </div>
          <p className="muted qr-art__hint">Dunkel/Hell sind Wunschpixel; „Radierer“ gibt Pixel frei für den Code.</p>
          {custom && (
            <p className="muted qr-art__hint">
              Handgemaltes Motiv: Text und Symbol wirken erst wieder nach dem Zurücksetzen.{' '}
              <button type="button" disabled={disabled} onClick={() => set({ motif: '' })}>Zurücksetzen</button>
            </p>
          )}
        </div>

        <div className="qr-art__pane">
          <div className="qr-art__toolbar"><span>Vorschau</span></div>
          {!url ? (
            <p className="muted qr-art__hint">Bitte oben einen QR-Code-Link eintragen.</p>
          ) : !motif ? (
            <p className="muted qr-art__hint">Text, Symbol oder ein gemaltes Motiv ergibt einen QR-Code mit Motiv.</p>
          ) : !preview ? (
            <p className="muted qr-art__hint">Wird berechnet …</p>
          ) : preview.result ? (
            <>
              {/* SVG built by @foyer/qr-art from module data, no user markup. */}
              <div className="qr-art__preview" dangerouslySetInnerHTML={{ __html: preview.result.svg }} />
              <p className="qr-art__status qr-art__status--ok">
                Lesbar · Version {preview.result.version} · {Math.round(preview.result.match * 100)} % des Motivs getroffen
              </p>
            </>
          ) : (
            <p className="qr-art__status qr-art__status--bad">
              {preview.error ?? 'Mit diesem Motiv ist der Code nicht lesbar. Auf dem Display erscheint ein normaler QR-Code. Tipp: Motiv verkleinern oder Fehlerkorrektur L wählen.'}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
