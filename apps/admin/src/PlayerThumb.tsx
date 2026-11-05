// Live miniature: the real (preview) player rendered at a fixed screen size and
// scaled down, so thumbnails look exactly like the display. Iframes load
// lazily, so long lists only render what is on screen.
import { useEffect, useRef, useState } from 'react';
import { relayPreviewEvents } from './previewEvents.ts';

const SIZES = {
  landscape: { width: 1280, height: 720 },
  portrait: { width: 720, height: 1280 },
};

const WALL_HEIGHT = 260;

/** A display wall: the whole grid, or (row/col) the part of one screen. */
export interface ThumbWall {
  rows: number;
  cols: number;
  row?: number;
  col?: number;
}

interface Props {
  /** Player URL, e.g. /p/preview/<slideId> or /p/preview-display/<displayId>. */
  src: string;
  /** Changing it reloads the miniature (e.g. the slide's updatedAt). */
  reloadKey?: string | number;
  orientation?: keyof typeof SIZES;
  wall?: ThumbWall;
}

export function PlayerThumb({ src, reloadKey = '', orientation = 'landscape', wall }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  const screen = SIZES[orientation];
  const cell = wall?.row !== undefined && wall.col !== undefined ? { row: wall.row, col: wall.col } : null;
  // The player renders the whole wall; a screen's thumbnail shows its cell of it.
  const size = wall ? { width: screen.width * wall.cols, height: screen.height * wall.rows } : screen;
  const shown = cell || !wall ? screen : size;

  useEffect(() => {
    const node = box.current;
    if (!node) return;
    const update = () => setScale(node.clientWidth / shown.width);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [shown.width]);

  // Live previews of a display get their events through the page's shared stream.
  const frame = useRef<HTMLIFrameElement>(null);
  const relayed = src.match(/^\/p\/preview-display\/([^/?]+)/)?.[1];
  const loaded = scale > 0;
  useEffect(() => {
    if (!relayed || !frame.current) return;
    return relayPreviewEvents(frame.current, relayed);
  }, [relayed, loaded, src, reloadKey]);

  const offset = cell ? `translate(${-cell.col * screen.width * scale}px, ${-cell.row * screen.height * scale}px) ` : '';
  return (
    <div
      ref={box}
      className={`thumb thumb--${orientation}${wall && !cell ? ' thumb--wall' : ''}`}
      // Whole wall: at most WALL_HEIGHT tall, as wide as that allows.
      style={wall && !cell ? { aspectRatio: `${size.width} / ${size.height}`, width: `min(100%, ${(WALL_HEIGHT * size.width) / size.height}px)` } : undefined}
      aria-hidden="true"
    >
      {scale > 0 && (
        <iframe
          ref={frame}
          key={`${src}-${reloadKey}`}
          src={relayed ? `${src}?relay` : src}
          loading="lazy"
          tabIndex={-1}
          title=""
          style={{ width: size.width, height: size.height, transform: `${offset}scale(${scale})` }}
        />
      )}
      {wall && !cell && (
        <div className="thumb__seams" style={{ gridTemplateColumns: `repeat(${wall.cols}, 1fr)`, gridTemplateRows: `repeat(${wall.rows}, 1fr)` }}>
          {Array.from({ length: wall.rows * wall.cols }, (_, i) => (
            <span key={i} />
          ))}
        </div>
      )}
    </div>
  );
}
