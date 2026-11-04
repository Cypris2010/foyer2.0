// Media library (KONZEPT 6.2): uploads, the ffmpeg pipeline and file serving.
//
// <dir>/originals/<sha256>.<ext>    uploaded file, kept for re-processing
// <dir>/files/<sha256>-<tag>.<ext>  derived files the players load; the name
//                                   never changes its content (immutable)
// <dir>/tmp/                        uploads in progress
//
// Images are scaled to at most 1920 px on the long side (JPEG, PNG with alpha).
// Videos become H.264 High/AAC MP4 with faststart, max 1080p at <= 30 fps and
// ~5 Mbit/s, plus a 720p variant: the profile the Airtame probe confirmed
// (1080p60 drops half the frames there).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import type { Db } from './db.ts';

export type MediaKind = 'image' | 'video';
export type MediaStatus = 'queued' | 'processing' | 'ready' | 'failed';

export interface MediaVariant {
  file: string;
  width: number;
  height: number;
}

export interface MediaRow {
  id: string;
  sha256: string;
  kind: MediaKind;
  name: string;
  original_ext: string;
  size: number;
  width: number | null;
  height: number | null;
  duration_s: number | null;
  variants_json: string;
  poster: string | null;
  thumb: string | null;
  status: MediaStatus;
  error: string | null;
  uploaded_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface MediaOptions {
  dir: string;
  ffmpeg: string;
  ffprobe: string;
  maxBytes: number;
  now?: () => number;
}

export class MediaError extends Error {
  status: 400 | 413;
  constructor(status: 400 | 413, message: string) {
    super(message);
    this.status = status;
  }
}

// Bump a tag when its encoding changes, so players never get a stale cached file.
const IMAGE_TAG = 'img1';
const THUMB_TAG = 'thumb1';
const POSTER_TAG = 'poster1';
const VIDEO_PROFILES = [
  { key: 'main', tag: 'v1-1080', long: 1920, short: 1080, maxrate: '5M', bufsize: '10M' },
  { key: 'sd', tag: 'v1-720', long: 1280, short: 720, maxrate: '3M', bufsize: '6M' },
] as const;

const FILE_NAME = /^[0-9a-f]{64}-[a-z0-9-]+\.(jpg|png|mp4)$/;
const CONTENT_TYPES: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', mp4: 'video/mp4' };

/** Detects the file type from its first bytes; the name and the browser's type are not trusted. */
export function sniff(head: Uint8Array): { kind: MediaKind; ext: string } | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...head.subarray(from, to));
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { kind: 'image', ext: 'jpg' };
  if (head[0] === 0x89 && ascii(1, 4) === 'PNG') return { kind: 'image', ext: 'png' };
  if (ascii(0, 4) === 'GIF8') return { kind: 'image', ext: 'gif' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { kind: 'image', ext: 'webp' };
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return { kind: 'video', ext: 'mkv' };
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (['heic', 'heix', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return { kind: 'image', ext: 'heic' };
    if (['avif', 'avis'].includes(brand)) return { kind: 'image', ext: 'avif' };
    return { kind: 'video', ext: brand === 'qt  ' ? 'mov' : 'mp4' };
  }
  return null;
}

export function cleanName(name: string | undefined): string {
  const base = (name ?? '').split(/[\\/]/).pop()!.replace(/[\u0000-\u001f]/g, '').trim();
  return base.slice(0, 200) || 'Datei';
}

export const mediaUrl = (file: string) => `/media/${file}`;

/** Files of a media item that players and the admin load. */
export function derivedFiles(row: Pick<MediaRow, 'variants_json' | 'poster' | 'thumb'>): string[] {
  const variants = JSON.parse(row.variants_json) as Record<string, MediaVariant>;
  return [...Object.values(variants).map((v) => v.file), row.poster, row.thumb].filter((f): f is string => Boolean(f));
}

// --- ffmpeg ------------------------------------------------------------------

function run(command: string, args: string[], onStdout?: (line: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let pending = '';
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (!onStdout) return;
      pending += text;
      const lines = pending.split('\n');
      pending = lines.pop()!;
      lines.forEach(onStdout);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      reject(new Error(err.code === 'ENOENT' ? `${command} ist auf dem Server nicht installiert` : err.message));
    });
    child.on('close', (code) => {
      if (code === 0) return resolve(stdout);
      const last = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 500);
      reject(new Error(`${command} fehlgeschlagen${last ? `: ${last}` : ''}`));
    });
  });
}

interface ProbeStream {
  codec_type: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  side_data_list?: Array<{ rotation?: number }>;
  tags?: { rotate?: string };
}

interface Probe {
  streams: ProbeStream[];
  format: { duration?: string };
}

async function probe(ffprobe: string, file: string): Promise<Probe> {
  return JSON.parse(await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]));
}

function rate(value: string | undefined): number {
  const [n, d] = (value ?? '').split('/').map(Number);
  return n && d ? n / d : 0;
}

/** Dimensions as shown, i.e. after the rotation phones store as metadata. */
function shownSize(stream: ProbeStream): { width: number; height: number } {
  const rotation = Math.abs(stream.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ?? Number(stream.tags?.rotate ?? 0));
  const width = stream.width ?? 0;
  const height = stream.height ?? 0;
  return rotation % 180 === 90 ? { width: height, height: width } : { width, height };
}

/** Fits into a long × short box in the orientation of the source, never upscaling. */
function fitFilter(long: number, short: number, portrait: boolean): string {
  const [w, h] = portrait ? [short, long] : [long, short];
  return `scale=w='min(${w},iw)':h='min(${h},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`;
}

/** 60 → 30, 50 → 25, anything else above 30 → 30. */
export function targetFps(source: number): number | null {
  if (source <= 30.5) return null;
  return source / 2 <= 30.5 ? Math.round((source / 2) * 1000) / 1000 : 30;
}

// --- Library -----------------------------------------------------------------

export class MediaLibrary {
  readonly filesDir: string;
  private readonly originalsDir: string;
  private readonly tmpDir: string;
  private readonly queue: string[] = [];
  private running: Promise<void> | null = null;
  /** Transcoding progress 0..1 of items being processed; in memory only. */
  readonly progress = new Map<string, number>();
  /** Called when an item finished processing (set by the app to notify players). */
  onReady?: (id: string) => void;
  private readonly now: () => number;
  private readonly db: Db;
  private readonly options: MediaOptions;

  constructor(db: Db, options: MediaOptions) {
    this.db = db;
    this.options = options;
    this.filesDir = join(options.dir, 'files');
    this.originalsDir = join(options.dir, 'originals');
    this.tmpDir = join(options.dir, 'tmp');
    for (const dir of [this.filesDir, this.originalsDir, this.tmpDir]) mkdirSync(dir, { recursive: true });
    this.now = options.now ?? Date.now;
  }

  get maxBytes() {
    return this.options.maxBytes;
  }

  /** Picks up work interrupted by a restart. */
  resume() {
    this.db.prepare("UPDATE media SET status = 'queued' WHERE status = 'processing'").run();
    const rows = this.db.prepare("SELECT id FROM media WHERE status = 'queued' ORDER BY created_at").all() as Array<{ id: string }>;
    rows.forEach((row) => this.enqueue(row.id));
  }

  /** Stores an upload. Returns the existing item when the same file was uploaded before. */
  async ingest(body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>, name: string | undefined, userId: string | null): Promise<{ row: MediaRow; existing: boolean }> {
    const tmp = join(this.tmpDir, crypto.randomUUID());
    const hash = createHash('sha256');
    const out = createWriteStream(tmp);
    let size = 0;
    let head = new Uint8Array(0);
    try {
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > this.options.maxBytes) throw new MediaError(413, `Datei ist größer als ${Math.round(this.options.maxBytes / 1048576)} MB`);
        if (head.length < 32) head = Buffer.concat([head, chunk]).subarray(0, 32);
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise<void>((resolve) => out.once('drain', () => resolve()));
      }
      out.end();
      await finished(out);
      if (!size) throw new MediaError(400, 'Leere Datei');
      const type = sniff(head);
      if (!type) throw new MediaError(400, 'Dateityp nicht unterstützt. Erlaubt sind Bilder (JPEG, PNG, GIF, WebP, HEIC, AVIF) und Videos (MP4, MOV, WebM, MKV).');
      const sha256 = hash.digest('hex');
      const existing = this.db.prepare('SELECT * FROM media WHERE sha256 = ?').get(sha256) as MediaRow | undefined;
      if (existing) {
        await rm(tmp, { force: true });
        return { row: existing, existing: true };
      }
      await rename(tmp, join(this.originalsDir, `${sha256}.${type.ext}`));
      const id = crypto.randomUUID();
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO media (id, sha256, kind, name, original_ext, size, status, uploaded_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
        )
        .run(id, sha256, type.kind, cleanName(name), type.ext, size, userId, now, now);
      this.enqueue(id);
      return { row: this.get(id)!, existing: false };
    } catch (err) {
      out.destroy();
      await rm(tmp, { force: true });
      throw err;
    }
  }

  get(id: string): MediaRow | undefined {
    return this.db.prepare('SELECT * FROM media WHERE id = ?').get(id) as MediaRow | undefined;
  }

  enqueue(id: string) {
    if (!this.queue.includes(id)) this.queue.push(id);
    this.running ??= this.drain().finally(() => (this.running = null));
  }

  /** Resolves once the queue is empty (tests, shutdown). */
  async idle() {
    while (this.running) await this.running;
  }

  /** Removes the item and all its files. Callers check that no slide uses it. */
  async remove(id: string) {
    const row = this.get(id);
    if (!row) return false;
    this.db.prepare('DELETE FROM media WHERE id = ?').run(id);
    const files = [...derivedFiles(row).map((f) => join(this.filesDir, f)), join(this.originalsDir, `${row.sha256}.${row.original_ext}`)];
    await Promise.all(files.map((f) => rm(f, { force: true })));
    return true;
  }

  private async drain() {
    while (this.queue.length) {
      const id = this.queue.shift()!;
      const row = this.get(id);
      if (!row || row.status === 'ready') continue;
      this.db.prepare("UPDATE media SET status = 'processing', error = NULL, updated_at = ? WHERE id = ?").run(this.now(), id);
      this.progress.set(id, 0);
      try {
        const result = row.kind === 'image' ? await this.processImage(row) : await this.processVideo(row);
        // Deleted while processing: drop what was produced.
        if (!this.get(id)) {
          await Promise.all(derivedFiles(result).map((f) => rm(join(this.filesDir, f), { force: true })));
          continue;
        }
        this.db
          .prepare(
            `UPDATE media SET status = 'ready', width = ?, height = ?, duration_s = ?, variants_json = ?, poster = ?, thumb = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(result.width, result.height, result.duration_s, result.variants_json, result.poster, result.thumb, this.now(), id);
        this.onReady?.(id);
      } catch (err) {
        this.db.prepare("UPDATE media SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run((err as Error).message.slice(0, 1000), this.now(), id);
      } finally {
        this.progress.delete(id);
      }
    }
  }

  private original(row: MediaRow) {
    return join(this.originalsDir, `${row.sha256}.${row.original_ext}`);
  }

  private async processImage(row: MediaRow) {
    const { ffmpeg, ffprobe } = this.options;
    const source = this.original(row);
    const info = (await probe(ffprobe, source)).streams.find((s) => s.codec_type === 'video');
    if (!info) throw new Error('Kein Bild in der Datei gefunden');
    // Transparent images stay PNG, everything else becomes JPEG.
    const alpha = /^(rgba|bgra|argb|abgr|ya|yuva|gbrap|pal8)/.test(info.pix_fmt ?? '');
    const ext = alpha ? 'png' : 'jpg';
    const { width: srcWidth, height: srcHeight } = shownSize(info);
    const portrait = srcHeight > srcWidth;
    const image = `${row.sha256}-${IMAGE_TAG}.${ext}`;
    const thumb = `${row.sha256}-${THUMB_TAG}.jpg`;
    const quality = alpha ? [] : ['-q:v', '3'];
    await run(ffmpeg, ['-v', 'error', '-y', '-i', source, '-frames:v', '1', '-vf', fitFilter(1920, 1920, portrait), ...quality, join(this.filesDir, image)]);
    this.progress.set(row.id, 0.7);
    await run(ffmpeg, ['-v', 'error', '-y', '-i', join(this.filesDir, image), '-frames:v', '1', '-vf', `${fitFilter(480, 480, portrait)},format=yuvj420p`, '-q:v', '5', join(this.filesDir, thumb)]);
    const out = (await probe(ffprobe, join(this.filesDir, image))).streams[0];
    const variants: Record<string, MediaVariant> = { main: { file: image, width: out.width ?? 0, height: out.height ?? 0 } };
    return { width: srcWidth, height: srcHeight, duration_s: null, variants_json: JSON.stringify(variants), poster: null, thumb };
  }

  private async processVideo(row: MediaRow) {
    const { ffmpeg, ffprobe } = this.options;
    const source = this.original(row);
    const info = await probe(ffprobe, source);
    const video = info.streams.find((s) => s.codec_type === 'video');
    if (!video) throw new Error('Keine Videospur in der Datei gefunden');
    const hasAudio = info.streams.some((s) => s.codec_type === 'audio');
    const duration = Number(info.format.duration ?? 0);
    const { width: srcWidth, height: srcHeight } = shownSize(video);
    const portrait = srcHeight > srcWidth;
    const fps = targetFps(rate(video.avg_frame_rate) || rate(video.r_frame_rate));
    // The 720p variant only when the source is larger than that.
    const profiles = VIDEO_PROFILES.filter((p) => p.key === 'main' || Math.min(srcWidth, srcHeight) > p.short);

    const variants: Record<string, MediaVariant> = {};
    for (const [index, profile] of profiles.entries()) {
      const file = `${row.sha256}-${profile.tag}.mp4`;
      const filters = [fitFilter(profile.long, profile.short, portrait), ...(fps ? [`fps=${fps}`] : [])].join(',');
      // prettier-ignore
      const args = [
        '-v', 'error', '-y', '-i', source,
        '-map', '0:v:0', ...(hasAudio ? ['-map', '0:a:0'] : []),
        '-vf', filters,
        '-c:v', 'libx264', '-profile:v', 'high', '-level:v', '4.1', '-preset', 'medium',
        '-crf', '21', '-maxrate', profile.maxrate, '-bufsize', profile.bufsize, '-pix_fmt', 'yuv420p',
        ...(hasAudio ? ['-c:a', 'aac', '-b:a', '128k', '-ac', '2'] : []),
        '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats',
        join(this.filesDir, file),
      ];
      await run(ffmpeg, args, (line) => {
        const match = /^out_time_us=(\d+)/.exec(line);
        if (match && duration > 0) {
          const part = Math.min(1, Number(match[1]) / 1e6 / duration);
          this.progress.set(row.id, Math.min(0.95, (index + part) / profiles.length));
        }
      });
      const out = (await probe(ffprobe, join(this.filesDir, file))).streams.find((s) => s.codec_type === 'video');
      variants[profile.key] = { file, width: out?.width ?? 0, height: out?.height ?? 0 };
    }

    const main = join(this.filesDir, variants.main.file);
    const poster = `${row.sha256}-${POSTER_TAG}.jpg`;
    const thumb = `${row.sha256}-${THUMB_TAG}.jpg`;
    const at = String(Math.min(1, duration / 3));
    await run(ffmpeg, ['-v', 'error', '-y', '-ss', at, '-i', main, '-frames:v', '1', '-q:v', '3', join(this.filesDir, poster)]);
    await run(ffmpeg, ['-v', 'error', '-y', '-i', join(this.filesDir, poster), '-vf', fitFilter(480, 480, portrait), '-q:v', '5', join(this.filesDir, thumb)]);
    const mainInfo = await probe(ffprobe, main);
    return {
      width: srcWidth,
      height: srcHeight,
      duration_s: Number(mainInfo.format.duration ?? duration) || null,
      variants_json: JSON.stringify(variants),
      poster,
      thumb,
    };
  }

  /** Serves a derived file with Range support (needed for <video> seeking and Safari/Chromium buffering). */
  async serve(file: string, rangeHeader: string | undefined): Promise<Response | null> {
    if (!FILE_NAME.test(file)) return null;
    const path = join(this.filesDir, file);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) return null;
    const headers: Record<string, string> = {
      'Content-Type': CONTENT_TYPES[file.split('.').pop()!],
      // Access depends on network or login (see app.ts), so no shared caches.
      'Cache-Control': 'private, max-age=31536000, immutable',
      'Accept-Ranges': 'bytes',
    };
    const range = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null;
    if (rangeHeader && range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : info.size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : info.size - 1;
      start = Math.max(0, start);
      end = Math.min(end, info.size - 1);
      if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } });
      headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
      headers['Content-Length'] = String(end - start + 1);
      return new Response(Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream, { status: 206, headers });
    }
    headers['Content-Length'] = String(info.size);
    return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, { status: 200, headers });
  }
}
