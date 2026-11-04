import { describe, expect, it } from 'vitest';
import { setup } from './helpers.ts';
import { ingestArgs, LiveGateway, livePathName, mediamtxConfig, type LiveOptions } from '../apps/server/src/live.ts';
import type { LiveInput } from '@foyer/slide-sdk';

const options: LiveOptions = {
  mediamtx: '/opt/mediamtx/mediamtx',
  ffmpeg: 'ffmpeg',
  ffmpegNdi: '/opt/ffmpeg-ndi/bin/ffmpeg',
  dir: '/tmp/live',
  mediaPort: 8189,
  hosts: ['10.0.0.5'],
  apiPort: 18552,
  webrtcPort: 18551,
  rtspPort: 18550,
};

const ndi: LiveInput = { kind: 'ndi', value: 'AULA-MIXER (Program) $HOME "x"', profile: '720p30', audio: false };

describe('Live-Gateway', () => {
  it('teilt eine Umwandlung zwischen Folien mit gleicher Quelle und gleichem Profil', () => {
    expect(livePathName(ndi)).toBe(livePathName({ ...ndi }));
    expect(livePathName(ndi)).not.toBe(livePathName({ ...ndi, profile: '1080p30' }));
    expect(livePathName(ndi)).toMatch(/^live_[0-9a-f]{20}$/);
  });

  it('gibt Quellnamen unverändert als ein Argument an ffmpeg (keine Shell)', () => {
    const args = ingestArgs(ndi, 'rtsp://127.0.0.1:18550/p');
    expect(args.slice(args.indexOf('-f'), args.indexOf('-f') + 4)).toEqual(['-f', 'libndi_newtek', '-i', ndi.value]);
    expect(args).toContain('-an');
    expect(args).toContain('baseline');
    expect(args[args.indexOf('-vf') + 1]).toBe('scale=-2:720,fps=30');
    expect(args.at(-1)).toBe('rtsp://127.0.0.1:18550/p');
  });

  it('sucht NDI-Quellen in anderen Subnetzen über die eingetragenen IPs', () => {
    const args = ingestArgs(ndi, 'rtsp://127.0.0.1:18550/p', ['10.48.20.5', '10.48.20.9']);
    expect(args.slice(args.indexOf('-extra_ips'), args.indexOf('-extra_ips') + 2)).toEqual(['-extra_ips', '10.48.20.5,10.48.20.9']);
  });

  it('holt RTSP-Kameras über TCP und wandelt Ton in Opus', () => {
    const args = ingestArgs({ kind: 'url', value: 'rtsp://10.0.0.20/stream1', profile: '1080p30', audio: true }, 'rtsp://127.0.0.1:18550/p');
    expect(args.slice(args.indexOf('-i') - 2, args.indexOf('-i') + 2)).toEqual(['-rtsp_transport', 'tcp', '-i', 'rtsp://10.0.0.20/stream1']);
    expect(args).toContain('libopus');
    expect(args).toContain('5M');
  });

  it('lauscht außer dem WebRTC-Medienport nur auf 127.0.0.1', () => {
    const conf = JSON.parse(mediamtxConfig(options));
    expect(conf.apiAddress).toBe('127.0.0.1:18552');
    expect(conf.rtspAddress).toBe('127.0.0.1:18550');
    expect(conf.webrtcAddress).toBe('127.0.0.1:18551');
    expect(conf.webrtcLocalUDPAddress).toBe(':8189');
    expect(conf.webrtcAdditionalHosts).toEqual(['10.0.0.5']);
    for (const off of ['rtmp', 'hls', 'srt', 'moq', 'playback']) expect(conf[off]).toBe(false);
    expect(conf.authInternalUsers).toEqual([
      { user: 'any', ips: ['127.0.0.1', '::1'], permissions: [{ action: 'publish' }, { action: 'read' }, { action: 'api' }] },
    ]);
  });

  it('meldet fehlendes MediaMTX und fehlenden NDI-Eingang', async () => {
    await expect(new LiveGateway({ ...options, mediamtx: '' }).ensure(ndi)).rejects.toThrow(/MediaMTX fehlt/);
    await expect(new LiveGateway({ ...options, mediamtx: 'mediamtx', ffmpegNdi: '' }).ensure(ndi)).rejects.toThrow(/keinen NDI-Eingang/);
  });
});

async function liveSetup(gateway: Partial<LiveGateway> | undefined) {
  const env = await setup();
  const config = { source: 'url', url: 'rtsp://10.0.0.20/stream1' };
  env.db.prepare('INSERT INTO slides (id, title, type, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    's-live', 'Live', 'live', JSON.stringify(config), env.now, env.now,
  );
  env.db.prepare('INSERT INTO channel_slides (channel_id, slide_id, position) VALUES (?, ?, ?)').run(env.channelId, 's-live', 9);
  env.db.prepare(
    `INSERT INTO schedules (id, scope, channel_id, content_kind, content_id, start_local, end_local, created_at, updated_at)
     VALUES ('plan-live', 'channel', ?, 'slide', 's-live', '2000-01-01T00:00', NULL, ?, ?)`,
  ).run(env.channelId, env.now, env.now);
  env.ctx.live = gateway as LiveGateway | undefined;
  const manifest = await (await env.app.request(`/api/player/${env.token}/manifest`)).json();
  const slide = manifest.slides.find((s: { id: string }) => s.id === 's-live');
  return { ...env, slide };
}

const offer = (headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/sdp', ...headers },
  body: 'v=0\r\n',
});

describe('Live-Folie', () => {
  const calls: Array<{ name: string; sdp: string }> = [];
  const gateway: Partial<LiveGateway> = {
    available: true,
    ndiAvailable: false,
    ensure: async (input) => livePathName(input),
    whep: async (name, sdp) => {
      calls.push({ name, sdp });
      return { status: 201, sdp: 'v=0 answer' };
    },
  };

  it('bekommt eine signierte WHEP-Adresse, die ins Schulnetz antwortet', async () => {
    const { app, slide } = await liveSetup(gateway);
    expect(slide.error).toBeUndefined();
    expect(slide.liveUrl).toMatch(/^\/content\/live\/s-live\/\d+\/whep\?d=d1&s=/);
    const res = await app.request(slide.liveUrl, offer());
    expect(res.status).toBe(201);
    expect(res.headers.get('content-type')).toBe('application/sdp');
    expect(await res.text()).toBe('v=0 answer');
    expect(calls.at(-1)).toEqual({ name: livePathName({ kind: 'url', value: 'rtsp://10.0.0.20/stream1', profile: '720p30', audio: false }), sdp: 'v=0\r\n' });
  });

  it('verweigert falsche Signatur, fremde Netze und fremde Inhalte', async () => {
    const { app, slide } = await liveSetup(gateway);
    expect((await app.request(slide.liveUrl.replace(/s=[^&]+/, 's=falsch'), offer())).status).toBe(403);
    expect((await app.request(slide.liveUrl, offer({ 'x-test-remote': '8.8.8.8' }))).status).toBe(403);
    expect((await app.request(slide.liveUrl, { ...offer(), headers: { 'content-type': 'text/plain' } })).status).toBe(415);
  });

  it('zeigt einen Fehler statt einer Adresse, wenn der Server kein Live-Video hat', async () => {
    const { slide } = await liveSetup(undefined);
    expect(slide.liveUrl).toBeUndefined();
    expect(slide.error).toMatch(/nicht eingerichtet/);
  });
});
