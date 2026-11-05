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
  const live = config.liveGateway ? new LiveGateway(config.liveGateway, config.liveGatewayKey) : undefined;
  return {
    db,
    registry: await loadRegistry(config.slideTypesDir),
    events: new EventHub(),
    media,
    live,
    liveServices: live && { ndiSources: ({ groups = [] } = {}) => live.ndiSources(groups) },
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
