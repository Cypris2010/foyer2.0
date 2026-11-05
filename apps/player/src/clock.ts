// The server's clock, as seen from this device. Displays that share it switch
// slides at the same moment without talking to each other (display walls).
// NTP-style: offset = server time − midpoint of the request; the sample with
// the shortest round trip wins, because its midpoint guess is the tightest.

const STORAGE_KEY = 'foyer.clockOffset';
const WINDOW = 8;
// Smaller corrections are noise; larger ones re-align the timeline (onShift).
const SHIFT_MIN_MS = 30;

export interface ClockSample {
  /** performance.now() when the request left and when the answer arrived. */
  sentAt: number;
  receivedAt: number;
  /** Server time (epoch ms) in the answer. */
  serverNow: number;
}

/** Offset between server time and performance.now() from the best recent sample. */
export function bestOffset(samples: ClockSample[]): number | null {
  let best: ClockSample | null = null;
  for (const sample of samples) {
    if (!best || sample.receivedAt - sample.sentAt < best.receivedAt - best.sentAt) best = sample;
  }
  return best ? best.serverNow - (best.sentAt + best.receivedAt) / 2 : null;
}

export class ServerClock {
  private samples: ClockSample[] = [];
  /** serverNow − performance.now(); before the first sample: last known, else the device clock. */
  private offset: number;
  onShift: () => void = () => undefined;

  constructor() {
    this.offset = Date.now() - performance.now() + (loadStoredOffset() ?? 0);
  }

  now(): number {
    return performance.now() + this.offset;
  }

  add(sample: ClockSample) {
    this.samples.push(sample);
    if (this.samples.length > WINDOW) this.samples.shift();
    const offset = bestOffset(this.samples);
    if (offset === null) return;
    const shift = offset - this.offset;
    this.offset = offset;
    storeOffset(offset - (Date.now() - performance.now()));
    if (Math.abs(shift) >= SHIFT_MIN_MS) this.onShift();
  }

  /** Asks the server for its time; failures just keep the current estimate. */
  async sync(url: string, fetchTime: (url: string) => Promise<number>) {
    const sentAt = performance.now();
    try {
      const serverNow = await fetchTime(url);
      this.add({ sentAt, receivedAt: performance.now(), serverNow });
    } catch {
      // offline: the device clock (or the last offset) carries on
    }
  }
}

// Kept as server − device clock, so a cold start from the cache is right away.
function loadStoredOffset(): number | null {
  try {
    const value = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function storeOffset(value: number) {
  try {
    localStorage.setItem(STORAGE_KEY, String(Math.round(value)));
  } catch {
    // no storage: the next start just begins with the device clock
  }
}
