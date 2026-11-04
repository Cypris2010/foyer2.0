import { describe, expect, it } from 'vitest';
import { json, PASSWORD, setup } from './helpers.ts';
import { maskPath } from '../apps/server/src/app.ts';

describe('Player-Zugang', () => {
  it('liefert das Manifest mit gültigem Token aus dem Schulnetz', async () => {
    const { app, token } = await setup();
    const res = await app.request(`/api/player/${token}/manifest`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const manifest = await res.json();
    expect(manifest.display.name).toBe('Aula');
    expect(manifest.slides.map((s: any) => s.id)).toEqual(['s-text', 's-html']);
    expect(manifest.slides[0].data.qrSvg).toContain('<svg');
    expect(manifest.slides[1].documentUrl).toMatch(/^\/content\/slides\/s-html\/\d+\?d=d1&s=/);
  });

  it('meldet den nächsten Wechsel aus Slide-Fenstern', async () => {
    const { app, token, now } = await setup();
    const manifest = await (await app.request(`/api/player/${token}/manifest`)).json();
    expect(manifest.nextChange).toBe(new Date(now + 3600_000).toISOString());
  });

  it('lehnt unbekannte Tokens ab', async () => {
    const { app } = await setup();
    expect((await app.request('/api/player/falsch/manifest')).status).toBe(403);
  });

  it('lehnt gültige Tokens aus fremden Netzen ab', async () => {
    const { app, token } = await setup();
    const res = await app.request(`/api/player/${token}/manifest`, { headers: { 'x-test-remote': '8.8.8.8' } });
    expect(res.status).toBe(403);
  });

  it('ignoriert X-Forwarded-For von nicht vertrauenswürdigen Absendern', async () => {
    const { app, token } = await setup();
    const res = await app.request(`/api/player/${token}/manifest`, {
      headers: { 'x-test-remote': '8.8.8.8', 'x-forwarded-for': '10.0.0.5' },
    });
    expect(res.status).toBe(403);
  });

  it('nutzt X-Forwarded-For hinter dem vertrauenswürdigen Proxy', async () => {
    const { app, token } = await setup();
    const outside = await app.request(`/api/player/${token}/manifest`, {
      headers: { 'x-test-remote': '127.0.0.1', 'x-forwarded-for': '8.8.8.8' },
    });
    expect(outside.status).toBe(403);
    const inside = await app.request(`/api/player/${token}/manifest`, {
      headers: { 'x-test-remote': '127.0.0.1', 'x-forwarded-for': '10.0.0.5' },
    });
    expect(inside.status).toBe(200);
  });

  it('beachtet die Netzbeschränkung pro Display', async () => {
    const { app, db, token } = await setup();
    db.prepare("UPDATE displays SET networks = '10.9.0.0/16' WHERE id = 'd1'").run();
    expect((await app.request(`/api/player/${token}/manifest`)).status).toBe(403);
    const ok = await app.request(`/api/player/${token}/manifest`, { headers: { 'x-test-remote': '10.9.1.1' } });
    expect(ok.status).toBe(200);
  });

  it('macht das alte Token nach Rotation ungültig', async () => {
    const { app, token, loginAs } = await setup();
    const cookie = await loginAs('admin');
    const res = await app.request('/api/displays/d1/rotate-token', json('POST', {}, cookie));
    const { token: fresh } = await res.json();
    expect((await app.request(`/api/player/${token}/manifest`)).status).toBe(403);
    expect((await app.request(`/api/player/${fresh}/manifest`)).status).toBe(200);
  });

  it('zeigt Displays erst nach einem Lebenszeichen als online', async () => {
    const { app, token, loginAs } = await setup();
    const cookie = await loginAs('viewer');
    const before = await (await app.request('/api/displays', { headers: { cookie } })).json();
    expect(before[0].state).toBe('never');
    await app.request(`/api/player/${token}/heartbeat`, json('POST', { version: null, slideId: null }));
    const after = await (await app.request('/api/displays', { headers: { cookie } })).json();
    expect(after[0].state).toBe('online');
  });

  it('nimmt Heartbeats an und speichert den Status', async () => {
    const { app, db, token } = await setup();
    const res = await app.request(`/api/player/${token}/heartbeat`, json('POST', { version: 'abc', slideId: 's-text', errors: [] }));
    expect(res.status).toBe(200);
    const row = db.prepare("SELECT last_seen_at, status_json FROM displays WHERE id = 'd1'").get() as any;
    expect(JSON.parse(row.status_json).slideId).toBe('s-text');
  });

  it('schreibt keine Tokens ins Log', () => {
    expect(maskPath('/p/abc123')).toBe('/p/***');
    expect(maskPath('/api/player/abc123/manifest')).toBe('/api/player/***/manifest');
    expect(maskPath('/p/preview/slide-1')).toBe('/p/preview/slide-1');
  });
});

describe('HTML-Folien-Dokument', () => {
  it('liefert das Dokument mit eigener CSP nur mit gültiger Signatur', async () => {
    const { app, token } = await setup();
    const manifest = await (await app.request(`/api/player/${token}/manifest`)).json();
    const url: string = manifest.slides[1].documentUrl;
    const res = await app.request(url);
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    const html = await res.text();
    expect(html).toContain('<h1>Aula</h1>');
    expect(html).toContain('var x = "<\\/script>";');
    expect(html).toContain('window.foyer');

    expect((await app.request(url.replace(/s=[^&]+/, 's=falsch'))).status).toBe(403);
    expect((await app.request(url.replace(/\/(\d+)\?/, '/1?'))).status).toBe(403);
  });

  it('verweigert Displays außerhalb des Schulnetzes das Dokument', async () => {
    const { app, token } = await setup();
    const manifest = await (await app.request(`/api/player/${token}/manifest`)).json();
    const res = await app.request(manifest.slides[1].documentUrl, { headers: { 'x-test-remote': '8.8.8.8' } });
    expect(res.status).toBe(403);
  });
});

describe('Admin-Zugang', () => {
  it('verlangt eine Anmeldung', async () => {
    const { app } = await setup();
    for (const path of ['/api/slides', '/api/displays', '/api/channels', '/api/slide-types', '/api/users']) {
      expect((await app.request(path)).status, path).toBe(401);
    }
  });

  it('setzt ein sicheres Session-Cookie', async () => {
    const { app } = await setup();
    const res = await app.request('/api/auth/login', json('POST', { email: 'admin@schule.de', password: PASSWORD }));
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
  });

  it('lehnt falsche Passwörter ab', async () => {
    const { app } = await setup();
    const res = await app.request('/api/auth/login', json('POST', { email: 'admin@schule.de', password: 'falsch' }));
    expect(res.status).toBe(401);
  });

  it('bremst Login-Versuche pro IP', async () => {
    const { app } = await setup();
    let last = 0;
    for (let i = 0; i < 21; i++) {
      last = (await app.request('/api/auth/login', json('POST', { email: 'x@schule.de', password: 'falsch' }))).status;
    }
    expect(last).toBe(429);
  });

  it('sperrt ein Konto nach 10 Fehlversuchen', async () => {
    const { app } = await setup();
    for (let i = 0; i < 10; i++) {
      await app.request('/api/auth/login', { ...json('POST', { email: 'editor@schule.de', password: 'falsch' }), headers: { 'content-type': 'application/json', 'x-test-remote': `10.0.0.${i + 10}` } });
    }
    const res = await app.request('/api/auth/login', { ...json('POST', { email: 'editor@schule.de', password: PASSWORD }), headers: { 'content-type': 'application/json', 'x-test-remote': '10.0.1.1' } });
    expect(res.status).toBe(429);
  });

  it('blockiert Cross-Site-Anfragen', async () => {
    const { app, loginAs } = await setup();
    const cookie = await loginAs('admin');
    const res = await app.request('/api/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site', cookie },
      body: JSON.stringify({ name: 'Böse' }),
    });
    expect(res.status).toBe(403);
  });

  it('erlaubt HTML-Folien nur Admins', async () => {
    const { app, loginAs } = await setup();
    const slide = { title: 'Animation', type: 'html', config: { html: '<p>hi</p>' } };
    expect((await app.request('/api/slides', json('POST', slide, await loginAs('editor')))).status).toBe(403);
    expect((await app.request('/api/slides', json('POST', slide, await loginAs('admin')))).status).toBe(201);
  });

  it('erlaubt Lesern keine Änderungen', async () => {
    const { app, loginAs } = await setup();
    const cookie = await loginAs('viewer');
    expect((await app.request('/api/slides', { headers: { cookie } })).status).toBe(200);
    expect((await app.request('/api/slides', json('POST', { title: 'x', type: 'text', config: {} }, cookie))).status).toBe(403);
  });

  it('validiert Folien-Konfigurationen gegen das Schema', async () => {
    const { app, loginAs } = await setup();
    const cookie = await loginAs('editor');
    const bad = await app.request('/api/slides', json('POST', { title: 'x', type: 'text', config: { qrUrl: 'kein-link' } }, cookie));
    expect(bad.status).toBe(400);
    const good = await app.request('/api/slides', json('POST', { title: 'x', type: 'text', config: { title: 'Hallo' } }, cookie));
    expect(good.status).toBe(201);
  });

  it('gibt die Player-URL nicht in der Display-Liste aus', async () => {
    const { app, loginAs } = await setup();
    const cookie = await loginAs('admin');
    const created = await (await app.request('/api/displays', json('POST', { name: 'Flur' }, cookie))).json();
    expect(created.token).toHaveLength(43);
    const list = await (await app.request('/api/displays', { headers: { cookie } })).json();
    expect(JSON.stringify(list)).not.toContain(created.token);
  });

  it('lässt Admins die Player-URL jederzeit wieder abrufen und protokolliert es', async () => {
    const { app, db, loginAs } = await setup();
    const cookie = await loginAs('admin');
    const created = await (await app.request('/api/displays', json('POST', { name: 'Flur' }, cookie))).json();
    const revealed = await (await app.request(`/api/displays/${created.id}/reveal-url`, json('POST', {}, cookie))).json();
    expect(revealed.playerPath).toBe(created.playerPath);
    const logged = db.prepare("SELECT user_id FROM audit_log WHERE action = 'reveal-url'").get() as any;
    expect(logged.user_id).toBe('admin');
  });

  it('liefert nach Rotation die neue URL', async () => {
    const { app, loginAs } = await setup();
    const cookie = await loginAs('admin');
    const created = await (await app.request('/api/displays', json('POST', { name: 'Flur' }, cookie))).json();
    const rotated = await (await app.request(`/api/displays/${created.id}/rotate-token`, json('POST', {}, cookie))).json();
    const revealed = await (await app.request(`/api/displays/${created.id}/reveal-url`, json('POST', {}, cookie))).json();
    expect(revealed.playerPath).toBe(rotated.playerPath);
  });

  it('zeigt die Player-URL nur Admins', async () => {
    const { app, loginAs } = await setup();
    const res = await app.request('/api/displays/d1/reveal-url', json('POST', {}, await loginAs('editor')));
    expect(res.status).toBe(403);
  });

  it('speichert das Token nicht im Klartext', async () => {
    const { app, db, loginAs } = await setup();
    const cookie = await loginAs('admin');
    const created = await (await app.request('/api/displays', json('POST', { name: 'Flur' }, cookie))).json();
    const row = db.prepare('SELECT * FROM displays WHERE id = ?').get(created.id);
    expect(JSON.stringify(row)).not.toContain(created.token);
  });

  it('meldet alte Displays ohne gespeicherte URL verständlich', async () => {
    const { app, loginAs } = await setup();
    const res = await app.request('/api/displays/d1/reveal-url', json('POST', {}, await loginAs('admin')));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('Neue URL');
  });

  it('protokolliert Änderungen im Audit-Log', async () => {
    const { app, db, loginAs } = await setup();
    const cookie = await loginAs('editor');
    await app.request('/api/channels', json('POST', { name: 'Neu' }, cookie));
    const row = db.prepare("SELECT * FROM audit_log WHERE action = 'create' AND entity = 'channel'").get() as any;
    expect(row.user_id).toBe('editor');
  });

  it('liefert JSON-Schemas der Folientypen für Formulare', async () => {
    const { app, loginAs } = await setup();
    const types = await (await app.request('/api/slide-types', { headers: { cookie: await loginAs('viewer') } })).json();
    const html = types.find((t: any) => t.id === 'html');
    expect(html.editRole).toBe('admin');
    expect(html.schema.properties.html.widget).toBe('code');
  });
});

describe('Ein Gerät pro Display', () => {
  const asDevice = (ip: string, session: string): RequestInit => ({ headers: { 'x-test-remote': ip, 'x-foyer-session': session } });

  it('weist ein zweites Gerät ab, solange das erste aktiv ist', async () => {
    const { app, token } = await setup();
    expect((await app.request(`/api/player/${token}/manifest`, asDevice('10.0.0.5', 'airtame'))).status).toBe(200);
    const second = await app.request(`/api/player/${token}/manifest`, asDevice('10.0.0.9', 'laptop'));
    expect(second.status).toBe(409);
    expect((await second.json()).code).toBe('display-busy');
    expect((await app.request(`/api/player/${token}/manifest`, asDevice('10.0.0.5', 'airtame'))).status).toBe(200);
  });

  it('lässt dasselbe Gerät nach einem Neuladen sofort wieder rein', async () => {
    const { app, token } = await setup();
    await app.request(`/api/player/${token}/manifest`, asDevice('10.0.0.5', 'vor-dem-reload'));
    expect((await app.request(`/api/player/${token}/manifest`, asDevice('10.0.0.5', 'nach-dem-reload'))).status).toBe(200);
    // Danach hält die neue Sitzung das Display.
    expect((await app.request(`/api/player/${token}/manifest`, asDevice('10.0.0.9', 'laptop'))).status).toBe(409);
  });

  it('gibt das Display frei, wenn das Gerät 90 s still ist', async () => {
    const { app, token, advance } = await setup();
    await app.request(`/api/player/${token}/manifest`, asDevice('10.0.0.5', 'airtame'));
    advance(89_000);
    expect((await app.request(`/api/player/${token}/manifest`, asDevice('10.0.0.9', 'laptop'))).status).toBe(409);
    advance(2_000);
    expect((await app.request(`/api/player/${token}/manifest`, asDevice('10.0.0.9', 'laptop'))).status).toBe(200);
  });

  it('lässt Admins das Gerät freigeben und benachrichtigt es', async () => {
    const { app, ctx, token, loginAs } = await setup();
    await app.request(`/api/player/${token}/manifest`, asDevice('10.0.0.5', 'airtame'));
    const received: string[] = [];
    ctx.events.subscribe('d1', (event) => received.push(event));
    expect((await app.request('/api/displays/d1/release', json('POST', {}, await loginAs('editor')))).status).toBe(403);
    expect((await app.request('/api/displays/d1/release', json('POST', {}, await loginAs('admin')))).status).toBe(200);
    expect(received).toContain('released');
    expect((await app.request(`/api/player/${token}/manifest`, asDevice('10.0.0.9', 'laptop'))).status).toBe(200);
  });

  it('zeigt im Admin, welches Gerät das Display hält', async () => {
    const { app, token, loginAs } = await setup();
    await app.request(`/api/player/${token}/manifest`, asDevice('10.0.0.5', 'airtame'));
    const list = await (await app.request('/api/displays', { headers: { cookie: await loginAs('viewer') } })).json();
    expect(list[0].device.ip).toBe('10.0.0.5');
  });
});

describe('Live-Vorschau', () => {
  it('folgt der Folie, die das Display meldet', async () => {
    const { app, ctx, token, loginAs } = await setup();
    const cookie = await loginAs('viewer');
    const seen: unknown[] = [];
    ctx.events.subscribe('watch:d1', (event, data) => event === 'now-playing' && seen.push(data));
    await app.request(`/api/player/${token}/now-playing`, json('POST', { slideId: 's-html', version: 'v1' }));
    expect(seen).toHaveLength(1);
    const preview = await (await app.request('/api/preview/displays/d1/manifest', { headers: { cookie } })).json();
    expect(preview.nowPlaying.slideId).toBe('s-html');
    // Vorschau-Dokumente sind als Vorschau signiert und aus jedem Netz abrufbar.
    expect(preview.slides[1].documentUrl).toContain('d=preview%3Ad1');
    const doc = await app.request(preview.slides[1].documentUrl, { headers: { 'x-test-remote': '8.8.8.8' } });
    expect(doc.status).toBe(200);
    expect(await doc.text()).toContain('<h1>Aula</h1>');
  });

  it('meldet ein Display ohne Lebenszeichen als offline', async () => {
    const { app, token, loginAs, advance } = await setup();
    await app.request(`/api/player/${token}/now-playing`, json('POST', { slideId: 's-text', version: 'v1' }));
    advance(120_000);
    const preview = await (await app.request('/api/preview/displays/d1/manifest', { headers: { cookie: await loginAs('viewer') } })).json();
    expect(preview.nowPlaying).toBeNull();
  });

  it('verlangt eine Admin-Anmeldung', async () => {
    const { app } = await setup();
    expect((await app.request('/api/preview/displays/d1/manifest')).status).toBe(401);
    expect((await app.request('/api/preview/displays/d1/events')).status).toBe(401);
  });
});
