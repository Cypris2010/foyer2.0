// Standalone server for the Airtame device probe. No dependencies: serves the
// static probe page (with HTTP Range support for the test clips) and stores the
// JSON reports the page posts back.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';

const root = import.meta.dirname;
const publicDir = join(root, 'public');
const reportsDir = process.env.PROBE_REPORTS_DIR ?? join(root, 'reports');
const port = Number(process.env.PORT ?? 8090);
const maxReportBytes = 1024 * 1024;
// When set, reading reports requires ?key=<PROBE_KEY>; posting stays open so devices need no secret.
const reportsKey = process.env.PROBE_KEY;

const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.svg': 'image/svg+xml',
};

function send(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxReportBytes) throw new Error('report too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function saveReport(req: IncomingMessage, res: ServerResponse) {
  try {
    const report = JSON.parse(await readBody(req));
    const device = String(report?.device ?? 'unbekannt').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    report.receivedAt = new Date().toISOString();
    report.remoteAddress = req.socket.remoteAddress;
    await mkdir(reportsDir, { recursive: true });
    const file = `${stamp}_${device}_${randomUUID().slice(0, 8)}.json`;
    await writeFile(join(reportsDir, file), JSON.stringify(report, null, 2));
    send(res, 201, JSON.stringify({ ok: true, file }), mimeTypes['.json']);
  } catch (err) {
    send(res, 400, JSON.stringify({ ok: false, error: String(err) }), mimeTypes['.json']);
  }
}

async function listReports(): Promise<Array<Record<string, any>>> {
  const files = await readdir(reportsDir).catch(() => [] as string[]);
  const reports = [];
  for (const file of files.filter((f) => f.endsWith('.json')).sort().reverse()) {
    const data = JSON.parse(await readFile(join(reportsDir, file), 'utf8'));
    reports.push({ file, ...data });
  }
  return reports;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

async function reportsPage(res: ServerResponse, keyQuery: string) {
  const reports = await listReports();
  const rows = reports.map((r) => {
    const videos = (r.video ?? [])
      .map((v: any) => `${escapeHtml(v.id)}: ${v.error ? 'Fehler ' + escapeHtml(v.error) : escapeHtml(v.droppedPercent) + ' % verworfen'}`)
      .join('<br>');
    const anims = (r.animation ?? [])
      .map((a: any) => `${escapeHtml(a.id)}: ${escapeHtml(a.fps)} fps, p95 ${escapeHtml(a.p95)} ms`)
      .join('<br>');
    return `<tr><td>${escapeHtml(r.receivedAt)}<br><a href="/api/reports/${escapeHtml(r.file)}${keyQuery}">JSON</a></td>
      <td>${escapeHtml(r.device)}<br>Lauf #${escapeHtml(r.storage?.loadCount)}</td>
      <td>${escapeHtml(r.browser?.chromium ?? r.browser?.userAgent)}</td>
      <td>${anims}</td><td>${videos}</td></tr>`;
  });
  send(res, 200, `<!doctype html><meta charset="utf-8"><title>Probe-Berichte</title>
    <style>body{font:14px system-ui;margin:24px}td,th{border:1px solid #ccc;padding:6px;vertical-align:top;text-align:left}table{border-collapse:collapse}</style>
    <h1>Probe-Berichte (${reports.length})</h1>
    <table><tr><th>Empfangen</th><th>Gerät</th><th>Browser</th><th>Animation</th><th>Video</th></tr>${rows.join('')}</table>`,
    mimeTypes['.html']);
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string) {
  const relative = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(publicDir, relative);
  if (!file.startsWith(publicDir)) return send(res, 403, 'forbidden');
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return send(res, 404, 'not found');

  const type = mimeTypes[extname(file)] ?? 'application/octet-stream';
  const headers: Record<string, string | number> = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  if (pathname === '/sw.js') headers['Service-Worker-Allowed'] = '/';

  const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  if (range) {
    const start = range[1] ? Number(range[1]) : info.size - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
    if (start > end || start >= info.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${info.size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${info.size}`, 'Content-Length': end - start + 1 });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': info.size });
  createReadStream(file).pipe(res);
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (req.method === 'POST' && url.pathname === '/api/report') return await saveReport(req, res);
    const readsReports = url.pathname === '/reports' || url.pathname.startsWith('/api/reports');
    if (readsReports && reportsKey && url.searchParams.get('key') !== reportsKey) return send(res, 401, 'key required');
    if (req.method === 'GET' && url.pathname === '/reports') return await reportsPage(res, reportsKey ? `?key=${encodeURIComponent(reportsKey)}` : "");
    if (req.method === 'GET' && url.pathname === '/api/reports') {
      return send(res, 200, JSON.stringify(await listReports()), mimeTypes['.json']);
    }
    const single = url.pathname.match(/^\/api\/reports\/([\w.-]+\.json)$/);
    if (req.method === 'GET' && single) {
      return send(res, 200, await readFile(join(reportsDir, single[1]), 'utf8'), mimeTypes['.json']);
    }
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res, url.pathname);
    send(res, 405, 'method not allowed');
  } catch (err) {
    send(res, 500, String(err));
  }
}).listen(port, () => {
  console.log(`Foyer-Probe läuft auf http://localhost:${port}  (Berichte: /reports)`);
});
