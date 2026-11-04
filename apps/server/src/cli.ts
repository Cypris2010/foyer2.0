// Admin command line:
//   user:create <email> <name> <role>   password from FOYER_PASSWORD or prompt
//   demo:seed                           demo channel, slides and display; prints the player URL
import { createInterface } from 'node:readline/promises';
import { openDb } from './db.ts';
import { config } from './config.ts';
import { hashPassword, randomToken, sha256 } from './crypto.ts';

const [command, ...args] = process.argv.slice(2);
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

function seedDemo() {
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
  });
  const token = randomToken();
  db.prepare('INSERT INTO displays (id, name, token_hash, default_channel_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    crypto.randomUUID(), 'Demo-Display', sha256(token), channelId, now, now,
  );
  console.log('Demo angelegt. Player-URL (nur jetzt sichtbar):');
  console.log(`  http://localhost:${config.port}/p/${token}`);
}

try {
  if (command === 'user:create') await createUser();
  else if (command === 'demo:seed') seedDemo();
  else console.log('Befehle: user:create <email> <name> <role> | demo:seed');
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
}
