import type { Db } from './db.ts';
import type { Registry } from './registry.ts';
import type { EventHub } from './events.ts';

export interface AppContext {
  db: Db;
  registry: Registry;
  events: EventHub;
  /** HMAC secret for signed content URLs, generated on first start. */
  secret: string;
  locale: string;
  timeZone: string;
  playerNetworks: string[];
  trustedProxies: string[];
  now: () => number;
}
