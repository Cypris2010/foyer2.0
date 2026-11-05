import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { createApp } from './app.ts';
import { createContext } from './bootstrap.ts';
import { staticRoutes } from './static.ts';
import { config } from './config.ts';
import { TEST_DOMAIN } from './test-accounts.ts';
import { startDataRefresh } from './manifest.ts';

const ctx = await createContext();
const app = createApp(ctx, {
  staticRoutes: staticRoutes(config.playerDist, config.adminDist),
  remoteAddress: (c) => getConnInfo(c).remote.address ?? '',
});
// Live data (refreshSeconds, e.g. Untis) reaches the displays without a reload.
startDataRefresh(ctx);

const users = (ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
const testAccounts = (ctx.db.prepare('SELECT COUNT(*) AS n FROM users WHERE email LIKE ?').get(`%@${TEST_DOMAIN}`) as { n: number }).n;

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`Foyer läuft auf http://${info.address}:${info.port}  (Admin: /admin/)`);
  console.log(`Folientypen: ${[...ctx.registry.keys()].join(', ')}`);
  if (!ctx.live) console.log('Live-Video nicht eingerichtet (kein Live-Gateway, FOYER_LIVE_GATEWAY)');
  else {
    ctx.live.status().then(
      (status) => console.log(`Live-Gateway erreichbar (${config.liveGateway}), ${status.ndi ? 'mit' : 'ohne'} NDI-Eingang`),
      (err: Error) => console.warn(`${err.message}. Live-Folien zeigen „Live-Bild nicht verfügbar“, bis es antwortet.`),
    );
  }
  if (!users) console.log('Noch kein Benutzer. Anlegen mit: npm run cli -w @foyer/server -- user:create <email> <name> admin');
  if (testAccounts) {
    console.warn(`WARNUNG: ${testAccounts} Testkonten (@${TEST_DOMAIN}) mit öffentlich bekannten Passwörtern sind aktiv. Nur für lokale Tests!`);
  }
});
