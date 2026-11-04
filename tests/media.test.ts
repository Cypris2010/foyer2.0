import { describe, expect, it, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { json, setup } from './helpers.ts';
import { sniff, targetFps } from '../apps/server/src/media.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const fixtures = mkdtempSync(join(tmpdir(), 'foyer-fixtures-'));
const fixture = (name: string) => join(fixtures, name);

function ffmpeg(...args: string[]) {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args]);
  if (result.status !== 0) throw new Error(result.stderr.toString());
}

function probeVideo(file: string) {
  const out = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,avg_frame_rate,codec_name,profile', '-of', 'json', file]);
  return JSON.parse(out.stdout.toString()).streams[0];
}

function upload(app: Awaited<ReturnType<typeof setup>>['app'], cookie: string, file: string, name = file.split('/').pop()!) {
  return app.request(`/api/media?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { cookie, 'sec-fetch-site': 'same-origin', 'content-type': 'application/octet-stream' },
    body: readFileSync(file),
  });
}

describe('Dateityp-Erkennung', () => {
  it('erkennt Typen am Inhalt, nicht am Namen', () => {
    expect(sniff(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toEqual({ kind: 'image', ext: 'jpg' });
    expect(sniff(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toEqual({ kind: 'image', ext: 'png' });
    expect(sniff(Buffer.from('\0\0\0\x18ftypheic'))).toEqual({ kind: 'image', ext: 'heic' });
    expect(sniff(Buffer.from('\0\0\0\x18ftypisom'))).toEqual({ kind: 'video', ext: 'mp4' });
    expect(sniff(Buffer.from('\0\0\0\x14ftypqt  '))).toEqual({ kind: 'video', ext: 'mov' });
    expect(sniff(Buffer.from('<svg xmlns='))).toBeNull();
    expect(sniff(Buffer.from('<?php echo 1;'))).toBeNull();
  });

  it('halbiert 50/60 fps, lässt bis 30 fps unverändert', () => {
    expect(targetFps(25)).toBeNull();
    expect(targetFps(30)).toBeNull();
    expect(targetFps(29.97)).toBeNull();
    expect(targetFps(50)).toBe(25);
    expect(targetFps(59.94)).toBe(29.97);
    expect(targetFps(120)).toBe(30);
  });
});

describe.skipIf(!hasFfmpeg)('Mediathek', () => {
  beforeAll(() => {
    ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=2400x1600', '-frames:v', '1', fixture('foto.jpg'));
    ffmpeg('-f', 'lavfi', '-i', 'color=c=red@0.5:size=300x200,format=rgba', '-frames:v', '1', fixture('logo.png'));
    // 1080p60 with sound, like a phone video: must come out at 30 fps.
    ffmpeg(
      '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=60:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', fixture('clip.mp4'),
    );
  }, 60_000);

  it('verarbeitet Fotos zu höchstens 1920 px plus Vorschaubild', async () => {
    const { app, ctx, loginAs } = await setup();
    const cookie = await loginAs('editor');
    const res = await upload(app, cookie, fixture('foto.jpg'), '../../Sommerfest.jpg');
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created).toMatchObject({ kind: 'image', name: 'Sommerfest.jpg' });
    await ctx.media.idle();
    const item = await (await app.request(`/api/media/${created.id}`, { headers: { cookie } })).json();
    expect(item).toMatchObject({ status: 'ready', width: 2400, height: 1600, usage: [] });
    expect(item.variants.main).toMatchObject({ width: 1920, height: 1280 });
    expect(item.url).toMatch(/^\/media\/[0-9a-f]{64}-img1\.jpg$/);
    expect(item.thumb).toMatch(/-thumb1\.jpg$/);
  });

  it('behält Transparenz als PNG', async () => {
    const { app, ctx, loginAs } = await setup();
    const cookie = await loginAs('editor');
    const created = await (await upload(app, cookie, fixture('logo.png'))).json();
    await ctx.media.idle();
    const item = await (await app.request(`/api/media/${created.id}`, { headers: { cookie } })).json();
    expect(item.url).toMatch(/-img1\.png$/);
    expect(item.variants.main).toMatchObject({ width: 300, height: 200 });
  });

  it('wandelt Videos ins Airtame-Profil um: H.264 High, 1080p30 und 720p', async () => {
    const { app, ctx, loginAs } = await setup();
    const cookie = await loginAs('editor');
    const created = await (await upload(app, cookie, fixture('clip.mp4'))).json();
    expect(created.kind).toBe('video');
    await ctx.media.idle();
    const item = await (await app.request(`/api/media/${created.id}`, { headers: { cookie } })).json();
    expect(item.status).toBe('ready');
    expect(item.duration).toBeCloseTo(2, 0);
    expect(item.poster).toMatch(/-poster1\.jpg$/);
    const main = probeVideo(join(ctx.media.filesDir, item.variants.main.url.split('/').pop()));
    expect(main).toMatchObject({ codec_name: 'h264', profile: 'High', width: 1920, height: 1080, avg_frame_rate: '30/1' });
    expect(item.variants.sd).toMatchObject({ width: 1280, height: 720 });
  }, 120_000);

  it('erkennt doppelte Uploads', async () => {
    const { app, ctx, loginAs } = await setup();
    const cookie = await loginAs('editor');
    const first = await (await upload(app, cookie, fixture('logo.png'))).json();
    const again = await upload(app, cookie, fixture('logo.png'), 'anders.png');
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ id: first.id, existing: true });
    await ctx.media.idle();
  });

  it('lehnt fremde Dateitypen, zu große Dateien und Betrachter ab', async () => {
    const { app, loginAs } = await setup();
    const editor = await loginAs('editor');
    const viewer = await loginAs('viewer');
    const script = await app.request('/api/media?name=bild.jpg', {
      method: 'POST',
      headers: { cookie: editor, 'sec-fetch-site': 'same-origin' },
      body: '<script>alert(1)</script>',
    });
    expect(script.status).toBe(400);
    const tooLarge = await app.request('/api/media?name=gross.mp4', {
      method: 'POST',
      headers: { cookie: editor, 'sec-fetch-site': 'same-origin', 'content-length': String(51 * 1048576) },
      body: 'x',
    });
    expect(tooLarge.status).toBe(413);
    expect((await upload(app, viewer, fixture('logo.png'))).status).toBe(403);
  });

  it('liefert Dateien nur ins Schulnetz oder an Angemeldete, mit Range', async () => {
    const { app, ctx, loginAs } = await setup();
    const cookie = await loginAs('editor');
    const created = await (await upload(app, cookie, fixture('foto.jpg'))).json();
    await ctx.media.idle();
    const { url } = await (await app.request(`/api/media/${created.id}`, { headers: { cookie } })).json();

    const player = await app.request(url, { headers: { range: 'bytes=0-9' } });
    expect(player.status).toBe(206);
    expect(player.headers.get('content-range')).toMatch(/^bytes 0-9\/\d+$/);
    expect((await player.arrayBuffer()).byteLength).toBe(10);
    expect(player.headers.get('cache-control')).toContain('immutable');

    expect((await app.request(url, { headers: { 'x-test-remote': '8.8.8.8' } })).status).toBe(403);
    expect((await app.request(url, { headers: { 'x-test-remote': '8.8.8.8', cookie } })).status).toBe(200);
    expect((await app.request('/media/..%2F..%2Ffoyer.sqlite')).status).toBe(404);
  });

  it('nutzt Medien als Folienhintergrund und schützt sie vor dem Löschen', async () => {
    const { app, ctx, token, loginAs } = await setup();
    // Admin: HTML slides need admin rights.
    const cookie = await loginAs('admin');
    const image = await (await upload(app, cookie, fixture('foto.jpg'))).json();
    await ctx.media.idle();

    const slide = { title: 's-text', type: 'text', config: { title: 'Hallo' }, published: true };
    const html = await app.request('/api/slides/s-html', json('PUT', { ...slide, type: 'html', config: { html: '<p>x</p>' }, background: { kind: 'image', mediaId: image.id } }, cookie));
    expect(html.status).toBe(400);
    const wrongKind = await app.request('/api/slides/s-text', json('PUT', { ...slide, background: { kind: 'video', mediaId: image.id } }, cookie));
    expect(wrongKind.status).toBe(400);
    const ok = await app.request('/api/slides/s-text', json('PUT', { ...slide, background: { kind: 'image', mediaId: image.id, dim: 30 } }, cookie));
    expect(ok.status).toBe(200);

    const manifest = await (await app.request(`/api/player/${token}/manifest`)).json();
    expect(manifest.slides[0].background).toEqual({ kind: 'image', url: expect.stringMatching(/^\/media\/.+-img1\.jpg$/), fit: 'cover', dim: 30 });

    const list = await (await app.request('/api/media', { headers: { cookie } })).json();
    expect(list[0].usageCount).toBe(1);
    const blocked = await app.request(`/api/media/${image.id}`, json('DELETE', {}, cookie));
    expect(blocked.status).toBe(409);

    await app.request('/api/slides/s-text', json('PUT', { ...slide, background: null }, cookie));
    const removed = await app.request(`/api/media/${image.id}`, json('DELETE', {}, cookie));
    expect(removed.status).toBe(200);
    expect((await app.request(list[0].url)).status).toBe(404);
  });

  it('Videofolie läuft so lange wie das Video, mit fester Dauer in Schleife', async () => {
    const { app, ctx, db, token, channelId, loginAs } = await setup();
    const cookie = await loginAs('editor');
    const video = await (await upload(app, cookie, fixture('clip.mp4'))).json();
    const image = await (await upload(app, cookie, fixture('logo.png'))).json();

    const body = { title: 'Film', type: 'video', config: { mediaId: video.id, sound: true }, published: true };
    expect((await app.request('/api/slides', json('POST', { ...body, config: {} }, cookie))).status).toBe(400);
    expect((await app.request('/api/slides', json('POST', { ...body, config: { mediaId: image.id } }, cookie))).status).toBe(400);
    const created = await app.request('/api/slides', json('POST', body, cookie));
    expect(created.status).toBe(201);
    const { id } = await created.json();
    db.prepare('INSERT INTO channel_slides (channel_id, slide_id, position) VALUES (?, ?, 9)').run(channelId, id);
    db.prepare(
      `INSERT INTO schedules (id, scope, channel_id, content_kind, content_id, start_local, created_at, updated_at)
       VALUES ('plan-film', 'channel', ?, 'slide', ?, '2000-01-01T00:00', 0, 0)`,
    ).run(channelId, id);

    // Still converting: the slide stays out of the playlist.
    const manifest = async () => (await (await app.request(`/api/player/${token}/manifest`)).json());
    expect((await manifest()).slides.map((s: any) => s.id)).not.toContain(id);

    await ctx.media.idle();
    let film = (await manifest()).slides.find((s: any) => s.id === id);
    expect(film).toMatchObject({ playsToEnd: true, duration: expect.closeTo(2, 0) });
    expect(film.media[video.id]).toMatchObject({ kind: 'video', url: expect.stringMatching(/-v1-1080\.mp4$/), width: 1920 });
    expect((await manifest()).display.soundAllowed).toBe(false);

    await app.request('/api/displays/d1', json('PATCH', { soundAllowed: true }, cookie));
    expect((await manifest()).display.soundAllowed).toBe(true);

    await app.request(`/api/slides/${id}`, json('PUT', { ...body, duration: 20 }, cookie));
    film = (await manifest()).slides.find((s: any) => s.id === id);
    expect(film).toMatchObject({ playsToEnd: false, duration: 20 });

    const blocked = await app.request(`/api/media/${video.id}`, json('DELETE', {}, cookie));
    expect(blocked.status).toBe(409);
  }, 120_000);
});
