// Client for the live gateway (apps/live-gateway, KONZEPT 6.5), which runs in its
// own container: MediaMTX, the NDI ffmpeg and the conversions live there. Foyer
// decides who may watch (app.ts) and passes the slide's source with the WebRTC
// offer; the media then flows from the gateway straight to the display.
import type { LiveInput } from '@foyer/slide-sdk';

export interface NdiSource {
  name: string;
  address: string;
}

export class LiveGateway {
  private url: string;
  private key: string;

  constructor(url: string, key: string) {
    this.url = url.replace(/\/+$/, '');
    this.key = key;
  }

  private async request(path: string, init: RequestInit & { timeout: number }): Promise<Response> {
    try {
      return await fetch(`${this.url}${path}`, {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${this.key}` },
        signal: AbortSignal.timeout(init.timeout),
      });
    } catch (err) {
      throw new Error(`Live-Gateway nicht erreichbar (${this.url}): ${(err as Error).message}`);
    }
  }

  private async check(res: Response): Promise<Response> {
    if (res.status === 401) throw new Error('Live-Gateway lehnt den Schlüssel ab (FOYER_LIVE_GATEWAY_KEY)');
    if (!res.ok) throw new Error((await res.text()).slice(0, 300) || `Live-Gateway: HTTP ${res.status}`);
    return res;
  }

  async status(): Promise<{ ndi: boolean }> {
    return (await this.check(await this.request('/status', { timeout: 5000 }))).json() as Promise<{ ndi: boolean }>;
  }

  /** NDI sources the gateway sees (in `groups`, else its default groups). */
  async ndiSources(groups: string[] = []): Promise<NdiSource[]> {
    const query = groups.length ? `?groups=${encodeURIComponent(groups.join(','))}` : '';
    return (await this.check(await this.request(`/ndi/sources${query}`, { timeout: 20_000 }))).json() as Promise<NdiSource[]>;
  }

  /** WHEP offer → answer; the gateway registers the source first (idempotent). */
  async whep(input: LiveInput, offer: string): Promise<string> {
    const res = await this.request('/whep', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, offer }),
      timeout: 30_000,
    });
    return (await this.check(res)).text();
  }
}
