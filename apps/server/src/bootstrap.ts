import { randomToken } from './crypto.ts';
import { getSetting, openDb, setSetting, type Db } from './db.ts';
import { loadRegistry } from './registry.ts';
import { EventHub } from './events.ts';
import { config } from './config.ts';
import type { AppContext } from './context.ts';
import { loadTokenKey } from './keys.ts';

export function contentSecret(db: Db): string {
  let secret = getSetting(db, 'content_secret');
  if (!secret) {
    secret = randomToken();
    setSetting(db, 'content_secret', secret);
  }
  return secret;
}

export async function createContext(db: Db = openDb(config.dataDir)): Promise<AppContext> {
  return {
    db,
    registry: await loadRegistry(config.slideTypesDir),
    events: new EventHub(),
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
