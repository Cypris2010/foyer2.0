// Serves the built player and admin bundles.
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import type { Hono } from 'hono';

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.map': 'application/json',
};

async function fileResponse(file: string, cacheControl: string): Promise<Response | null> {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return null;
  return new Response(await readFile(file), {
    headers: { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream', 'Cache-Control': cacheControl },
  });
}

function inside(root: string, path: string): string | null {
  const file = join(root, normalize(path).replace(/^(\.\.[/\\])+/, ''));
  return file.startsWith(root) ? file : null;
}

const NOT_BUILT = (name: string) => new Response(`${name} ist nicht gebaut. Bitte "npm run build" ausführen.`, { status: 503 });

export function staticRoutes(playerDist: string, adminDist: string) {
  return (app: Hono<any>) => {
    // Hash-named build assets never change.
    app.get('/player/assets/*', async (c) => {
      const file = inside(playerDist, c.req.path.slice('/player'.length));
      return (file && (await fileResponse(file, 'public, max-age=31536000, immutable'))) || c.notFound();
    });
    // Player shell for real displays (/p/<token>) and admin previews (/p/preview/<slideId>).
    // It contains no data; the API checks token and network.
    app.get('/p/*', async () => (await fileResponse(join(playerDist, 'index.html'), 'no-store')) ?? NOT_BUILT('Player'));

    app.get('/admin/assets/*', async (c) => {
      const file = inside(adminDist, c.req.path.slice('/admin'.length));
      return (file && (await fileResponse(file, 'public, max-age=31536000, immutable'))) || c.notFound();
    });
    app.get('/admin/*', async () => (await fileResponse(join(adminDist, 'index.html'), 'no-store')) ?? NOT_BUILT('Admin'));
    app.get('/admin', (c) => c.redirect('/admin/'));
    app.get('/favicon.ico', (c) => c.body(null, 204));
    app.get('/', (c) => c.redirect('/admin/'));
  };
}
