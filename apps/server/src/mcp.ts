// MCP server (Model Context Protocol, Streamable HTTP) at /mcp: AI assistants
// such as Claude create slides, pick media, search the image databases and
// plan slides. Stateless: every POST is one JSON-RPC message (or a batch)
// answered with JSON; there is no SSE stream and no session.
//
// Authentication with a personal API key (api-keys.ts). Each tool calls the
// admin API in-process with that key, so validation, roles (e.g. HTML slides
// for admins only), audit log and live updates are the same as in the admin.
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from './context.ts';
import type { AuthEnv, SessionUser } from './auth.ts';
import { apiKeyUser } from './api-keys.ts';
import { utcToLocal } from './schedule-engine.ts';

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const MAX_PREVIEWS = 6;
const PREVIEW_MAX_BYTES = 200_000;

type Api = (method: string, path: string, body?: unknown) => Promise<Response>;

interface ToolContext {
  api: Api;
  /** Like api, but throws ToolError on an error status and returns the JSON body. */
  call: <T = any>(method: string, path: string, body?: unknown) => Promise<T>;
  user: SessionUser;
  ctx: AppContext;
  /** Base URL of this server as the client sees it, for links. */
  origin: string;
}

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

interface Tool<S extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  input: S;
  readOnly?: boolean;
  destructive?: boolean;
  run: (args: z.infer<S>, t: ToolContext) => Promise<unknown>;
}

class ToolError extends Error {}

const tool = <S extends z.ZodObject>(t: Tool<S>) => t as unknown as Tool;

/** A result that is more than JSON, e.g. with preview images. */
class Rich {
  content: Content[];
  constructor(content: Content[]) {
    this.content = content;
  }
}

const local = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Format JJJJ-MM-TTTHH:MM');
const mediaKind = z.enum(['image', 'video']);

const INSTRUCTIONS = `Foyer ist die Digital-Signage-Software der Schule: Displays zeigen Folien aus Channels.

Ablauf:
1. get_overview: Channels, Displays, Folientypen, Bilddatenbanken und die aktuelle Schulzeit.
2. get_slide_type: Felder (JSON-Schema) und Hinweise eines Folientyps, bevor du eine Folie anlegst.
3. Bilder: list_media (Mediathek) oder search_stock_media + import_stock_media (freie Bilddatenbanken). Medien werden über ihre id eingebunden: als Hintergrund {"kind":"image","mediaId":"…","fit":"cover","dim":30}, in Medienfeldern der Folie oder in HTML-Folien mit {{media:<id>}}.
4. create_slide / update_slide. Das Ergebnis enthält einen Vorschau-Link für den Admin.
5. Planen mit create_schedule. Eine Folie läuft in einem Channel nur, solange sie dort einen Kalendereintrag hat (scope "channel"). Mit scope "display" kommt eine Folie oder ein ganzer Channel direkt auf bestimmte Displays.

Zeiten sind immer Schulzeit (Wanduhr der Schule) im Format JJJJ-MM-TTTHH:MM. Schreib Folientexte auf Deutsch, kurz und aus der Entfernung lesbar. Bildnachweise für lizenzpflichtige Bilder zeigen die Displays automatisch an.
Frag nach, bevor du Folien oder Kalendereinträge löschst oder fremde Folien änderst.`;

/** Hints per slide type that the JSON schema alone does not tell. */
const TYPE_NOTES: Record<string, string> = {
  html: `Freies HTML/CSS/JS in einer Sandbox (iframe), nur für Admins. Die Folie füllt den ganzen Bildschirm (meist 1920×1080, Hochformat möglich): Größen in vw/vh/vmin angeben, nicht in px.
- Platzhalter im HTML: {{date}}, {{time}}, {{weekday}}, {{display.name}} und eigene aus dem Feld "variables" (eine Zeile pro Wert: name=Wert).
- Animationen: <html> bekommt die Klasse "foyer-active", sobald die Folie sichtbar wird, z. B. ".foyer-active .titel { animation: … }". In JS: foyer.onStart(fn), foyer.onStop(fn), foyer.done() (mit durationMode "done").
- Medien aus der Mediathek: {{media:<id>}} wird zur Adresse der Datei, in HTML, CSS und JS, z. B. <img src="{{media:…}}">, <video src="{{media:…}}" autoplay muted loop playsinline> oder background-image: url({{media:…}}). Bilder dafür mit list_media oder search_stock_media + import_stock_media holen. Bildnachweise zeigen die Displays automatisch.
- Externe Ressourcen (Schriften, Bilder über https) nur mit allowExternal: true; sonst nur Mediathek und eingebettete Inhalte (data:-URLs, SVG, CSS-Verläufe). Netzwerkzugriffe aus JS (fetch) sind gesperrt.`,
  text: 'Gut für Ankündigungen: Dachzeile, Titel, Untertitel, Text, optional QR-Code. Platzhalter wie {{date}} und {{weekday}} gehen in den Texten. Hintergrund: Farbe, Bild oder Video aus der Mediathek (mit "dim" abdunkeln, damit Text lesbar bleibt).',
  video: 'Zeigt ein Video aus der Mediathek (Feld mit Medien-id). Ohne Dauer läuft die Folie so lange wie das Video.',
};

const slideSummary = (s: any) => ({ id: s.id, title: s.title, type: s.type, published: s.published, duration: s.duration, updatedAt: new Date(s.updatedAt).toISOString() });

const mediaSummary = (m: any) => ({
  id: m.id,
  name: m.name,
  kind: m.kind,
  status: m.status,
  width: m.width,
  height: m.height,
  duration: m.duration,
  credit: m.credit,
  usedBySlides: m.usageCount,
});

/** Fields of a slide type that hold a media id or a server option list. */
function fieldHints(schema: any): string[] {
  const hints: string[] = [];
  for (const [name, prop] of Object.entries<any>(schema?.properties ?? {})) {
    if (prop.widget === 'media') hints.push(`"${name}": id eines ${prop.accept === 'video' ? 'Videos' : 'Bildes'} aus der Mediathek`);
    if (prop.widget === 'options' || prop.widget === 'suggest') hints.push(`"${name}": Werte über get_field_options (type, field "${prop.options}")`);
  }
  return hints;
}

async function previewOf(t: ToolContext, url: string | null): Promise<Content | null> {
  if (!url) return null;
  // Library files come straight from the media library, search hits through the signed thumb route.
  const res = url.startsWith('/media/') ? await t.ctx.media.serve(url.slice('/media/'.length), undefined) : await t.api('GET', url.replace(/^\/api/, ''));
  if (!res?.ok) return null;
  const type = res.headers.get('content-type') ?? '';
  if (!/^image\/(jpeg|png|webp|gif)/.test(type)) return null;
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > PREVIEW_MAX_BYTES) return null;
  return { type: 'image', data: data.toString('base64'), mimeType: type.split(';')[0] };
}

const TOOLS: Tool[] = [
  tool({
    name: 'get_overview',
    title: 'Überblick',
    description: 'Überblick über Foyer: dein Konto und deine Rolle, Channels, Displays, Folientypen (mit benötigter Rolle), Bilddatenbanken und die aktuelle Schulzeit. Zuerst aufrufen.',
    input: z.object({}),
    readOnly: true,
    run: async (_args, t) => {
      const [channels, displays, types, sources] = await Promise.all([
        t.call('GET', '/channels'),
        t.call('GET', '/displays'),
        t.call('GET', '/slide-types'),
        t.call('GET', '/media-sources'),
      ]);
      const rank = { viewer: 0, editor: 1, admin: 2 } as const;
      return {
        you: { name: t.user.name, role: t.user.role },
        now: utcToLocal(t.ctx.now(), t.ctx.timeZone),
        timeZone: t.ctx.timeZone,
        channels: channels.map((c: any) => ({ id: c.id, name: c.name, slides: c.slideCount, published: c.published, defaultDuration: c.defaultDuration })),
        displays: displays.map((d: any) => ({
          id: d.id,
          name: d.name,
          kind: d.kind,
          defaultChannelId: d.defaultChannelId,
          state: d.state,
          showing: d.currentSlideTitle,
          orientation: d.orientation,
          ...(d.wallId ? { partOfWall: d.wallId } : {}),
        })),
        slideTypes: types.map((s: any) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          backgrounds: s.backgrounds,
          youMayEdit: rank[t.user.role] >= rank[s.editRole as keyof typeof rank],
        })),
        mediaSources: sources.map((s: any) => ({ id: s.id, name: s.name, kinds: s.kinds, ready: s.ready })),
      };
    },
  }),

  tool({
    name: 'get_slide_type',
    title: 'Folientyp',
    description: 'Felder eines Folientyps als JSON-Schema (das ist das Format von "config" bei create_slide) plus Hinweise zur Gestaltung.',
    input: z.object({ type: z.string().describe('id des Folientyps, z. B. "text" oder "html"') }),
    readOnly: true,
    run: async ({ type }, t) => {
      const types = await t.call('GET', '/slide-types');
      const found = types.find((s: any) => s.id === type);
      if (!found) throw new ToolError(`Unbekannter Folientyp "${type}". Vorhanden: ${types.map((s: any) => s.id).join(', ')}`);
      return {
        id: found.id,
        name: found.name,
        description: found.description,
        editRole: found.editRole,
        backgrounds: found.backgrounds,
        durationFromMedia: found.durationFromMedia,
        notes: [TYPE_NOTES[type], ...fieldHints(found.schema)].filter(Boolean),
        configSchema: found.schema,
      };
    },
  }),

  tool({
    name: 'get_field_options',
    title: 'Auswahlwerte',
    description: 'Mögliche Werte für ein Auswahlfeld eines Folientyps, die der Server liefert (z. B. Räume aus WebUntis oder Live-Quellen).',
    input: z.object({
      type: z.string(),
      field: z.string().describe('Name der Liste (aus get_slide_type, "options")'),
      config: z.record(z.string(), z.unknown()).default({}).describe('Bisher gewählte Werte der Folie, falls die Liste davon abhängt'),
    }),
    readOnly: true,
    run: ({ type, field, config }, t) =>
      t.call('GET', `/slide-types/${encodeURIComponent(type)}/options/${encodeURIComponent(field)}?${new URLSearchParams({ config: JSON.stringify(config) })}`),
  }),

  tool({
    name: 'list_slides',
    title: 'Folien auflisten',
    description: 'Vorhandene Folien, neueste zuerst. Optional nach Text im Titel oder Typ filtern.',
    input: z.object({ query: z.string().optional(), type: z.string().optional(), limit: z.number().int().min(1).max(200).default(50) }),
    readOnly: true,
    run: async ({ query, type, limit }, t) => {
      const slides: any[] = await t.call('GET', '/slides');
      const q = query?.toLowerCase();
      return slides.filter((s) => (!type || s.type === type) && (!q || s.title.toLowerCase().includes(q))).slice(0, limit).map(slideSummary);
    },
  }),

  tool({
    name: 'get_slide',
    title: 'Folie lesen',
    description: 'Eine Folie mit allen Feldern (config, Hintergrund, Dauer).',
    input: z.object({ id: z.string() }),
    readOnly: true,
    run: async ({ id }, t) => {
      const slide = await t.call('GET', `/slides/${encodeURIComponent(id)}`);
      return { ...slide, previewUrl: `${t.origin}/p/preview/${slide.id}` };
    },
  }),

  tool({
    name: 'create_slide',
    title: 'Folie anlegen',
    description:
      'Legt eine Folie an. "config" folgt dem JSON-Schema aus get_slide_type; fehlende Felder bekommen ihre Standardwerte. Die Folie läuft erst, wenn sie eingeplant ist (create_schedule).',
    input: z.object({
      title: z.string().min(1).max(300).describe('Name der Folie in der Verwaltung'),
      type: z.string(),
      config: z.record(z.string(), z.unknown()).default({}),
      background: z
        .record(z.string(), z.unknown())
        .nullable()
        .default(null)
        .describe('Nur bei Typen mit backgrounds: {"kind":"color","value":"#1e3a8a"}, {"kind":"image","mediaId":"…","fit":"cover","dim":0-80} oder {"kind":"video","mediaId":"…","dim":0-80}'),
      duration: z.number().int().min(1).max(86400).nullable().default(null).describe('Sekunden; null = Standard des Channels'),
      published: z.boolean().default(true),
    }),
    run: async (args, t) => {
      const { id } = await t.call('POST', '/slides', args);
      return { id, previewUrl: `${t.origin}/p/preview/${id}`, next: 'Mit create_schedule einplanen, damit die Folie läuft.' };
    },
  }),

  tool({
    name: 'update_slide',
    title: 'Folie ändern',
    description: 'Ändert eine Folie. Nur angegebene Angaben ändern sich; "config" wird mit der bisherigen config zusammengeführt (replaceConfig: true ersetzt sie ganz).',
    input: z.object({
      id: z.string(),
      title: z.string().min(1).max(300).optional(),
      config: z.record(z.string(), z.unknown()).optional(),
      replaceConfig: z.boolean().default(false),
      background: z.record(z.string(), z.unknown()).nullable().optional(),
      duration: z.number().int().min(1).max(86400).nullable().optional(),
      published: z.boolean().optional(),
    }),
    run: async ({ id, config, replaceConfig, ...changes }, t) => {
      const current = await t.call('GET', `/slides/${encodeURIComponent(id)}`);
      const next = {
        title: changes.title ?? current.title,
        type: current.type,
        config: config ? (replaceConfig ? config : { ...current.config, ...config }) : current.config,
        background: changes.background !== undefined ? changes.background : current.background,
        duration: changes.duration !== undefined ? changes.duration : current.duration,
        published: changes.published ?? current.published,
      };
      await t.call('PUT', `/slides/${encodeURIComponent(id)}`, next);
      return { id, previewUrl: `${t.origin}/p/preview/${id}` };
    },
  }),

  tool({
    name: 'delete_slide',
    title: 'Folie löschen',
    description: 'Löscht eine Folie mit allen Kalendereinträgen. Nicht rückgängig zu machen, vorher nachfragen.',
    input: z.object({ id: z.string() }),
    destructive: true,
    run: ({ id }, t) => t.call('DELETE', `/slides/${encodeURIComponent(id)}`),
  }),

  tool({
    name: 'list_media',
    title: 'Mediathek',
    description: 'Bilder und Videos der Mediathek, neueste zuerst. Mit previews: true kommen Vorschaubilder der ersten Treffer mit, damit du passende auswählen kannst.',
    input: z.object({
      kind: mediaKind.optional(),
      query: z.string().optional().describe('Text im Dateinamen'),
      limit: z.number().int().min(1).max(200).default(30),
      previews: z.boolean().default(false),
    }),
    readOnly: true,
    run: async ({ kind, query, limit, previews }, t) => {
      const items: any[] = await t.call('GET', `/media${kind ? `?kind=${kind}` : ''}`);
      const q = query?.toLowerCase();
      const found = items.filter((m) => !q || m.name.toLowerCase().includes(q)).slice(0, limit);
      if (!previews) return found.map(mediaSummary);
      const content: Content[] = [{ type: 'text', text: JSON.stringify(found.map(mediaSummary), null, 2) }];
      for (const m of found.slice(0, MAX_PREVIEWS)) {
        const image = await previewOf(t, m.thumb ?? m.poster);
        if (image) content.push({ type: 'text', text: `Vorschau ${m.id} (${m.name}):` }, image);
      }
      return new Rich(content);
    },
  }),

  tool({
    name: 'search_stock_media',
    title: 'Bilddatenbanken durchsuchen',
    description:
      'Sucht in den freien Bilddatenbanken der Schule (Wikimedia Commons, Openverse, Pixabay, Unsplash; siehe get_overview). Ohne source in allen eingerichteten, die die Art liefern. Mit previews: true (Standard) kommen Vorschaubilder der ersten Treffer mit. Einen Treffer übernimmst du mit import_stock_media. Suchbegriffe auf Englisch liefern meist mehr Treffer.',
    input: z.object({
      query: z.string().min(1).max(100),
      kind: mediaKind.default('image'),
      source: z.string().optional().describe('id der Bilddatenbank, z. B. "wikimedia"'),
      page: z.number().int().min(1).max(50).default(1),
      perSource: z.number().int().min(1).max(30).default(6),
      previews: z.boolean().default(true),
    }),
    readOnly: true,
    run: async ({ query, kind, source, page, perSource, previews }, t) => {
      const sources: any[] = await t.call('GET', '/media-sources');
      const targets = sources.filter((s) => (source ? s.id === source : s.ready) && s.kinds.includes(kind));
      if (!targets.length) throw new ToolError(source ? `Bilddatenbank "${source}" gibt es nicht oder sie liefert keine ${kind === 'video' ? 'Videos' : 'Bilder'}` : 'Keine Bilddatenbank eingerichtet');
      const params = (id: string) => `/media-sources/${id}/search?${new URLSearchParams({ q: query, kind, page: String(page) })}`;
      const results = await Promise.all(
        targets.map(async (s) => {
          try {
            const result = await t.call('GET', params(s.id));
            return { source: s.id, hits: result.hits.slice(0, perSource) as any[], hasMore: result.hasMore as boolean };
          } catch (err) {
            return { source: s.id, error: (err as Error).message, hits: [] as any[], hasMore: false };
          }
        }),
      );
      const listing = results.map((r) => ({
        source: r.source,
        ...('error' in r ? { error: r.error } : {}),
        hasMore: r.hasMore,
        hits: r.hits.map((h) => ({
          id: h.id,
          title: h.title,
          author: h.author,
          license: h.license,
          creditRequired: h.attribution,
          width: h.width,
          height: h.height,
          duration: h.duration,
          page: h.pageUrl,
          ...(h.mediaId ? { alreadyInLibrary: h.mediaId } : {}),
        })),
      }));
      const content: Content[] = [{ type: 'text', text: JSON.stringify(listing, null, 2) }];
      if (previews) {
        // Round robin over the sources, so every database shows up in the previews.
        const order = results.flatMap((r) => r.hits.map((h, i) => ({ i, source: r.source, hit: h }))).sort((a, b) => a.i - b.i);
        let shown = 0;
        for (const { source: sourceId, hit } of order) {
          if (shown >= MAX_PREVIEWS) break;
          const image = await previewOf(t, hit.thumb);
          if (!image) continue;
          content.push({ type: 'text', text: `Vorschau ${sourceId} ${hit.id}${hit.title ? ` („${hit.title}“)` : ''}:` }, image);
          shown++;
        }
      }
      return new Rich(content);
    },
  }),

  tool({
    name: 'import_stock_media',
    title: 'Bild übernehmen',
    description:
      'Übernimmt einen Treffer aus search_stock_media in die Mediathek (mit Urheber, Lizenz und Bildnachweis) und gibt die Medien-id zurück. Die Umwandlung läuft danach noch kurz weiter; die id kann man sofort in Folien verwenden.',
    input: z.object({ source: z.string(), id: z.string(), kind: mediaKind.default('image') }),
    run: async (args, t) => {
      const item = await t.call('POST', '/media/import', args);
      return { ...mediaSummary(item), alreadyInLibrary: item.existing };
    },
  }),

  tool({
    name: 'list_schedules',
    title: 'Kalender lesen',
    description:
      'Kalendereinträge in einem Zeitraum (Standard: die nächsten 14 Tage). scope "channel" mit channelId: wann Folien in diesem Channel laufen. scope "display": was direkt auf Displays geplant ist.',
    input: z.object({
      scope: z.enum(['channel', 'display']),
      channelId: z.string().optional(),
      from: local.optional(),
      to: local.optional(),
    }),
    readOnly: true,
    run: async ({ scope, channelId, from, to }, t) => {
      if (scope === 'channel' && !channelId) throw new ToolError('channelId fehlt');
      const now = t.ctx.now();
      const params = new URLSearchParams({
        scope,
        from: from ?? utcToLocal(now, t.ctx.timeZone),
        to: to ?? utcToLocal(now + 14 * 86400_000, t.ctx.timeZone),
        ...(channelId ? { channelId } : {}),
      });
      const occurrences: any[] = await t.call('GET', `/schedules?${params}`);
      return occurrences.map((o) => ({
        scheduleId: o.id,
        title: o.title,
        contentKind: o.contentKind,
        contentId: o.contentId,
        start: o.occStart,
        end: o.occEnd,
        rrule: o.rrule,
        exclusive: o.exclusive,
        ...(o.scope === 'display' ? { displayIds: o.displayIds } : {}),
      }));
    },
  }),

  tool({
    name: 'create_schedule',
    title: 'Einplanen',
    description: `Plant eine Folie oder einen Channel ein.
- scope "channel": die Folie (contentKind "slide") läuft im Channel channelId, solange der Eintrag gilt; sie wird dabei automatisch in den Channel aufgenommen. Das ist der normale Weg für neue Folien.
- scope "display": eine Folie oder ein ganzer Channel direkt auf den Displays displayIds. exclusive: true zeigt dort währenddessen nur diesen Inhalt.
end null = ohne Ende (nur ohne Wiederholung). Bei Wiederholung ist end das Ende des ersten Termins. rrule ist eine RRULE ohne DTSTART, z. B. "FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20261218T235900" oder "FREQ=DAILY;COUNT=5".`,
    input: z.object({
      scope: z.enum(['channel', 'display']),
      contentKind: z.enum(['slide', 'channel']).default('slide'),
      contentId: z.string().describe('id der Folie bzw. des Channels'),
      channelId: z.string().optional().describe('bei scope "channel"'),
      displayIds: z.array(z.string()).optional().describe('bei scope "display"'),
      start: local,
      end: local.nullable(),
      rrule: z.string().max(500).nullable().default(null),
      exclusive: z.boolean().default(false),
    }),
    run: async ({ channelId, displayIds, ...rest }, t) => {
      const { id } = await t.call('POST', '/schedules', { ...rest, channelId: channelId ?? null, displayIds: displayIds ?? [] });
      return { scheduleId: id };
    },
  }),

  tool({
    name: 'delete_schedule',
    title: 'Kalendereintrag löschen',
    description: 'Löscht einen Kalendereintrag (bei einer Serie alle Termine). Vorher nachfragen.',
    input: z.object({ scheduleId: z.string() }),
    destructive: true,
    run: ({ scheduleId }, t) => t.call('DELETE', `/schedules/${encodeURIComponent(scheduleId)}`),
  }),
];

const toolList = TOOLS.map((t) => {
  const { $schema: _schema, ...inputSchema } = z.toJSONSchema(t.input, { io: 'input' }) as Record<string, unknown>;
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema,
    annotations: { title: t.title, readOnlyHint: !!t.readOnly, destructiveHint: !!t.destructive, openWorldHint: t.name === 'search_stock_media' },
  };
});

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
}

const rpcError = (id: JsonRpcMessage['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

class RpcError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

async function callTool(name: string, args: unknown, t: ToolContext) {
  const found = TOOLS.find((x) => x.name === name);
  if (!found) return null;
  const parsed = found.input.safeParse(args ?? {});
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Ungültige Eingabe: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'Eingabe'}: ${i.message}`).join('; ')}` }], isError: true };
  }
  try {
    const result = await found.run(parsed.data, t);
    if (result instanceof Rich) return { content: result.content };
    return { content: [{ type: 'text', text: JSON.stringify(result ?? { ok: true }, null, 2) }] };
  } catch (err) {
    if (err instanceof ToolError) return { content: [{ type: 'text', text: err.message }], isError: true };
    throw err;
  }
}

async function handle(message: JsonRpcMessage, t: ToolContext) {
  const { method, params } = message;
  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'foyer', title: 'Foyer', version: '2.0.0' },
        instructions: INSTRUCTIONS,
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: toolList };
    case 'tools/call': {
      const result = await callTool(params?.name, params?.arguments, t);
      if (!result) throw new RpcError(-32602, `Unbekanntes Werkzeug: ${params?.name}`);
      return result;
    }
    default:
      throw new RpcError(-32601, `Unbekannte Methode: ${method}`);
  }
}

export function registerMcp(app: Hono<AuthEnv>, ctx: AppContext) {
  const { db } = ctx;

  app.on(['GET', 'DELETE'], '/mcp', (c) => c.json({ error: 'Nur POST (zustandslos, ohne SSE)' }, 405, { Allow: 'POST' }));

  app.post('/mcp', async (c) => {
    // DNS rebinding: a browser page must not reach the endpoint under another name.
    const origin = c.req.header('origin');
    const host = c.req.header('x-forwarded-host') ?? c.req.header('host');
    if (origin && new URL(origin).host !== host) return c.json(rpcError(null, -32000, 'Fremde Herkunft abgelehnt'), 403);
    const user = apiKeyUser(db, c.req.header('authorization'), ctx.now());
    if (!user) {
      return c.json(rpcError(null, -32001, 'API-Schlüssel fehlt oder ist ungültig (Admin → KI-Zugang)'), 401, { 'WWW-Authenticate': 'Bearer realm="foyer"' });
    }
    const body = await c.req.json().catch(() => undefined);
    if (body === undefined) return c.json(rpcError(null, -32700, 'Kein gültiges JSON'), 400);

    const tc = toolContext(app, c, user, ctx);
    const messages: JsonRpcMessage[] = Array.isArray(body) ? body : [body];
    const replies = [];
    for (const message of messages) {
      // Notifications and responses (no method or no id) get no answer.
      if (message?.id === undefined || message.id === null || typeof message.method !== 'string') continue;
      try {
        replies.push({ jsonrpc: '2.0', id: message.id, result: await handle(message, tc) });
      } catch (err) {
        if (!(err instanceof RpcError)) console.error('MCP:', err);
        replies.push(rpcError(message.id, err instanceof RpcError ? err.code : -32603, err instanceof RpcError ? err.message : 'Interner Fehler'));
      }
    }
    if (!replies.length) return c.body(null, 202);
    return c.json(Array.isArray(body) ? replies : replies[0]);
  });
}

function toolContext(app: Hono<AuthEnv>, c: Context<AuthEnv>, user: SessionUser, ctx: AppContext): ToolContext {
  const api: Api = (method, path, body) => {
    const headers = new Headers({ authorization: c.req.header('authorization') ?? '' });
    // Same client address as the MCP request (proxy chain, then socket via c.env).
    const forwarded = c.req.header('x-forwarded-for');
    if (forwarded) headers.set('x-forwarded-for', forwarded);
    if (body !== undefined) headers.set('content-type', 'application/json');
    const request = new Request(`http://foyer.internal/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return Promise.resolve(app.fetch(request, c.env));
  };
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await api(method, path, body);
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const issues = Array.isArray(data?.issues) ? `: ${data.issues.map((i: any) => `${(i.path ?? []).join('.') || 'Eingabe'} – ${i.message}`).join('; ')}` : '';
      throw new ToolError(`${data?.error ?? `HTTP ${res.status}`}${issues}`);
    }
    return data;
  };
  const proto = c.req.header('x-forwarded-proto') ?? new URL(c.req.url).protocol.replace(':', '');
  const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? new URL(c.req.url).host;
  return { api, call, user, ctx, origin: `${proto}://${host}` };
}
