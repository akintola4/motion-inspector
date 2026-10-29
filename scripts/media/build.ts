// Regenerate the README media in docs/media from the real extension.
//
//   pnpm media                # build, capture, render everything
//   pnpm media --only hero    # or: gif
//   pnpm media --render       # re-render from the last capture (layout tweaks)
//
// Loads dist/chrome-mv3 into Playwright's Chromium, opens fixtures/demo.html
// as http://localhost:3000/deploys and drives the panel page against it, the
// same way scripts/e2e.ts does. Every state is a screenshot of the real panel
// and the real page; build.ts only draws the browser window around them and
// the pointer. Needs ffmpeg on PATH. See docs/media.md.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXT = join(ROOT, 'dist', 'chrome-mv3');
const CACHE = join(ROOT, '.media-cache');
const CAPTURES = join(CACHE, 'captures');
const STAGE = join(CACHE, 'stage');
const FRAMES = join(CACHE, 'frames');
const OUT = join(ROOT, 'docs', 'media');

const { values } = parseArgs({ options: { only: { type: 'string' }, render: { type: 'boolean' } } });
const only = values.only;
if (only && only !== 'hero' && only !== 'gif') throw new Error('--only takes hero or gif');

/** The demo page is served under a dev-server URL so the panel and the omnibox read like a real project. */
const ORIGIN = 'http://localhost:3000';
const PAGE_PATH = '/deploys';
const ROUTES: Record<string, string> = {
  [PAGE_PATH]: join(ROOT, 'fixtures', 'demo.html'),
  '/vendor/gsap.js': join(ROOT, 'node_modules', 'gsap', 'dist', 'gsap.min.js'),
  '/vendor/motion.js': join(ROOT, 'node_modules', 'motion', 'dist', 'motion.js'),
};

type Theme = 'light' | 'dark';
interface Size { width: number; height: number }
interface Point { x: number; y: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ffmpeg(args: string[]): void {
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
}

function kb(path: string): string {
  return `${Math.round(statSync(path).size / 1024)} KB`;
}

// ---------------------------------------------------------------- layout

/**
 * One browser window: tab strip and toolbar, the page on the left, Chrome's
 * side panel (a rounded card with its own header) on the right. All sizes are
 * CSS px. Every edge an image sits on is a multiple of 4 (GIF, 1.25x) or 2
 * (hero, 1.5x), so the screenshots land on whole device pixels and stay sharp.
 */
interface Layout {
  dpr: number;
  stage: Size;
  win: Point & Size;
  page: Size;
  panel: Size;
}
const TABS = 36, TOOLBAR = 40, CHROME = TABS + TOOLBAR, GUTTER = 8, PANEL_HEAD = 36;

function layout(dpr: number, stage: Size, win: Point & Size, panelW: number): Layout {
  const contentH = win.height - CHROME;
  return {
    dpr,
    stage,
    win,
    page: { width: win.width - panelW - GUTTER * 2, height: contentH },
    panel: { width: panelW, height: contentH - PANEL_HEAD - GUTTER * 2 },
  };
}
/** 1920x1080 PNG. */
const HERO = layout(1.5, { width: 1280, height: 720 }, { x: 48, y: 36, width: 1184, height: 648 }, 380);
/** 1100x805 GIF: GitHub shows it at ~880px, which puts the panel's 13px text at about 13px. */
const GIF = layout(1.25, { width: 880, height: 644 }, { x: 16, y: 16, width: 848, height: 612 }, 336);

/** Where the page and the panel sit on the stage. */
function origins(l: Layout) {
  const top = l.win.y + CHROME;
  return {
    page: { x: l.win.x, y: top },
    panel: { x: l.win.x + l.page.width + GUTTER, y: top + GUTTER + PANEL_HEAD },
  };
}

// ---------------------------------------------------------------- capture

interface Session { ctx: BrowserContext; page: Page; panel: Page }

async function open(l: Layout, theme: Theme): Promise<Session> {
  if (!existsSync(join(EXT, 'manifest.json'))) throw new Error('dist/chrome-mv3 is missing: run pnpm build first');
  const ctx = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: !process.env.HEADED,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--hide-scrollbars'],
    viewport: l.page,
    deviceScaleFactor: l.dpr,
    colorScheme: theme,
  });
  await ctx.route(`${ORIGIN}/**`, async (route) => {
    const file = ROUTES[new URL(route.request().url()).pathname];
    if (!file) return route.fulfill({ status: 404, body: 'not found' });
    const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8';
    await route.fulfill({ status: 200, contentType: type, body: readFileSync(file) });
  });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(ORIGIN + PAGE_PATH);
  await page.bringToFront();
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id ?? -1);
  const panel = await ctx.newPage();
  await panel.setViewportSize(l.panel);
  await panel.goto(`chrome-extension://${extId}/sidepanel.html?tabId=${tabId}&theme=${theme}`);
  await panel.waitForSelector('.rows .row');
  await panel.evaluate('document.fonts.ready');
  await sleep(1200);
  return { ctx, page, panel };
}

const SCRUBBER = '.transport [data-part=scrubber]';

/** Move every animation to `ms` from its start through the scrubber's test hook, the same path a drag takes. */
async function seek(s: Session, ms: number) {
  await s.panel.$eval(SCRUBBER, (el, v) => el.dispatchEvent(new CustomEvent('mi-seek', { detail: v })), ms);
  await sleep(320);
}

async function center(p: Page, selector: string, fx = 0.5, fy = 0.5): Promise<Point> {
  const b = await p.locator(selector).first().boundingBox();
  if (!b) throw new Error(`not on screen: ${selector}`);
  return { x: b.x + b.width * fx, y: b.y + b.height * fy };
}

const rowFor = (name: string) => `.rows .row[data-id]:has(.row-name:text-is("${name}"))`;

/** Hero: paused part-way through, the "load" row hovered so its element is outlined on the page. */
const HERO_TIME = 1150;

async function captureHero(theme: Theme) {
  const dir = join(CAPTURES, `hero-${theme}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const s = await open(HERO, theme);
  try {
    await s.panel.keyboard.press('k');
    await sleep(400);
    await seek(s, HERO_TIME);
    const row = await center(s.panel, rowFor('load'), 0.4);
    await s.panel.mouse.move(row.x, row.y);
    await sleep(500);
    await s.panel.screenshot({ path: join(dir, 'panel.png') });
    await s.page.screenshot({ path: join(dir, 'page.png') });
  } finally {
    await s.ctx.close();
  }
  console.log(`captured hero-${theme}`);
}

/** One GIF frame: which panel and page screenshot, where the pointer is (stage px), frames since the last click. */
interface Frame { panel: number; page: number; x: number; y: number; press: number }
interface GifCapture { panels: string[]; pages: string[]; frames: Frame[]; fps: number }

const FPS = 20;
const LIVE_MS = 2000;

const easeInOut = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const lerp = (a: Point, b: Point, p: number): Point => ({ x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p });

/**
 * The GIF is captured frame by frame at 20 fps: every frame where the pointer
 * is over the panel moves the real mouse there and screenshots the panel, so
 * hover states, the scrubber preview and the drag are exactly what the panel
 * drew at that pointer position. The page is re-shot whenever it can change.
 */
async function captureGif() {
  const dir = join(CAPTURES, 'gif');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const o = origins(GIF);
  const s = await open(GIF, 'light');
  const cap: GifCapture = { panels: [], pages: [], frames: [], fps: FPS };
  let panelIdx = -1, pageIdx = -1, press = 99;
  let cur: Point = { x: o.page.x + GIF.page.width * 0.72, y: o.page.y + GIF.page.height * 0.17 };
  const toStage = (p: Point): Point => ({ x: o.panel.x + p.x, y: o.panel.y + p.y });
  const inPanel = (p: Point) => p.x >= o.panel.x && p.y >= o.panel.y && p.x < o.panel.x + GIF.panel.width && p.y < o.panel.y + GIF.panel.height;

  const shotPanel = async () => {
    const f = join(dir, `panel-${cap.panels.length}.png`);
    await s.panel.screenshot({ path: f });
    cap.panels.push(f);
    panelIdx = cap.panels.length - 1;
  };
  const shotPage = async () => {
    const f = join(dir, `page-${cap.pages.length}.png`);
    await s.page.screenshot({ path: f });
    cap.pages.push(f);
    pageIdx = cap.pages.length - 1;
  };
  const push = (n = 1) => {
    for (let i = 0; i < n; i++) {
      cap.frames.push({ panel: panelIdx, page: pageIdx, x: cur.x, y: cur.y, press });
      press++;
    }
  };
  const moveMouse = async (p: Point, down = false) => {
    if (!inPanel(p)) return;
    await s.panel.mouse.move(p.x - o.panel.x, p.y - o.panel.y);
    await sleep(down ? 140 : 70);
  };
  /** Glide the pointer to `to` over `n` frames, shooting the panel (and the page) at each step. */
  const glide = async (to: Point, n: number, opts: { page?: boolean; down?: boolean } = {}) => {
    const from = cur;
    for (let k = 1; k <= n; k++) {
      cur = lerp(from, to, easeInOut(k / n));
      await moveMouse(cur, opts.down);
      if (inPanel(cur)) await shotPanel();
      if (opts.page) await shotPage();
      push();
    }
  };
  const click = async () => {
    await s.panel.mouse.down();
    await s.panel.mouse.up();
    press = 0;
  };

  try {
    // 1. Live. The panel shows LIVE with the bars still; the pointer comes in to the pause button.
    await shotPanel();
    const play = toStage(await center(s.panel, '.transport [data-part=play]'));
    const liveFrames = Math.round((LIVE_MS / 1000) * FPS);
    const liveStart = cap.frames.length;
    push(liveFrames - 16);
    await glide(play, 16);
    // Page frames for the live part: pause, then step every animation through the same times.
    await click();
    await sleep(300);
    for (let i = 0; i < liveFrames; i++) {
      await seek(s, (i * 1000) / FPS);
      await shotPage();
      cap.frames[liveStart + i]!.page = pageIdx;
    }

    // 2. Paused at LIVE_MS.
    await seek(s, LIVE_MS);
    await shotPage();
    await shotPanel();
    push(12);

    // 3. Hover the waveform: the preview takes the readout's place and its time changes in place.
    const wave = await s.panel.locator(SCRUBBER).boundingBox();
    if (!wave) throw new Error('no scrubber');
    const at = (f: number) => toStage({ x: wave.x + wave.width * f, y: wave.y + wave.height * 0.55 });
    await glide(at(0.9), 10);
    await glide(at(0.24), 30);
    push(4);

    // 4. Press and drag: everything moves to the same time.
    await s.panel.mouse.down();
    await sleep(250);
    await shotPanel();
    await shotPage();
    push(2);
    await glide(at(0.64), 30, { page: true, down: true });
    await s.panel.mouse.up();
    await sleep(250);
    await shotPanel();
    push(8);

    // 5. Hover the "load" row (its element is outlined on the page), open it.
    const load = toStage(await center(s.panel, rowFor('load'), 0.32));
    await glide(load, 14, { page: true });
    await sleep(300);
    await shotPanel();
    await shotPage();
    push(10);
    await click();
    await s.panel.waitForSelector('.detail-scroll');
    await sleep(500);
    await shotPanel();
    await shotPage();
    push(16);

    // 6. Scroll the detail down until the Export section sits at the top, the pointer resting at the side.
    const target = await s.panel.$eval('.detail-scroll', (el) => {
      const head = el.querySelector('.section.export')!.getBoundingClientRect();
      return Math.round(head.top - el.getBoundingClientRect().top - 12);
    });
    await glide(toStage({ x: GIF.panel.width - 40, y: GIF.panel.height * 0.72 }), 10);
    for (let k = 1; k <= 12; k++) {
      const y = Math.round(target * easeInOut(k / 12));
      await s.panel.$eval('.detail-scroll', (el, v) => (el.scrollTop = v), y);
      await sleep(60);
      await shotPanel();
      push();
    }
    push(8);

    // 7. Export tabs: CSS → Motion → GSAP, then Copy.
    for (const tab of ['motion', 'gsap']) {
      await glide(toStage(await center(s.panel, `.seg-btn[data-tab="${tab}"]`, 0.5, 0.72)), tab === 'motion' ? 12 : 9);
      await click();
      await sleep(200);
      await shotPanel();
      push(26);
    }
    await glide(toStage(await center(s.panel, '.export-bar .copy', 0.3, 0.78)), 10);
    await click();
    await sleep(200);
    await shotPanel();
    push(22);
  } finally {
    await s.ctx.close();
  }
  writeFileSync(join(dir, 'capture.json'), JSON.stringify(cap));
  console.log(`captured gif: ${cap.frames.length} frames, ${cap.panels.length} panel and ${cap.pages.length} page shots`);
}

// ---------------------------------------------------------------- stage

const FONT_UI = `-apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif`;

const CHROME_THEME = {
  light: { tabs: '#e3e5e8', bar: '#ffffff', omni: '#eef0f2', fg: '#1f1f1f', dim: '#5f6368', line: '#dcdfe3', light: '#d1d4d8', border: 'rgba(15,20,30,.14)', shadow: '0 24px 60px -18px rgba(15,20,30,.32), 0 8px 20px -10px rgba(15,20,30,.18)' },
  dark: { tabs: '#18181b', bar: '#26262a', omni: '#1b1b1e', fg: '#ececef', dim: '#a1a1aa', line: '#36363c', light: '#3f3f46', border: 'rgba(255,255,255,.12)', shadow: '0 24px 60px -18px rgba(0,0,0,.6), 0 8px 20px -10px rgba(0,0,0,.4)' },
};

const ICON_SVG = readFileSync(join(ROOT, 'public', 'icon.svg'), 'utf8');
const dataUri = (svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`;
const stroke = (d: string, size = 16, w = 1.75) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const I = {
  back: stroke('<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>'),
  fwd: stroke('<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>'),
  reload: stroke('<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>'),
  tune: stroke('<path d="M4 7h10"/><path d="M18 7h2"/><circle cx="16" cy="7" r="2"/><path d="M4 17h2"/><path d="M10 17h10"/><circle cx="8" cy="17" r="2"/>', 14),
  star: stroke('<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/>', 15),
  more: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>',
  plus: stroke('<path d="M12 5v14"/><path d="M5 12h14"/>', 14),
  x: stroke('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>', 12, 2),
  close: stroke('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>', 15),
  pin: stroke('<path d="M12 17v5"/><path d="M9 3h6l-1 7 4 3v2H6v-2l4-3z"/>', 15),
  caret: stroke('<path d="m6 9 6 6 6-6"/>', 12, 2),
};
/** The demo page's logo, as its favicon. */
const favicon = (theme: Theme) => {
  const fg = theme === 'light' ? '#111113' : '#f2f2f3', bg = theme === 'light' ? '#ffffff' : '#26262a';
  return dataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18"><rect width="18" height="18" rx="5" fill="${fg}"/><rect x="5" y="5" width="8" height="8" rx="2" fill="${bg}"/></svg>`);
};

/** The window chrome around a page and a panel. Images are positioned by the caller. */
function windowHtml(l: Layout, theme: Theme, body: string): string {
  const c = CHROME_THEME[theme];
  const { win } = l;
  const w = l.page.width;
  return `
  <style>
    .win{position:absolute;left:${win.x}px;top:${win.y}px;width:${win.width}px;height:${win.height}px;border-radius:12px;overflow:hidden;background:${c.bar};
      box-shadow:0 0 0 1px ${c.border},${c.shadow};font-family:${FONT_UI};-webkit-font-smoothing:antialiased;color:${c.fg}}
    .win *{box-sizing:border-box}
    .tabs{position:absolute;left:0;top:0;right:0;height:${TABS}px;background:${c.tabs}}
    .lights{position:absolute;left:14px;top:13px;display:flex;gap:8px}
    .lights i{width:12px;height:12px;border-radius:50%;background:${c.light};display:block}
    .tab{position:absolute;left:84px;bottom:0;width:232px;height:30px;background:${c.bar};border-radius:9px 9px 0 0;display:flex;align-items:center;gap:8px;padding:0 10px 0 12px;font-size:12px}
    .tab img{width:14px;height:14px;display:block}
    .tab .t{flex:1;white-space:nowrap;overflow:hidden}
    .tab .x{color:${c.dim};display:flex;flex:none}
    .newtab{position:absolute;left:330px;top:14px;color:${c.dim};display:flex}
    .bar{position:absolute;left:0;right:0;top:${TABS}px;height:${TOOLBAR}px;display:flex;align-items:center;padding:0 8px;gap:2px;box-shadow:inset 0 -1px 0 ${c.line}}
    .ib{width:30px;height:30px;display:grid;place-items:center;color:${c.dim};border-radius:50%}
    .ib.on{background:${c.omni};color:${c.fg}}
    .omni{flex:1;height:30px;margin:0 8px;border-radius:15px;background:${c.omni};display:flex;align-items:center;gap:10px;padding:0 6px 0 12px;font-size:13px;color:${c.fg}}
    .omni .t{color:${c.dim};display:flex}
    .omni .u{flex:1;letter-spacing:.005em}
    .omni .u b{font-weight:400;color:${c.dim}}
    .ext img{width:16px;height:16px;display:block}
    .gut{position:absolute;left:${w}px;top:${CHROME}px;right:0;bottom:0;background:${c.bar}}
    .card{position:absolute;left:${w + GUTTER}px;top:${CHROME + GUTTER}px;width:${l.panel.width}px;height:${PANEL_HEAD + l.panel.height}px;border-radius:10px;overflow:hidden;
      box-shadow:0 0 0 1px ${c.line};background:${c.bar}}
    .head{height:${PANEL_HEAD}px;display:flex;align-items:center;gap:8px;padding:0 6px 0 12px;font-size:12.5px;font-weight:500}
    .head img{width:16px;height:16px;display:block}
    .head .caret{color:${c.dim};display:flex;margin-left:-2px}
    .head .sp{flex:1}
    .head .ib{width:26px;height:26px}
    .shot{position:absolute;display:block}
  </style>
  <div class="win">
    <div class="tabs">
      <div class="lights"><i></i><i></i><i></i></div>
      <div class="tab"><img src="${favicon(theme)}"><span class="t">Deploys · Fieldnote</span><span class="x">${I.x}</span></div>
      <div class="newtab">${I.plus}</div>
    </div>
    <div class="bar">
      <span class="ib">${I.back}</span><span class="ib" style="opacity:.45">${I.fwd}</span><span class="ib">${I.reload}</span>
      <div class="omni"><span class="t">${I.tune}</span><span class="u">localhost:3000<b>${PAGE_PATH}</b></span><span class="ib" style="width:24px;height:24px">${I.star}</span></div>
      <span class="ib ext on"><img src="${dataUri(ICON_SVG)}"></span><span class="ib">${I.more}</span>
    </div>
    <div class="gut"></div>
    <div class="card"><div class="head"><img src="${dataUri(ICON_SVG)}"><span>Motion Inspector</span><span class="caret">${I.caret}</span><span class="sp"></span><span class="ib">${I.pin}</span><span class="ib">${I.close}</span></div></div>
  </div>
  ${body}`;
}

function imgTag(src: string, at: Point, size: Size, extra = ''): string {
  return `<img class="shot" src="${pathToFileURL(src).href}" style="left:${at.x}px;top:${at.y}px;width:${size.width}px;height:${size.height}px${extra}">`;
}

/** The panel card's rounded bottom corners clip the panel screenshot. */
function panelClip(): string {
  return `;clip-path:inset(0 round 0 0 10px 10px)`;
}

async function shoot(browser: Browser, l: Layout, html: string, out: string, transparent: boolean) {
  const file = join(STAGE, 'page.html');
  writeFileSync(file, html);
  const ctx = await browser.newContext({ viewport: l.stage, deviceScaleFactor: l.dpr });
  const page = await ctx.newPage();
  await page.goto(pathToFileURL(file).href);
  await page.waitForFunction('Array.from(document.images).every(i => i.complete)');
  await page.screenshot({ path: out, omitBackground: transparent });
  await ctx.close();
}

// ---------------------------------------------------------------- hero

async function hero(browser: Browser) {
  const o = origins(HERO);
  for (const theme of ['light', 'dark'] as const) {
    const dir = join(CAPTURES, `hero-${theme}`);
    const html = `<!doctype html><html><head><style>html,body{margin:0;background:transparent}</style></head><body>
      ${windowHtml(HERO, theme, imgTag(join(dir, 'page.png'), o.page, HERO.page) + imgTag(join(dir, 'panel.png'), o.panel, HERO.panel, panelClip()))}
    </body></html>`;
    const raw = join(STAGE, `hero-${theme}-raw.png`);
    await shoot(browser, HERO, html, raw, true);
    const out = join(OUT, `hero-${theme}.png`);
    // Keep alpha for the window's shadow; only recompress.
    ffmpeg(['-i', raw, '-compression_level', '9', out]);
    console.log(`${out}  ${kb(out)}  ${HERO.stage.width * HERO.dpr}x${HERO.stage.height * HERO.dpr}`);
  }
}

// ---------------------------------------------------------------- GIF

/** A macOS-style arrow; the hotspot is the tip at (2, 2). */
const POINTER = `<svg width="22" height="26" viewBox="0 0 22 26"><path d="M2.5 2.2v17.6l4.6-4.4 3 7 3.2-1.4-3-6.8h6.4z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
const BACKDROP = '#e9ebee';

async function gif(browser: Browser) {
  const capFile = join(CAPTURES, 'gif', 'capture.json');
  if (!existsSync(capFile)) throw new Error('no GIF capture: run without --render first');
  const cap = JSON.parse(readFileSync(capFile, 'utf8')) as GifCapture;
  const o = origins(GIF);
  // Loop seam: the window's content fades to white and back in on the first
  // frame while the pointer goes back, so no frame shows two states at once.
  const FADE = 12;
  const imgs =
    cap.pages.map((p, i) => imgTag(p, o.page, GIF.page, `;visibility:hidden" id="g${i}`)).join('') +
    cap.panels.map((p, i) => imgTag(p, o.panel, GIF.panel, `${panelClip()};visibility:hidden" id="p${i}`)).join('');
  const html = `<!doctype html><html><head><style>
    html,body{margin:0;background:${BACKDROP};overflow:hidden}
    #ptr{position:absolute;left:0;top:0;width:22px;height:26px;margin:-2px 0 0 -2px;filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.3));transform-origin:2px 2px;z-index:3}
    #ring{position:absolute;left:0;top:0;width:28px;height:28px;margin:-14px 0 0 -14px;border-radius:50%;box-shadow:0 0 0 2px rgba(37,99,235,.55);z-index:2;opacity:0}
    #veil{position:absolute;background:#fff;z-index:1;opacity:0}
  </style></head><body>
    ${windowHtml(GIF, 'light', imgs)}
    <div id="veil" style="left:${o.page.x}px;top:${o.page.y}px;width:${GIF.win.width}px;height:${GIF.win.height - CHROME}px"></div>
    <div id="ring"></div><div id="ptr">${POINTER}</div>
  <script>
    const F = ${JSON.stringify(cap.frames)}, FADE = ${FADE};
    let shown = [];
    function show(id) {
      const el = document.getElementById(id);
      el.style.visibility = 'visible';
      shown.push(el);
    }
    const out3 = (p) => 1 - Math.pow(1 - p, 3);
    window.render = (i) => {
      for (const el of shown) el.style.visibility = 'hidden';
      shown = [];
      const end = F[F.length - 1], a = F[0];
      let f = F[Math.min(i, F.length - 1)], x = f.x, y = f.y, veil = 0;
      if (i >= F.length) {
        const p = (i - F.length + 1) / FADE, e = (1 - Math.cos(Math.PI * p)) / 2;
        x = end.x + (a.x - end.x) * e;
        y = end.y + (a.y - end.y) * e;
        if (p > 0.5) f = a;
        veil = p <= 0.5 ? p * 2 : (1 - p) * 2;
      }
      show('g' + f.page);
      show('p' + f.panel);
      document.getElementById('veil').style.opacity = String(Math.min(1, veil * 1.1));
      const ptr = document.getElementById('ptr');
      const pressed = i < F.length && f.press < 3;
      ptr.style.transform = 'translate(' + x + 'px,' + y + 'px)' + (pressed ? ' scale(.9)' : '');
      const ring = document.getElementById('ring');
      const r = i < F.length ? f.press / 7 : 1;
      ring.style.opacity = r < 1 ? String(0.9 * (1 - r)) : '0';
      ring.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + (0.5 + 0.7 * out3(Math.min(1, r))) + ')';
    };
  </script></body></html>`;

  const file = join(STAGE, 'gif.html');
  writeFileSync(file, html);
  rmSync(FRAMES, { recursive: true, force: true });
  mkdirSync(FRAMES, { recursive: true });
  const ctx = await browser.newContext({ viewport: GIF.stage, deviceScaleFactor: GIF.dpr });
  const page = await ctx.newPage();
  await page.goto(pathToFileURL(file).href);
  await page.waitForFunction('Array.from(document.images).every(i => i.complete)');
  const n = cap.frames.length + FADE;
  for (let i = 0; i < n; i++) {
    await page.evaluate(`window.render(${i})`);
    await page.screenshot({ path: join(FRAMES, `f${String(i).padStart(4, '0')}.png`) });
  }
  await ctx.close();

  const out = join(OUT, 'demo.gif');
  // Two-pass palette: one global palette from the frame diffs, then only the
  // changed rectangle of each frame is re-encoded. No dithering keeps the flat
  // UI colours flat, the text clean and the file small.
  ffmpeg([
    '-framerate', String(cap.fps), '-i', join(FRAMES, 'f%04d.png'),
    '-vf', 'split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle',
    '-loop', '0', out,
  ]);
  const w = GIF.stage.width * GIF.dpr, h = GIF.stage.height * GIF.dpr;
  console.log(`${out}  ${kb(out)}  (${n} frames, ${(n / cap.fps).toFixed(1)}s @ ${cap.fps} fps, ${w}x${h})`);
}

// ---------------------------------------------------------------- main

mkdirSync(STAGE, { recursive: true });
mkdirSync(OUT, { recursive: true });
if (!values.render) {
  if (!only || only === 'hero') for (const t of ['light', 'dark'] as const) await captureHero(t);
  if (!only || only === 'gif') await captureGif();
}
const browser = await chromium.launch();
try {
  if (!only || only === 'hero') await hero(browser);
  if (!only || only === 'gif') await gif(browser);
} finally {
  await browser.close();
}
