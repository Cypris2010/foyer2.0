// Server-sent events to connected players (key: display id) and to admin
// live previews (key: "watch:<display id>"): manifest changes, reload,
// identify, test patterns, and which slide a display is showing right now.
export type PlayerEvent = 'manifest-changed' | 'reload' | 'identify' | 'now-playing' | 'released' | 'test-pattern';

type Listener = (event: PlayerEvent, data?: unknown) => void;

export class EventHub {
  private listeners = new Map<string, Set<Listener>>();

  subscribe(displayId: string, listener: Listener): () => void {
    let set = this.listeners.get(displayId);
    if (!set) this.listeners.set(displayId, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      // Only our own set: callers may unsubscribe twice (abort, then end of the
      // stream loop), after a reconnect has already put a new set in place.
      if (!set.size && this.listeners.get(displayId) === set) this.listeners.delete(displayId);
    };
  }

  send(displayId: string, event: PlayerEvent, data?: unknown) {
    for (const listener of this.listeners.get(displayId) ?? []) listener(event, data);
  }

  /** Players re-fetch and compare the manifest version, so a broad broadcast is cheap. */
  broadcast(event: PlayerEvent, data?: unknown) {
    for (const displayId of this.listeners.keys()) this.send(displayId, event, data);
  }

  connected(displayId: string): number {
    return this.listeners.get(displayId)?.size ?? 0;
  }
}
