// Checks that an admin edit reaches a running player via SSE without reload.
//   FOYER_E2E_EMAIL=… FOYER_E2E_PASSWORD=… node tests/e2e/live-update.ts <base-url> <player-token>
import { chromium } from 'playwright-core';

const [base, token] = process.argv.slice(2);
const email = process.env.FOYER_E2E_EMAIL;
const password = process.env.FOYER_E2E_PASSWORD;
if (!base || !token || !email || !password) {
  console.error('Aufruf: FOYER_E2E_EMAIL=… FOYER_E2E_PASSWORD=… node tests/e2e/live-update.ts <base-url> <player-token>');
  process.exit(1);
}

async function adminRequest(cookie: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}`);
  return res.json();
}

const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
  body: JSON.stringify({ email, password }),
});
if (!login.ok) throw new Error(`Login: HTTP ${login.status}`);
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

const slides = await adminRequest(cookie, 'GET', '/slides');
const text = slides.find((s: any) => s.type === 'text');
if (!text) throw new Error('Keine Text-Folie gefunden');

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${base}/p/${token}`);
  await page.waitForTimeout(1500);

  const marker = `Live-Update ${new Date().toLocaleTimeString('de-DE')}`;
  const started = Date.now();
  await adminRequest(cookie, 'PUT', `/slides/${text.id}`, { ...text, config: { ...text.config, subtitle: marker } });
  await page.waitForFunction((m) => document.body.innerText.includes(m), marker, { timeout: 30_000 });
  console.log(`OK: Änderung nach ${((Date.now() - started) / 1000).toFixed(1)} s im Player sichtbar (nächste Foliengrenze).`);
  await adminRequest(cookie, 'PUT', `/slides/${text.id}`, text);
} finally {
  await browser.close();
}
