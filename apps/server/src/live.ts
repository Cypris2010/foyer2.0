// Live gateway (KONZEPT 6.5): MediaMTX turns live sources into WebRTC for the
// displays. Foyer starts it as a child process and adds one path per source
// through its local API. Each path runs live-ingest.ts on demand, which pulls the
// source with ffmpeg and converts it to the display profile; nothing is encoded
// while no display watches. Only the WebRTC media port (UDP/TCP) is reachable from
// outside: signalling (WHEP) goes through Foyer, which checks who may watch.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LiveInput } from '@foyer/slide-sdk';
import { sha256 } from './crypto.ts';

export interface LiveOptions {
  /** MediaMTX binary; empty or missing = no live video. */
  mediamtx: string;
  ffmpeg: string;
  ffmpegNdi: string;
  /** Holds the generated MediaMTX config and one source file per path. */
  dir: string;
  /** WebRTC media port (UDP, TCP as fallback); must be reachable from the displays. */
  mediaPort: number;
  /** Extra IPs/hosts announced to players, e.g. the server's LAN address behind NAT. */
  hosts: string[];
  /** NDI senders outside the server's subnet (no mDNS there). */
  ndiExtraIps?: string[];
  /** Local ports (127.0.0.1 only). */
  apiPort: number;
  webrtcPort: number;
  rtspPort: number;
}

export const PROFILES = {
  '720p30': { height: 720, bitrate: '3M' },
  '1080p30': { height: 1080, bitrate: '5M' },
} as const;

/** Same source + profile = same path, so several slides share one conversion. */
export function livePathName(input: LiveInput): string {
  return `live_${sha256(JSON.stringify([input.kind, input.value, input.profile, input.audio])).slice(0, 20)}`;
}

/**
 * ffmpeg arguments: source → H.264 Constrained Baseline without B-frames (what
 * WebRTC and the Airtame decoder take), 1 s GOP, Opus audio, pushed to MediaMTX.
 */
export function ingestArgs(input: LiveInput, target: string, ndiExtraIps: string[] = []): string[] {
  const { height, bitrate } = PROFILES[input.profile];
  const source =
    input.kind === 'ndi'
      ? ['-f', 'libndi_newtek', ...(ndiExtraIps.length ? ['-extra_ips', ndiExtraIps.join(',')] : []), '-i', input.value]
      : [...(/^rtsps?:/i.test(input.value) ? ['-rtsp_transport', 'tcp'] : []), '-i', input.value];
  const audio = input.audio ? ['-map', '0:a:0?', '-c:a', 'libopus', '-b:a', '96k', '-ar', '48000', '-ac', '2'] : ['-an'];
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    ...source,
    '-map', '0:v:0',
    '-vf', `scale=-2:${height},fps=30`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p',
    '-b:v', bitrate, '-maxrate', bitrate, '-bufsize', bitrate, '-g', '30', '-keyint_min', '30', '-bf', '0',
    ...audio,
    '-f', 'rtsp', '-rtsp_transport', 'tcp', target,
  ];
}

/** MediaMTX config (JSON is valid YAML). Everything but the WebRTC media port listens on 127.0.0.1. */
export function mediamtxConfig(options: LiveOptions): string {
  return JSON.stringify(
    {
      logLevel: 'warn',
      api: true,
      apiAddress: `127.0.0.1:${options.apiPort}`,
      rtsp: true,
      rtspAddress: `127.0.0.1:${options.rtspPort}`,
      rtspTransports: ['tcp'],
      rtmp: false,
      hls: false,
      srt: false,
      moq: false,
      playback: false,
      webrtc: true,
      webrtcAddress: `127.0.0.1:${options.webrtcPort}`,
      webrtcLocalUDPAddress: `:${options.mediaPort}`,
      webrtcLocalTCPAddress: `:${options.mediaPort}`,
      webrtcAdditionalHosts: options.hosts,
      // Foyer itself publishes (ingest), reads (WHEP proxy) and configures (API).
      authInternalUsers: [
        { user: 'any', ips: ['127.0.0.1', '::1'], permissions: [{ action: 'publish' }, { action: 'read' }, { action: 'api' }] },
      ],
      paths: {},
    },
    null,
    2,
  );
}

/** MediaMTX splits commands like a shell and then expands $VARS, so no user text may go in. */
function quote(part: string): string {
  if (/['$]/.test(part)) throw new Error(`Pfad für Live-Video darf weder ' noch $ enthalten: ${part}`);
  return `'${part}'`;
}

export class LiveGateway {
  private child: ChildProcess | null = null;
  private paths = new Map<string, LiveInput>();
  /** Registrations in flight, so parallel requests (preview + thumbnail) add a path once. */
  private adding = new Map<string, Promise<void>>();
  private ready: Promise<void> | null = null;
  private stopped = false;

  private options: LiveOptions;

  constructor(options: LiveOptions) {
    this.options = options;
  }

  /** The MediaMTX binary exists (a bare name is looked up in PATH when starting). */
  get available(): boolean {
    const bin = this.options.mediamtx;
    return Boolean(bin) && (!bin.includes('/') || existsSync(bin));
  }

  get ndiAvailable(): boolean {
    return Boolean(this.options.ffmpegNdi);
  }

  /** Starts MediaMTX lazily, on the first live slide. */
  private start(): Promise<void> {
    if (this.ready) return this.ready;
    mkdirSync(this.options.dir, { recursive: true });
    const configFile = join(this.options.dir, 'mediamtx.yml');
    writeFileSync(configFile, mediamtxConfig(this.options));
    this.ready = new Promise<void>((resolve, reject) => {
      const child = spawn(this.options.mediamtx, [configFile], { stdio: ['ignore', 'inherit', 'inherit'] });
      this.child = child;
      child.on('error', (err: NodeJS.ErrnoException) => {
        this.ready = null;
        reject(new Error(err.code === 'ENOENT' ? 'MediaMTX ist auf dem Server nicht installiert' : err.message));
      });
      child.on('exit', (code) => {
        this.child = null;
        this.ready = null;
        if (this.stopped) return;
        console.error(`MediaMTX beendet (Code ${code}), Neustart beim nächsten Abruf`);
      });
      this.waitForApi().then(async () => {
        // After a restart: add the paths players already use.
        for (const [name, input] of this.paths) await this.addPath(name, input);
        resolve();
      }, reject);
    });
    this.ready.catch(() => undefined);
    return this.ready;
  }

  private async waitForApi() {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (!this.child) throw new Error('MediaMTX ließ sich nicht starten');
      try {
        const res = await this.api('GET', '/v3/config/global/get');
        if (res.ok) return;
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('MediaMTX antwortet nicht');
  }

  private api(method: string, path: string, body?: unknown) {
    return fetch(`http://127.0.0.1:${this.options.apiPort}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    });
  }

  private async addPath(name: string, input: LiveInput) {
    const sourceFile = join(this.options.dir, `${name}.json`);
    const ffmpeg = input.kind === 'ndi' ? this.options.ffmpegNdi : this.options.ffmpeg;
    writeFileSync(sourceFile, JSON.stringify({ ffmpeg, args: ingestArgs(input, `rtsp://127.0.0.1:${this.options.rtspPort}/${name}`, this.options.ndiExtraIps) }));
    const conf = {
      runOnDemand: [process.execPath, join(import.meta.dirname, 'live-ingest.ts'), sourceFile].map(quote).join(' '),
      runOnDemandRestart: true,
      // NDI sources and network cameras can take a few seconds to answer.
      runOnDemandStartTimeout: '20s',
      runOnDemandCloseAfter: '30s',
    };
    let res = await this.api('POST', `/v3/config/paths/add/${name}`, conf);
    if (!res.ok) res = await this.api('POST', `/v3/config/paths/replace/${name}`, conf);
    if (!res.ok) throw new Error(`MediaMTX lehnt die Quelle ab: ${(await res.text()).slice(0, 200)}`);
  }

  /** Registers the source (idempotent) and returns its path name. */
  async ensure(input: LiveInput): Promise<string> {
    if (!this.available) throw new Error('Live-Video ist auf dem Server nicht eingerichtet (MediaMTX fehlt)');
    if (input.kind === 'ndi' && !this.ndiAvailable) throw new Error('Der Server hat keinen NDI-Eingang (ffmpeg mit NDI fehlt)');
    const name = livePathName(input);
    await this.start();
    if (this.paths.has(name)) return name;
    let adding = this.adding.get(name);
    if (!adding) {
      adding = this.addPath(name, input)
        .then(() => {
          this.paths.set(name, input);
        })
        .finally(() => this.adding.delete(name));
      this.adding.set(name, adding);
    }
    await adding;
    return name;
  }

  /** WHEP offer → answer, forwarded to the local MediaMTX. */
  async whep(name: string, offer: string): Promise<{ status: number; sdp: string }> {
    const res = await fetch(`http://127.0.0.1:${this.options.webrtcPort}/${name}/whep`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: offer,
      signal: AbortSignal.timeout(25_000),
    });
    return { status: res.status, sdp: await res.text() };
  }

  stop() {
    this.stopped = true;
    this.child?.kill();
  }
}
