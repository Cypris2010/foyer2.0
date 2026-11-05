import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NDI_FFMPEG_DEFAULT = '/opt/ffmpeg-ndi/bin/ffmpeg';
const MEDIAMTX_DEFAULT = '/opt/mediamtx/mediamtx';

function list(value: string | undefined): string[] {
  return (value ?? '').split(',').map((v) => v.trim()).filter(Boolean);
}

export const config = {
  // API for Foyer (api.ts). Reachable from the Foyer server, protected by the shared key.
  host: process.env.FOYER_GATEWAY_HOST ?? '127.0.0.1',
  port: Number(process.env.FOYER_GATEWAY_PORT ?? 8190),
  key: process.env.FOYER_LIVE_GATEWAY_KEY ?? '',
  // Generated MediaMTX config, one source file per path, NDI group configs; rebuilt on every start.
  dir: process.env.FOYER_GATEWAY_DIR ?? join(tmpdir(), 'foyer-live-gateway'),
  ffmpeg: process.env.FOYER_FFMPEG ?? 'ffmpeg',
  // Separate ffmpeg with NDI input (deploy/ffmpeg-ndi/build.sh); empty = no NDI.
  ffmpegNdi: process.env.FOYER_FFMPEG_NDI ?? (existsSync(NDI_FFMPEG_DEFAULT) ? NDI_FFMPEG_DEFAULT : ''),
  mediamtx: process.env.FOYER_MEDIAMTX ?? (existsSync(MEDIAMTX_DEFAULT) ? MEDIAMTX_DEFAULT : ''),
  // WebRTC media port for the displays, extra addresses to announce (the gateway's LAN IP
  // when it runs behind NAT), NDI hosts in other subnets.
  liveMediaPort: Number(process.env.FOYER_LIVE_PORT ?? 8189),
  liveHosts: list(process.env.FOYER_LIVE_HOSTS),
  // First of three ports MediaMTX uses on 127.0.0.1 (RTSP ingest, WHEP, API).
  liveLocalPorts: Number(process.env.FOYER_LIVE_LOCAL_PORTS ?? 18550),
  ndiExtraIps: list(process.env.FOYER_NDI_EXTRA_IPS),
  // NDI groups to search; empty = the NDI default ("public").
  ndiGroups: list(process.env.FOYER_NDI_GROUPS),
};
