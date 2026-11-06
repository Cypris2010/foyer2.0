import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { json, setup } from './helpers.ts';
import { fillMediaPlaceholders, mediaPlaceholderIds } from '../packages/slide-sdk/src/runtime.ts';

const FILE = `${'a'.repeat(64)}-img1.jpg`;

/** A converted image in the library, without ffmpeg: row plus file. */
async function withImage(status = 'ready', source: object | null = null) {
  const env = await setup();
  const { ctx, db, now } = env;
  db.prepare(
    `INSERT INTO media (id, sha256, kind, name, original_ext, size, width, height, variants_json, status, source_json, show_credit, created_at, updated_at)
     VALUES ('m1', 'sha', 'image', 'Schulhof.jpg', 'jpg', 3, 1920, 1080, ?, ?, ?, ?, ?, ?)`,
  ).run(JSON.stringify({ main: { file: FILE, width: 1920, height: 1080 } }), status, source ? JSON.stringify(source) : null, source ? 1 : 0, now, now);
  writeFileSync(join(ctx.media.filesDir, FILE), 'jpg');
  db.prepare("UPDATE slides SET config_json = ? WHERE id = 's-html'").run(
    JSON.stringify({ html: '<img src="{{media:m1}}">', css: '.x { background: url({{ media:m1 }}) }', js: 'var src = "{{media:m1}}";' }),
  );
  return env;
}

const htmlSlide = async (app: Awaited<ReturnType<typeof setup>>['app'], token: string) =>
  (await (await app.request(`/api/player/${token}/manifest`)).json()).slides.find((s: any) => s.id === 's-html');

describe('Medien in HTML-Folien', () => {
  it('findet und ersetzt {{media:ID}}', () => {
    expect(mediaPlaceholderIds('{{media:a}} {{ media:b-2 }} {{media:a}} {{date}}')).toEqual(['a', 'b-2']);
    expect(fillMediaPlaceholders('<img src="{{media:a}}"><img src="{{media:x}}">', (id) => (id === 'a' ? '/media/a.jpg' : null))).toBe('<img src="/media/a.jpg"><img src="">');
  });

  it('setzt signierte Adressen in HTML, CSS und JS ein und erlaubt sie per CSP', async () => {
    const { app, token } = await withImage();
    const slide = await htmlSlide(app, token);
    const doc = await app.request(slide.documentUrl);
    const html = await doc.text();
    const urls = html.match(/\/media\/[^"')\s]+/g)!;
    expect(urls).toHaveLength(3);
    expect(new Set(urls).size).toBe(1);
    expect(urls[0]).toMatch(new RegExp(`^/media/${FILE}\\?s=`));
    expect(doc.headers.get('content-security-policy')).toContain("img-src 'self'");
    // The sandbox sends no cookie: from outside the school network only the signature counts.
    expect((await app.request(urls[0], { headers: { 'x-test-remote': '8.8.8.8' } })).status).toBe(200);
    expect((await app.request(`/media/${FILE}?s=falsch`, { headers: { 'x-test-remote': '8.8.8.8' } })).status).toBe(403);
  });

  it('wartet auf die Umwandlung und zeigt den Bildnachweis', async () => {
    const source = { provider: 'wikimedia', id: 'File:x.jpg', title: 'Hof', author: 'Anna', license: 'CC BY 4.0', attribution: true, via: 'Wikimedia Commons', pageUrl: 'https://x' };
    const pending = await withImage('processing', source);
    expect(await htmlSlide(pending.app, pending.token)).toBeUndefined();
    const ready = await withImage('ready', source);
    const slide = await htmlSlide(ready.app, ready.token);
    expect(slide.credits).toEqual(['Foto: „Hof“, Anna · CC BY 4.0 · Wikimedia Commons']);
  });

  it('zählt Platzhalter als Verwendung und prüft sie beim Speichern', async () => {
    const { app, loginAs } = await withImage();
    const cookie = await loginAs('admin');
    const detail = await (await app.request('/api/media/m1', { headers: { cookie } })).json();
    expect(detail.usage.map((s: any) => s.id)).toEqual(['s-html']);
    expect((await app.request('/api/media/m1', json('DELETE', {}, cookie))).status).toBe(409);
    const bad = await app.request('/api/slides', json('POST', { title: 'x', type: 'html', config: { html: '<img src="{{media:gibtsnicht}}">' } }, cookie));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain('gibtsnicht');
  });
});
