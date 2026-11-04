// Admin command line:
//   user:create <email> <name> <role>   password from FOYER_PASSWORD or prompt
//   demo:seed                           demo channel, slides and display; prints the player URL
//   test:seed [--reset]                 test accounts + demo content + two displays (local testing only)
//   ndi:sources [ip,ip…]                NDI sources this server sees (needs the NDI ffmpeg)
import { createInterface } from 'node:readline/promises';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db.ts';
import { config } from './config.ts';
import { encrypt, hashPassword, randomToken, sha256 } from './crypto.ts';
import { loadTokenKey } from './keys.ts';
import { TEST_ACCOUNTS } from './test-accounts.ts';
import { findNdiSources, ndiAvailable } from './ndi.ts';

const [command, ...args] = process.argv.slice(2);

// --reset starts from an empty database (the token key is kept).
if (command === 'test:seed' && args.includes('--reset')) {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = join(config.dataDir, `foyer.sqlite${suffix}`);
    if (existsSync(file)) rmSync(file);
  }
}
const db = openDb(config.dataDir);

async function readPassword(): Promise<string> {
  if (process.env.FOYER_PASSWORD) return process.env.FOYER_PASSWORD;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const password = await rl.question('Passwort (mind. 12 Zeichen): ');
  rl.close();
  return password;
}

async function createUser() {
  const [email, name, role] = args;
  if (!email || !name || !['admin', 'editor', 'viewer'].includes(role)) {
    throw new Error('Aufruf: user:create <email> <name> <admin|editor|viewer>');
  }
  const password = await readPassword();
  if (password.length < 12) throw new Error('Passwort muss mindestens 12 Zeichen haben');
  db.prepare('INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    crypto.randomUUID(), email, name, await hashPassword(password), role, Date.now(),
  );
  console.log(`Benutzer ${email} (${role}) angelegt.`);
}

const DEMO_HTML = `<div class="stage">
  <h1 class="headline">Willkommen</h1>
  <p class="sub">{{weekday}}, {{date}} · {{display.name}}</p>
  <div class="bar"></div>
</div>`;

const DEMO_CSS = `.stage { position: absolute; top: 0; right: 0; bottom: 0; left: 0; display: flex; flex-direction: column; justify-content: center; padding: 10vmin;
  background: linear-gradient(135deg, #0f172a, #1e3a8a); color: #fff; font-family: system-ui, sans-serif; }
.headline { font-size: 14vmin; margin: 0; opacity: 0; transform: translateY(6vmin); }
.sub { font-size: 4.5vmin; opacity: 0; transform: translateY(3vmin); }
.bar { height: 1.2vmin; width: 40vmin; background: #38bdf8; transform: scaleX(0); transform-origin: left; }
.foyer-active .headline { animation: rise 1.2s ease-out forwards; }
.foyer-active .sub { animation: rise 1.2s 0.4s ease-out forwards; }
.foyer-active .bar { animation: grow 1.5s 0.8s ease-out forwards; }
@keyframes rise { to { opacity: 1; transform: none; } }
@keyframes grow { to { transform: scaleX(1); } }`;

function seedDemo(displayNames = ['Demo-Display']) {
  const now = Date.now();
  const channelId = crypto.randomUUID();
  db.prepare('INSERT INTO channels (id, name, transition, default_duration, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    channelId, 'Demo', 'fade', 8, now, now,
  );
  const slides = [
    { title: 'Begrüßung (HTML)', type: 'html', config: { html: DEMO_HTML, css: DEMO_CSS, js: '', variables: '', durationMode: 'fixed', allowExternal: false } },
    {
      title: 'Hinweis (Text)',
      type: 'text',
      config: { pretitle: 'Foyer 2.0', title: 'Digitale Infotafel', subtitle: 'Neu gebaut, ohne WordPress', content: 'Heute ist {{weekday}}, der {{date}}.', qrUrl: 'https://github.com/Cypris2010/foyer2.0', qrEcc: 'M' },
    },
  ];
  slides.forEach((slide, position) => {
    const slideId = crypto.randomUUID();
    db.prepare('INSERT INTO slides (id, title, type, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      slideId, slide.title, slide.type, JSON.stringify(slide.config), now, now,
    );
    db.prepare('INSERT INTO channel_slides (channel_id, slide_id, position) VALUES (?, ?, ?)').run(channelId, slideId, position);
    // Slides play only by channel calendar: plan them open-ended.
    db.prepare(
      `INSERT INTO schedules (id, scope, channel_id, content_kind, content_id, start_local, end_local, created_at, updated_at)
       VALUES (?, 'channel', ?, 'slide', ?, '2000-01-01T00:00', NULL, ?, ?)`,
    ).run(crypto.randomUUID(), channelId, slideId, now, now);
  });
  const key = loadTokenKey(config.dataDir);
  console.log('Demo angelegt. Player-URLs (später im Admin unter „URL anzeigen“):');
  for (const name of displayNames) {
    const token = randomToken();
    db.prepare('INSERT INTO displays (id, name, token_hash, token_enc, default_channel_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      crypto.randomUUID(), name, sha256(token), encrypt(key, token), channelId, now, now,
    );
    console.log(`  ${name}: http://127.0.0.1:${config.port}/p/${token}`);
  }
}

async function seedTest() {
  const users = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  if (users > 0) {
    throw new Error('Die Datenbank enthält schon Benutzer. Für Testdaten neu beginnen mit: test:seed --reset (löscht die lokale Datenbank)');
  }
  for (const account of TEST_ACCOUNTS) {
    db.prepare('INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      crypto.randomUUID(), account.email, account.name, await hashPassword(account.password), account.role, Date.now(),
    );
  }
  seedDemo(['Aula', 'Foyer Eingang']);
  console.log('');
  console.log('Testkonten (nur für lokale Tests, Zugangsdaten stehen öffentlich in apps/server/src/test-accounts.ts):');
  for (const account of TEST_ACCOUNTS) console.log(`  ${account.role.padEnd(7)} ${account.email.padEnd(22)} ${account.password}`);
  console.log('');
  console.log(`Admin: http://127.0.0.1:${config.port}/admin/`);
}

async function listNdi() {
  if (!(await ndiAvailable(config.ffmpegNdi))) {
    throw new Error('Kein ffmpeg mit NDI gefunden. Bauen mit deploy/ffmpeg-ndi/build.sh, Pfad über FOYER_FFMPEG_NDI.');
  }
  const extraIps = args[0] ? args[0].split(',').map((ip) => ip.trim()).filter(Boolean) : [];
  const sources = await findNdiSources(config.ffmpegNdi, { extraIps });
  if (!sources.length) console.log('Keine NDI-Quellen gefunden (gleiches Netz? Quellen in anderen Subnetzen als IP angeben).');
  for (const source of sources) console.log(`  ${source.name}  (${source.address})`);
}

try {
  if (command === 'user:create') await createUser();
  else if (command === 'demo:seed') seedDemo();
  else if (command === 'test:seed') await seedTest();
  else if (command === 'ndi:sources') await listNdi();
  else console.log('Befehle: user:create <email> <name> <role> | demo:seed | test:seed [--reset] | ndi:sources [ip,…]');
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
}
