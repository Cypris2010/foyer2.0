import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { createApp } from './app.ts';
import { createContext } from './bootstrap.ts';
import { staticRoutes } from './static.ts';
import { config } from './config.ts';
import { TEST_DOMAIN } from './test-accounts.ts';
import { startDataRefresh } from './manifest.ts';
import { ndiAvailable } from './ndi.ts';

const ctx = await createContext();
const app = createApp(ctx, {
  staticRoutes: staticRoutes(config.playerDist, config.adminDist),
  remoteAddress: (c) => getConnInfo(c).remote.address ?? '',
});
// Live data (refreshSeconds, e.g. Untis) reaches the displays without a reload.
startDataRefresh(ctx);

const users = (ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
const testAccounts = (ctx.db.prepare('SELECT COUNT(*) AS n FROM users WHERE email LIKE ?').get(`%@${TEST_DOMAIN}`) as { n: number }).n;
const ndi = await ndiAvailable(config.ffmpegNdi);
// MediaMTX runs as a child process; take it down with the server.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    ctx.live?.stop();
    process.exit(0);
  });
}

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`Foyer läuft auf http://${info.address}:${info.port}  (Admin: /admin/)`);
  console.log(`Folientypen: ${[...ctx.registry.keys()].join(', ')}`);
  console.log(ctx.live?.available ? `Live-Video verfügbar (WebRTC-Port ${config.liveMediaPort} UDP/TCP)` : 'Live-Video nicht eingerichtet (MediaMTX fehlt, FOYER_MEDIAMTX)');
  if (ndi) console.log(`NDI-Eingang verfügbar (${config.ffmpegNdi})`);
  else if (config.ffmpegNdi) console.log(`NDI-Eingang nicht verfügbar: ${config.ffmpegNdi} fehlt oder kann kein NDI`);
  if (!users) console.log('Noch kein Benutzer. Anlegen mit: npm run cli -w @foyer/server -- user:create <email> <name> admin');
  if (testAccounts) {
    console.warn(`WARNUNG: ${testAccounts} Testkonten (@${TEST_DOMAIN}) mit öffentlich bekannten Passwörtern sind aktiv. Nur für lokale Tests!`);
  }
});
