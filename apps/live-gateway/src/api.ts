// HTTP API of the live gateway, for the Foyer server only (shared key). Foyer checks
// who may watch, then hands over the slide's source together with the WebRTC offer.
// The gateway registers the source on every call (idempotent), so a restart of
// either side loses nothing, and answers with MediaMTX's SDP. No dependencies, so
// the gateway image needs no npm install.
//
//   GET  /status                   { ndi: boolean }
//   GET  /ndi/sources?groups=a,b   [{ name, address }]
//   POST /whep                     { input: LiveInput, offer: SDP } → 201 SDP answer
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { LiveInput } from '@foyer/slide-sdk';
import { PROFILES } from './live.ts';
import type { NdiSource } from './ndi.ts';

export interface GatewayBackend {
  ndi: boolean;
  ensure(input: LiveInput): Promise<string>;
  whep(name: string, offer: string): Promise<{ status: number; sdp: string }>;
  ndiSources(groups: string[]): Promise<NdiSource[]>;
}

// Same rules as the live slide type (slide-types/live/index.ts); Foyer has checked them already.
const NDI_GROUP = /^[\p{L}\p{N} _.-]{1,100}$/u;
const STREAM_URL = /^(rtsps?|rtmps?|srt|udp|rtp|https?):\/\/\S+$/i;
const MAX_BODY = 128 * 1024;

/** The source from Foyer, or null: only what live slides can produce reaches ffmpeg. */
export function parseLiveInput(value: unknown): LiveInput | null {
  if (!value || typeof value !== 'object') return null;
  const { kind, value: source, groups, profile, audio } = value as Record<string, unknown>;
  if (kind !== 'ndi' && kind !== 'url') return null;
  if (typeof source !== 'string' || !source || source.length > 2000 || /[\0\r\n]/.test(source)) return null;
  if (kind === 'url' && !STREAM_URL.test(source)) return null;
  if (typeof profile !== 'string' || !Object.hasOwn(PROFILES, profile)) return null;
  if (typeof audio !== 'boolean') return null;
  if (groups !== undefined) {
    if (kind !== 'ndi' || !Array.isArray(groups) || groups.length > 20) return null;
    if (!groups.every((g) => typeof g === 'string' && NDI_GROUP.test(g))) return null;
  }
  return {
    kind,
    value: source,
    ...(groups?.length ? { groups: groups as string[] } : {}),
    profile: profile as LiveInput['profile'],
    audio,
  };
}

function digest(value: string) {
  return createHash('sha256').update(value).digest();
}

function send(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createGatewayServer(backend: GatewayBackend, key: string): Server {
  const expected = digest(`Bearer ${key}`);
  const authorized = (req: IncomingMessage) => timingSafeEqual(digest(req.headers.authorization ?? ''), expected);

  return createServer(async (req, res) => {
    try {
      if (!authorized(req)) return send(res, 401, 'Nicht erlaubt');
      const url = new URL(req.url ?? '/', 'http://gateway');

      if (req.method === 'GET' && url.pathname === '/status') {
        return send(res, 200, JSON.stringify({ ndi: backend.ndi }), 'application/json');
      }

      if (req.method === 'GET' && url.pathname === '/ndi/sources') {
        if (!backend.ndi) return send(res, 501, 'Das Live-Gateway hat keinen NDI-Eingang (siehe README, „NDI als Live-Quelle“)');
        const groups = (url.searchParams.get('groups') ?? '').split(',').map((g) => g.trim()).filter(Boolean);
        if (groups.length > 20 || !groups.every((g) => NDI_GROUP.test(g))) return send(res, 400, 'Ungültige NDI-Gruppen');
        return send(res, 200, JSON.stringify(await backend.ndiSources(groups)), 'application/json');
      }

      if (req.method === 'POST' && url.pathname === '/whep') {
        const text = await readBody(req);
        if (text === null) return send(res, 413, 'Anfrage zu groß');
        let body: { input?: unknown; offer?: unknown };
        try {
          body = JSON.parse(text);
        } catch {
          return send(res, 400, 'JSON erwartet');
        }
        const input = parseLiveInput(body.input);
        if (!input) return send(res, 400, 'Ungültige Live-Quelle');
        if (typeof body.offer !== 'string' || !body.offer || body.offer.length > 64_000) return send(res, 400, 'Ungültiges Angebot');
        const name = await backend.ensure(input);
        const answer = await backend.whep(name, body.offer);
        if (answer.status !== 201) return send(res, 502, `MediaMTX antwortet mit ${answer.status}`);
        return send(res, 201, answer.sdp, 'application/sdp');
      }

      send(res, 404, 'Nicht gefunden');
    } catch (err) {
      if (!res.headersSent) send(res, 502, (err as Error).message);
      else res.destroy();
    }
  });
}
