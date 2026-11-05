import type { Db } from './db.ts';
import type { Registry } from './registry.ts';
import type { EventHub } from './events.ts';
import type { MediaLibrary } from './media.ts';
import type { LiveGateway } from './live.ts';
import type { LiveServices } from '@foyer/slide-sdk';

export interface AppContext {
  db: Db;
  registry: Registry;
  events: EventHub;
  media: MediaLibrary;
  /** Client for the live gateway (live.ts); absent when FOYER_LIVE_GATEWAY is not set. */
  live?: LiveGateway;
  /** Handed to slide-type servers (option lists, e.g. NDI sources). */
  liveServices?: LiveServices;
  /** File name of the player bundle being served (player-build.ts); null when not built. */
  playerBuild: () => string | null;
  /** HMAC secret for signed content URLs, generated on first start. */
  secret: string;
  /** AES key for stored display tokens (see keys.ts). */
  tokenKey: Buffer;
  locale: string;
  timeZone: string;
  playerNetworks: string[];
  trustedProxies: string[];
  /** Server start, for the reconnect grace period in the display status. */
  startedAt: number;
  now: () => number;
}
