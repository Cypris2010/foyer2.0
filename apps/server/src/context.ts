import type { Db } from './db.ts';
import type { Registry } from './registry.ts';
import type { EventHub } from './events.ts';

export interface AppContext {
  db: Db;
  registry: Registry;
  events: EventHub;
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
