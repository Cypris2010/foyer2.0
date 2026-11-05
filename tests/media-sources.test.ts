import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { json, setup } from './helpers.ts';
import { ccName, checkUrl, clearSourceCache, openverse, pixabay, plainText, safeFetch, unsplash, wikimedia } from '../apps/server/src/media-sources.ts';
import { creditText } from '../apps/server/src/media.ts';
import { getSetting } from '../apps/server/src/db.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const PIXABAY_KEY = 'pixabay-testschluessel-9876';
const UNSPLASH_KEY = 'unsplash-testschluessel-5432';

// A real JPEG when ffmpeg is there (the import is converted then), else just its magic bytes.
let jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
beforeAll(() => {
  if (!hasFfmpeg) return;
  const file = join(mkdtempSync(join(tmpdir(), 'foyer-sources-')), 'bild.jpg');
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720', '-frames:v', '1', file]);
  jpeg = new Uint8Array(readFileSync(file));
});

// --- Made-up answers in the shape of the real APIs ---------------------------

const commonsImage = (title: string, over: Record<string, unknown> = {}) => ({
  title,
  index: 1,
  imageinfo: [
    {
      url: `https://upload.wikimedia.org/wikipedia/commons/a/ab/${encodeURIComponent(title.slice(5))}`,
      thumburl: `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/x.jpg/500px-x.jpg`,
      width: 4000,
      height: 3000,
      size: 9_000_000,
      mime: 'image/jpeg',
      mediatype: 'BITMAP',
      descriptionurl: `https://commons.wikimedia.org/wiki/${title.replace(/ /g, '_')}`,
      extmetadata: {
        Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Muster">Erika &amp; Max Muster</a>' },
        LicenseShortName: { value: 'CC BY-SA 4.0' },
        LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0' },
        AttributionRequired: { value: 'true' },
        ObjectName: { value: 'Schulhof im Herbst' },
      },
      ...over,
    },
  ],
});

const commonsVideo = {
  title: 'File:Wasserfall.webm',
  index: 1,
  videoinfo: [
    {
      url: 'https://upload.wikimedia.org/wikipedia/commons/d/df/Wasserfall.webm',
      thumburl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/df/Wasserfall.webm/500px--Wasserfall.webm.jpg',
      width: 3840,
      height: 2160,
      size: 400_000_000,
      duration: 13.2,
      mime: 'video/webm',
      mediatype: 'VIDEO',
      descriptionurl: 'https://commons.wikimedia.org/wiki/File:Wasserfall.webm',
      derivatives: [
        { src: 'https://upload.wikimedia.org/transcoded/d/df/Wasserfall.webm/Wasserfall.webm.480p.vp9.webm', type: 'video/webm; codecs="vp9, opus"', width: 854, height: 480 },
        { src: 'https://upload.wikimedia.org/transcoded/d/df/Wasserfall.webm/Wasserfall.webm.1080p.vp9.webm', type: 'video/webm; codecs="vp9, opus"', width: 1920, height: 1080 },
        { src: 'https://upload.wikimedia.org/transcoded/d/df/Wasserfall.webm/Wasserfall.webm.2160p.vp9.webm', type: 'video/webm; codecs="vp9, opus"', width: 3840, height: 2160 },
        { src: 'https://upload.wikimedia.org/transcoded/d/df/Wasserfall.webm/Wasserfall.webm.360p.mpeg4.mov', type: 'video/quicktime', width: 640, height: 360 },
      ],
      extmetadata: { Artist: { value: 'PantaRhei' }, LicenseShortName: { value: 'CC0' }, AttributionRequired: { value: 'false' } },
    },
  ],
};

const openverseImage = {
  id: 'b1dc9ade-dc16-4db7-93d0-433bf095237f',
  title: 'Klassenzimmer',
  foreign_landing_url: 'https://www.flickr.com/photos/123@N04/13884976499',
  url: 'https://live.staticflickr.com/7378/13884976499_0eec392706_b.jpg',
  creator: 'sarusekh',
  creator_url: 'https://www.flickr.com/photos/123@N04',
  license: 'by-nc',
  license_version: '2.0',
  license_url: 'https://creativecommons.org/licenses/by-nc/2.0/',
  source: 'flickr',
  width: 1024,
  height: 768,
  thumbnail: 'https://api.openverse.org/v1/images/b1dc9ade-dc16-4db7-93d0-433bf095237f/thumb/',
};

const pixabayImage = {
  id: 195893,
  pageURL: 'https://pixabay.com/photos/blossom-bloom-flower-195893/',
  tags: 'blüte, blume, frühling',
  user: 'Josch13',
  user_id: 48777,
  webformatURL: 'https://pixabay.com/get/35bbf209e13e39d2_640.jpg',
  largeImageURL: 'https://pixabay.com/get/ed6a99fd0a76647_1280.jpg',
  imageWidth: 4000,
  imageHeight: 2250,
};

const pixabayVideo = {
  id: 125,
  pageURL: 'https://pixabay.com/videos/id-125/',
  tags: 'blumen, gelb',
  user: 'CoverrFree',
  user_id: 1281706,
  duration: 12,
  videos: {
    large: { url: 'https://cdn.pixabay.com/video/125/large.mp4', width: 3840, height: 2160, size: 90_000_000, thumbnail: 'https://cdn.pixabay.com/video/125/large.jpg' },
    medium: { url: 'https://cdn.pixabay.com/video/125/medium.mp4', width: 1920, height: 1080, size: 20_000_000, thumbnail: 'https://cdn.pixabay.com/video/125/medium.jpg' },
    small: { url: 'https://cdn.pixabay.com/video/125/small.mp4', width: 1280, height: 720, size: 9_000_000, thumbnail: 'https://cdn.pixabay.com/video/125/small.jpg' },
    tiny: { url: '', width: 0, height: 0, size: 0, thumbnail: '' },
  },
};

const unsplashPhoto = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  width: 6000,
  height: 4000,
  description: 'Bücherregal in der Bibliothek',
  alt_description: 'books on shelf',
  urls: { raw: `https://images.unsplash.com/photo-${id}?ixid=abc`, small: `https://images.unsplash.com/photo-${id}?w=400` },
  links: { html: `https://unsplash.com/photos/${id}`, download_location: `https://api.unsplash.com/photos/${id}/download?ixid=abc` },
  user: { name: 'Anna Fotografin', links: { html: 'https://unsplash.com/@anna' } },
  ...over,
});

let fetchMock: Mock<(input: string | URL, init?: RequestInit) => Promise<Response>>;
const requested = (part: string) => fetchMock.mock.calls.filter(([url]) => String(url).includes(part));
const ok = (body: unknown) => Response.json(body);

beforeEach(() => {
  clearSourceCache();
  fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    if (url.hostname === 'commons.wikimedia.org') {
      if (url.searchParams.get('titles') === 'File:Wasserfall.webm' || url.searchParams.get('gsrsearch')?.includes('filetype:video')) {
        return ok({ query: { pages: [commonsVideo] } });
      }
      if (url.searchParams.has('titles')) {
        const page = commonsImage(url.searchParams.get('titles')!, { thumburl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/x.jpg/1920px-x.jpg' });
        return ok({ query: { pages: [page] } });
      }
      return ok({
        continue: { gsroffset: 24 },
        query: {
          searchinfo: { totalhits: 2 },
          pages: [
            // Without license metadata, and with a Wikidata label in the name.
            { ...commonsImage('File:Schulhof.jpg', { extmetadata: { ObjectName: { value: 'Schulhof, Wien label QS:Lde,"Schulhof, Wien"' } } }), index: 2 }, { ...commonsImage('File:Aula.jpg'), index: 1 }, { title: 'File:Ton.ogg', index: 3, imageinfo: [{ mediatype: 'AUDIO', thumburl: 'x' }] }],
        },
      });
    }
    if (url.hostname === 'api.openverse.org') {
      if (url.pathname === `/v1/images/${openverseImage.id}/`) return ok(openverseImage);
      return ok({ result_count: 240, page_count: 12, results: [openverseImage] });
    }
    if (url.hostname === 'pixabay.com' && url.pathname.startsWith('/api/')) {
      if (url.searchParams.get('key') !== PIXABAY_KEY) return new Response('[ERROR 400] "key" is not valid', { status: 400 });
      const hit = url.pathname === '/api/videos/' ? pixabayVideo : pixabayImage;
      return ok({ total: 500, totalHits: 500, hits: [hit] });
    }
    if (url.hostname === 'api.unsplash.com') {
      if (headers.get('authorization') !== `Client-ID ${UNSPLASH_KEY}`) return Response.json({ errors: ['OAuth error: The access token is invalid'] }, { status: 401 });
      if (url.pathname === '/search/photos') return ok({ total: 2, total_pages: 1, results: [unsplashPhoto('aaa'), unsplashPhoto('plus1', { premium: true })] });
      if (url.pathname === '/photos/aaa') return ok(unsplashPhoto('aaa'));
      if (url.pathname === '/photos/aaa/download') return ok({ url: 'https://images.unsplash.com/photo-aaa?ixid=abc&fm=jpg' });
    }
    // File downloads and previews.
    if (url.hostname === 'redirect.example.org') return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8080/api/auth/me' } });
    if (/\.(jpg|jpeg)$/.test(url.pathname) || url.pathname.endsWith('/thumb/') || url.hostname === 'images.unsplash.com' || url.pathname.includes('/get/')) {
      return new Response(jpeg, { headers: { 'content-type': 'image/jpeg', 'content-length': String(jpeg.length) } });
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Hilfsfunktionen', () => {
  it('macht aus HTML-Autoren Text und aus Lizenzcodes Namen', () => {
    expect(plainText('<a href="//x">Erika &amp; Max</a> <i>Muster</i>&#x21;')).toBe('Erika & Max Muster !');
    expect(plainText('')).toBeNull();
    expect(ccName('by-sa', '4.0')).toBe('CC BY-SA 4.0');
    expect(ccName('cc0', '1.0')).toBe('CC0 1.0');
    expect(ccName('pdm', '')).toBe('Public Domain Mark');
  });

  it('lässt nur https zu benannten Hosts zu, auch nach Weiterleitungen', async () => {
    expect(checkUrl('https://upload.wikimedia.org/x.jpg').hostname).toBe('upload.wikimedia.org');
    for (const bad of ['http://upload.wikimedia.org/x.jpg', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://localhost/x', 'https://nas.local/x', 'https://intranet/x', 'file:///etc/passwd']) {
      expect(() => checkUrl(bad), bad).toThrow();
    }
    await expect(safeFetch('https://redirect.example.org/bild.jpg')).rejects.toThrow(/nicht erlaubt/);
  });

  it('baut den Bildnachweis', () => {
    const source = { provider: 'wikimedia', providerName: 'Wikimedia Commons', id: 'File:x.jpg', title: 'Schulhof', author: 'Erika Muster', authorUrl: null, pageUrl: 'https://x', license: 'CC BY-SA 4.0', licenseUrl: null, attribution: true, via: 'Wikimedia Commons' };
    expect(creditText('image', source)).toBe('Foto: „Schulhof“, Erika Muster · CC BY-SA 4.0 · Wikimedia Commons');
    expect(creditText('video', { ...source, title: 'x'.repeat(80), author: null })).toBe('Video: unbekannt · CC BY-SA 4.0 · Wikimedia Commons');
  });
});

describe('Anbindungen', () => {
  it('Wikimedia Commons: Treffer in Suchreihenfolge, nur der gesuchte Typ, Lizenz aus den Metadaten', async () => {
    const result = await wikimedia.search('Schulhof', 'image', 1, null);
    expect(result.hits.map((h) => h.id)).toEqual(['File:Aula.jpg', 'File:Schulhof.jpg']);
    expect(result.hasMore).toBe(true);
    expect(result.hits[0]).toMatchObject({ kind: 'image', author: 'Erika & Max Muster', license: 'CC BY-SA 4.0', attribution: true, title: 'Schulhof im Herbst' });
    expect(result.hits[1]).toMatchObject({ title: 'Schulhof, Wien', author: null, license: 'Lizenz siehe Quelle', attribution: true });
    const [[searchUrl, searchInit]] = requested('generator=search');
    expect(new URL(searchUrl).searchParams.get('gsrsearch')).toBe('Schulhof filetype:bitmap');
    expect(new Headers(searchInit?.headers).get('user-agent')).toMatch(/^Foyer\/2\.0/);

    const image = await wikimedia.resolve('File:Aula.jpg', 'image', null);
    // 1920 px rendering, not the 4000 px original.
    expect(image.download).toContain('1920px-');
    expect(image.source).toMatchObject({ author: 'Erika & Max Muster', authorUrl: 'https://commons.wikimedia.org/wiki/User:Muster', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0' });
    await expect(wikimedia.resolve('https://evil.example/x', 'image', null)).rejects.toThrow(/Ungültige/);
  });

  it('Wikimedia Commons: Videos als 1080p-WebM statt 4K-Original', async () => {
    const result = await wikimedia.search('Wasserfall', 'video', 1, null);
    expect(result.hits[0]).toMatchObject({ kind: 'video', duration: 13.2, attribution: false, license: 'CC0' });
    const video = await wikimedia.resolve('File:Wasserfall.webm', 'video', null);
    expect(video.download).toMatch(/1080p\.vp9\.webm$/);
  });

  it('Openverse: CC-Lizenz und Sammlung je Treffer', async () => {
    const result = await openverse.search('Klassenzimmer', 'image', 1, null);
    expect(result).toMatchObject({ total: 240, hasMore: true });
    expect(result.hits[0]).toMatchObject({ license: 'CC BY-NC 2.0', attribution: true, author: 'sarusekh' });
    const resolved = await openverse.resolve(openverseImage.id, 'image', null);
    expect(resolved.download).toBe(openverseImage.url);
    expect(resolved.source).toMatchObject({ via: 'Flickr', providerName: 'Openverse', licenseUrl: openverseImage.license_url });
  });

  it('Pixabay: braucht den Schlüssel, Videos höchstens 1080p', async () => {
    await expect(pixabay.search('Blume', 'image', 1, null)).rejects.toThrow(/kein API-Schlüssel/);
    await expect(pixabay.search('Blume', 'image', 1, 'falsch')).rejects.toThrow(/API-Schlüssel ungültig/);
    const images = await pixabay.search('Blume', 'image', 1, PIXABAY_KEY);
    expect(images.hits[0]).toMatchObject({ id: '195893', license: 'Pixabay-Inhaltslizenz', attribution: false, thumb: pixabayImage.webformatURL });
    expect(new URL(requested('pixabay.com/api/?')[0][0]).searchParams.get('safesearch')).toBe('true');

    const video = await pixabay.resolve('125', 'video', PIXABAY_KEY);
    expect(video.download).toBe('https://cdn.pixabay.com/video/125/medium.mp4');
    expect(video.source.authorUrl).toBe('https://pixabay.com/users/CoverrFree-1281706/');
  });

  it('Unsplash: ohne Unsplash+, Download wird bei Unsplash gemeldet', async () => {
    const result = await unsplash.search('Bibliothek', 'image', 1, UNSPLASH_KEY);
    expect(result.hits.map((h) => h.id)).toEqual(['aaa']);
    const resolved = await unsplash.resolve('aaa', 'image', UNSPLASH_KEY);
    expect(requested('/photos/aaa/download')).toHaveLength(1);
    const download = new URL(resolved.download);
    expect(download.searchParams.get('w')).toBe('1920');
    expect(download.searchParams.get('fit')).toBe('max');
    expect(resolved.source.pageUrl).toContain('utm_source=foyer');
  });
});

describe('Einstellungen', () => {
  it('nur Admins; Schlüssel verschlüsselt, nicht im Audit-Log, nur das Ende sichtbar', async () => {
    const { app, db, loginAs } = await setup();
    const editor = await loginAs('editor');
    expect((await app.request('/api/settings/media-sources', { headers: { cookie: editor } })).status).toBe(403);
    expect((await app.request('/api/settings/media-sources/pixabay', json('PUT', { key: PIXABAY_KEY }, editor))).status).toBe(403);

    const cookie = await loginAs('admin');
    const initial = await (await app.request('/api/settings/media-sources', { headers: { cookie } })).json();
    expect(initial.map((s: any) => [s.id, s.needsKey, s.keySet])).toEqual([
      ['wikimedia', false, false],
      ['openverse', false, false],
      ['pixabay', true, false],
      ['unsplash', true, false],
    ]);
    expect((await app.request('/api/settings/media-sources/wikimedia', json('PUT', { key: 'x' }, cookie))).status).toBe(404);

    const saved = await (await app.request('/api/settings/media-sources/pixabay', json('PUT', { key: PIXABAY_KEY }, cookie))).json();
    expect(saved.find((s: any) => s.id === 'pixabay')).toMatchObject({ keySet: true, keyHint: '…9876' });
    expect(JSON.stringify(saved)).not.toContain(PIXABAY_KEY);
    expect(getSetting(db, 'media_source_pixabay_key')).not.toContain(PIXABAY_KEY);
    const logged = db.prepare("SELECT detail_json FROM audit_log WHERE entity = 'settings'").all() as Array<{ detail_json: string }>;
    expect(logged.map((l) => l.detail_json).join()).not.toContain(PIXABAY_KEY);

    const test = await (await app.request('/api/settings/media-sources/pixabay/test', json('POST', {}, cookie))).json();
    expect(test).toEqual({ ok: true, count: 500, more: false });
    expect((await (await app.request('/api/settings/media-sources/unsplash/test', json('POST', {}, cookie))).json()).error).toMatch(/zuerst/);

    await app.request('/api/settings/media-sources/pixabay', json('PUT', { key: '' }, cookie));
    const list = await (await app.request('/api/media-sources', { headers: { cookie: editor } })).json();
    expect(list.find((s: any) => s.id === 'pixabay').ready).toBe(false);
    expect(list.find((s: any) => s.id === 'wikimedia').ready).toBe(true);
  });
});

describe('Suche und Übernahme', () => {
  it('sucht nur für Redakteure, Vorschauen nur über signierte Adressen', async () => {
    const { app, loginAs } = await setup();
    const viewer = await loginAs('viewer');
    expect((await app.request('/api/media-sources/wikimedia/search?q=Schule', { headers: { cookie: viewer } })).status).toBe(403);

    const cookie = await loginAs('editor');
    expect((await app.request('/api/media-sources/wikimedia/search?q=', { headers: { cookie } })).status).toBe(400);
    expect((await app.request('/api/media-sources/openverse/search?q=Schule&kind=video', { headers: { cookie } })).status).toBe(400);
    expect((await app.request('/api/media-sources/pixabay/search?q=Schule', { headers: { cookie } })).status).toBe(400);
    const res = await app.request('/api/media-sources/wikimedia/search?q=Schulhof', { headers: { cookie } });
    expect(res.status).toBe(200);
    const result = await res.json();
    const thumb = result.hits[0].thumb as string;
    expect(thumb).toMatch(/^\/api\/media-sources\/thumb\?u=/);
    expect(result.hits[0].mediaId).toBeNull();

    // Same search again: from the cache.
    await app.request('/api/media-sources/wikimedia/search?q=Schulhof', { headers: { cookie } });
    expect(requested('generator=search')).toHaveLength(1);

    const preview = await app.request(thumb, { headers: { cookie } });
    expect(preview.status).toBe(200);
    expect(preview.headers.get('content-type')).toBe('image/jpeg');
    const forged = `/api/media-sources/thumb?${new URLSearchParams({ u: 'https://intranet.schule.de/geheim.jpg', s: new URL(thumb, 'http://x').searchParams.get('s')! })}`;
    expect((await app.request(forged, { headers: { cookie } })).status).toBe(403);
  });

  it('übernimmt einen Treffer wie einen Upload, mit Herkunft und Bildnachweis', async () => {
    const { app, ctx, db, token, loginAs } = await setup();
    const cookie = await loginAs('editor');
    const viewer = await loginAs('viewer');
    const body = { source: 'wikimedia', id: 'File:Aula.jpg', kind: 'image' };
    expect((await app.request('/api/media/import', json('POST', body, viewer))).status).toBe(403);
    expect((await app.request('/api/media/import', json('POST', { ...body, source: 'pexels' }, cookie))).status).toBe(404);

    const res = await app.request('/api/media/import', json('POST', body, cookie));
    expect(res.status).toBe(201);
    const item = await res.json();
    expect(item).toMatchObject({
      kind: 'image',
      name: 'Aula.jpg',
      showCredit: true,
      credit: 'Foto: „Schulhof im Herbst“, Erika & Max Muster · CC BY-SA 4.0 · Wikimedia Commons',
      source: { provider: 'wikimedia', id: 'File:Aula.jpg', license: 'CC BY-SA 4.0', pageUrl: 'https://commons.wikimedia.org/wiki/File:Aula.jpg' },
    });
    expect(requested('1920px-x.jpg')).toHaveLength(1);
    const logged = db.prepare("SELECT detail_json FROM audit_log WHERE action = 'import'").get() as { detail_json: string };
    expect(JSON.parse(logged.detail_json)).toMatchObject({ source: 'wikimedia', sourceId: 'File:Aula.jpg' });

    // Again: the existing item, nothing downloaded; the search marks it.
    const again = await app.request('/api/media/import', json('POST', body, cookie));
    expect(again.status).toBe(200);
    expect((await again.json()).id).toBe(item.id);
    expect(requested('1920px-x.jpg')).toHaveLength(1);
    const search = await (await app.request('/api/media-sources/wikimedia/search?q=Aula', { headers: { cookie } })).json();
    expect(search.hits.find((h: any) => h.id === 'File:Aula.jpg').mediaId).toBe(item.id);

    await ctx.media.idle();
    if (hasFfmpeg) {
      const ready = await (await app.request(`/api/media/${item.id}`, { headers: { cookie } })).json();
      expect(ready.status).toBe('ready');
      expect(ready.thumb).toMatch(/-thumb1\.jpg$/);
    }

    // Credit line on the display; switched off it is gone.
    const slide = { title: 's-text', type: 'text', config: { title: 'Hallo' }, published: true, background: { kind: 'image', mediaId: item.id } };
    expect((await app.request('/api/slides/s-text', json('PUT', slide, cookie))).status).toBe(200);
    const credits = async () => (await (await app.request(`/api/player/${token}/manifest`)).json()).slides.find((s: any) => s.id === 's-text')?.credits;
    if (hasFfmpeg) expect(await credits()).toEqual([item.credit]);
    expect((await app.request(`/api/media/${item.id}`, json('PATCH', { showCredit: false }, cookie))).status).toBe(200);
    expect(await credits()).toBeUndefined();
  });

  it('meldet Fehler der Bilddatenbank und zu große Dateien', async () => {
    const { app, ctx, loginAs } = await setup();
    const cookie = await loginAs('editor');
    fetchMock.mockImplementationOnce(async () => new Response('busy', { status: 429 }));
    const limited = await app.request('/api/media/import', json('POST', { source: 'openverse', id: openverseImage.id, kind: 'image' }, cookie));
    expect(limited.status).toBe(429);
    expect((await limited.json()).error).toMatch(/zu viele Anfragen/);

    const huge = String(ctx.media.maxBytes + 1);
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) =>
      String(input).includes('staticflickr') ? new Response(jpeg, { headers: { 'content-length': huge } }) : original(input, init),
    );
    const tooBig = await app.request('/api/media/import', json('POST', { source: 'openverse', id: openverseImage.id, kind: 'image' }, cookie));
    expect(tooBig.status).toBe(413);
    expect((await (await app.request('/api/media', { headers: { cookie } })).json())).toHaveLength(0);
  });

  it('Bildnachweis nur für übernommene Medien', async () => {
    const { app, loginAs } = await setup();
    const cookie = await loginAs('editor');
    const upload = await app.request('/api/media?name=eigen.jpg', {
      method: 'POST',
      headers: { cookie, 'sec-fetch-site': 'same-origin', 'content-type': 'application/octet-stream' },
      body: jpeg,
    });
    const item = await upload.json();
    expect(item).toMatchObject({ source: null, showCredit: false, credit: null });
    expect((await app.request(`/api/media/${item.id}`, json('PATCH', { showCredit: true }, cookie))).status).toBe(400);
    expect((await app.request(`/api/media/${item.id}`, json('PATCH', {}, cookie))).status).toBe(400);
    expect((await app.request(`/api/media/${item.id}`, json('PATCH', { name: 'Neu' }, cookie))).status).toBe(200);
  });
});
