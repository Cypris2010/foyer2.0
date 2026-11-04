import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const NDI_FFMPEG_DEFAULT = '/opt/ffmpeg-ndi/bin/ffmpeg';
const MEDIAMTX_DEFAULT = '/opt/mediamtx/mediamtx';

function list(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  return value.split(',').map((v) => v.trim()).filter(Boolean);
}

const repoRoot = resolve(import.meta.dirname, '../../..');

export const config = {
  repoRoot,
  // Bind to loopback by default; expose through a TLS reverse proxy (KONZEPT 3.5).
  host: process.env.FOYER_HOST ?? '127.0.0.1',
  port: Number(process.env.FOYER_PORT ?? 8080),
  dataDir: resolve(process.env.FOYER_DATA_DIR ?? join(repoRoot, 'data')),
  slideTypesDir: join(repoRoot, 'slide-types'),
  playerDist: join(repoRoot, 'apps/player/dist'),
  adminDist: join(repoRoot, 'apps/admin/dist'),
  // Only honour X-Forwarded-For from these proxy addresses.
  trustedProxies: list(process.env.FOYER_TRUSTED_PROXIES, ['127.0.0.1', '::1']),
  // Player endpoints only answer requests from these networks (KONZEPT 3.3).
  playerNetworks: list(process.env.FOYER_PLAYER_NETWORKS, [
    '127.0.0.0/8',
    '::1/128',
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    'fc00::/7',
  ]),
  // Secure cookies work on https and on http://localhost; only disable for plain-http LAN tests.
  secureCookies: process.env.FOYER_INSECURE_COOKIES !== '1',
  locale: process.env.FOYER_LOCALE ?? 'de-DE',
  timeZone: process.env.FOYER_TIMEZONE ?? 'Europe/Berlin',
  // Media pipeline (KONZEPT 6.2): ffmpeg/ffprobe on the server, upload limit in MB.
  ffmpeg: process.env.FOYER_FFMPEG ?? 'ffmpeg',
  ffprobe: process.env.FOYER_FFPROBE ?? 'ffprobe',
  // Separate ffmpeg with NDI input (deploy/ffmpeg-ndi/build.sh); empty = no NDI.
  ffmpegNdi: process.env.FOYER_FFMPEG_NDI ?? (existsSync(NDI_FFMPEG_DEFAULT) ? NDI_FFMPEG_DEFAULT : ''),
  // Live gateway (live.ts): MediaMTX binary, WebRTC media port for the displays, extra
  // addresses to announce (the server's LAN IP when it runs behind NAT), NDI hosts in other subnets.
  mediamtx: process.env.FOYER_MEDIAMTX ?? (existsSync(MEDIAMTX_DEFAULT) ? MEDIAMTX_DEFAULT : ''),
  liveMediaPort: Number(process.env.FOYER_LIVE_PORT ?? 8189),
  liveHosts: list(process.env.FOYER_LIVE_HOSTS, []),
  // First of three ports MediaMTX uses on 127.0.0.1 (RTSP ingest, WHEP, API).
  liveLocalPorts: Number(process.env.FOYER_LIVE_LOCAL_PORTS ?? 18550),
  ndiExtraIps: list(process.env.FOYER_NDI_EXTRA_IPS, []),
  mediaMaxMb: Number(process.env.FOYER_MEDIA_MAX_MB ?? 2048),
  sessionIdleHours: 8,
  sessionMaxDays: 7,
};
