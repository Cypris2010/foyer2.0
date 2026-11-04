import { describe, expect, it } from 'vitest';
import { json, setup } from './helpers.ts';
import { expand, localToUtc, utcToLocal } from '../apps/server/src/schedule-engine.ts';

const TZ = 'Europe/Berlin';

describe('Serien-Engine', () => {
  const spec = (over: object = {}) => ({
    startLocal: '2026-10-19T08:00',
    endLocal: '2026-10-19T09:00',
    rrule: 'FREQ=WEEKLY;BYDAY=MO,WE',
    exdates: [] as string[],
    overrides: {} as Record<string, { startLocal: string; endLocal: string }>,
    ...over,
  });
  const range = (from: string, to: string) => [localToUtc(from, TZ), localToUtc(to, TZ)] as const;

  it('hält die Uhrzeit über die Zeitumstellung (25.10.2026)', () => {
    const occ = expand(spec(), ...range('2026-10-19T00:00', '2026-11-01T00:00'), TZ);
    expect(occ.map((o) => o.startLocal)).toEqual(['2026-10-19T08:00', '2026-10-21T08:00', '2026-10-26T08:00', '2026-10-28T08:00']);
    // Vor der Umstellung UTC+2, danach UTC+1
    expect(new Date(occ[0].startUtc).toISOString()).toBe('2026-10-19T06:00:00.000Z');
    expect(new Date(occ[2].startUtc).toISOString()).toBe('2026-10-26T07:00:00.000Z');
  });

  it('zählt COUNT ab Serienbeginn, nicht ab dem Abfragefenster', () => {
    // wp-foyer zählte nur Termine im Fenster und lieferte so zu viele.
    const occ = expand(spec({ rrule: 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=3' }), ...range('2026-10-26T00:00', '2026-12-31T00:00'), TZ);
    expect(occ.map((o) => o.startLocal)).toEqual(['2026-10-26T08:00']);
  });

  it('beachtet UNTIL, Ausnahmen und verschobene Termine', () => {
    const occ = expand(
      spec({
        rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20261109T235900',
        exdates: ['2026-10-26T08:00'],
        overrides: { '2026-11-02T08:00': { startLocal: '2026-11-03T10:00', endLocal: '2026-11-03T11:00' } },
      }),
      ...range('2026-10-01T00:00', '2026-12-31T00:00'),
      TZ,
    );
    expect(occ.map((o) => [o.occId, o.startLocal])).toEqual([
      ['2026-10-19T08:00', '2026-10-19T08:00'],
      ['2026-11-02T08:00', '2026-11-03T10:00'],
      ['2026-11-09T08:00', '2026-11-09T08:00'],
    ]);
  });

  it('kennt "jeden 2. Dienstag im Monat"', () => {
    const occ = expand(
      spec({ startLocal: '2026-11-01T18:00', endLocal: '2026-11-01T20:00', rrule: 'FREQ=MONTHLY;BYDAY=+2TU' }),
      ...range('2026-11-01T00:00', '2027-01-31T00:00'),
      TZ,
    );
    expect(occ.map((o) => o.startLocal)).toEqual(['2026-11-10T18:00', '2026-12-08T18:00', '2027-01-12T18:00']);
  });

  it('behandelt unbefristete Einzeltermine', () => {
    const occ = expand(spec({ rrule: null, endLocal: null }), ...range('2030-01-01T00:00', '2030-01-02T00:00'), TZ);
    expect(occ).toHaveLength(1);
    expect(occ[0].endUtc).toBeNull();
  });
});

describe('Auflösung: was ein Display zeigt', () => {
  async function plan(app: any, cookie: string, body: object) {
    const res = await app.request('/api/schedules', json('POST', body, cookie));
    if (res.status !== 201) throw new Error(`plan: ${res.status} ${await res.text()}`);
    return (await res.json()).id as string;
  }
  const manifest = async (app: any, token: string) => (await app.request(`/api/player/${token}/manifest`)).json();

  it('zeigt Folien eines Channels nur mit Kalendertermin', async () => {
    const { app, db, token } = await setup();
    db.prepare("DELETE FROM schedules WHERE content_id = 's-html'").run();
    const m = await manifest(app, token);
    expect(m.slides.map((s: any) => s.id)).toEqual(['s-text']);
  });

  it('ersetzt den Standard-Channel durch einen geplanten Channel', async () => {
    const { app, db, token, now, local, loginAs } = await setup();
    const cookie = await loginAs('editor');
    db.prepare("INSERT INTO channels (id, name, created_at, updated_at) VALUES ('ch2', 'Mensa', ?, ?)").run(now, now);
    db.prepare("INSERT INTO slides (id, title, type, config_json, created_at, updated_at) VALUES ('s-mensa', 'Mensa', 'text', '{}', ?, ?)").run(now, now);
    await plan(app, cookie, { scope: 'channel', channelId: 'ch2', contentKind: 'slide', contentId: 's-mensa', start: '2000-01-01T00:00', end: null });
    await plan(app, cookie, { scope: 'display', contentKind: 'channel', contentId: 'ch2', displayIds: ['d1'], start: local(now - 600_000), end: local(now + 600_000) });
    const m = await manifest(app, token);
    expect(m.channel.name).toBe('Mensa');
    expect(m.slides.map((s: any) => s.id)).toEqual(['s-mensa']);
    expect(m.nextChange).toBe(new Date(now + 600_000).toISOString());
  });

  it('koppelt zwei gleichzeitig geplante Channels', async () => {
    const { app, db, token, now, local, loginAs } = await setup();
    const cookie = await loginAs('editor');
    db.prepare("INSERT INTO channels (id, name, created_at, updated_at) VALUES ('ch2', 'Mensa', ?, ?)").run(now, now);
    db.prepare("INSERT INTO slides (id, title, type, config_json, created_at, updated_at) VALUES ('s-mensa', 'Mensa', 'text', '{}', ?, ?)").run(now, now);
    await plan(app, cookie, { scope: 'channel', channelId: 'ch2', contentKind: 'slide', contentId: 's-mensa', start: '2000-01-01T00:00', end: null });
    await plan(app, cookie, { scope: 'display', contentKind: 'channel', contentId: 'ch1', displayIds: ['d1'], start: local(now - 3600_000), end: local(now + 3600_000) });
    await plan(app, cookie, { scope: 'display', contentKind: 'channel', contentId: 'ch2', displayIds: ['d1'], start: local(now - 600_000), end: local(now + 600_000) });
    const m = await manifest(app, token);
    expect(m.channel.name).toBe('Foyer + Mensa');
    expect(m.slides.map((s: any) => s.id)).toEqual(['s-text', 's-html', 's-mensa']);

    const list = await (await app.request(`/api/schedules?scope=display&from=${local(now - 86400_000)}&to=${local(now + 86400_000)}`, { headers: { cookie } })).json();
    expect(list.every((e: any) => e.overlaps)).toBe(true);
  });

  it('fügt eine geplante Einzelfolie zum laufenden Programm hinzu', async () => {
    const { app, db, token, now, local, loginAs } = await setup();
    db.prepare("INSERT INTO slides (id, title, type, config_json, created_at, updated_at) VALUES ('s-eltern', 'Elternabend', 'text', '{}', ?, ?)").run(now, now);
    await plan(app, await loginAs('editor'), { scope: 'display', contentKind: 'slide', contentId: 's-eltern', displayIds: ['d1'], start: local(now - 600_000), end: local(now + 600_000) });
    const m = await manifest(app, token);
    expect(m.slides.map((s: any) => s.id)).toEqual(['s-text', 's-html', 's-eltern']);
  });

  it('zeigt bei einem exklusiven Termin nur diesen Inhalt', async () => {
    const { app, db, token, now, local, loginAs } = await setup();
    db.prepare("INSERT INTO slides (id, title, type, config_json, created_at, updated_at) VALUES ('s-schluss', 'Schulschluss', 'text', '{}', ?, ?)").run(now, now);
    await plan(app, await loginAs('editor'), {
      scope: 'display', contentKind: 'slide', contentId: 's-schluss', displayIds: ['d1'], start: local(now - 600_000), end: local(now + 600_000), exclusive: true,
    });
    const m = await manifest(app, token);
    expect(m.slides.map((s: any) => s.id)).toEqual(['s-schluss']);
  });

  it('spielt eine Serie nur zu ihren Zeiten', async () => {
    const { app, db, token, loginAs, advance } = await setup(Date.parse('2026-11-04T07:30:00Z')); // Mi 08:30
    db.prepare("INSERT INTO slides (id, title, type, config_json, created_at, updated_at) VALUES ('s-mo', 'Montag', 'text', '{}', 0, 0)").run();
    await plan(app, await loginAs('editor'), {
      scope: 'channel', channelId: 'ch1', contentKind: 'slide', contentId: 's-mo', start: '2026-11-02T08:00', end: '2026-11-02T09:00', rrule: 'FREQ=WEEKLY;BYDAY=MO',
    });
    expect((await manifest(app, token)).slides.map((s: any) => s.id)).not.toContain('s-mo');
    advance(5 * 86400_000); // Mo 09.11. 08:30
    expect((await manifest(app, token)).slides.map((s: any) => s.id)).toContain('s-mo');
    void db;
  });
});

describe('Kalender-API', () => {
  it('lässt Leser nur ansehen', async () => {
    const { app, now, local, loginAs } = await setup();
    const cookie = await loginAs('viewer');
    expect((await app.request(`/api/schedules?scope=channel&channelId=ch1&from=${local(now)}&to=${local(now + 86400_000)}`, { headers: { cookie } })).status).toBe(200);
    const res = await app.request('/api/schedules', json('POST', { scope: 'channel', channelId: 'ch1', contentKind: 'slide', contentId: 's-text', start: local(now), end: null }, cookie));
    expect(res.status).toBe(403);
  });

  it('prüft Eingaben', async () => {
    const { app, loginAs } = await setup();
    const cookie = await loginAs('editor');
    const post = (body: object) => app.request('/api/schedules', json('POST', body, cookie));
    const base = { scope: 'display', contentKind: 'channel', contentId: 'ch1', displayIds: ['d1'] };
    expect((await post({ ...base, start: '2026-11-04T10:00', end: '2026-11-04T09:00' })).status).toBe(400);
    expect((await post({ ...base, start: '2026-11-04T10:00', end: null, rrule: 'FREQ=DAILY' })).status).toBe(400);
    expect((await post({ ...base, displayIds: [], start: '2026-11-04T10:00', end: '2026-11-04T11:00' })).status).toBe(400);
    expect((await post({ ...base, contentId: 'gibt-es-nicht', start: '2026-11-04T10:00', end: '2026-11-04T11:00' })).status).toBe(400);
    expect((await post({ ...base, start: '2026-11-04T10:00', end: '2026-11-04T11:00' })).status).toBe(201);
  });

  it('verschiebt und streicht einzelne Termine einer Serie', async () => {
    const { app, loginAs } = await setup();
    const cookie = await loginAs('editor');
    const created = await app.request(
      '/api/schedules',
      json('POST', { scope: 'display', contentKind: 'channel', contentId: 'ch1', displayIds: ['d1'], start: '2026-11-02T08:00', end: '2026-11-02T09:00', rrule: 'FREQ=DAILY;COUNT=3' }, cookie),
    );
    const { id } = await created.json();
    const occ = (occId: string) => `/api/schedules/${id}/occurrences/${encodeURIComponent(occId)}`;
    expect((await app.request(occ('2026-11-03T08:00'), json('PATCH', { start: '2026-11-03T12:00', end: '2026-11-03T13:00' }, cookie))).status).toBe(200);
    expect((await app.request(occ('2026-11-04T08:00'), { method: 'DELETE', headers: { cookie, 'sec-fetch-site': 'same-origin' } })).status).toBe(200);
    const list = await (await app.request('/api/schedules?scope=display&from=2026-11-01T00:00&to=2026-11-08T00:00', { headers: { cookie } })).json();
    expect(list.map((e: any) => e.occStart)).toEqual(['2026-11-02T08:00', '2026-11-03T12:00']);
  });

  it('nimmt eine im Channel geplante Folie in die Folienliste auf', async () => {
    const { app, db, now, local, loginAs } = await setup();
    db.prepare("INSERT INTO slides (id, title, type, config_json, created_at, updated_at) VALUES ('s-neu', 'Neu', 'text', '{}', ?, ?)").run(now, now);
    await app.request('/api/schedules', json('POST', { scope: 'channel', channelId: 'ch1', contentKind: 'slide', contentId: 's-neu', start: local(now), end: null }, await loginAs('editor')));
    expect(db.prepare("SELECT 1 FROM channel_slides WHERE channel_id = 'ch1' AND slide_id = 's-neu'").get()).toBeTruthy();
  });

  it('entfernt Termine mit der Folie aus dem Channel', async () => {
    const { app, db, loginAs } = await setup();
    await app.request('/api/channels/ch1/slides', json('PUT', [{ slideId: 's-text' }], await loginAs('editor')));
    const left = db.prepare("SELECT content_id FROM schedules WHERE scope = 'channel' AND channel_id = 'ch1'").all() as any[];
    expect(left.map((r) => r.content_id)).toEqual(['s-text']);
  });

  it('löscht Display-Termine mit ihrem Channel', async () => {
    const { app, db, loginAs } = await setup();
    const cookie = await loginAs('editor');
    await app.request('/api/schedules', json('POST', { scope: 'display', contentKind: 'channel', contentId: 'ch1', displayIds: ['d1'], start: '2026-11-04T10:00', end: '2026-11-04T11:00' }, cookie));
    await app.request('/api/channels/ch1', { method: 'DELETE', headers: { cookie, 'sec-fetch-site': 'same-origin' } });
    expect((db.prepare('SELECT COUNT(*) AS n FROM schedules').get() as any).n).toBe(0);
  });

  it('wandelt Zeiten in Schulzeit um', () => {
    expect(utcToLocal(Date.parse('2026-11-04T07:00:00Z'), TZ)).toBe('2026-11-04T08:00');
  });
});
