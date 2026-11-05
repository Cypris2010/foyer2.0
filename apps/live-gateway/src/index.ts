// Live gateway (KONZEPT 6.5): its own process and container next to Foyer, or on a
// machine in the AV network where it sees the NDI sources directly.
import { join } from 'node:path';
import { createGatewayServer } from './api.ts';
import { config } from './config.ts';
import { LiveGateway } from './live.ts';
import { findNdiSources, ndiAvailable, ndiConfigDir, useNdiGroups } from './ndi.ts';

if (config.key.length < 32) {
  console.error('FOYER_LIVE_GATEWAY_KEY fehlt oder ist kürzer als 32 Zeichen (z. B. openssl rand -hex 32)');
  process.exit(1);
}
if (!config.mediamtx) {
  console.error('MediaMTX fehlt (FOYER_MEDIAMTX); das Docker-Image des Gateways bringt es mit');
  process.exit(1);
}

const ndiDir = join(config.dir, 'ndi');
useNdiGroups(ndiDir, config.ndiGroups);
const ndi = await ndiAvailable(config.ffmpegNdi);
const live = new LiveGateway({
  mediamtx: config.mediamtx,
  ffmpeg: config.ffmpeg,
  ffmpegNdi: ndi ? config.ffmpegNdi : '',
  dir: config.dir,
  mediaPort: config.liveMediaPort,
  hosts: config.liveHosts,
  ndiExtraIps: config.ndiExtraIps,
  rtspPort: config.liveLocalPorts,
  webrtcPort: config.liveLocalPorts + 1,
  apiPort: config.liveLocalPorts + 2,
});

const server = createGatewayServer(
  {
    ndi,
    ensure: (input) => live.ensure(input),
    whep: (name, offer) => live.whep(name, offer),
    ndiSources: (groups) =>
      findNdiSources(config.ffmpegNdi, { extraIps: config.ndiExtraIps, configDir: groups.length ? ndiConfigDir(ndiDir, groups) : undefined }),
  },
  config.key,
);

// MediaMTX runs as a child process; take it down with the gateway.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    live.stop();
    process.exit(0);
  });
}

server.listen(config.port, config.host, () => {
  console.log(`Live-Gateway läuft auf http://${config.host}:${config.port}  (WebRTC-Bild: Port ${config.liveMediaPort} UDP/TCP)`);
  if (ndi) console.log(`NDI-Eingang verfügbar (${config.ffmpegNdi})`);
  else if (config.ffmpegNdi) console.log(`NDI-Eingang nicht verfügbar: ${config.ffmpegNdi} fehlt oder kann kein NDI`);
});
