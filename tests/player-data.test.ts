import { afterEach, describe, expect, it, vi } from 'vitest';
import { withSlideData } from '../apps/player/src/data.ts';
import type { Manifest, ManifestSlide } from '../apps/player/src/types.ts';

const slide = (dataVersion: string): ManifestSlide => ({
  id: 'room',
  type: 'webuntis-room-display',
  title: 'Belegung',
  duration: 30,
  keepAlive: true,
  config: {},
  data: null,
  dataUrl: '/content/data/room/1?d=x&s=y',
  dataVersion,
  background: null,
  media: {},
  playsToEnd: false,
});

const manifest = (version: string, dataVersion: string): Manifest => ({
  version,
  generatedAt: '2026-11-11T08:00:00Z',
  display: { id: 'd', name: 'T 3.00 Flur', showProgress: true, orientation: 'landscape' },
  channel: null,
  slides: [slide(dataVersion)],
  nextChange: null,
  settings: { locale: 'de-DE', timeZone: 'Europe/Berlin' },
});

const ok = (data: unknown) => vi.fn(async () => new Response(JSON.stringify({ data }), { status: 200 }));
const offline = () =>
  vi.fn(async () => {
    throw new TypeError('Failed to fetch');
  });

describe('withSlideData (Untis data in the player)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the last data when a fetch fails and asks for a retry', async () => {
    vi.stubGlobal('fetch', ok({ rows: [['A 1.01']] }));
    const first = await withSlideData(manifest('v1', 'd1'));
    expect(first.retry).toBe(false);
    expect(first.manifest.version).toBe('v1');
    expect(first.manifest.slides[0].data).toEqual({ rows: [['A 1.01']] });

    // New data on the server, but the network drops this one request.
    vi.stubGlobal('fetch', offline());
    const failed = await withSlideData(manifest('v2', 'd2'));
    expect(failed.retry).toBe(true);
    expect(failed.stale).toEqual(['Belegung: Daten nicht verfügbar: Failed to fetch']);
    expect(failed.manifest.slides[0].error).toBeUndefined();
    expect(failed.manifest.slides[0].data).toEqual({ rows: [['A 1.01']] });
    // Its own version: the retry with the same server manifest is not ignored as unchanged.
    expect(failed.manifest.version).not.toBe('v2');

    vi.stubGlobal('fetch', ok({ rows: [['A 1.05']] }));
    const retried = await withSlideData(manifest('v2', 'd2'));
    expect(retried.retry).toBe(false);
    expect(retried.manifest.version).toBe('v2');
    expect(retried.manifest.slides[0].data).toEqual({ rows: [['A 1.05']] });
  });

  it('marks the slide as failed when it never had data', async () => {
    vi.stubGlobal('fetch', offline());
    const result = await withSlideData({ ...manifest('v9', 'd9'), slides: [{ ...slide('d9'), id: 'fresh' }] });
    expect(result.retry).toBe(true);
    expect(result.stale).toEqual([]);
    expect(result.manifest.slides[0].error).toBe('Daten nicht verfügbar: Failed to fetch');
    expect(result.manifest.version).not.toBe('v9');
  });
});
