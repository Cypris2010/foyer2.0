// Compares the ported teacher dashboard with the wp-foyer original in real Chrome:
// same data, same clock, 1920×1080; checks the rendered text and writes
// screenshots of both side by side.
//   node tests/e2e/untis-compare.ts <foyer-url> <wp-foyer-checkout> <out-dir>
// Needs a running Foyer with the test accounts, the fixture server
// (tests/fixtures/untis on http://127.0.0.1:8191) and an installed Google Chrome.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { TEST_ACCOUNTS } from '../../apps/server/src/test-accounts.ts';

const [base, legacyDir, outDir] = process.argv.slice(2);
if (!base || !legacyDir || !outDir) {
  console.error('Aufruf: node tests/e2e/untis-compare.ts <foyer-url> <wp-foyer-checkout> <out-dir>');
  process.exit(1);
}
const FIXTURES = 'http://127.0.0.1:8191';
const CLOCK = new Date('2026-11-04T10:00:00');
const legacyCss = readFileSync(join(legacyDir, 'public/css/foyer-public.css'), 'utf8');
const legacyJs = (name: string) => readFileSync(join(legacyDir, 'public/js', name), 'utf8');
const esc = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

interface Case {
  name: string;
  config: Record<string, unknown>;
  legacy: string;
}

function teacherCase(name: string, teachers: string[], theme: 'dark' | 'light', legend: boolean): Case {
  return {
    name,
    config: { source: `${FIXTURES}/lehrer.txt`, teachers, theme, legend },
    // Markup of teacher-dashboard.php (with the data-error-no-source quote fixed).
    legacy: `<div class="foyer-slide foyer-slide-teacher-dashboard active">
      <div class="foyer-teacher-dashboard foyer-teacher-dashboard--${theme}" data-source="${FIXTURES}/lehrer.txt" data-refresh="30"
        data-teachers='${esc(JSON.stringify(teachers))}' data-error-no-source="Keine Datenquelle definiert." data-theme="${theme}">
        <div class="foyer-teacher-dashboard__grid" role="list"></div>
        ${legend ? '<div class="foyer-teacher-dashboard__legend" role="group" aria-label="Statusfilter"></div>' : ''}
        <div class="foyer-teacher-dashboard__error" hidden><div class="foyer-teacher-dashboard__error-box" role="alert">
          <h3>CSV konnte nicht geladen werden</h3><p class="foyer-teacher-dashboard__error-msg"></p></div></div>
      </div></div>`,
  };
}

const cases: Case[] = [
  teacherCase('lehrer-alle-dunkel', [], 'dark', true),
  teacherCase('lehrer-auswahl-hell', ['LAAA', 'LAAB', 'LAAC', 'LAAK', 'LAAN', 'LACH'], 'light', false),
];

// Stops the clock at CLOCK: no timer fires, so rotating tiles show their first entry on both sides.
async function freeze(page: Page) {
  await page.clock.install({ time: new Date(CLOCK.getTime() - 1000) });
  await page.clock.pauseAt(CLOCK);
}

// The widget's visible text, minus the parts that may legitimately differ.
async function widgetText(page: Page): Promise<string> {
  return page.locator('.foyer-teacher-dashboard').first().innerText();
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results: Array<{ case: string; sameText: boolean; legacy?: string; ported?: string }> = [];
try {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, timezoneId: 'Europe/Berlin', locale: 'de-DE' });
  const account = TEST_ACCOUNTS.find((a) => a.role === 'admin')!;
  const login = await context.request.post(`${base}/api/auth/login`, { data: { email: account.email, password: account.password } });
  if (!login.ok()) throw new Error(`Login fehlgeschlagen: ${login.status()}`);

  for (const c of cases) {
    // Original: the template markup with the old CSS and script, served from a fake origin.
    const legacyPage = await context.newPage();
    await freeze(legacyPage);
    await legacyPage.route('http://legacy.test/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html><head><meta charset="utf-8"><style>${legacyCss}</style></head>
          <body class="single-foyer_slide"><div class="foyer-slides">${c.legacy}</div><script>${legacyJs('teacher-dashboard.js')}</script></body></html>`,
      }),
    );
    // The old script fetches the export itself; allow the fake origin to read it.
    await legacyPage.route(`${FIXTURES}/**`, async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': '*', 'access-control-expose-headers': 'Last-Modified, Date' } });
    });
    await legacyPage.goto('http://legacy.test/');
    await legacyPage.evaluate(() => document.dispatchEvent(new Event('DOMContentLoaded')));
    await legacyPage.waitForTimeout(2500);
    await legacyPage.screenshot({ path: join(outDir, `${c.name}-alt.png`) });

    // Port: a real slide in Foyer, shown by the preview player.
    const created = await context.request.post(`${base}/api/slides`, { data: { title: `Vergleich ${c.name}`, type: 'teacher-dashboard', config: c.config, background: null } });
    if (!created.ok()) throw new Error(`Folie anlegen fehlgeschlagen: ${await created.text()}`);
    const { id } = (await created.json()) as { id: string };
    const page = await context.newPage();
    await freeze(page);
    await page.goto(`${base}/p/preview/${id}`);
    await page.waitForSelector('.foyer-slide.is-active');
    await page.waitForTimeout(2500);
    await page.screenshot({ path: join(outDir, `${c.name}-neu.png`) });

    const [legacy, ported] = await Promise.all([widgetText(legacyPage), widgetText(page)]);
    if (legacy === ported) {
      results.push({ case: c.name, sameText: true });
    } else {
      // Report only the first differing line, not the whole slide.
      const a = legacy.split('\n');
      const b = ported.split('\n');
      const at = a.findIndex((line, i) => line !== b[i]);
      results.push({ case: c.name, sameText: false, legacy: a.slice(at - 2, at + 3).join(' | '), ported: b.slice(at - 2, at + 3).join(' | ') });
    }
    await context.request.delete(`${base}/api/slides/${id}`);
    await legacyPage.close();
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(JSON.stringify(results, null, 2));
if (results.some((r) => !r.sameText)) process.exitCode = 1;
