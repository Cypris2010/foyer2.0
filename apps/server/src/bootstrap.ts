import { randomToken } from './crypto.ts';
import { getSetting, openDb, setSetting, type Db } from './db.ts';
import { loadRegistry } from './registry.ts';
import { EventHub } from './events.ts';
import { config } from './config.ts';
import type { AppContext } from './context.ts';
import { loadTokenKey } from './keys.ts';
import { join } from 'node:path';
import { MediaLibrary } from './media.ts';
import { playerBuildReader } from './player-build.ts';
import { LiveGateway } from './live.ts';
import { findNdiSources, ndiAvailable, ndiConfigDir, useNdiGroups } from './ndi.ts';

export function contentSecret(db: Db): string {
  let secret = getSetting(db, 'content_secret');
  if (!secret) {
    secret = randomToken();
    setSetting(db, 'content_secret', secret);
  }
  return secret;
}

export async function createContext(db: Db = openDb(config.dataDir)): Promise<AppContext> {
  const media = new MediaLibrary(db, {
    dir: join(config.dataDir, 'media'),
    ffmpeg: config.ffmpeg,
    ffprobe: config.ffprobe,
    maxBytes: config.mediaMaxMb * 1048576,
  });
  media.resume();
  useNdiGroups(join(config.dataDir, 'ndi'), config.ndiGroups);
  const live = new LiveGateway({
    mediamtx: config.mediamtx,
    ffmpeg: config.ffmpeg,
    ffmpegNdi: config.ffmpegNdi,
    dir: join(config.dataDir, 'live'),
    mediaPort: config.liveMediaPort,
    hosts: config.liveHosts,
    ndiExtraIps: config.ndiExtraIps,
    rtspPort: config.liveLocalPorts,
    webrtcPort: config.liveLocalPorts + 1,
    apiPort: config.liveLocalPorts + 2,
  });
  return {
    db,
    registry: await loadRegistry(config.slideTypesDir),
    events: new EventHub(),
    media,
    live,
    liveServices: {
      ndiSources: async ({ groups = [] } = {}) => {
        if (!(await ndiAvailable(config.ffmpegNdi))) throw new Error('Der Server hat keinen NDI-Eingang (siehe README, „NDI als Live-Quelle“)');
        const configDir = groups.length ? ndiConfigDir(join(config.dataDir, 'ndi'), groups) : undefined;
        return findNdiSources(config.ffmpegNdi, { extraIps: config.ndiExtraIps, configDir });
      },
    },
    playerBuild: playerBuildReader(config.playerDist),
    secret: contentSecret(db),
    tokenKey: loadTokenKey(config.dataDir),
    locale: config.locale,
    timeZone: config.timeZone,
    playerNetworks: config.playerNetworks,
    trustedProxies: config.trustedProxies,
    startedAt: Date.now(),
    now: () => Date.now(),
  };
}
