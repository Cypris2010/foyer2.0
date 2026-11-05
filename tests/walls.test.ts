import { describe, expect, it } from 'vitest';
import { json, setup } from './helpers.ts';
import { wallGeometry } from '../apps/player/src/wall.ts';
import { wallCells } from '../apps/player/src/testpattern.ts';
import { TEST_PATTERNS } from '../packages/slide-sdk/src/test-patterns.ts';

// Aula (d1, aus helpers) plus ein zweites Display und eine Wand 1 × 2.
async function wallSetup() {
  const base = await setup();
  const { app, loginAs } = base;
  const admin = await loginAs('admin');
  const second = await (await app.request('/api/displays', json('POST', { name: 'Foyer', kind: 'screen' }, admin))).json();
  const wall = await (await app.request('/api/displays', json('POST', { name: 'Aula-Wand', kind: 'wall', rows: 1, cols: 2 }, admin))).json();
  const cells = (list: Array<[string, number, number]>) =>
    app.request(`/api/displays/${wall.id}/cells`, json('PUT', { cells: list.map(([displayId, row, col]) => ({ displayId, row, col })) }, admin));
  const manifestOf = async (token: string) => (await app.request(`/api/player/${token}/manifest`)).json();
  return { ...base, admin, wallId: wall.id as string, wall, second: second as { id: string; token: string }, cells, manifestOf };
}

describe('Display-Wand', () => {
  it('legt eine Wand ohne eigene Player-URL an', async () => {
    const { wall, app, admin } = await wallSetup();
    expect(wall.token).toBeUndefined();
    expect(wall.playerPath).toBeUndefined();
    const list = await (await app.request('/api/displays', { headers: { cookie: admin } })).json();
    const entry = list.find((d: any) => d.id === wall.id);
    expect(entry).toMatchObject({ kind: 'wall', wall: { rows: 1, cols: 2, bezel: 0, screens: 0 }, state: 'never' });
  });

  it('spielt auf jedem Teil den Inhalt der Wand mit seiner Position', async () => {
    const { app, admin, token, wallId, second, cells, manifestOf } = await wallSetup();
    // Die Wand zeigt den Channel, das Display selbst hat keinen mehr.
    await app.request(`/api/displays/${wallId}`, json('PATCH', { defaultChannelId: 'ch1', wallBezel: 40, soundAllowed: true }, admin));
    await app.request('/api/displays/d1', json('PATCH', { defaultChannelId: null }, admin));
    expect((await cells([['d1', 0, 0], [second.id, 0, 1]])).status).toBe(200);

    const left = await manifestOf(token);
    const right = await manifestOf(second.token);
    expect(left.slides.map((s: any) => s.id)).toEqual(['s-text', 's-html']);
    expect(right.slides.map((s: any) => s.id)).toEqual(left.slides.map((s: any) => s.id));
    expect(left.wall).toEqual({ id: wallId, name: 'Aula-Wand', rows: 1, cols: 2, row: 0, col: 0, bezel: 40, screen: 'Aula' });
    expect(right.wall).toMatchObject({ row: 0, col: 1, screen: 'Foyer' });
    // Ton nur auf dem ersten Bildschirm, sonst Echo.
    expect(left.display.soundAllowed).toBe(true);
    expect(right.display.soundAllowed).toBe(false);
  });

  it('prüft das Raster', async () => {
    const { cells, second, wallId, app, admin } = await wallSetup();
    expect((await cells([['d1', 0, 2]])).status).toBe(400);
    expect((await cells([['d1', 0, 0], [second.id, 0, 0]])).status).toBe(400);
    expect((await cells([['d1', 0, 0], ['d1', 0, 1]])).status).toBe(400);
    expect((await cells([[wallId, 0, 0]])).status).toBe(400);
    // Ein Display gehört höchstens zu einer Wand.
    const other = await (await app.request('/api/displays', json('POST', { name: 'Zweite Wand', kind: 'wall' }, admin))).json();
    await cells([['d1', 0, 0]]);
    const res = await app.request(`/api/displays/${other.id}/cells`, json('PUT', { cells: [{ displayId: 'd1', row: 0, col: 0 }] }, admin));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('Aula');
  });

  it('tauscht Displays zwischen Feldern', async () => {
    const { cells, second, token, manifestOf } = await wallSetup();
    await cells([['d1', 0, 0], [second.id, 0, 1]]);
    expect((await cells([['d1', 0, 1], [second.id, 0, 0]])).status).toBe(200);
    expect((await manifestOf(token)).wall.col).toBe(1);
  });

  it('gibt Displays frei, wenn das Raster kleiner wird oder die Wand verschwindet', async () => {
    const { app, admin, cells, second, wallId, token, manifestOf } = await wallSetup();
    await cells([['d1', 0, 0], [second.id, 0, 1]]);
    await app.request(`/api/displays/${wallId}`, json('PATCH', { wallCols: 1 }, admin));
    expect((await manifestOf(second.token)).wall).toBeNull();
    expect((await manifestOf(token)).wall).not.toBeNull();

    expect((await app.request(`/api/displays/${wallId}`, { method: 'DELETE', headers: { cookie: admin } })).status).toBe(200);
    const manifest = await manifestOf(token);
    expect(manifest.wall).toBeNull();
    // Wieder der eigene Channel des Displays.
    expect(manifest.slides.length).toBeGreaterThan(0);
  });

  it('gibt Befehle und Änderungen an alle Teile weiter', async () => {
    const { app, ctx, admin, cells, second, wallId } = await wallSetup();
    await cells([['d1', 0, 0], [second.id, 0, 1]]);
    const received: string[] = [];
    ctx.events.subscribe('d1', (event) => received.push(`d1:${event}`));
    ctx.events.subscribe(second.id, (event) => received.push(`second:${event}`));
    await app.request(`/api/displays/${wallId}/identify`, json('POST', {}, admin));
    await app.request(`/api/displays/${wallId}`, json('PATCH', { wallBezel: 12 }, admin));
    expect(received).toEqual(['d1:identify', 'second:identify', 'd1:manifest-changed', 'second:manifest-changed']);
  });

  it('lässt die Vorschau der Wand ihren Bildschirmen folgen', async () => {
    const { app, ctx, cells, token, wallId, loginAs } = await wallSetup();
    await cells([['d1', 0, 0]]);
    const seen: unknown[] = [];
    ctx.events.subscribe(`watch:${wallId}`, (event, data) => event === 'now-playing' && seen.push(data));
    await app.request(`/api/player/${token}/now-playing`, json('POST', { slideId: 's-html', version: 'v1' }));
    expect(seen).toHaveLength(1);
    const cookie = await loginAs('viewer');
    const preview = await (await app.request(`/api/preview/displays/${wallId}/manifest`, { headers: { cookie } })).json();
    expect(preview.nowPlaying.slideId).toBe('s-html');
    const list = await (await app.request('/api/displays', { headers: { cookie } })).json();
    expect(list.find((d: any) => d.id === wallId)).toMatchObject({ state: 'online', wall: { screens: 1, online: 1 } });
  });
});

describe('Wand-Zuschnitt', () => {
  const wall = { id: 'w', name: 'Wand', rows: 2, cols: 2, row: 1, col: 1, bezel: 20, screen: 'unten rechts' };

  it('legt das große Bild so, dass jeder Bildschirm seinen Teil zeigt', () => {
    expect(wallGeometry(wall, 1920, 1080)).toEqual({ width: 3860, height: 2180, x: -1940, y: -1100 });
    expect(wallGeometry({ ...wall, row: 0, col: 0 }, 1920, 1080)).toMatchObject({ x: -0, y: -0 });
    expect(wallGeometry({ ...wall, rows: 1, cols: 2, row: 0, col: 1, bezel: 0 }, 1920, 1080)).toEqual({ width: 3840, height: 1080, x: -1920, y: -0 });
  });
});

describe('Testbilder', () => {
  const step = (app: any, id: string, action: string, cookie: string) =>
    app.request(`/api/displays/${id}/test-pattern`, json('POST', { action }, cookie)).then((res: Response) => res.json());

  it('schaltet von Hand durch und endet nach 10 Minuten von selbst', async () => {
    const { app, loginAs, advance } = await setup();
    const editor = await loginAs('editor');
    expect((await step(app, 'd1', 'start', editor)).testPattern).toMatchObject({ index: 0, name: 'Gitter', count: TEST_PATTERNS.length });
    expect((await step(app, 'd1', 'next', editor)).testPattern.index).toBe(1);
    await step(app, 'd1', 'prev', editor);
    // Vor dem ersten kommt das letzte.
    expect((await step(app, 'd1', 'prev', editor)).testPattern.index).toBe(TEST_PATTERNS.length - 1);
    const list = async () => (await (await app.request('/api/displays', { headers: { cookie: editor } })).json())[0].testPattern;
    expect((await list()).name).toBe(TEST_PATTERNS.at(-1)!.name);
    advance(10 * 60_000 + 1);
    expect(await list()).toBeNull();
    expect((await step(app, 'd1', 'stop', editor)).testPattern).toBeNull();
    // Nur Redaktion und Admins
    expect((await app.request('/api/displays/d1/test-pattern', json('POST', { action: 'start' }, await loginAs('viewer')))).status).toBe(403);
  });

  it('gibt Testbilder der Wand an ihre Displays weiter', async () => {
    const { app, ctx, admin, cells, second, wallId } = await wallSetup();
    await cells([['d1', 0, 0], [second.id, 0, 1]]);
    const received: unknown[] = [];
    ctx.events.subscribe(second.id, (event, data) => event === 'test-pattern' && received.push(data));
    await step(app, wallId, 'start', admin);
    await step(app, wallId, 'stop', admin);
    expect(received).toEqual([{ index: 0, until: ctx.now() + 10 * 60_000 }, null]);
  });

  it('zeigt das Testbild nach einer Neuverbindung wieder', async () => {
    const { app, admin, cells, token, wallId } = await wallSetup();
    await cells([['d1', 0, 0]]);
    await step(app, wallId, 'start', admin);
    const res = await app.request(`/api/player/${token}/events`);
    const reader = res.body!.getReader();
    let text = '';
    while (!text.includes('test-pattern')) text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    expect(text).toContain('event: test-pattern');
    expect(text).toContain('"index":0');
  });
});

describe('Testbild-Raster', () => {
  it('kennt die Bildschirme der Wand samt Rahmen', () => {
    const cells = wallCells(3860, 1080, { id: 'w', name: 'Wand', rows: 1, cols: 2, row: 0, col: 1, bezel: 20, screen: 'rechts' });
    expect(cells).toEqual([
      { x: 0, y: 0, w: 1920, h: 1080, row: 0, col: 0 },
      { x: 1940, y: 0, w: 1920, h: 1080, row: 0, col: 1 },
    ]);
    expect(wallCells(1920, 1080, null)).toHaveLength(1);
  });
});
