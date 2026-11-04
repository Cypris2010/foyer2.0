// Player smoke test in real Chrome (sandboxed iframes, transitions, lifecycle).
//   node tests/e2e/player-smoke.ts <player-url> [screenshot-dir]
// Needs an installed Google Chrome; uses playwright-core without bundled browsers.
import { chromium } from 'playwright-core';

const [url, outDir = '.'] = process.argv.slice(2);
if (!url) {
  console.error('Aufruf: node tests/e2e/player-smoke.ts <player-url> [screenshot-dir]');
  process.exit(1);
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const problems: string[] = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`request failed: ${r.url().split('?')[0]} ${r.failure()?.errorText}`));

  await page.goto(url);
  const seen = new Map<string, string>();
  // Sample the active slide for 20 s and capture each slide once, after its animations.
  for (let t = 0; t < 20; t++) {
    await page.waitForTimeout(1000);
    const active = await page.evaluate(() => document.querySelector('.foyer-slide.is-active')?.className ?? 'keine');
    if (seen.has(active)) continue;
    await page.waitForTimeout(2500);
    const frame = page.frames().find((f) => f.url().includes('/content/'));
    const frameClass = frame ? await frame.evaluate(() => document.documentElement.className) : '-';
    const file = `${outDir}/slide-${seen.size + 1}.png`;
    await page.screenshot({ path: file });
    seen.set(active, `${file} (iframe <html class="${frameClass}">)`);
  }
  console.log(JSON.stringify({ slides: Object.fromEntries(seen), problems }, null, 2));
  if (problems.length) process.exitCode = 1;
} finally {
  await browser.close();
}
