import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { json, setup } from './helpers.ts';
import { checkSourceUrl, clearUntisSources, distinctKeys, parseUntisText, toRows, TxtSource } from '../slide-types/_untis/source.ts';
import roomServer from '../slide-types/webuntis-room-display/server.ts';
import teacherServer from '../slide-types/teacher-dashboard/server.ts';
import { config as roomConfig } from '../slide-types/webuntis-room-display/index.ts';
import { config as teacherConfig } from '../slide-types/teacher-dashboard/index.ts';
import { buildManifest, refreshSlideData } from '../apps/server/src/manifest.ts';

// Anonymized copies of real exports (names, codes and texts replaced; times and status kept).
const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures/untis', name), 'utf8');
const ROOMS = fixture('raeume_ganzer_tag.txt');
const TEACHERS = fixture('lehrer.txt');
const ROOMS_URL = 'https://untis.example/raeume_ganzer_tag.txt';
const TEACHERS_URL = 'https://untis.example/lehrer.txt';
const ctx = { locale: 'de-DE', timeZone: 'Europe/Berlin', untisApi: null };

let files: Record<string, string>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearUntisSources();
  files = { [ROOMS_URL]: ROOMS, [TEACHERS_URL]: TEACHERS };
  fetchMock = vi.fn(async (url: string) =>
    url in files
      ? new Response(files[url], { headers: { 'last-modified': 'Wed, 04 Nov 2026 09:05:19 GMT' } })
      : new Response('nicht da', { status: 404 }),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Untis-TXT-Export', () => {
  it('liest alle Zeilen und lässt die Werte wie exportiert', () => {
    const lessons = parseUntisText(ROOMS);
    expect(lessons).toHaveLength(ROOMS.trim().split('\n').length);
    expect(lessons[0]).toEqual({
      key: 'A 1.01',
      start: '2026-11-04 07:45:00',
      end: '2026-11-04 08:30:00',
      rooms: 'A 1.01',
      teachers: 'LAAA',
      classes: '5a',
      subject: 'F01',
      status: 'None',
      type: 'Unterricht',
      substitutionText: '',
      bookingText: '',
    });
    // "-" rows (NoData) stay as they are: the old renderers show them so.
    const nodata = parseUntisText(TEACHERS).find((l) => l.status === 'NoData')!;
    expect([nodata.start, nodata.rooms, nodata.type]).toEqual(['-', '-', '-']);
    // Rows go back to the renderers in the column order of the file.
    expect(toRows([lessons[0]])[0].join('|')).toBe(ROOMS.split('\n')[0]);
  });

  it('überspringt Leerzeilen und zu kurze Zeilen', () => {
    expect(parseUntisText('\r\nA|1|2|3|4|5|6\r\n|a|b|c|d|e|f|g\r\nR 1|s|e|r|t|c|f|None\r\n')).toHaveLength(1);
  });

  it('sortiert Räume natürlich', () => {
    const lessons = parseUntisText('A 10|s|e|||||None\nA 2|s|e|||||None\nb 1|s|e|||||None\nA  2|s|e|||||None\n');
    expect(distinctKeys(lessons.map((l) => l.key))).toEqual(['A 2', 'A 10', 'b 1']);
  });

  it('erlaubt nur http- und https-Adressen', () => {
    expect(() => checkSourceUrl('file:///etc/passwd')).toThrow('Nur http');
    expect(() => checkSourceUrl('kein link')).toThrow('Keine gültige Adresse');
    expect(checkSourceUrl('https://untis.example/a.txt').href).toBe('https://untis.example/a.txt');
  });
});

describe('TXT-Quelle', () => {
  it('cacht, teilt gleichzeitige Abrufe und nimmt Last-Modified', async () => {
    let now = 1_000_000;
    const source = new TxtSource(ROOMS_URL, () => now);
    const [a, b] = await Promise.all([source.load(60_000), source.load(60_000)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(a.lastModified).toBe('2026-11-04T09:05:19.000Z');
    now += 30_000;
    await source.load(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now += 31_000;
    await source.load(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('zeigt bei Ausfall eine Stunde lang die letzten Daten, danach den Fehler', async () => {
    let now = 1_000_000;
    const source = new TxtSource(ROOMS_URL, () => now);
    const good = await source.load(60_000);
    delete files[ROOMS_URL];
    now += 10 * 60_000;
    expect(await source.load(60_000)).toBe(good);
    now += 60 * 60_000;
    await expect(source.load(60_000)).rejects.toThrow('HTTP 404');
  });

  it('meldet Netzwerkfehler ohne Details', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('getaddrinfo ENOTFOUND untis.example'));
    await expect(new TxtSource(ROOMS_URL).load(1000)).rejects.toThrow('Datenquelle nicht erreichbar (Netzwerkfehler)');
  });
});

describe('Raumanzeige (Server)', () => {
  it('liefert nur die Zeilen der gewählten Räume', async () => {
    const data = await roomServer.data!(roomConfig.parse({ source: ROOMS_URL, rooms: ['A 1.05', ' A  1.01 '] }), ctx);
    expect(data.error).toBeNull();
    expect(new Set(data.rows.map((r) => r[0]))).toEqual(new Set(['A 1.01', 'A 1.05']));
    expect(data.lastModified).toBe('2026-11-04T09:05:19.000Z');
  });

  it('meldet fehlende oder kaputte Quellen in der Folie statt zu werfen', async () => {
    expect((await roomServer.data!(roomConfig.parse({ rooms: ['A 1.01'] }), ctx)).error).toBe('Keine Datenquelle eingestellt');
    const broken = await roomServer.data!(roomConfig.parse({ source: 'https://untis.example/fehlt.txt', rooms: ['A 1.01'] }), ctx);
    expect(broken).toEqual({ rows: [], lastModified: null, error: 'Antwort der Datenquelle: HTTP 404' });
  });

  it('prüft die Konfiguration', () => {
    expect(roomConfig.safeParse({ refresh: 5 }).success).toBe(false);
    expect(roomConfig.safeParse({ source: 'ftp://untis.example/a.txt' }).success).toBe(false);
    expect(roomConfig.parse({})).toEqual({ title: '', source: '', rooms: [], refresh: 60, hideUpcoming: false, hideCurrent: false });
  });
});

describe('Lehrkräfte-Dashboard (Server)', () => {
  it('liefert ohne Auswahl alle Lehrkräfte, mit Auswahl nur diese', async () => {
    const all = await teacherServer.data!(teacherConfig.parse({ source: TEACHERS_URL }), ctx);
    expect(all.rows).toHaveLength(TEACHERS.trim().split('\n').length);
    const some = await teacherServer.data!(teacherConfig.parse({ source: TEACHERS_URL, teachers: ['LAAB', 'LAAC'] }), ctx);
    expect(new Set(some.rows.map((r) => r[0]))).toEqual(new Set(['LAAB', 'LAAC']));
  });

  it('zeigt ohne Quelle den Hinweis der alten Folie', async () => {
    expect(await teacherServer.data!(teacherConfig.parse({}), ctx)).toEqual({ rows: [], noSource: true, error: null });
  });
});

describe('Untis im Server', () => {
  it('liefert Auswahllisten für den Admin, Fehler der Quelle als 502', async () => {
    const { app, loginAs } = await setup();
    const cookie = await loginAs('editor');
    const list = (type: string, name: string, config: unknown) =>
      app.request(`/api/slide-types/${type}/options/${name}?config=${encodeURIComponent(JSON.stringify(config))}`, { headers: { cookie } });
    const rooms = await (await list('webuntis-room-display', 'rooms', { source: ROOMS_URL })).json();
    expect(rooms.slice(0, 3)).toEqual([
      { value: 'A 1.01', label: 'A 1.01' },
      { value: 'A 1.05', label: 'A 1.05' },
      { value: 'A 1.09', label: 'A 1.09' },
    ]);
    expect(await (await list('teacher-dashboard', 'teachers', {})).json()).toEqual([]);
    const failed = await list('teacher-dashboard', 'teachers', { source: 'https://untis.example/fehlt.txt' });
    expect(failed.status).toBe(502);
    expect((await app.request('/api/slide-types/teacher-dashboard/options/teachers?config=%7B', { headers: { cookie } })).status).toBe(400);
  });

  it('erkennt geänderte Daten und meldet sie den Playern', async () => {
    const { app, ctx: appCtx, db, loginAs, advance } = await setup();
    const cookie = await loginAs('editor');
    const res = await app.request('/api/slides', json('POST', { title: 'Räume', type: 'webuntis-room-display', config: { source: ROOMS_URL, rooms: ['A 1.01'], refresh: 30 }, background: null }, cookie));
    expect(res.status).toBe(201);
    const { id } = await res.json();
    db.prepare("INSERT INTO channel_slides (channel_id, slide_id, position) VALUES ('ch1', ?, 9)").run(id);
    db.prepare(
      `INSERT INTO schedules (id, scope, channel_id, content_kind, content_id, start_local, end_local, created_at, updated_at)
       VALUES ('plan-untis', 'channel', 'ch1', 'slide', ?, '2000-01-01T00:00', NULL, 0, 0)`,
    ).run(id);
    const display = db.prepare("SELECT * FROM displays WHERE id = 'd1'").get() as any;

    const first = await buildManifest(appCtx, display);
    const entry = first.slides.find((s) => s.id === id)!;
    // Personal data stays out of the manifest (players cache it offline).
    expect(entry.data).toBeNull();
    expect(JSON.stringify(first)).not.toContain('LAAA');
    expect(entry.dataUrl).toMatch(/^\/content\/data\//);
    // Fresh: nothing to do.
    expect(await refreshSlideData(appCtx)).toBe(false);
    // Expired, same file: no change.
    advance(31_000);
    clearUntisSources();
    expect(await refreshSlideData(appCtx)).toBe(false);
    // Expired, new lesson in the room: players are told.
    files[ROOMS_URL] = `${ROOMS}A 1.01|2026-11-04 20:00:00|2026-11-04 21:00:00|A 1.01|LAAA|5a|F01|None|Veranstaltung||\n`;
    advance(31_000);
    clearUntisSources();
    expect(await refreshSlideData(appCtx)).toBe(true);
    const second = await buildManifest(appCtx, display);
    expect(second.version).not.toBe(first.version);
  });

  it('liefert die Daten nur über die signierte URL, an Displays nur ins Schulnetz', async () => {
    const { app, ctx: appCtx, db, loginAs } = await setup();
    const cookie = await loginAs('editor');
    const res = await app.request('/api/slides', json('POST', { title: 'Lehrkräfte', type: 'teacher-dashboard', config: { source: TEACHERS_URL, teachers: ['LAAB'] }, background: null }, cookie));
    const { id } = await res.json();
    const row = db.prepare('SELECT * FROM slides WHERE id = ?').get(id) as any;
    const { buildSlideEntry } = await import('../apps/server/src/manifest.ts');
    const forDisplay = (await buildSlideEntry(appCtx, row, 10, 'd1'))!;
    const forPreview = (await buildSlideEntry(appCtx, row, 10, 'preview'))!;
    expect(forDisplay.data).toBeNull();

    const ok = await app.request(forDisplay.dataUrl!);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    const { data } = await ok.json();
    expect(new Set(data.rows.map((r: string[]) => r[0]))).toEqual(new Set(['LAAB']));
    // Outside the school networks, with a forged signature, or for another display: no data.
    expect((await app.request(forDisplay.dataUrl!, { headers: { 'x-test-remote': '203.0.113.9' } })).status).toBe(403);
    expect((await app.request(forDisplay.dataUrl!.replace(/s=[^&]+/, 's=00'))).status).toBe(403);
    expect((await app.request(forDisplay.dataUrl!.replace('d=d1', 'd=d2'))).status).toBe(403);
    // Admin previews: only with a session, from anywhere.
    expect((await app.request(forPreview.dataUrl!, { headers: { 'x-test-remote': '203.0.113.9' } })).status).toBe(403);
    expect((await app.request(forPreview.dataUrl!, { headers: { 'x-test-remote': '203.0.113.9', cookie } })).status).toBe(200);
    // An edited slide invalidates old URLs.
    db.prepare('UPDATE slides SET updated_at = updated_at + 1 WHERE id = ?').run(id);
    expect((await app.request(forDisplay.dataUrl!)).status).toBe(404);
  });
});
