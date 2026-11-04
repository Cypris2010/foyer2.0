// Live miniature of a slide: the real preview player rendered at a fixed
// screen size and scaled down, so thumbnails look exactly like the display.
// Iframes load lazily, so long lists only render what is on screen.
import { useEffect, useRef, useState } from 'react';

const SIZES = {
  landscape: { width: 1280, height: 720 },
  portrait: { width: 720, height: 1280 },
};

interface Props {
  slideId: string;
  /** Changes whenever the slide was saved, to reload the miniature. */
  version: number;
  orientation?: keyof typeof SIZES;
}

export function SlideThumb({ slideId, version, orientation = 'landscape' }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  const size = SIZES[orientation];

  useEffect(() => {
    const node = box.current;
    if (!node) return;
    const update = () => setScale(node.clientWidth / size.width);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [size.width]);

  return (
    <div ref={box} className={`thumb thumb--${orientation}`} aria-hidden="true">
      {scale > 0 && (
        <iframe
          key={`${slideId}-${version}`}
          src={`/p/preview/${slideId}`}
          loading="lazy"
          tabIndex={-1}
          title=""
          style={{ width: size.width, height: size.height, transform: `scale(${scale})` }}
        />
      )}
    </div>
  );
}
