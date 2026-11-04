import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { json, setup } from './helpers.ts';
import { ApiSource, clearUntisApi, localNow, roomLessons, teacherLessons, type ApiLesson } from '../slide-types/_untis/api.ts';
import { toRows } from '../slide-types/_untis/source.ts';
import roomServer from '../slide-types/webuntis-room-display/server.ts';
import teacherServer from '../slide-types/teacher-dashboard/server.ts';
import { config as roomConfig } from '../slide-types/webuntis-room-display/index.ts';
import { config as teacherConfig } from '../slide-types/teacher-dashboard/index.ts';
import { getSetting } from '../apps/server/src/db.ts';

const API = 'https://untis-api.example';
const KEY = 'wu_testschluessel1234';
const ctx = { locale: 'de-DE', timeZone: 'Europe/Berlin', untisApi: { url: API, key: KEY } };

const lesson = (over: Partial<ApiLesson>): ApiLesson => ({
  datum: '2026-11-04',
  beginn: '07:45:00',
  ende: '08:30:00',
  klassen: [{ name: '5a' }],
  lehrkraefte: [{ kuerzel: 'LAAA' }],
  lehrkraefte_original: [],
  faecher: [{ kuerzel: 'F01' }],
  raeume: [{ name: 'A 1.01' }],
  raeume_original: [],
  status: 'regulaer',
  art: 'unterricht',
  text: null,
  ...over,
});

// One day, made up in the shape of /v1/stunden.
const LESSONS: ApiLesson[] = [
  lesson({}),
  lesson({ beginn: '10:20', ende: '11:05' }),
  // Substitution with a room change: LABA holds it for LABB in A 1.17 instead of D 1.16.
  lesson({
    beginn: '10:20:00',
    ende: '11:05:00',
    klassen: [{ name: '10a' }, { name: '10b' }],
    lehrkraefte: [{ kuerzel: 'LABA' }],
    lehrkraefte_original: [{ kuerzel: 'LABB' }],
    faecher: [{ kuerzel: 'F10' }, { kuerzel: 'F11' }],
    raeume: [{ name: 'A 1.17' }],
    raeume_original: [{ name: 'D 1.16' }],
    status: 'geaendert',
    text: 'Vertretung',
  }),
  lesson({ beginn: '11:25:00', ende: '12:10:00', lehrkraefte: [{ kuerzel: 'LAAN' }], raeume: [{ name: 'C 1.07' }], status: 'entfall' }),
  lesson({ beginn: '09:35:00', ende: '10:00:00', klassen: [], lehrkraefte: [{ kuerzel: 'LAAN' }], faecher: [], raeume: [{ name: 'Hof' }], art: 'aufsicht' }),
  lesson({ beginn: '13:35:00', ende: '14:20:00', lehrkraefte: [{ kuerzel: 'LACK' }], raeume: [{ name: 'A 2.13' }], art: 'sprechstunde' }),
];

let stand: string;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearUntisApi();
  stand = '2026-11-04T09:00:00Z';
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get('authorization');
    if (auth !== `Bearer ${KEY}`) return Response.json({ detail: 'API-Schlüssel ungültig oder gesperrt.' }, { status: 401 });
    const { pathname, searchParams } = new URL(url);
    if (pathname === '/v1/stunden/stand') return Response.json({ stand });
    if (pathname === '/v1/stunden') return Response.json(LESSONS.filter((l) => l.datum === searchParams.get('von')));
    if (pathname === '/v1/raeume') return Response.json([{ id: 1, name: 'A 10' }, { id: 2, name: 'A 2' }, { id: 3, name: 'Hof' }]);
    if (pathname === '/v1/lehrkraefte') return Response.json({ detail: 'Schlüssel ohne Freigabe „stammdaten“.' }, { status: 403 });
    return new Response('nicht da', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const calls = (path: string) => fetchMock.mock.calls.filter(([url]) => new URL(url).pathname === path).length;

describe('WebUntis-API: Zeilen wie im TXT-Export', () => {
  it('Raumansicht: jede Stunde unter ihren Räumen, Änderungen in der alten Schreibweise', () => {
    const rows = toRows(roomLessons(LESSONS)).map((r) => r.join('|'));
    expect(rows[0]).toBe('A 1.01|2026-11-04 07:45:00|2026-11-04 08:30:00|A 1.01|LAAA|5a|F01|None|Unterricht||');
    // Like the export: under the new and the originally planned room.
    const moved = '|2026-11-04 10:20:00|2026-11-04 11:05:00|+A 1.17(D 1.16)|+LABA(LABB)|10a,10b|F10/F11|irregular|Unterricht|Vertretung|';
    expect(rows).toContain(`A 1.17${moved}`);
    expect(rows).toContain(`D 1.16${moved}`);
    expect(rows).toContain('C 1.07|2026-11-04 11:25:00|2026-11-04 12:10:00|C 1.07|LAAN|5a|F01|cancelled|Unterricht||');
    expect(rows).toContain('A 2.13|2026-11-04 13:35:00|2026-11-04 14:20:00|A 2.13|LACK|5a|F01|None|Sprechstunde||');
    // Duties do not occupy rooms.
    expect(rows.some((r) => r.startsWith('Hof|'))).toBe(false);
  });

  it('Lehrkräfte: aktuelle oder nächste Stunde, ohne Unterricht heute Keine Daten', () => {
    const rows = toRows(teacherLessons(LESSONS, ['LAZZ'], '2026-11-04 10:30:00'));
    const byTeacher = Object.fromEntries(rows.map((r) => [r[0], r.join('|')]));
    expect(byTeacher.LAAA).toBe('LAAA|2026-11-04 10:20:00|2026-11-04 11:05:00|A 1.01|LAAA|5a|F01|None|Unterricht||');
    expect(byTeacher.LABA).toContain('|+A 1.17(D 1.16)|+LABA(LABB)|');
    // Substituted: the lesson is the substitute's, not theirs.
    expect(byTeacher.LABB).toBeUndefined();
    // The duty is over, the next lesson is cancelled.
    expect(byTeacher.LAAN).toContain('|2026-11-04 11:25:00|');
    expect(byTeacher.LAAN).toContain('|cancelled|');
    expect(byTeacher.LACK).toContain('|2026-11-04 13:35:00|');
    // Selected, but no lessons today.
    expect(byTeacher.LAZZ).toBe('LAZZ|-|-|-|-|-|-|NoData|-|-|');
    expect(rows).toHaveLength(5);
  });

  it('Lehrkräfte: nach der letzten Stunde des Tages fertig (Gone)', () => {
    const status = (now: string) => Object.fromEntries(teacherLessons(LESSONS, ['LAZZ', 'LABB'], now).map((r) => [r.key, r.status]));
    expect(status('2026-11-04 12:00:00')).toEqual({ LAZZ: 'NoData', LABB: 'NoData', LAAA: 'Gone', LABA: 'Gone', LAAN: 'cancelled', LACK: 'None' });
    // The last lesson counts until its end, also when it is cancelled.
    expect(status('2026-11-04 12:10:00')).toMatchObject({ LAAN: 'Gone', LACK: 'None' });
    expect(status('2026-11-04 16:00:00')).toEqual({ LAZZ: 'NoData', LABB: 'NoData', LAAA: 'Gone', LABA: 'Gone', LAAN: 'Gone', LACK: 'Gone' });
  });

  it('rechnet „jetzt“ in der Zeitzone der Schule', () => {
    expect(localNow('Europe/Berlin', Date.parse('2026-11-04T23:30:00Z'))).toBe('2026-11-05 00:30:00');
  });
});

describe('WebUntis-API: Abruf', () => {
  it('schickt den Schlüssel, lädt die Stunden nur bei neuem Stand neu', async () => {
    let now = 1_000_000;
    const source = new ApiSource(`${API}/`, KEY, () => now);
    const [a, b] = await Promise.all([source.load('2026-11-04', 60_000), source.load('2026-11-04', 60_000)]);
    expect(a).toBe(b);
    expect(a.lessons).toHaveLength(LESSONS.length);
    expect(a.lastModified).toBe(stand);
    expect(calls('/v1/stunden')).toBe(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${API}/v1/stunden/stand`);

    now += 61_000;
    await source.load('2026-11-04', 60_000);
    expect([calls('/v1/stunden/stand'), calls('/v1/stunden')]).toEqual([2, 1]);

    now += 61_000;
    stand = '2026-11-04T09:10:00Z';
    expect((await source.load('2026-11-04', 60_000)).lastModified).toBe(stand);
    expect(calls('/v1/stunden')).toBe(2);
    // A new day is always fetched.
    await source.load('2026-11-05', 60_000);
    expect(calls('/v1/stunden')).toBe(3);
  });

  it('meldet abgelehnte Schlüssel mit dem Text der API', async () => {
    await expect(new ApiSource(API, 'wu_falsch').load('2026-11-04', 0)).rejects.toThrow(
      'Antwort der WebUntis-API: HTTP 401 – API-Schlüssel ungültig oder gesperrt.',
    );
  });

  it('fragt eine fehlende Freigabe nicht bei jedem Abruf erneut ab', async () => {
    const source = new ApiSource(API, KEY);
    await expect(source.teachers(60_000)).rejects.toThrow('HTTP 403');
    await expect(source.teachers(60_000)).rejects.toThrow('HTTP 403');
    expect(calls('/v1/lehrkraefte')).toBe(1);
  });
});

describe('WebUntis-Folien mit der API aus den Einstellungen', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-11-04T09:30:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('Raumanzeige: ohne eigene Quelle die API, nur die gewählten Räume', async () => {
    const data = await roomServer.data!(roomConfig.parse({ rooms: ['D 1.16'] }), ctx);
    expect(data.error).toBeNull();
    expect(data.lastModified).toBe(stand);
    expect(data.rows.map((r) => r[0])).toEqual(['D 1.16']);
    // Without settings: the old hint.
    expect((await roomServer.data!(roomConfig.parse({ rooms: ['A 1.01'] }), { ...ctx, untisApi: null })).error).toBe('Keine Datenquelle eingestellt');
    expect(await roomServer.options!.rooms({}, ctx)).toEqual([
      { value: 'A 2', label: 'A 2' },
      { value: 'A 10', label: 'A 10' },
      { value: 'Hof', label: 'Hof' },
    ]);
  });

  it('Lehrkräfte-Dashboard: Stand jetzt, ohne Freigabe „stammdaten“ die Lehrkräfte des Tages', async () => {
    const data = await teacherServer.data!(teacherConfig.parse({ teachers: ['LAAA', 'LABB'] }), ctx);
    expect(data.error).toBeNull();
    expect(data.rows.map((r) => [r[0], r[1], r[7]])).toEqual([
      ['LAAA', '2026-11-04 10:20:00', 'None'],
      ['LABB', '-', 'NoData'],
    ]);
    expect(await teacherServer.data!(teacherConfig.parse({}), { ...ctx, untisApi: null })).toEqual({ rows: [], noSource: true, error: null });
    expect((await teacherServer.options!.teachers({}, ctx)).map((o) => o.value)).toEqual(['LAAA', 'LAAN', 'LABA', 'LACK']);
  });

  it('eine eingetragene TXT-Adresse hat Vorrang', async () => {
    await roomServer.data!(roomConfig.parse({ source: 'https://untis.example/raeume.txt', rooms: ['A 1.01'] }), ctx);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['https://untis.example/raeume.txt']);
    // The API key never goes to another address.
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('authorization')).toBeNull();
  });
});

describe('Einstellungen: WebUntis-API', () => {
  it('nur Admins, der Schlüssel bleibt verschlüsselt und geht nie zurück', async () => {
    const { app, db, loginAs } = await setup();
    const editor = await loginAs('editor');
    expect((await app.request('/api/settings/untis-api', { headers: { cookie: editor } })).status).toBe(403);
    expect((await app.request('/api/settings/untis-api', json('PUT', { url: API, key: KEY }, editor))).status).toBe(403);

    const cookie = await loginAs('admin');
    expect(await (await app.request('/api/settings/untis-api', { headers: { cookie } })).json()).toEqual({ url: '', keySet: false, keyHint: null, keyUnreadable: false });
    expect((await app.request('/api/settings/untis-api', json('PUT', { url: 'ftp://x', key: KEY }, cookie))).status).toBe(400);

    const saved = await app.request('/api/settings/untis-api', json('PUT', { url: `${API}/`, key: KEY }, cookie));
    const state = await saved.json();
    expect(state).toEqual({ url: API, keySet: true, keyHint: '…1234', keyUnreadable: false });
    expect(JSON.stringify(state)).not.toContain(KEY);
    expect(getSetting(db, 'untis_api_key')).not.toContain(KEY);
    const logged = db.prepare("SELECT detail_json FROM audit_log WHERE entity = 'settings'").all() as Array<{ detail_json: string }>;
    expect(logged.map((l) => l.detail_json).join()).not.toContain(KEY);

    // Without a key the stored one stays; an empty key removes it.
    await app.request('/api/settings/untis-api', json('PUT', { url: API }, cookie));
    expect((await (await app.request('/api/settings/untis-api', { headers: { cookie } })).json()).keySet).toBe(true);
    await app.request('/api/settings/untis-api', json('PUT', { url: API, key: '' }, cookie));
    expect((await (await app.request('/api/settings/untis-api', { headers: { cookie } })).json()).keySet).toBe(false);
  });

  it('testet die Verbindung und gibt sie an die Folien weiter', async () => {
    const { app, loginAs } = await setup();
    const cookie = await loginAs('admin');
    expect((await app.request('/api/settings/untis-api/test', json('POST', {}, cookie))).status).toBe(400);
    await app.request('/api/settings/untis-api', json('PUT', { url: API, key: KEY }, cookie));

    const test = await (await app.request('/api/settings/untis-api/test', json('POST', {}, cookie))).json();
    expect(test.lessons.ok).toBe(true);
    expect(test.rooms).toEqual({ ok: true, count: 3 });
    expect(test.teachers).toEqual({ ok: false, error: 'Antwort der WebUntis-API: HTTP 403 – Schlüssel ohne Freigabe „stammdaten“.' });

    // The slide's room list now comes from the API.
    const editor = await loginAs('editor');
    const rooms = await app.request(`/api/slide-types/webuntis-room-display/options/rooms?config=${encodeURIComponent('{}')}`, { headers: { cookie: editor } });
    expect((await rooms.json()).map((o: { value: string }) => o.value)).toEqual(['A 2', 'A 10', 'Hof']);
  });
});
