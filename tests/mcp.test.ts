import { describe, expect, it } from 'vitest';
import { json, setup } from './helpers.ts';

async function withKey(role: string) {
  const env = await setup();
  const cookie = await env.loginAs(role);
  const res = await env.app.request('/api/api-keys', json('POST', { name: 'Claude' }, cookie));
  expect(res.status).toBe(201);
  const { key } = await res.json();
  let nextId = 1;
  const rpc = (method: string, params?: unknown, headers: Record<string, string> = {}) =>
    env.app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}`, ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
    });
  const tool = async (name: string, args: unknown = {}) => {
    const res = await rpc('tools/call', { name, arguments: args });
    expect(res.status).toBe(200);
    const { result } = await res.json();
    const text = result.content[0].text as string;
    return { isError: !!result.isError, text, data: result.isError ? null : JSON.parse(text) };
  };
  return { ...env, cookie, key, rpc, tool };
}

describe('API-Schlüssel', () => {
  it('meldet mit dem Schlüssel an der Admin-API an, mit den Rechten des Kontos', async () => {
    const { app, key } = await withKey('viewer');
    const auth = { authorization: `Bearer ${key}` };
    expect((await app.request('/api/slides', { headers: auth })).status).toBe(200);
    const create = await app.request('/api/slides', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x', type: 'text', config: {} }) });
    expect(create.status).toBe(403);
    expect((await app.request('/api/slides', { headers: { authorization: 'Bearer foyer_falsch' } })).status).toBe(401);
  });

  it('zeigt den Schlüssel nur einmal und lässt ihn widerrufen', async () => {
    const { app, cookie, key } = await withKey('editor');
    const list = await (await app.request('/api/api-keys', { headers: { cookie } })).json();
    expect(list).toHaveLength(1);
    expect(list[0].hint).toBe(`…${key.slice(-4)}`);
    expect(JSON.stringify(list)).not.toContain(key);
    expect((await app.request(`/api/api-keys/${list[0].id}`, json('DELETE', {}, cookie))).status).toBe(200);
    expect((await app.request('/api/slides', { headers: { authorization: `Bearer ${key}` } })).status).toBe(401);
  });

  it('erlaubt mit einem Schlüssel keine weiteren Schlüssel', async () => {
    const { app, key } = await withKey('admin');
    const res = await app.request('/api/api-keys', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: '{"name":"mehr"}' });
    expect(res.status).toBe(403);
  });

  it('entfernt die Schlüssel mit dem Konto', async () => {
    const { app, db, key } = await withKey('editor');
    db.prepare("DELETE FROM users WHERE id = 'editor'").run();
    expect((await app.request('/api/slides', { headers: { authorization: `Bearer ${key}` } })).status).toBe(401);
  });
});

describe('MCP', () => {
  it('verlangt einen gültigen Schlüssel', async () => {
    const { app } = await setup();
    const res = await app.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Bearer');
  });

  it('lehnt fremde Herkunft ab (DNS-Rebinding)', async () => {
    const { rpc } = await withKey('editor');
    expect((await rpc('ping', undefined, { origin: 'https://boese.example', host: 'foyer.schule.de' })).status).toBe(403);
  });

  it('handelt Version und Werkzeuge aus', async () => {
    const { rpc } = await withKey('editor');
    const init = await (await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })).json();
    expect(init.result.protocolVersion).toBe('2025-06-18');
    expect(init.result.capabilities.tools).toBeDefined();
    expect(init.result.instructions).toContain('create_schedule');
    const tools = (await (await rpc('tools/list')).json()).result.tools;
    expect(tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(['get_overview', 'create_slide', 'search_stock_media', 'import_stock_media', 'create_schedule']));
    for (const t of tools) expect(t.inputSchema.type).toBe('object');
    expect((await (await rpc('gibtsnicht')).json()).error.code).toBe(-32601);
  });

  it('beantwortet Benachrichtigungen ohne Inhalt', async () => {
    const { app, key } = await withKey('editor');
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    });
    expect(res.status).toBe(202);
  });

  it('legt eine Folie an, ändert sie und plant sie im Channel ein', async () => {
    const { tool, db, channelId } = await withKey('editor');
    const overview = await tool('get_overview');
    expect(overview.data.you.role).toBe('editor');
    expect(overview.data.channels.map((c: any) => c.id)).toContain(channelId);
    expect(overview.data.slideTypes.find((t: any) => t.id === 'html').youMayEdit).toBe(false);

    const type = await tool('get_slide_type', { type: 'text' });
    expect(type.data.configSchema.properties.title).toBeDefined();

    const created = await tool('create_slide', { title: 'Sommerfest', type: 'text', config: { title: 'Sommerfest', subtitle: 'Freitag, 15 Uhr' }, background: { kind: 'color', value: '#1e3a8a' } });
    expect(created.isError).toBe(false);
    const slideId = created.data.id;
    expect(created.data.previewUrl).toContain(`/p/preview/${slideId}`);
    const audit = db.prepare("SELECT user_id FROM audit_log WHERE entity = 'slide' AND entity_id = ?").get(slideId) as { user_id: string };
    expect(audit.user_id).toBe('editor');

    await tool('update_slide', { id: slideId, config: { subtitle: 'Freitag, 16 Uhr' } });
    const slide = await tool('get_slide', { id: slideId });
    expect(slide.data.config).toMatchObject({ title: 'Sommerfest', subtitle: 'Freitag, 16 Uhr' });

    const plan = await tool('create_schedule', { scope: 'channel', channelId, contentId: slideId, start: '2026-11-05T07:00', end: '2026-11-05T16:00', rrule: 'FREQ=DAILY;COUNT=3' });
    expect(plan.isError).toBe(false);
    expect(db.prepare('SELECT 1 FROM channel_slides WHERE channel_id = ? AND slide_id = ?').get(channelId, slideId)).toBeTruthy();
    const occurrences = await tool('list_schedules', { scope: 'channel', channelId });
    expect(occurrences.data.filter((o: any) => o.contentId === slideId).map((o: any) => o.start)).toEqual(['2026-11-05T07:00', '2026-11-06T07:00', '2026-11-07T07:00']);
  });

  it('meldet Fehler der API als Werkzeugfehler', async () => {
    const { tool } = await withKey('editor');
    const html = await tool('create_slide', { title: 'Code', type: 'html', config: { html: '<h1>x</h1>' } });
    expect(html.isError).toBe(true);
    expect(html.text).toContain('Admin-Rechte');
    const bad = await tool('create_schedule', { scope: 'channel', channelId: 'ch1', contentId: 's-text', start: 'morgen', end: null });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('start');
  });

  it('lässt Admins HTML-Folien anlegen', async () => {
    const { tool } = await withKey('admin');
    const html = await tool('create_slide', { title: 'Code', type: 'html', config: { html: '<h1>{{weekday}}</h1>', css: 'h1 { font-size: 10vmin }' } });
    expect(html.isError).toBe(false);
    const type = await tool('get_slide_type', { type: 'html' });
    expect(type.data.notes.join(' ')).toContain('foyer-active');
  });
});
