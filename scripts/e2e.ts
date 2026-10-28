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
import { diff, measureAlignment, rects } from './panel-probes';

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

/** Set a scrubber to an exact value: a native range input, or a transport option's role=slider (its `mi-seek` hook). */
async function setRange(panel: Page, selector: string, value: number) {
  await panel.$eval(
    selector,
    (el, v) => {
      if (el instanceof HTMLInputElement) {
        el.value = String(v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        el.dispatchEvent(new CustomEvent('mi-seek', { detail: v }));
      }
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

/** Run `action` and report any stable element that moved more than 0.5px. */
async function noShift(panel: Page, name: string, stable: string[], action: () => Promise<unknown>, settle = 400) {
  const before = await rects(panel, stable);
  await action();
  await sleep(settle);
  const moved = diff(before, await rects(panel, stable));
  check(`no layout shift: ${name}`, moved.length === 0, moved.join('; '));
}

/** Stable parts for any transport option: everything tagged data-part in the transport. */
const CHROME_ANY = ['.top', '.top .status', '.top .host', '.top > .icon-btn', '.variant-switch', '.transport', '.transport [data-part]', '.list-bar', '.seg-btn[data-filter]'];
const DETAIL_ANY = ['.detail-bar', '.back', '.detail-head h2', '.big-curve', '.ease-row', '.scrub-one', '.scrub-one [data-part]', '.export-bar', '.code', '.keyframes'];

const CHROME = ['.top', '.top .status', '.top .host', '.top .icon-btn', 'button.play', '.transport .seg', '.transport .seg-btn', '.transport-row > .icon-btn', '.timeline', '.transport .time', '.list-bar', '.seg-btn[data-filter]'];
const DETAIL = ['.detail-bar', '.back', '.back svg', '.detail-head h2', '.big-curve', '.scrub-one .slider', '.scrub-one .time', '.export-bar', '.seg-btn[data-tab]', '.export-bar .copy', '.code', '.keyframes'];

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
    await panel.waitForSelector('.rows .row', { timeout: 8000 }).catch(() => {});
    await sleep(fx.wait ?? 1200);

    const snap = await page.evaluate(() =>
      (window as unknown as { __motionInspector: { snapshot(): import('../lib/types').AgentSnapshot } }).__motionInspector.snapshot(),
    );
    const list = snap.animations.map((x) => ({ kind: x.spec.kind, name: x.spec.name, easing: x.spec.easing }));
    const [ok, detail] = fx.expect(list, snap.jsDriven.map((j) => `${j.selector} (${j.properties.join(',')})`));
    check(`${fx.file}: captures expected animations`, ok, detail);

    // Rows are grouped and ended ones are filtered out, so compare against the "All" count.
    const rows = await panel.$$eval('.rows .row', (els) => els.length);
    await panel.click('.seg-btn[data-filter="all"]');
    await sleep(300);
    const allCount = Number(await panel.textContent('.seg-btn[data-filter="all"] .seg-count'));
    await panel.click('.seg-btn[data-filter="live"]');
    check(`${fx.file}: panel lists them`, rows >= 1 && Math.abs(allCount - snap.animations.length) <= 1, `${rows} rows, all=${allCount}, agent=${snap.animations.length}`);

    // Export every format for the first animation row.
    await panel.click('.rows .row[data-id]');
    await panel.waitForSelector('.detail .code');
    const ex = await exportsFor(panel);
    allExports[fx.file] = ex;
    const bad = Object.entries(MARKERS).filter(([k, re]) => !re.test(ex[k] ?? '') || /undefined|NaN/.test(ex[k] ?? ''));
    check(`${fx.file}: exports look like code`, bad.length === 0, bad.map(([k]) => k).join(', '));

    if (fx.file === 'motion.html') {
      await panel.keyboard.press('Escape');
      await sleep(200);
      await panel.locator('.rows .row[data-id]', { hasText: 'm-spring' }).first().click();
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
    await panel.waitForSelector('.rows .row');
    await sleep(800);

    // Alignment: status dot on the host's cap height, transport on one centre line.
    const al = await measureAlignment(panel);
    check('status dot centred on the host cap height (±0.5px)', Math.abs(al.dotVsCap) <= 0.5, `${al.dotVsCap}px`);
    check('play, speed and restart share one centre line', al.segVsPlay === 0 && al.restartVsPlay === 0, `seg ${al.segVsPlay} restart ${al.restartVsPlay}`);
    check('dot / play share the left gutter; theme / restart the right', al.dotLeftVsPlayLeft === 0 && al.themeRightVsRestartRight === 0, `left ${al.dotLeftVsPlayLeft} right ${al.themeRightVsRestartRight}`);
    const status0 = await panel.$eval('.top .status', (el) => ({ state: (el as HTMLElement).dataset.state, word: el.textContent, title: (el as HTMLElement).title }));
    check('header dot says Live (screen reader text + tooltip)', status0.state === 'live' && status0.word === 'Live' && /Live/.test(status0.title), JSON.stringify(status0));

    for (const f of ['ended', 'all', 'live']) {
      await noShift(panel, `filter → ${f} keeps chrome + filter bar still`, CHROME, () => panel.click(`.seg-btn[data-filter="${f}"]`));
    }
    await noShift(panel, 'pause keeps transport + header still', CHROME, () => panel.click('button.play'));
    const status1 = await panel.$eval('.top .status', (el) => ({ state: (el as HTMLElement).dataset.state, word: el.textContent }));
    check('header dot says Paused', status1.state === 'paused' && status1.word === 'Paused', JSON.stringify(status1));
    await noShift(panel, 'play keeps transport + header still', CHROME, () => panel.click('button.play'));

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
    const slideRow = panel.locator('.rows .row[data-id]', { hasText: 'slide' }).first();
    await noShift(panel, 'drill in keeps header + transport still', CHROME.slice(0, 10), () => slideRow.click());
    await panel.waitForSelector('.detail .slider');
    const chev = await measureAlignment(panel);
    check('back chevron centred on its label cap height (±0.5px)', chev.chevronVsCap != null && Math.abs(chev.chevronVsCap) <= 0.5, `${chev.chevronVsCap}px`);
    for (const t of ['linear', 'motion', 'gsap', 'css']) {
      await noShift(panel, `export tab → ${t}`, DETAIL, () => panel.click(`.seg-btn[data-tab="${t}"]`), 200);
    }
    await noShift(panel, 'Copy → Copied keeps the button size', DETAIL, () => panel.click('.export-bar .copy'), 200);
    await noShift(panel, 'paused detail: polling + global scrub keep readout + slider still', DETAIL, () => setRange(panel, '.transport .slider', 1234), 1200);
    await setRange(panel, '.transport .slider', 150);
    await sleep(300);
    await setRange(panel, '.detail .slider', 777);
    await sleep(300);
    p = await probe(page);
    const slide = p.animations.find((a) => a.name === 'slide');
    const others = p.animations.filter((a) => a.name !== 'slide' && a.kind !== 'css-transition');
    check('per-animation scrub moves only that animation', slide?.currentTime === 777 && others.every((a) => a.currentTime === 150), `slide=${slide?.currentTime}`);

    // Screenshots: light + dark, with the spring selected for a good curve.
    await panel.keyboard.press('Escape');
    await sleep(200);
    await panel.locator('.rows .row[data-id]', { hasText: 'drop' }).first().click();
    await setRange(panel, '.transport .slider', 420);
    await sleep(500);
    await panel.click('.seg-btn[data-tab="motion"]');
    await sleep(200);
    await panel.$eval('.detail-scroll', (el) => (el.scrollTop = 0));
    await panel.screenshot({ path: join(SHOTS, 'detail-light.png') });

    const dark = await openPanel(ctx, extId, tabId, 'dark');
    await dark.waitForSelector('.rows .row');
    await sleep(500);
    await dark.locator('.rows .row[data-id]', { hasText: 'drop' }).first().click();
    await sleep(400);
    await dark.click('.seg-btn[data-tab="motion"]');
    await sleep(300);
    await dark.$eval('.detail-scroll', (el) => (el.scrollTop = 0));
    await dark.screenshot({ path: join(SHOTS, 'detail-dark.png') });

    // The whole detail column, for checking the lower sections render.
    await dark.setViewportSize({ width: PANEL_SIZE.width, height: 1500 });
    await sleep(300);
    await dark.screenshot({ path: join(SHOTS, 'detail-full-dark.png') });
    await dark.setViewportSize(PANEL_SIZE);

    // Back to the list: Escape returns focus to the row we came from.
    await dark.keyboard.press('Escape');
    await sleep(300);
    const backFocus = await dark.evaluate(() => (document.activeElement as HTMLElement | null)?.textContent ?? '');
    check('Escape goes back to the list and refocuses the row', /drop/.test(backFocus), backFocus.slice(0, 40));
    await dark.keyboard.press('ArrowDown');
    const nextFocus = await dark.evaluate(() => (document.activeElement as HTMLElement | null)?.matches('.row[data-nav]') ?? false);
    check('ArrowDown moves focus to the next row', nextFocus);
    await dark.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await dark.screenshot({ path: join(SHOTS, 'list-dark.png') });
    await panel.keyboard.press('Escape');
    await sleep(300);
    await panel.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await panel.screenshot({ path: join(SHOTS, 'list-light.png') });

    // GSAP export screenshot.
    await panel.locator('.rows .row[data-id]', { hasText: 'rotation' }).first().click();
    await sleep(300);
    await panel.click('.seg-btn[data-tab="gsap"]');
    await sleep(200);
    await panel.$eval('.detail-scroll', (el) => (el.scrollTop = 0));
    await panel.screenshot({ path: join(SHOTS, 'export-gsap-light.png') });

    // Overview: page + panel side by side.
    await panel.keyboard.press('Escape');
    await sleep(200);
    await panel.locator('.rows .row[data-id]', { hasText: 'drop' }).first().click();
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
  /* Transport options A, B, C: alignment, no-shift, keys, semantics   */
  /* ---------------------------------------------------------------- */
  for (const v of ['a', 'b', 'c'] as const) {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/all.html`);
    await sleep(800);
    const tabId = await tabIdFor(sw, page);
    const panel = await ctx.newPage();
    await panel.setViewportSize(PANEL_SIZE);
    await panel.goto(`chrome-extension://${extId}/sidepanel.html?tabId=${tabId}&theme=light&transport=${v}`);
    await panel.waitForSelector('.rows .row');
    await sleep(800);
    const T = `[${v.toUpperCase()}]`;
    const G = '.transport [data-part=scrubber]';
    const agent = () =>
      page.evaluate(() => (window as unknown as { __motionInspector: { snapshot(): import('../lib/types').AgentSnapshot } }).__motionInspector.snapshot());
    const near = (n: number) => Math.abs(n) <= 0.5;

    // Alignment (live list).
    const al = await measureAlignment(panel);
    check(`${T} transport row shares the play button's centre line`, near(al.rowVsPlay), `${al.rowVsPlay}px (${al.rowParts})`);
    check(`${T} first / last control on the gutters (dot / theme)`, near(al.startVsDot) && near(al.endVsTheme), `left ${al.startVsDot} right ${al.endVsTheme}`);
    check(`${T} timeline row spans gutter to gutter`, near(al.timelineLeftVsDot) && near(al.timelineRightVsTheme), `left ${al.timelineLeftVsDot} right ${al.timelineRightVsTheme}`);
    check(`${T} status dot still on the host cap height`, near(al.dotVsCap), `${al.dotVsCap}px`);

    // Slider semantics.
    const sem = await panel.$eval(G, (el) => ({
      role: el.getAttribute('role'),
      tab: el.getAttribute('tabindex'),
      text: el.getAttribute('aria-valuetext') ?? '',
      label: el.getAttribute('aria-label') ?? '',
      h: el.getBoundingClientRect().height,
    }));
    check(`${T} global scrubber is a labelled slider with a 24px+ hit area`, sem.role === 'slider' && sem.tab === '0' && !!sem.label && sem.h >= 24, `${sem.role} h=${sem.h}`);
    check(`${T} live slider says it's live`, /^Live, timeline \d+ milliseconds$/.test(sem.text), sem.text);
    check(`${T} transport says live`, (await panel.$eval('.transport', (el) => (el as HTMLElement).dataset.state)) === 'live');

    // No-shift: pause, play, speed, keyboard step, scrub, drag, hover.
    await noShift(panel, `${T} pause (K) keeps chrome still`, CHROME_ANY, () => panel.keyboard.press('k'));
    let a = await agent();
    check(`${T} K pauses`, a.paused);
    check(`${T} transport shows paused`, (await panel.$eval('.transport', (el) => (el as HTMLElement).dataset.state)) === 'paused');
    await noShift(panel, `${T} play (Space) keeps chrome still`, CHROME_ANY, () => panel.keyboard.press(' '));
    a = await agent();
    check(`${T} Space plays`, !a.paused);

    if (v === 'a') {
      await noShift(panel, `${T} speed pill cycles without moving`, CHROME_ANY, () => panel.click('.ta-speed'));
      check(`${T} speed pill: 1× → 0.1×`, (await agent()).rate === 0.1);
      for (let i = 0; i < 3; i++) await panel.click('.ta-speed');
      await sleep(300);
      check(`${T} speed pill cycles back to 1×`, (await agent()).rate === 1);
    } else if (v === 'b') {
      await noShift(panel, `${T} speed stepper − keeps chrome still`, CHROME_ANY, () => panel.click('.tb-step-rate >> nth=0'));
      check(`${T} stepper − : 1× → 0.5×`, (await agent()).rate === 0.5);
      await panel.click('.tb-step-rate >> nth=1');
      await sleep(300);
      check(`${T} stepper + : back to 1×`, (await agent()).rate === 1);
    } else {
      await noShift(panel, `${T} speed popover opens over the list`, [...CHROME_ANY, '.rows .row'], () => panel.click('.tc-speed'));
      const open = await panel.$eval('.tc-menu', (el) => getComputedStyle(el).visibility);
      check(`${T} speed popover is visible`, open === 'visible');
      await panel.click('.tc-item[data-rate="0.25"]');
      await sleep(400);
      check(`${T} popover sets 0.25×`, (await agent()).rate === 0.25);
      await panel.focus('.tc-speed');
      await panel.keyboard.press('ArrowDown');
      await sleep(250);
      const focused = await panel.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.rate ?? '');
      check(`${T} ArrowDown opens the popover on the checked item`, focused === '0.25', focused);
      await panel.keyboard.press('ArrowDown');
      await panel.keyboard.press('Enter');
      await sleep(400);
      check(`${T} keyboard picks 0.5×`, (await agent()).rate === 0.5);
      await panel.click('.tc-speed');
      await panel.keyboard.press('Escape');
      await sleep(250);
      const menuGone = await panel.$eval('.tc-menu', (el) => getComputedStyle(el).visibility);
      const backOnButton = await panel.evaluate(() => document.activeElement?.classList.contains('tc-speed') ?? false);
      check(`${T} Escape closes the popover and returns focus`, menuGone === 'hidden' && backOnButton, `${menuGone} ${backOnButton}`);
      await panel.click('.tc-speed');
      await panel.click('.tc-item[data-rate="1"]');
      await sleep(300);
    }

    // J / L shuttle the speed.
    await panel.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await panel.keyboard.press('j');
    await sleep(350);
    const jr = (await agent()).rate;
    await panel.keyboard.press('l');
    await sleep(350);
    check(`${T} J slower, L faster`, jr === 0.5 && (await agent()).rate === 1, `J→${jr}`);

    // Scrub to an exact time, then step frames from the keyboard.
    await noShift(panel, `${T} global scrub keeps chrome still`, CHROME_ANY, () => setRange(panel, G, 400));
    let p = await probe(page);
    check(`${T} scrub sets currentTime = 400 ms`, p.animations.filter((x) => x.kind !== 'css-transition').every((x) => x.currentTime === 400), p.animations.map((x) => `${x.name}=${x.currentTime}`).join(' '));
    const text = await panel.$eval(G, (el) => el.getAttribute('aria-valuetext') ?? '');
    check(`${T} aria-valuetext reads the position`, /^400 of \d+ milliseconds$/.test(text), text);
    await panel.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await noShift(panel, `${T} '.' frame step keeps chrome still`, CHROME_ANY, async () => {
      for (let i = 0; i < 3; i++) await panel.keyboard.press('.');
    });
    p = await probe(page);
    const slide = p.animations.find((x) => x.name === 'slide');
    check(`${T} '.' ×3 steps three frames (400 → 450 ms)`, !!slide && Math.abs((slide.currentTime ?? 0) - 450) < 0.5, `slide=${slide?.currentTime}`);
    await panel.keyboard.press(',');
    await panel.keyboard.press('ArrowLeft');
    await sleep(400);
    p = await probe(page);
    const s2 = p.animations.find((x) => x.name === 'slide');
    check(`${T} ',' and ← step back`, !!s2 && Math.abs((s2.currentTime ?? 0) - 416.67) < 0.5, `slide=${s2?.currentTime}`);
    await panel.focus(G);
    await panel.keyboard.press('Home');
    await sleep(400);
    p = await probe(page);
    check(`${T} Home on the slider goes to 0`, p.animations.filter((x) => x.kind !== 'css-transition').every((x) => x.currentTime === 0));
    await panel.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    // A real pointer drag: nothing but the playhead moves.
    const box = (await panel.locator(G).boundingBox())!;
    await noShift(panel, `${T} pointer drag keeps chrome still`, CHROME_ANY, async () => {
      await panel.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
      await panel.mouse.down();
      await panel.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, { steps: 8 });
      await sleep(200);
      check(`${T} transport shows scrubbing while dragging`, (await panel.$eval('.transport', (el) => (el as HTMLElement).dataset.state)) === 'scrubbing');
      await panel.mouse.up();
    });
    const focusRing = await panel.$eval(G, (el) => el.matches(':focus-visible'));
    check(`${T} no focus ring after a pointer drag`, !focusRing);
    await noShift(panel, `${T} hover over the scrubber keeps chrome still`, CHROME_ANY, () => panel.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2));
    await panel.mouse.move(200, 700);

    // Detail scrubber on the infinite spring.
    await panel.keyboard.press('k');
    await sleep(300);
    await panel.locator('.rows .row[data-id]', { hasText: 'drop' }).first().click();
    await panel.waitForSelector('.scrub-one [data-part=scrubber]');
    await sleep(500);
    const dal = await measureAlignment(panel);
    check(`${T} detail scrubber lines up with the easing row`, near(dal.detailScrubLeft ?? 9) && near(dal.detailScrubRight ?? 9), `left ${dal.detailScrubLeft} right ${dal.detailScrubRight}`);
    check(`${T} detail scrubber hit area 24px+`, (dal.detailScrubberHeight ?? 0) >= 24, `${dal.detailScrubberHeight}`);
    await noShift(panel, `${T} live detail: 2 s of polling moves nothing`, [...CHROME_ANY, ...DETAIL_ANY], () => sleep(2000), 0);
    await noShift(panel, `${T} pause in detail moves nothing`, [...CHROME_ANY, ...DETAIL_ANY], () => panel.keyboard.press('k'));
    const dText = await panel.$eval('.scrub-one [data-part=scrubber]', (el) => el.getAttribute('aria-valuetext') ?? '');
    check(`${T} detail aria-valuetext: "N of 972 milliseconds, iteration N"`, /^\d+ of 972 milliseconds, iteration \d+$/.test(dText), dText);
    await noShift(panel, `${T} detail scrub moves nothing`, [...CHROME_ANY, ...DETAIL_ANY], () => setRange(panel, '.scrub-one [data-part=scrubber]', 300));
    p = await probe(page);
    const drop = p.animations.find((x) => x.name === 'drop');
    check(`${T} detail scrub moves that animation inside its iteration`, !!drop && Math.abs((((drop.currentTime ?? 0) - 300) % 972) - 300) < 1, `drop=${drop?.currentTime}`);
    const dbox = (await panel.locator('.scrub-one [data-part=scrubber]').boundingBox())!;
    await noShift(panel, `${T} detail pointer drag moves nothing`, [...CHROME_ANY, ...DETAIL_ANY], async () => {
      await panel.mouse.move(dbox.x + dbox.width * 0.3, dbox.y + dbox.height / 2);
      await panel.mouse.down();
      await panel.mouse.move(dbox.x + dbox.width * 0.7, dbox.y + dbox.height / 2, { steps: 8 });
      await panel.mouse.up();
    });
    await panel.keyboard.press('Escape');
    await sleep(300);
    await panel.keyboard.press('k');
    await panel.close();
    await page.close();
  }

  /* Switching options from the header swaps the transport in place. */
  {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/all.html`);
    await sleep(600);
    const tabId = await tabIdFor(sw, page);
    const panel = await openPanel(ctx, extId, tabId);
    await panel.waitForSelector('.rows .row');
    const seen: string[] = [];
    for (const v of ['a', 'b', 'c', 'current']) {
      await noShift(panel, `switch → ${v} keeps the header still`, ['.top', '.top .host', '.top > .icon-btn', '.variant-switch'], () => panel.click(`.variant-switch [data-variant="${v}"]`), 300);
      seen.push(await panel.$eval('.transport', (el) => (el as HTMLElement).dataset.variant ?? ''));
    }
    check('header switch swaps the transport (a, b, c, current)', seen.join(',') === 'a,b,c,current', seen.join(','));
    await panel.close();
    await page.close();
  }

  /* ---------------------------------------------------------------- */
  /* Noisy page: grouping, ended filter, zero-length, iteration readout */
  /* ---------------------------------------------------------------- */
  {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/noisy.html`);
    await sleep(600);
    const tabId = await tabIdFor(sw, page);


    const panel = await openPanel(ctx, extId, tabId);
    await panel.waitForSelector('.rows .row');
    // Let the pulses run past two iterations and the chips finish a few transitions.
    await sleep(4600);

    const polls = await page.evaluate(() => {
      type Poll = { session: string; order: string[]; specs: unknown[] };
      const mi = (window as unknown as { __motionInspector: { poll(s: string | null, k: string[]): Poll } }).__motionInspector;
      const first = mi.poll(null, []);
      const second = mi.poll(first.session, first.order);
      return { order: first.order.length, firstSpecs: first.specs.length, secondSpecs: second.specs.length };
    });
    check('poll sends specs once, then only live state', polls.firstSpecs === polls.order && polls.secondSpecs <= 2, JSON.stringify(polls));

    const group = panel.locator('.rows .row.is-group', { hasText: 'pulse' });
    const count = (await group.locator('.row-count').textContent()) ?? '';
    check('noisy.html: 12 animate-pulse skeletons collapse into one row', (await group.count()) === 1 && count === '×12', count);
    const subtitle = (await group.locator('.row-sub').textContent()) ?? '';
    check('noisy.html: group subtitle names the element, not a selector path', /12 elements · div in article\.card/.test(subtitle), subtitle);

    const liveEnded = await panel.$$eval('.rows .row[data-id].is-ended', (els) => els.length);
    const liveCount = Number(await panel.textContent('.seg-btn[data-filter="live"] .seg-count'));
    const endedCount = Number(await panel.textContent('.seg-btn[data-filter="ended"] .seg-count'));
    check('noisy.html: Live filter (default) hides ended animations', liveEnded === 0 && endedCount > 0, `live=${liveCount} ended=${endedCount}`);
    const noop = (await panel.textContent('.noop-note')) ?? '';
    check('noisy.html: zero-length animations are hidden with a note', /zero-length animations? hidden/.test(noop), noop);

    await panel.screenshot({ path: join(SHOTS, 'noisy-light.png') });

    await panel.click('.seg-btn[data-filter="ended"]');
    await sleep(400);
    const endedRows = await panel.$$eval('.rows .row', (els) => els.map((e) => e.classList.contains('is-ended')));
    check('noisy.html: Ended filter shows only ended animations', endedRows.length > 0 && endedRows.every(Boolean), `${endedRows.length} rows`);
    await panel.click('.seg-btn[data-filter="live"]');
    await sleep(300);

    await group.click();
    await sleep(300);
    const children = await panel.$$eval('.rows .row.is-child', (els) => els.length);
    check('noisy.html: expanding the group lists all 12 elements', children === 12, `${children}`);
    await panel.screenshot({ path: join(SHOTS, 'noisy-expanded-light.png') });

    // Live child detail: the per-animation readout ticks every poll without moving anything.
    await panel.locator('.rows .row.is-child').first().click();
    await panel.waitForSelector('.detail .scrub-one .time');
    await sleep(300);
    await noShift(panel, 'live detail: 2 s of polling moves nothing', [...CHROME.slice(0, 10), ...DETAIL], () => sleep(2000), 0);
    await noShift(panel, 'Esc back keeps header + transport still', CHROME.slice(0, 10), () => panel.keyboard.press('Escape'));

    // Pause, then open one pulse: readout is the position inside the current iteration.
    await panel.click('button.play');
    await sleep(400);
    await panel.locator('.rows .row.is-child').first().click();
    await panel.waitForSelector('.detail .scrub-one .time');
    await sleep(400);
    const readout = (await panel.textContent('.detail .scrub-one .time')) ?? '';
    const slider = await panel.$eval('.detail .slider', (el) => ({ value: Number((el as HTMLInputElement).value), max: Number((el as HTMLInputElement).max) }));
    const p = await probe(page);
    const pulse = p.animations.find((a) => a.name === 'pulse');
    const m = readout.match(/^(\d+) \/ 2000 ms · iteration (\d+)$/);
    const expected = pulse?.currentTime != null ? Math.round(pulse.currentTime % 2000) : -1;
    check(
      'iteration readout shows the time inside the current iteration',
      !!m && Number(m[2]) >= 2 && slider.max === 2000 && slider.value <= slider.max,
      `${readout}; slider ${slider.value}/${slider.max}`,
    );
    check('iteration readout matches the page', !!m && Math.abs(Number(m[1]) - expected) <= 1 || !pulse, `readout ${m?.[1]} page ${expected} (currentTime ${pulse?.currentTime})`);
    await panel.$eval('.detail-scroll', (el) => (el.scrollTop = 0));
    await panel.screenshot({ path: join(SHOTS, 'noisy-detail-light.png') });

    const dark = await openPanel(ctx, extId, tabId, 'dark');
    await dark.waitForSelector('.rows .row');
    await sleep(600);
    await dark.screenshot({ path: join(SHOTS, 'noisy-dark.png') });
    await dark.locator('.rows .row.is-group', { hasText: 'pulse' }).click();
    await sleep(200);
    await dark.locator('.rows .row.is-child').first().click();
    await sleep(500);
    await dark.screenshot({ path: join(SHOTS, 'noisy-detail-dark.png') });

    await panel.click('button.play');
    await dark.close();
    await panel.close();
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
