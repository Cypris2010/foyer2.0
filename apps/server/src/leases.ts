// One device per display: the first player session holds the display; others
// are turned away until it has been silent for LEASE_MS or an admin releases it.
// The same IP may take over at once, so a reloading Airtame (after every screen
// share) never locks itself out. In memory: after a server restart the first
// device to reconnect wins, which is the display itself within seconds.
import { ONLINE_WINDOW_MS } from './status.ts';

export const LEASE_MS = ONLINE_WINDOW_MS;

export interface Lease {
  sessionId: string;
  ip: string;
  since: number;
  lastSeen: number;
}

export type LeaseResult = { ok: true; tookOver: Lease | null } | { ok: false; holder: Lease };

export class LeaseTable {
  private leases = new Map<string, Lease>();

  acquire(displayId: string, sessionId: string, ip: string, now: number): LeaseResult {
    const lease = this.leases.get(displayId);
    if (lease && lease.sessionId === sessionId) {
      lease.lastSeen = now;
      lease.ip = ip;
      return { ok: true, tookOver: null };
    }
    const free = !lease || now - lease.lastSeen >= LEASE_MS || lease.ip === ip;
    if (!free) return { ok: false, holder: lease };
    this.leases.set(displayId, { sessionId, ip, since: now, lastSeen: now });
    return { ok: true, tookOver: lease ?? null };
  }

  /** Holder of a display, if its lease is still alive. */
  holder(displayId: string, now: number): Lease | null {
    const lease = this.leases.get(displayId);
    return lease && now - lease.lastSeen < LEASE_MS ? lease : null;
  }

  release(displayId: string): Lease | null {
    const lease = this.leases.get(displayId) ?? null;
    this.leases.delete(displayId);
    return lease;
  }
}
