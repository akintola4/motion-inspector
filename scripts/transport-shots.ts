/**
 * Screenshots of every transport option (Old, A, B, C) in light and dark,
 * playing, paused and scrubbing, for the global transport and the detail
 * scrubber. Saves to screenshots/transport/<variant>-<theme>-<where>-<state>.png
 * plus a full-panel shot per option and theme.
 *
 *   pnpm shots:transport      (builds first)
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './serve-fixtures';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'dist/chrome-mv3');
const PROFILE = join(ROOT, '.shots-profile');
const OUT = join(ROOT, 'screenshots/transport');
const PORT = 4613;
const BASE = `http://127.0.0.1:${PORT}`;
const PANEL = { width: 400, height: 900 };
const VARIANTS = (process.env.VARIANTS ?? 'current,a,b,c').split(',');
const THEMES = (process.env.THEMES ?? 'light,dark').split(',');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Header + transport, with a little of the list for context. */
async function shotGlobal(panel: Page, name: string) {
  const box = await panel.locator('.transport').boundingBox();
  await panel.screenshot({ path: join(OUT, `${name}.png`), clip: { x: 0, y: 0, width: PANEL.width, height: Math.ceil(box!.y + box!.height + 12) } });
}

async function shotDetail(panel: Page, name: string) {
  const box = await panel.locator('.curve-card').boundingBox();
  await panel.screenshot({ path: join(OUT, `${name}.png`), clip: { x: 0, y: Math.floor(box!.y - 8), width: PANEL.width, height: Math.ceil(box!.height + 16) } });
}

/** Press on a scrubber at fraction `a`, drag to `b`, and leave it held. */
async function holdDrag(panel: Page, sel: string, a: number, b: number) {
  const box = (await panel.locator(sel).boundingBox())!;
  const y = box.y + box.height / 2;
  await panel.mouse.move(box.x + box.width * a, y);
  await panel.mouse.down();
  await panel.mouse.move(box.x + box.width * b, y, { steps: 6 });
  await sleep(350);
}

async function main() {
  rmSync(PROFILE, { recursive: true, force: true });
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const server = await startFixtureServer(PORT);
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chromium',
    headless: !process.env.HEADED,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    viewport: { width: 1100, height: 760 },
    deviceScaleFactor: 2,
  });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;

  for (const variant of VARIANTS) {
    for (const theme of THEMES) {
      const page = await ctx.newPage();
      await page.goto(`${BASE}/all.html`);
      await sleep(800);
      await page.bringToFront();
      const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id ?? -1);
      const panel = await ctx.newPage();
      await panel.setViewportSize(PANEL);
      await panel.goto(`chrome-extension://${extId}/sidepanel.html?tabId=${tabId}&theme=${theme}&transport=${variant}`);
      await panel.waitForSelector('.rows .row');
      await sleep(900);
      const n = `${variant}-${theme}`;
      const gScrub = '.transport [data-part=scrubber]';

      // Global: playing, paused, scrubbing.
      await shotGlobal(panel, `${n}-global-playing`);
      await panel.keyboard.press('k');
      await sleep(600);
      await shotGlobal(panel, `${n}-global-paused`);
      await holdDrag(panel, gScrub, 0.2, 0.45);
      await shotGlobal(panel, `${n}-global-scrubbing`);
      await panel.mouse.up();
      await sleep(300);
      await panel.mouse.move(200, 600);
      await panel.screenshot({ path: join(OUT, `${n}-panel-list.png`) });

      // Detail on the infinite spring ("drop"): playing, paused, scrubbing.
      await panel.keyboard.press('k'); // play
      await sleep(400);
      await panel.locator('.rows .row[data-id]', { hasText: 'drop' }).first().click();
      await panel.waitForSelector('.curve-card');
      await sleep(900);
      await panel.mouse.move(380, 880);
      await shotDetail(panel, `${n}-detail-playing`);
      await panel.keyboard.press('k');
      await sleep(600);
      await shotDetail(panel, `${n}-detail-paused`);
      await holdDrag(panel, '.scrub-one [data-part=scrubber]', 0.3, 0.62);
      await shotDetail(panel, `${n}-detail-scrubbing`);
      await panel.mouse.up();
      await sleep(300);
      await panel.mouse.move(380, 880);
      await panel.screenshot({ path: join(OUT, `${n}-panel-detail.png`) });
      await panel.close();
      await page.close();
      console.log(`shots: ${n}`);
    }
  }
  await ctx.close();
  server.close();
  rmSync(PROFILE, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
