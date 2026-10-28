/**
 * End-to-end check: loads the built extension into Playwright's Chromium,
 * opens each fixture page, drives the side panel UI, and asserts against the
 * page's real Animation objects. Saves panel screenshots to screenshots/.
 *
 *   pnpm e2e              (builds first)
 *   HEADED=1 pnpm e2e     (watch it run)
 *
 * Playwright can't click the toolbar icon or reach into the real side
 * panel, so UI checks run on the same panel page opened as a tab at side
 * panel width with ?tabId=<fixture tab>. A separate check opens the real
 * side panel with chrome.sidePanel.open and confirms it attaches.
 */
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './serve-fixtures';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'dist/chrome-mv3');
const PROFILE = join(ROOT, '.e2e-profile');
const SHOTS = join(ROOT, 'screenshots');
const PORT = 4611;
const BASE = `http://127.0.0.1:${PORT}`;
const PANEL_SIZE = { width: 400, height: 900 };

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Probe {
  animations: { id: string; name: string; kind: string; currentTime: number | null; playState: string; playbackRate: number }[];
  gsap: { paused: boolean; timeScale: number; times: number[] } | null;
}

const probe = (page: Page) =>
  page.evaluate(() => (window as unknown as { __motionInspector: { probe(): Probe } }).__motionInspector.probe());

/** Tab id of `page`. Call right after creating it, while it's the active tab. */
async function tabIdFor(sw: Worker, page: Page): Promise<number> {
  await page.bringToFront();
  return sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab?.id ?? -1;
  });
}

async function openPanel(ctx: BrowserContext, extId: string, tabId: number, theme = 'light') {
  const panel = await ctx.newPage();
  await panel.setViewportSize(PANEL_SIZE);
  await panel.goto(`chrome-extension://${extId}/sidepanel.html?tabId=${tabId}&theme=${theme}`);
  return panel;
}

async function setRange(panel: Page, selector: string, value: number) {
  await panel.$eval(
    selector,
    (el, v) => {
      const input = el as HTMLInputElement;
      input.value = String(v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    value,
  );
}

async function exportsFor(panel: Page) {
  const out: Record<string, string> = {};
  for (const tab of ['css', 'linear', 'motion', 'gsap']) {
    await panel.click(`.seg-btn[data-tab="${tab}"]`);
    out[tab] = (await panel.textContent('.code')) ?? '';
  }
  await panel.click(`.seg-btn[data-tab="css"]`);
  return out;
}

const MARKERS: Record<string, RegExp> = {
  css: /@keyframes|transition:/,
  linear: /linear\(|steps\(|: linear;/,
  motion: /animate\(/,
  gsap: /gsap\.(to|fromTo)\(/,
};

async function main() {
  rmSync(PROFILE, { recursive: true, force: true });
  mkdirSync(SHOTS, { recursive: true });
  const server = await startFixtureServer(PORT);

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chromium',
    headless: !process.env.HEADED,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    viewport: { width: 1100, height: 760 },
  });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;
  check('extension service worker started', !!extId, extId);

  const allExports: Record<string, unknown> = {};

  /* ---------------------------------------------------------------- */
  /* Per-fixture capture checks                                        */
  /* ---------------------------------------------------------------- */
  const expectations: { file: string; wait?: number; expect: (names: { kind: string; name: string; easing: string }[], js: string[]) => [boolean, string] }[] = [
    {
      file: 'css-keyframes.html',
      expect: (a) => {
        const names = a.filter((x) => x.kind === 'css-animation').map((x) => x.name);
        return [['pulse', 'spin', 'blink'].every((n) => names.includes(n)), names.join(', ')];
      },
    },
    {
      file: 'css-transition.html',
      wait: 3200,
      expect: (a) => {
        const t = a.filter((x) => x.kind === 'css-transition').map((x) => x.name);
        return [t.includes('transform') && t.includes('background-color'), t.join(', ')];
      },
    },
    {
      file: 'waapi.html',
      expect: (a) => {
        const w = a.filter((x) => x.kind === 'waapi');
        const slide = w.find((x) => x.name === 'slide');
        return [!!slide && slide.easing.startsWith('cubic-bezier') && w.some((x) => x.name === 'hop'), w.map((x) => `${x.name} ${x.easing}`).join(' | ')];
      },
    },
    {
      file: 'spring.html',
      expect: (a) => {
        const d = a.find((x) => x.name === 'drop');
        return [!!d, d ? d.easing.slice(0, 40) : 'missing'];
      },
    },
    {
      file: 'gsap.html',
      expect: (a) => {
        const g = a.filter((x) => x.kind === 'gsap');
        return [g.length >= 4, g.map((x) => `${x.name} ${x.easing.slice(0, 28)}`).join(' | ')];
      },
    },
    {
      file: 'motion.html',
      wait: 2500,
      expect: (a, js) => {
        const w = a.filter((x) => x.kind === 'waapi');
        const spring = w.find((x) => x.easing.startsWith('linear('));
        return [!!spring && w.length >= 3 && js.some((j) => j.includes('m-js')), `waapi: ${w.map((x) => `${x.name} ${x.easing.slice(0, 24)}`).join(' | ')}; js: ${js.join(', ')}`];
      },
    },
  ];

  for (const fx of expectations) {
    const url = `${BASE}/${fx.file}`;
    const page = await ctx.newPage();
    await page.goto(url);
    await sleep(800);
    const tabId = await tabIdFor(sw, page);
    const panel = await openPanel(ctx, extId, tabId);
    await panel.waitForSelector('.row', { timeout: 8000 }).catch(() => {});
    await sleep(fx.wait ?? 1200);

    const snap = await page.evaluate(() =>
      (window as unknown as { __motionInspector: { snapshot(): import('../lib/types').AgentSnapshot } }).__motionInspector.snapshot(),
    );
    const list = snap.animations.map((x) => ({ kind: x.spec.kind, name: x.spec.name, easing: x.spec.easing }));
    const [ok, detail] = fx.expect(list, snap.jsDriven.map((j) => `${j.selector} (${j.properties.join(',')})`));
    check(`${fx.file}: captures expected animations`, ok, detail);

    const rows = await panel.$$eval('.rows .row', (els) => els.length);
    check(`${fx.file}: panel lists them`, rows >= 1 && Math.abs(rows - snap.animations.length) <= 1, `${rows} rows`);

    // Export every format for the first row.
    await panel.click('.rows .row');
    await panel.waitForSelector('.detail .code');
    const ex = await exportsFor(panel);
    allExports[fx.file] = ex;
    const bad = Object.entries(MARKERS).filter(([k, re]) => !re.test(ex[k] ?? '') || /undefined|NaN/.test(ex[k] ?? ''));
    check(`${fx.file}: exports look like code`, bad.length === 0, bad.map(([k]) => k).join(', '));

    if (fx.file === 'motion.html') {
      await panel.keyboard.press('Escape');
      await sleep(200);
      await panel.locator('.rows .row', { hasText: 'm-spring' }).first().click();
      await sleep(300);
      const springEx = await exportsFor(panel);
      allExports['motion.html#spring'] = springEx;
      check('motion.html: Motion spring exports back as type: "spring"', /type: "spring"[\s\S]*visualDuration: 0\.6\d*[\s\S]*bounce: 0\.[34]/.test(springEx.motion ?? ''), (springEx.motion ?? '').match(/visualDuration: [\d.]+|bounce: [\d.]+/g)?.join(' ') ?? '');
    }

    const overlay = await page.evaluate(() => !!document.querySelector('motion-inspector-overlay'));
    check(`${fx.file}: selecting a row highlights the element`, overlay);

    await panel.close();
    await page.close();
  }

  /* ---------------------------------------------------------------- */
  /* Controls on the all-in-one page                                   */
  /* ---------------------------------------------------------------- */
  {
    const url = `${BASE}/all.html`;
    const page = await ctx.newPage();
    await page.goto(url);
    await sleep(1000);
    const tabId = await tabIdFor(sw, page);
    const panel = await openPanel(ctx, extId, tabId);
    await panel.waitForSelector('.row');
    await sleep(800);

    await panel.click('.seg-btn[data-rate="0.25"]');
    await sleep(400);
    let p = await probe(page);
    check(
      'rate 0.25× applies to every live animation and GSAP',
      p.animations.length > 0 && p.animations.every((a) => a.playbackRate === 0.25) && p.gsap?.timeScale === 0.25,
      p.animations.map((a) => a.playbackRate).join(',') + ` gsap ${p.gsap?.timeScale}`,
    );
    await panel.click('.seg-btn[data-rate="1"]');

    await panel.click('button.play');
    await sleep(300);
    const a1 = await probe(page);
    await sleep(500);
    const a2 = await probe(page);
    const frozen = a1.animations.every((a) => {
      const b = a2.animations.find((x) => x.id === a.id);
      return !b || (b.playState === 'paused' && b.currentTime === a.currentTime);
    });
    check('pause freezes currentTime', frozen && a1.animations.every((a) => a.playState === 'paused'), `${a1.animations.length} animations`);
    check('pause pauses GSAP global timeline', a2.gsap?.paused === true && JSON.stringify(a1.gsap?.times) === JSON.stringify(a2.gsap?.times));

    await setRange(panel, '.transport .slider', 400);
    await sleep(400);
    p = await probe(page);
    const scrubbed = p.animations.filter((a) => a.currentTime !== 400);
    // A transition that ends before 400 ms is clamped to its end; everything else should sit exactly at 400.
    check(
      'global scrub sets currentTime = 400 ms',
      p.animations.length > 0 && scrubbed.every((a) => a.kind === 'css-transition'),
      p.animations.map((a) => `${a.name}=${a.currentTime}`).join(' '),
    );
    check('global scrub moves GSAP to 400 ms', !!p.gsap && p.gsap.times.every((t) => Math.abs(t - 400) < 1), p.gsap?.times.join(','));

    await setRange(panel, '.transport .slider', 150);
    await sleep(300);
    p = await probe(page);
    check('scrub again to 150 ms', p.animations.filter((a) => a.kind !== 'css-transition').every((a) => a.currentTime === 150));

    // Per-animation scrub on the WAAPI slide.
    const slideRow = panel.locator('.rows .row', { hasText: 'slide' }).first();
    await slideRow.click();
    await panel.waitForSelector('.detail .slider');
    await setRange(panel, '.detail .slider', 777);
    await sleep(300);
    p = await probe(page);
    const slide = p.animations.find((a) => a.name === 'slide');
    const others = p.animations.filter((a) => a.name !== 'slide' && a.kind !== 'css-transition');
    check('per-animation scrub moves only that animation', slide?.currentTime === 777 && others.every((a) => a.currentTime === 150), `slide=${slide?.currentTime}`);

    // Screenshots: light + dark, with the spring selected for a good curve.
    await panel.locator('.rows .row', { hasText: 'drop' }).first().click();
    await setRange(panel, '.transport .slider', 420);
    await sleep(500);
    await panel.click('.seg-btn[data-tab="motion"]');
    await sleep(200);
    await panel.$eval('.detail', (el) => (el.scrollTop = 0));
    await panel.screenshot({ path: join(SHOTS, 'panel-light.png') });

    const dark = await openPanel(ctx, extId, tabId, 'dark');
    await dark.waitForSelector('.row');
    await sleep(500);
    await dark.locator('.rows .row', { hasText: 'drop' }).first().click();
    await sleep(400);
    await dark.click('.seg-btn[data-tab="motion"]');
    await sleep(300);
    await dark.$eval('.detail', (el) => (el.scrollTop = 0));
    await dark.screenshot({ path: join(SHOTS, 'panel-dark.png') });

    // The whole detail column, for checking the lower sections render.
    await dark.setViewportSize({ width: PANEL_SIZE.width, height: 1700 });
    await sleep(300);
    await dark.screenshot({ path: join(SHOTS, 'detail-full-dark.png') });
    await dark.setViewportSize(PANEL_SIZE);

    // List-only views (nothing selected).
    await dark.keyboard.press('Escape');
    await sleep(300);
    await dark.screenshot({ path: join(SHOTS, 'list-dark.png') });
    await panel.keyboard.press('Escape');
    await sleep(300);
    await panel.screenshot({ path: join(SHOTS, 'list-light.png') });

    // GSAP export screenshot.
    await panel.locator('.rows .row', { hasText: 'rotation' }).first().click();
    await sleep(300);
    await panel.click('.seg-btn[data-tab="gsap"]');
    await sleep(200);
    await panel.$eval('.detail', (el) => (el.scrollTop = 0));
    await panel.screenshot({ path: join(SHOTS, 'export-gsap-light.png') });

    // Overview: page + panel side by side.
    await panel.locator('.rows .row', { hasText: 'drop' }).first().click();
    await panel.click('.seg-btn[data-tab="css"]');
    await sleep(400);
    const panelPng = await panel.screenshot();
    await page.setViewportSize({ width: 1100, height: 900 });
    const pagePng = await page.screenshot();
    const composer = await ctx.newPage();
    await composer.setViewportSize({ width: 1100 + PANEL_SIZE.width, height: 900 });
    await composer.setContent(
      `<body style="margin:0;display:flex;background:#e5e5e5;height:900px">
        <img src="data:image/png;base64,${pagePng.toString('base64')}" style="width:1100px;height:900px">
        <img src="data:image/png;base64,${panelPng.toString('base64')}" style="width:${PANEL_SIZE.width}px;height:900px;border-left:1px solid #d4d4d4">
      </body>`,
    );
    await composer.screenshot({ path: join(SHOTS, 'overview.png') });
    await composer.close();

    // Play resumes.
    await panel.click('button.play');
    await sleep(400);
    p = await probe(page);
    check('play resumes', p.animations.some((a) => a.playState === 'running') && p.gsap?.paused === false);

    await dark.close();
    await panel.close();
    await sleep(500);
    p = await probe(page);
    check('closing the panel leaves the page running at 1×', p.animations.every((a) => a.playbackRate === 1));
    await page.close();
  }

  /* ---------------------------------------------------------------- */
  /* The real side panel                                               */
  /* ---------------------------------------------------------------- */
  {
    // chrome.sidePanel.open needs a user gesture; a Playwright click in an
    // extension page counts as one. The opened panel isn't exposed as a
    // Playwright page, so check its effect: it follows the active tab and
    // injects the agent there.
    const page = await ctx.newPage();
    await page.goto(`${BASE}/waapi.html`);
    const opener = await ctx.newPage();
    await opener.goto(`chrome-extension://${extId}/sidepanel.html?tabId=-1`);
    await opener.evaluate(() => {
      const b = document.createElement('button');
      b.id = 'open-side-panel';
      b.style.cssText = 'position:fixed;inset:0 auto auto 0;width:80px;height:40px;z-index:9';
      b.onclick = async () => {
        const w = await chrome.windows.getCurrent();
        await chrome.sidePanel.open({ windowId: w.id! });
        b.dataset.ok = '1';
      };
      document.body.append(b);
    });
    await opener.click('#open-side-panel');
    await sleep(600);
    await page.bringToFront();
    await sleep(1500);
    const contexts = await sw.evaluate(async () =>
      (await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL' as chrome.runtime.ContextType] })).length,
    );
    const injected = await page.evaluate(() => !!(window as unknown as Record<string, unknown>).__motionInspector);
    check('real side panel opens and attaches to the active tab', contexts === 1 && injected, `contexts=${contexts} injected=${injected}`);
    await opener.close();
    await page.close();
  }

  /* ---------------------------------------------------------------- */
  /* Restricted page                                                   */
  /* ---------------------------------------------------------------- */
  {
    const page = await ctx.newPage();
    await page.goto('chrome://version');
    const tabId = await tabIdFor(sw, page);
    const panel = await openPanel(ctx, extId, tabId);
    await sleep(800);
    const text = (await panel.textContent('.state')) ?? '';
    check('restricted page shows a clear message', /Can’t inspect this page/.test(text), text.slice(0, 60));
    await panel.close();
    await page.close();
  }

  writeFileSync(
    join(ROOT, 'node_modules/.e2e-exports.json'),
    JSON.stringify(allExports, null, 2),
  );
  await ctx.close();
  server.close();
  rmSync(PROFILE, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
