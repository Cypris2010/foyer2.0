// Server-sent events to connected players: manifest changes, reload, identify.
export type PlayerEvent = 'manifest-changed' | 'reload' | 'identify';

type Listener = (event: PlayerEvent, data?: unknown) => void;

export class EventHub {
  private listeners = new Map<string, Set<Listener>>();

  subscribe(displayId: string, listener: Listener): () => void {
    let set = this.listeners.get(displayId);
    if (!set) this.listeners.set(displayId, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(displayId);
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
