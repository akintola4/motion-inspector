/**
 * Screenshots of the transport in light and dark, playing, paused, hovering
 * and scrubbing, for the global transport and the detail scrubber. Saves to
 * screenshots/transport/<theme>-<where>-<state>.png, a full panel per theme,
 * and the panel at narrow side-panel widths on a page with ~100 animations.
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
const THEMES = (process.env.THEMES ?? 'light,dark').split(',');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Header + transport, with a little of the list for context. */
async function shotGlobal(panel: Page, name: string, extra = 12) {
  const box = await panel.locator('.transport').boundingBox();
  await panel.screenshot({ path: join(OUT, `${name}.png`), clip: { x: 0, y: 0, width: panel.viewportSize()!.width, height: Math.ceil(box!.y + box!.height + extra) } });
}

async function shotDetail(panel: Page, name: string) {
  const box = await panel.locator('.curve-card').boundingBox();
  await panel.screenshot({ path: join(OUT, `${name}.png`), clip: { x: 0, y: Math.floor(box!.y - 8), width: panel.viewportSize()!.width, height: Math.ceil(box!.height + 48) } });
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

  {
    for (const theme of THEMES) {
      const page = await ctx.newPage();
      await page.goto(`${BASE}/all.html`);
      await sleep(800);
      await page.bringToFront();
      const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id ?? -1);
      const panel = await ctx.newPage();
      await panel.setViewportSize(PANEL);
      await panel.goto(`chrome-extension://${extId}/sidepanel.html?tabId=${tabId}&theme=${theme}`);
      await panel.waitForSelector('.rows .row');
      await sleep(900);
      const n = theme;
      const gScrub = '.transport [data-part=scrubber]';

      // Global: playing, paused, scrubbing.
      await shotGlobal(panel, `${n}-global-playing`);
      await panel.keyboard.press('k');
      await sleep(600);
      await shotGlobal(panel, `${n}-global-paused`);
      const gb = (await panel.locator(gScrub).boundingBox())!;
      await panel.mouse.move(gb.x + gb.width * 0.7, gb.y + 14);
      await sleep(300);
      await shotGlobal(panel, `${n}-global-hover`, 40);
      await holdDrag(panel, gScrub, 0.2, 0.45);
      await shotGlobal(panel, `${n}-global-scrubbing`, 40);
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

  /* Narrow side panels on a page with ~100 animations. */
  {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/many.html`);
    await sleep(800);
    await page.bringToFront();
    const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id ?? -1);
    for (const theme of THEMES) {
      for (const width of [300, 320, 360]) {
        const panel = await ctx.newPage();
        await panel.setViewportSize({ width, height: 700 });
        await panel.goto(`chrome-extension://${extId}/sidepanel.html?tabId=${tabId}&theme=${theme}`);
        await panel.waitForSelector('.rows .row');
        await sleep(900);
        await panel.screenshot({ path: join(OUT, `${theme}-narrow-${width}-playing.png`) });
        await panel.keyboard.press('k');
        await panel.focus('.transport [data-part=scrubber]');
        await panel.keyboard.press('End');
        await sleep(500);
        await panel.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await panel.screenshot({ path: join(OUT, `${theme}-narrow-${width}-end.png`) });
        await panel.close();
      }
    }
    await page.close();
  }
  await ctx.close();
  server.close();
  rmSync(PROFILE, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
