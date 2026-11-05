// External image databases: search with preview, and import into the media
// library like an upload (same pipeline, thumbnail, deduplication).
//
// Only the server talks to the databases. Keys stay here, previews go through
// /api/media-sources/thumb (signed URLs: the admin CSP allows only 'self', and
// the browsers of the staff contact no outside service). An import looks the
// hit up again by its id, so no URL coming from a browser is ever fetched.
import type { MediaKind, MediaSource } from './media.ts';

export const USER_AGENT = 'Foyer/2.0 (Digital Signage; https://github.com/Cypris2010/foyer2.0)';
// Openverse takes over 10 s at times without an account.
const TIMEOUT_MS = 25_000;
const PAGE_SIZE = 24;

export class SourceError extends Error {
  status: 400 | 404 | 413 | 429 | 502;
  constructor(status: SourceError['status'], message: string) {
    super(message);
    this.status = status;
  }
}

/** A search result; `thumb` is the database's preview URL (signed and proxied by the routes). */
export interface SourceHit {
  id: string;
  kind: MediaKind;
  title: string | null;
  author: string | null;
  license: string;
  attribution: boolean;
  pageUrl: string;
  thumb: string;
  width: number | null;
  height: number | null;
  duration: number | null;
}

export interface SearchResult {
  hits: SourceHit[];
  hasMore: boolean;
  total: number | null;
}

/** What an import downloads: the file and what is stored with it. */
export interface Resolved {
  download: string;
  name: string;
  source: MediaSource;
}

export interface Provider {
  id: string;
  name: string;
  kinds: MediaKind[];
  /** Where an admin gets a key; absent: works without one. */
  key?: { signup: string; placeholder: string };
  /** Shown in the admin next to the results. */
  terms: string;
  homepage: string;
  /** Seconds a search result may be reused (Pixabay asks for 24 h caching). */
  cacheSeconds: number;
  search(query: string, kind: MediaKind, page: number, key: string | null): Promise<SearchResult>;
  resolve(id: string, kind: MediaKind, key: string | null): Promise<Resolved>;
}

// --- HTTP --------------------------------------------------------------------

/**
 * Only https to a named host: no IP literals or local names, also not after a
 * redirect. The URLs come from the databases' answers, never from a browser.
 */
export function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SourceError(502, 'Ungültige Adresse von der Bilddatenbank');
  }
  const host = url.hostname.toLowerCase();
  const local = host === 'localhost' || /\.(localhost|local|internal|lan|home|test)$/.test(host) || !host.includes('.');
  const ipLiteral = /^\d+(\.\d+){3}$/.test(host) || host.startsWith('[');
  if (url.protocol !== 'https:' || local || ipLiteral) throw new SourceError(502, `Adresse nicht erlaubt: ${url.protocol}//${host}`);
  return url;
}

/** fetch() with the checks of checkUrl() on every redirect hop. */
export async function safeFetch(raw: string, init: RequestInit = {}, timeoutMs = TIMEOUT_MS): Promise<Response> {
  const signal = AbortSignal.timeout(timeoutMs);
  let url = checkUrl(raw);
  for (let hop = 0; hop < 5; hop++) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal, redirect: 'manual', headers: { 'User-Agent': USER_AGENT, ...init.headers } });
    } catch (err) {
      const reason = (err as Error).name === 'TimeoutError' ? 'Zeitüberschreitung' : (err as Error).message;
      throw new SourceError(502, `${url.hostname} nicht erreichbar (${reason})`);
    }
    const location = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !location) return res;
    url = checkUrl(new URL(location, url).href);
  }
  throw new SourceError(502, 'Zu viele Weiterleitungen');
}

async function getJson<T>(provider: string, url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await safeFetch(url, { headers: { Accept: 'application/json', ...headers } });
  if (res.status === 401 || res.status === 403) throw new SourceError(502, `${provider}: API-Schlüssel ungültig oder ohne Berechtigung`);
  if (res.status === 404) throw new SourceError(404, `${provider}: nicht gefunden`);
  if (res.status === 429) throw new SourceError(429, `${provider}: zu viele Anfragen, bitte später noch einmal versuchen`);
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    // Pixabay answers a wrong key with 400 "[ERROR 400] "key" is not valid".
    if (/key/i.test(text) && res.status === 400) throw new SourceError(502, `${provider}: API-Schlüssel ungültig`);
    throw new SourceError(502, `${provider}: HTTP ${res.status}${text ? ` (${text})` : ''}`);
  }
  return (await res.json()) as T;
}

function needKey(provider: string, key: string | null): string {
  if (!key) throw new SourceError(400, `Für ${provider} ist kein API-Schlüssel eingetragen (Einstellungen)`);
  return key;
}

// --- Text helpers --------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Wikimedia gives authors as HTML ("<a href=…>Name</a>"). */
export function plainText(html: string | null | undefined): string | null {
  if (!html) return null;
  const text = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, code: string) => {
      if (code[0] !== '#') return ENTITIES[code.toLowerCase()] ?? all;
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) ? String.fromCodePoint(n) : all;
    })
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, 200) : null;
}

/** Protocol-relative links ("//commons…") made absolute; only http(s). */
function absoluteUrl(href: string | null | undefined): string | null {
  if (!href) return null;
  const url = href.startsWith('//') ? `https:${href}` : href;
  return /^https?:\/\//.test(url) ? url : null;
}

function firstLink(html: string | undefined): string | null {
  return absoluteUrl(/href="([^"]+)"/.exec(html ?? '')?.[1]);
}

/** Openverse license codes as people write them: "by-sa" 4.0 → "CC BY-SA 4.0". */
export function ccName(code: string, version: string | null | undefined): string {
  if (code === 'pdm') return 'Public Domain Mark';
  if (code === 'cc0') return 'CC0 1.0';
  return `CC ${code.toUpperCase()}${version ? ` ${version}` : ''}`;
}

/** Largest variant whose short side is at most 1080 px (displays never show more), else the smallest. */
function pickSize<T extends { width: number; height: number }>(variants: T[]): T | undefined {
  const fitting = variants.filter((v) => Math.min(v.width, v.height) <= 1080).sort((a, b) => b.width * b.height - a.width * a.height);
  return fitting[0] ?? [...variants].sort((a, b) => a.width * a.height - b.width * b.height)[0];
}

// --- Wikimedia Commons -----------------------------------------------------------

interface CommonsInfo {
  url: string;
  thumburl?: string;
  width: number;
  height: number;
  size: number;
  duration?: number;
  mime: string;
  mediatype: string;
  descriptionurl: string;
  derivatives?: Array<{ src: string; type: string; width: number; height: number }>;
  extmetadata?: Record<string, { value: string } | undefined>;
}

interface CommonsPage {
  title: string;
  index?: number;
  imageinfo?: CommonsInfo[];
  videoinfo?: CommonsInfo[];
}

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const COMMONS_META = 'Artist|LicenseShortName|LicenseUrl|AttributionRequired|ObjectName';

function commonsQuery(kind: MediaKind, params: Record<string, string>, width: number): string {
  const prefix = kind === 'video' ? 'vi' : 'ii';
  const query = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    prop: kind === 'video' ? 'videoinfo' : 'imageinfo',
    [`${prefix}prop`]: `url|size|mime|mediatype|extmetadata${kind === 'video' ? '|derivatives' : ''}`,
    [`${prefix}urlwidth`]: String(width),
    [`${prefix}extmetadatafilter`]: COMMONS_META,
    [`${prefix}extmetadatalanguage`]: 'de',
    ...params,
  });
  return `${COMMONS_API}?${query}`;
}

function commonsLicense(info: CommonsInfo) {
  const meta = info.extmetadata ?? {};
  const license = plainText(meta.LicenseShortName?.value) ?? 'Lizenz siehe Quelle';
  return {
    license,
    licenseUrl: absoluteUrl(meta.LicenseUrl?.value),
    // Public domain and CC0 need none; when unknown, credit to be safe.
    attribution: meta.AttributionRequired?.value !== 'false',
    author: plainText(meta.Artist?.value),
    authorUrl: firstLink(meta.Artist?.value),
    // Wikidata labels leak into some names: "Schulhof, Wien label QS:Lde,"Schulhof, Wien"".
    title: plainText(meta.ObjectName?.value)?.replace(/\s*label QS:.*$/, '') || null,
  };
}

const commonsInfo = (page: CommonsPage) => (page.videoinfo ?? page.imageinfo)?.[0];
const commonsKind = (info: CommonsInfo): MediaKind | null => (info.mediatype === 'VIDEO' ? 'video' : info.mediatype === 'BITMAP' || info.mediatype === 'DRAWING' ? 'image' : null);

export const wikimedia: Provider = {
  id: 'wikimedia',
  name: 'Wikimedia Commons',
  kinds: ['image', 'video'],
  homepage: 'https://commons.wikimedia.org/',
  terms:
    'Freie Lizenzen, je Datei verschieden (meist CC BY oder CC BY-SA, auch gemeinfrei). Bei CC BY und CC BY-SA muss der Bildnachweis dort stehen, wo das Bild gezeigt wird.',
  cacheSeconds: 3600,
  async search(query, kind, page) {
    const url = commonsQuery(
      kind,
      {
        generator: 'search',
        gsrsearch: `${query} filetype:${kind === 'video' ? 'video' : 'bitmap'}`,
        gsrnamespace: '6',
        gsrlimit: String(PAGE_SIZE),
        gsroffset: String((page - 1) * PAGE_SIZE),
      },
      500,
    );
    const data = await getJson<{ continue?: unknown; query?: { searchinfo?: { totalhits: number }; pages?: CommonsPage[] } }>(this.name, url);
    const pages = [...(data.query?.pages ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const hits: SourceHit[] = [];
    for (const p of pages) {
      const info = commonsInfo(p);
      if (!info?.thumburl || commonsKind(info) !== kind) continue;
      const meta = commonsLicense(info);
      hits.push({
        id: p.title,
        kind,
        title: meta.title ?? p.title.replace(/^File:/, ''),
        author: meta.author,
        license: meta.license,
        attribution: meta.attribution,
        pageUrl: info.descriptionurl,
        thumb: info.thumburl,
        width: info.width || null,
        height: info.height || null,
        duration: info.duration ?? null,
      });
    }
    return { hits, hasMore: !!data.continue, total: data.query?.searchinfo?.totalhits ?? null };
  },
  async resolve(id, kind) {
    if (!/^File:.{1,250}$/.test(id)) throw new SourceError(400, 'Ungültige Datei-ID');
    const data = await getJson<{ query?: { pages?: Array<CommonsPage & { missing?: boolean }> } }>(this.name, commonsQuery(kind, { titles: id }, 1920));
    const page = data.query?.pages?.[0];
    const info = page && !page.missing ? commonsInfo(page) : undefined;
    if (!info || commonsKind(info) !== kind) throw new SourceError(404, `${this.name}: Datei nicht gefunden`);
    let download = info.url;
    if (kind === 'image') {
      // A 1920 px rendering instead of originals of 50 MB+ (TIFF and SVG become JPEG/PNG too).
      download = info.thumburl ?? info.url;
    } else if (Math.min(info.width, info.height) > 1080 || !/webm|ogg|mp4/.test(info.mime)) {
      // Commons keeps WebM renderings of every video; 1080p is all the displays use.
      const webm = (info.derivatives ?? []).filter((d) => d.type.startsWith('video/webm') && d.width && d.height);
      download = pickSize(webm)?.src ?? info.url;
    }
    const meta = commonsLicense(info);
    return {
      download,
      name: page!.title.replace(/^File:/, ''),
      source: {
        provider: this.id,
        providerName: this.name,
        id,
        title: meta.title,
        author: meta.author,
        authorUrl: meta.authorUrl,
        pageUrl: info.descriptionurl,
        license: meta.license,
        licenseUrl: meta.licenseUrl,
        attribution: meta.attribution,
        via: this.name,
      },
    };
  },
};

// --- Openverse -------------------------------------------------------------------

interface OpenverseImage {
  id: string;
  title: string | null;
  foreign_landing_url: string;
  url: string;
  creator: string | null;
  creator_url: string | null;
  license: string;
  license_version: string | null;
  license_url: string | null;
  source: string;
  width: number | null;
  height: number | null;
  thumbnail: string;
}

const OPENVERSE_API = 'https://api.openverse.org/v1/images/';
// Openverse knows the collections by short ids; the larger ones by name.
const OPENVERSE_SOURCES: Record<string, string> = {
  flickr: 'Flickr',
  wikimedia: 'Wikimedia Commons',
  stocksnap: 'StockSnap',
  rawpixel: 'rawpixel',
  nappy: 'nappy',
  smithsonian: 'Smithsonian',
  met: 'The Met',
  europeana: 'Europeana',
};
const openverseSource = (id: string) => OPENVERSE_SOURCES[id] ?? OPENVERSE_SOURCES[id.split('_')[0]] ?? id;

export const openverse: Provider = {
  id: 'openverse',
  name: 'Openverse',
  kinds: ['image'],
  homepage: 'https://openverse.org/',
  terms:
    'Sucht CC-lizenzierte und gemeinfreie Bilder aus vielen Sammlungen (u. a. Flickr, Museen). Die Lizenz steht bei jedem Treffer; bei allen CC-Lizenzen außer CC0 ist der Bildnachweis Pflicht, „NC“ heißt nur nicht kommerziell.',
  cacheSeconds: 3600,
  async search(query, _kind, page) {
    // Without an account Openverse allows 20 per page.
    const params = new URLSearchParams({ q: query, page: String(page), page_size: '20', mature: 'false' });
    const data = await getJson<{ result_count: number; page_count: number; results: OpenverseImage[] }>(this.name, `${OPENVERSE_API}?${params}`);
    return {
      hits: data.results.map((r) => ({
        id: r.id,
        kind: 'image' as const,
        title: r.title,
        author: r.creator,
        license: ccName(r.license, r.license_version),
        attribution: r.license !== 'cc0' && r.license !== 'pdm',
        pageUrl: r.foreign_landing_url,
        thumb: r.thumbnail,
        width: r.width,
        height: r.height,
        duration: null,
      })),
      hasMore: page < data.page_count,
      total: data.result_count,
    };
  },
  async resolve(id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new SourceError(400, 'Ungültige Bild-ID');
    const r = await getJson<OpenverseImage>(this.name, `${OPENVERSE_API}${id}/`);
    return {
      download: r.url,
      name: r.title ?? id,
      source: {
        provider: this.id,
        providerName: this.name,
        id,
        title: r.title,
        author: r.creator,
        authorUrl: absoluteUrl(r.creator_url),
        pageUrl: r.foreign_landing_url,
        license: ccName(r.license, r.license_version),
        licenseUrl: absoluteUrl(r.license_url),
        attribution: r.license !== 'cc0' && r.license !== 'pdm',
        via: openverseSource(r.source),
      },
    };
  },
};

// --- Pixabay ---------------------------------------------------------------------

interface PixabayHit {
  id: number;
  pageURL: string;
  tags: string;
  user: string;
  user_id: number;
  // images
  webformatURL?: string;
  largeImageURL?: string;
  fullHDURL?: string;
  imageWidth?: number;
  imageHeight?: number;
  // videos
  duration?: number;
  videos?: Record<string, { url: string; width: number; height: number; size: number; thumbnail?: string }>;
}

const PIXABAY_LICENSE = 'Pixabay-Inhaltslizenz';
const PIXABAY_LICENSE_URL = 'https://pixabay.com/de/service/license-summary/';

function pixabayUrl(kind: MediaKind, key: string, params: Record<string, string>) {
  const base = kind === 'video' ? 'https://pixabay.com/api/videos/' : 'https://pixabay.com/api/';
  return `${base}?${new URLSearchParams({ key, lang: 'de', safesearch: 'true', ...params })}`;
}

const pixabayVideos = (hit: PixabayHit) => Object.values(hit.videos ?? {}).filter((v) => v.url && v.width && v.height);

export const pixabay: Provider = {
  id: 'pixabay',
  name: 'Pixabay',
  kinds: ['image', 'video'],
  key: { signup: 'https://pixabay.com/api/docs/', placeholder: 'z. B. 12345678-abcdef…' },
  homepage: 'https://pixabay.com/',
  terms:
    'Pixabay-Inhaltslizenz: kostenlos nutzbar, auch bearbeitet, ohne Namensnennung. Nicht erlaubt: unveränderter Verkauf, Nutzung als Marke, abgebildete Personen in ein schlechtes Licht rücken. Die Quelle Pixabay wird bei den Treffern genannt.',
  // Pixabay: "requests must be cached for 24 hours".
  cacheSeconds: 86_400,
  async search(query, kind, page, key) {
    const params: Record<string, string> = { q: query.slice(0, 100), page: String(page), per_page: String(PAGE_SIZE) };
    if (kind === 'image') params.image_type = 'photo';
    const data = await getJson<{ totalHits: number; hits: PixabayHit[] }>(this.name, pixabayUrl(kind, needKey(this.name, key), params));
    const hits: SourceHit[] = data.hits.map((h) => {
      const video = kind === 'video' ? pickSize(pixabayVideos(h)) : undefined;
      return {
        id: String(h.id),
        kind,
        title: h.tags || null,
        author: h.user || null,
        license: PIXABAY_LICENSE,
        attribution: false,
        pageUrl: h.pageURL,
        thumb: (kind === 'video' ? (h.videos?.medium?.thumbnail ?? h.videos?.tiny?.thumbnail) : h.webformatURL) ?? '',
        width: video?.width ?? h.imageWidth ?? null,
        height: video?.height ?? h.imageHeight ?? null,
        duration: h.duration ?? null,
      };
    });
    return { hits: hits.filter((h) => h.thumb), hasMore: page * PAGE_SIZE < data.totalHits, total: data.totalHits };
  },
  async resolve(id, kind, key) {
    if (!/^\d{1,12}$/.test(id)) throw new SourceError(400, 'Ungültige ID');
    const data = await getJson<{ hits: PixabayHit[] }>(this.name, pixabayUrl(kind, needKey(this.name, key), { id }));
    const hit = data.hits[0];
    if (!hit) throw new SourceError(404, `${this.name}: nicht gefunden`);
    const download = kind === 'video' ? pickSize(pixabayVideos(hit))?.url : (hit.fullHDURL ?? hit.largeImageURL);
    if (!download) throw new SourceError(502, `${this.name}: keine Datei zum Herunterladen`);
    return {
      download,
      name: hit.tags ? hit.tags.split(',').slice(0, 3).join(',').trim() : `Pixabay ${id}`,
      source: {
        provider: this.id,
        providerName: this.name,
        id,
        title: hit.tags || null,
        author: hit.user || null,
        authorUrl: hit.user ? `https://pixabay.com/users/${encodeURIComponent(hit.user)}-${hit.user_id}/` : null,
        pageUrl: hit.pageURL,
        license: PIXABAY_LICENSE,
        licenseUrl: PIXABAY_LICENSE_URL,
        attribution: false,
        via: this.name,
      },
    };
  },
};

// --- Unsplash --------------------------------------------------------------------

interface UnsplashPhoto {
  id: string;
  width: number;
  height: number;
  description: string | null;
  alt_description: string | null;
  premium?: boolean;
  plus?: boolean;
  urls: { raw: string; small: string };
  links: { html: string; download_location: string };
  user: { name: string; links: { html: string } };
}

const UNSPLASH_API = 'https://api.unsplash.com';
// Unsplash asks for these on every link back to them.
const utm = (url: string) => `${url}${url.includes('?') ? '&' : '?'}utm_source=foyer&utm_medium=referral`;
const unsplashHeaders = (key: string) => ({ Authorization: `Client-ID ${key}`, 'Accept-Version': 'v1' });
const paid = (p: UnsplashPhoto) => p.premium === true || p.plus === true;

export const unsplash: Provider = {
  id: 'unsplash',
  name: 'Unsplash',
  kinds: ['image'],
  key: { signup: 'https://unsplash.com/oauth/applications', placeholder: 'Access Key' },
  homepage: 'https://unsplash.com/',
  terms:
    'Unsplash-Lizenz: kostenlos nutzbar, ohne Namensnennung, nicht unverändert verkaufen. Fotograf und Unsplash werden bei den Treffern genannt. Nur Fotos, keine Videos; Unsplash+-Fotos sind ausgeblendet.',
  cacheSeconds: 3600,
  async search(query, _kind, page, key) {
    const params = new URLSearchParams({ query: query.slice(0, 100), page: String(page), per_page: String(PAGE_SIZE), content_filter: 'high' });
    const data = await getJson<{ total: number; total_pages: number; results: UnsplashPhoto[] }>(
      this.name,
      `${UNSPLASH_API}/search/photos?${params}`,
      unsplashHeaders(needKey(this.name, key)),
    );
    return {
      hits: data.results
        .filter((p) => !paid(p))
        .map((p) => ({
          id: p.id,
          kind: 'image' as const,
          title: p.description ?? p.alt_description,
          author: p.user.name,
          license: 'Unsplash-Lizenz',
          attribution: false,
          pageUrl: utm(p.links.html),
          thumb: p.urls.small,
          width: p.width,
          height: p.height,
          duration: null,
        })),
      hasMore: page < data.total_pages,
      total: data.total,
    };
  },
  async resolve(id, _kind, key) {
    if (!/^[\w-]{1,40}$/.test(id)) throw new SourceError(400, 'Ungültige Foto-ID');
    const headers = unsplashHeaders(needKey(this.name, key));
    const photo = await getJson<UnsplashPhoto>(this.name, `${UNSPLASH_API}/photos/${id}`, headers);
    if (paid(photo)) throw new SourceError(400, 'Unsplash+-Fotos lassen sich nicht übernehmen');
    // Required by the API guidelines: count the download at Unsplash.
    const tracked = await getJson<{ url: string }>(this.name, photo.links.download_location, headers);
    const download = new URL(tracked.url || photo.urls.raw);
    download.searchParams.set('w', '1920');
    download.searchParams.set('fit', 'max');
    download.searchParams.set('fm', 'jpg');
    download.searchParams.set('q', '85');
    return {
      download: download.href,
      name: (photo.description ?? photo.alt_description ?? `Unsplash ${id}`).slice(0, 120),
      source: {
        provider: this.id,
        providerName: this.name,
        id,
        title: photo.description ?? photo.alt_description,
        author: photo.user.name,
        authorUrl: utm(photo.user.links.html),
        pageUrl: utm(photo.links.html),
        license: 'Unsplash-Lizenz',
        licenseUrl: 'https://unsplash.com/de/lizenz',
        attribution: false,
        via: this.name,
      },
    };
  },
};

export const PROVIDERS: Provider[] = [wikimedia, openverse, pixabay, unsplash];

export const provider = (id: string) => PROVIDERS.find((p) => p.id === id);

// --- Search cache -------------------------------------------------------------------

const cache = new Map<string, { at: number; result: SearchResult }>();

/** Search with a small in-memory cache (the databases ask for it; repeated paging is free). */
export async function cachedSearch(p: Provider, query: string, kind: MediaKind, page: number, key: string | null, now: number): Promise<SearchResult> {
  const id = JSON.stringify([p.id, key, kind, page, query.trim().toLowerCase()]);
  const hit = cache.get(id);
  if (hit && now - hit.at < p.cacheSeconds * 1000) return hit.result;
  const result = await p.search(query.trim(), kind, page, key);
  if (cache.size >= 300) cache.delete(cache.keys().next().value!);
  cache.set(id, { at: now, result });
  return result;
}

export function clearSourceCache() {
  cache.clear();
}
