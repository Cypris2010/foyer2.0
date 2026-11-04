// Connection state of a display as shown in the admin.

export type DisplayState = 'online' | 'offline' | 'never' | 'checking';

/** Heartbeats come every 30 s; three missed ones mean offline. */
export const ONLINE_WINDOW_MS = 90_000;
/** After a server restart players need a moment to reconnect; avoid false alarms. */
export const STARTUP_GRACE_MS = 30_000;

export function displayState(opts: { connected: boolean; lastSeenAt: number | null; now: number; serverStartedAt: number }): DisplayState {
  const { connected, lastSeenAt, now, serverStartedAt } = opts;
  // Players without EventSource only poll and send heartbeats, so a recent
  // heartbeat counts as online too.
  if (connected || (lastSeenAt !== null && now - lastSeenAt < ONLINE_WINDOW_MS)) return 'online';
  if (lastSeenAt === null) return 'never';
  if (now - serverStartedAt < STARTUP_GRACE_MS) return 'checking';
  return 'offline';
}
