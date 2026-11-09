// Imports slides and their images and videos from wp-foyer (KONZEPT 10). Nothing is
// planned: imported slides run only once somebody schedules them. Running it again
// skips what has been imported, and a slide edited in Foyer stays as it is.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { audit, type Db } from './db.ts';
import type { MediaLibrary } from './media.ts';
import { parseConfig, type Registry } from './registry.ts';

export interface WpSlide {
  id: number;
  title: string;
  status: string;
  meta: Record<string, string>;
}

export interface WpData {
  slides: WpSlide[];
  /** Attachment id → path below the uploads folder. */
  attachments: Map<number, string>;
  zoomByDefault: boolean;
  uploadsUrl: string;
}

export interface WpFiles {
  exists(file: string): Promise<boolean>;
  open(file: string): Promise<AsyncIterable<Uint8Array>>;
}

interface WpFile {
  /** Remembered per attachment, so a file used by many slides is fetched once. */
  attachmentId: number | null;
  path: string;
  kind: 'image' | 'video';
}

export interface PlannedSlide {
  wpId: number;
  title: string;
  published: boolean;
  type: 'text' | 'video';
  config: Record<string, unknown>;
  file: WpFile | null;
  /** How the file is used: as background (with zoom for images) or as the video of the slide. */
  fileAs: 'background' | 'video' | null;
  zoom: boolean;
  warnings: string[];
}

export interface SkippedSlide {
  wpId: number;
  title: string;
  reason: string;
}

export interface WpPlan {
  slides: PlannedSlide[];
  skipped: SkippedSlide[];
}

const FORMAT_NAMES: Record<string, string> = {
  iframe: 'Externe Webseite',
  post: 'Beitrag',
  'recent-posts': 'Neueste Beiträge',
  'rss-feed': 'RSS-Feed',
  calendar: 'Kalender',
  pdf: 'PDF',
  production: 'Veranstaltung',
  'upcoming-productions': 'Veranstaltungen',
  'teacher-dashboard': 'Lehrkräfte-Dashboard',
  'webuntis-room-display': 'Raumanzeige',
};

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] !== '#') return ENTITIES[code.toLowerCase()] ?? whole;
    const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
  });
}

/** WordPress may store HTML in the text; the slide shows plain text. */
function plainText(value: string | undefined, warnings: string[], label: string): string {
  let text = (value ?? '').replace(/\r\n?/g, '\n');
  if (/<[a-z/][^>]*>/i.test(text)) {
    warnings.push(`HTML in „${label}“ entfernt`);
    text = text
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
      .replace(/<[^>]+>/g, '');
  }
  return decodeEntities(text).trim();
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment; // Not percent-encoded after all, e.g. a bare "%".
  }
}

function fileOf(data: WpData, meta: Record<string, string>, idKey: string, urlKey: string | null, kind: WpFile['kind']): WpFile | null {
  const attachmentId = Number(meta[idKey]);
  const path = attachmentId > 0 ? data.attachments.get(attachmentId) : undefined;
  if (path) return { attachmentId, path, kind };
  // Videos may also be stored as an address only.
  const url = urlKey ? meta[urlKey] : undefined;
  const marker = '/wp-content/uploads/';
  if (url?.includes(marker)) return { attachmentId: null, path: url.slice(url.indexOf(marker) + marker.length).split('/').map(decodeSegment).join('/'), kind };
  return null;
}

/** Decides for every slide what becomes of it. Touches nothing. */
export function planImport(data: WpData, { onlyText = false }: { onlyText?: boolean } = {}): WpPlan {
  const plan: WpPlan = { slides: [], skipped: [] };
  for (const slide of data.slides) {
    const { meta } = slide;
    const warnings: string[] = [];
    const wpTitle = plainText(slide.title, warnings, 'Titel');
    const format = meta.slide_format || 'default';
    const background = meta.slide_background || 'default';
    const skip = (reason: string) => plan.skipped.push({ wpId: slide.id, title: wpTitle || `Folie ${slide.id}`, reason });

    if (format !== 'text' && format !== 'default') {
      skip(`Folientyp „${FORMAT_NAMES[format] ?? format}“ wird nicht übernommen`);
      continue;
    }
    if (background === 'video') {
      skip('YouTube-Video: Foyer kennt kein YouTube');
      continue;
    }
    if (onlyText && format !== 'text') {
      skip('Standardfolie: bei --only-text nicht dabei');
      continue;
    }
    if (onlyText && background === 'html5-video') {
      skip('Video-Hintergrund: bei --only-text nicht dabei');
      continue;
    }

    const qrUrl = (meta.slide_text_qr ?? '').trim();
    const config =
      format === 'text'
        ? {
            pretitle: plainText(meta.slide_text_pretitle, warnings, 'Dachzeile'),
            title: plainText(meta.slide_text_title, warnings, 'Titel'),
            subtitle: plainText(meta.slide_text_subtitle, warnings, 'Untertitel'),
            content: plainText(meta.slide_text_content, warnings, 'Text'),
            qrUrl,
            qrEcc: ['L', 'M', 'Q', 'H'].includes((meta.slide_text_qr_ecc ?? '').toUpperCase()) ? meta.slide_text_qr_ecc.toUpperCase() : 'M',
          }
        : {};
    if ('qrUrl' in config && qrUrl && !URL.canParse(qrUrl)) {
      warnings.push(`QR-Code entfernt, weil er keine Adresse ist: ${qrUrl.slice(0, 60)}`);
      config.qrUrl = '';
    }
    const hasText = 'title' in config && Boolean(config.pretitle || config.title || config.subtitle || config.content);
    const title = (wpTitle || ('title' in config && config.title) || `Folie ${slide.id}`).slice(0, 300);

    let file: WpFile | null = null;
    if (background === 'image') file = fileOf(data, meta, 'slide_bg_image_image', null, 'image');
    if (background === 'html5-video') file = fileOf(data, meta, 'slide_bg_html5_video_video', 'slide_bg_html5_video_video_url', 'video');
    if (background === 'image' || background === 'html5-video') {
      if (!file && !hasText) {
        skip(`${background === 'image' ? 'Bild' : 'Video'} nicht hinterlegt und kein Text`);
        continue;
      }
      if (!file) warnings.push(`${background === 'image' ? 'Bild' : 'Video'} nicht hinterlegt: Folie kommt ohne Hintergrund`);
    }
    if (!file && !hasText) {
      skip('Leer: weder Text noch Hintergrund');
      continue;
    }

    // A full-screen video without text is what the video slide type is for.
    const asVideo = file?.kind === 'video' && !hasText;
    const zoomSetting = meta.slide_bg_image_zoom;
    plan.slides.push({
      wpId: slide.id,
      title,
      published: slide.status === 'publish',
      type: asVideo ? 'video' : 'text',
      config,
      file,
      fileAs: !file ? null : asVideo ? 'video' : 'background',
      zoom: file?.kind === 'image' && (zoomSetting === 'enabled' || (zoomSetting !== 'disabled' && data.zoomByDefault)),
      warnings,
    });
  }
  return plan;
}

function checkedPath(file: string): string {
  if (file.startsWith('/') || file.split('/').includes('..')) throw new Error(`Ungültiger Dateipfad: ${file}`);
  return file;
}

/** The uploads folder, as a local path or (by default) the address of the old site. */
export function wpFiles(uploads: string): WpFiles {
  if (/^https?:\/\//.test(uploads)) {
    const url = (file: string) => `${uploads.replace(/\/+$/, '')}/${checkedPath(file).split('/').map(encodeURIComponent).join('/')}`;
    return {
      async exists(file) {
        const res = await fetch(url(file), { method: 'HEAD', signal: AbortSignal.timeout(30_000) });
        return res.ok;
      },
      async open(file) {
        const res = await fetch(url(file));
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        return res.body as unknown as AsyncIterable<Uint8Array>;
      },
    };
  }
  return {
    async exists(file) {
      return stat(join(uploads, checkedPath(file))).then((s) => s.isFile(), () => false);
    },
    async open(file) {
      return createReadStream(join(uploads, checkedPath(file)));
    },
  };
}

export interface ImportDeps {
  db: Db;
  registry: Registry;
  media: Pick<MediaLibrary, 'ingest' | 'get' | 'idle'>;
  now: () => number;
}

export interface ImportResult {
  apply: boolean;
  created: Array<{ wpId: number; id: string | null; title: string }>;
  alreadyImported: number;
  skipped: SkippedSlide[];
  failed: Array<{ wpId: number; title: string; error: string }>;
  warnings: Array<{ wpId: number; title: string; warning: string }>;
  /** Files copied from WordPress, or to be copied in a dry run. */
  files: number;
  /** Copied, but the media pipeline could not process them. */
  mediaFailed: Array<{ name: string; error: string }>;
}

function mapped(db: Db, entity: 'slide' | 'attachment', wpId: number): string | undefined {
  return (db.prepare('SELECT foyer_id FROM wp_import_map WHERE entity = ? AND wp_id = ?').get(entity, wpId) as { foyer_id: string } | undefined)?.foyer_id;
}

function remember(db: Db, entity: 'slide' | 'attachment', wpId: number, foyerId: string, now: number) {
  db.prepare('INSERT OR REPLACE INTO wp_import_map (entity, wp_id, foyer_id, at) VALUES (?, ?, ?, ?)').run(entity, wpId, foyerId, now);
}

function slideExists(db: Db, id: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM slides WHERE id = ?').get(id));
}

/** Without apply nothing is written or copied: the report shows what would happen. */
export async function runImport(deps: ImportDeps, plan: WpPlan, files: WpFiles, options: { apply: boolean; onProgress?: (text: string) => void }): Promise<ImportResult> {
  const { db, registry, media, now } = deps;
  const { apply } = options;
  const result: ImportResult = { apply, created: [], alreadyImported: 0, skipped: plan.skipped, failed: [], warnings: [], files: 0, mediaFailed: [] };
  const seenFiles = new Map<string, string | null>();
  const usedMedia = new Set<string>();

  /** Foyer's media id of a WordPress file, copying it if needed; null in a dry run. */
  const fileToMedia = async (file: WpFile): Promise<string | null> => {
    const key = file.attachmentId ? `a${file.attachmentId}` : `p${file.path}`;
    if (seenFiles.has(key)) return seenFiles.get(key)!;
    const known = file.attachmentId ? mapped(db, 'attachment', file.attachmentId) : undefined;
    let mediaId: string | null = known && media.get(known)?.kind === file.kind ? known : null;
    if (!mediaId) {
      if (!(await files.exists(file.path))) throw new Error(`Datei fehlt: ${file.path}`);
      result.files++;
      if (apply) {
        options.onProgress?.(`Kopiere ${file.path}`);
        const { row } = await media.ingest(await files.open(file.path), file.path.split('/').pop(), null);
        if (row.kind !== file.kind) throw new Error(`${file.path} ist kein ${file.kind === 'image' ? 'Bild' : 'Video'}`);
        mediaId = row.id;
        if (file.attachmentId) remember(db, 'attachment', file.attachmentId, mediaId, now());
      }
    }
    seenFiles.set(key, mediaId);
    return mediaId;
  };

  for (const slide of plan.slides) {
    const known = mapped(db, 'slide', slide.wpId);
    if (known && slideExists(db, known)) {
      result.alreadyImported++;
      continue;
    }
    try {
      const mediaId = slide.file ? await fileToMedia(slide.file) : null;
      // A dry run validates with a stand-in, as the video slide requires a media id.
      const config = parseConfig(registry, slide.type, slide.fileAs === 'video' ? { mediaId: mediaId ?? 'dry-run', fill: true, sound: false } : slide.config);
      const background =
        slide.fileAs === 'background' && slide.file
          ? slide.file.kind === 'image'
            ? { kind: 'image', mediaId, fit: 'cover', dim: 0, zoom: slide.zoom }
            : { kind: 'video', mediaId, dim: 0 }
          : null;
      let id: string | null = null;
      if (apply) {
        id = crypto.randomUUID();
        if (mediaId) usedMedia.add(mediaId);
        const at = now();
        db.exec('BEGIN');
        try {
          db.prepare('INSERT INTO slides (id, title, type, config_json, background_json, duration, published, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)').run(
            id, slide.title, slide.type, JSON.stringify(config), background ? JSON.stringify(background) : null, slide.published ? 1 : 0, at, at,
          );
          remember(db, 'slide', slide.wpId, id, at);
          audit(db, null, 'wp-import', 'slide', id, { wpId: slide.wpId, title: slide.title });
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
      }
      result.created.push({ wpId: slide.wpId, id, title: slide.title });
      for (const warning of slide.warnings) result.warnings.push({ wpId: slide.wpId, title: slide.title, warning });
    } catch (err) {
      result.failed.push({ wpId: slide.wpId, title: slide.title, error: (err as Error).message.replace(/\s+/g, ' ').slice(0, 300) });
    }
  }

  if (apply) {
    options.onProgress?.('Warte auf die Umwandlung der Medien …');
    await media.idle();
    for (const mediaId of usedMedia) {
      const row = media.get(mediaId);
      if (row?.status === 'failed') result.mediaFailed.push({ name: row.name, error: row.error ?? 'unbekannt' });
    }
  }
  return result;
}
