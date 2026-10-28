/**
 * Layout audit for the side panel. Loads the built extension, opens the
 * panel page as a tab against fixtures/all.html and fixtures/noisy.html, and
 * walks every navigation a user makes. For each step it records:
 *
 *  - `layout-shift` entries from a PerformanceObserver in the panel page
 *    (including ones Chrome attributes to recent input, which CLS ignores
 *    but a user still sees),
 *  - bounding-box drift of elements that should stay put,
 *  - before/after screenshots in .layout-audit/.
 *
 * Idle polling is measured separately: rects sampled every 250 ms, DOM
 * mutations per poll, and CDP layout/style counters.
 *
 *   pnpm audit:layout         (builds first)
 *   AUDIT_JSON=1 → also prints the raw JSON
 */
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './serve-fixtures';
import { diff, measureAlignment, rects, type Alignment } from './panel-probes';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'dist/chrome-mv3');
const PROFILE = join(ROOT, '.audit-profile');
const OUT = join(ROOT, '.layout-audit');
const PORT = 4612;
const BASE = `http://127.0.0.1:${PORT}`;
const PANEL_SIZE = { width: 400, height: 900 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* In-page instrumentation                                             */
/* ------------------------------------------------------------------ */

function instrument() {
  type Shift = { value: number; recent: boolean; t: number; sources: string[] };
  const describe = (n: Node | null | undefined): string => {
    if (!n) return '?';
    const el = n.nodeType === 1 ? (n as Element) : n.parentElement;
    if (!el) return '#text';
    const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).join('.') : '';
    const txt = (el.textContent ?? '').trim().slice(0, 24);
    return `${el.tagName.toLowerCase()}${cls}${txt ? ` "${txt}"` : ''}`;
  };
  const a = {
    shifts: [] as Shift[],
    longtasks: [] as { t: number; d: number }[],
    mutations: { childList: 0, characterData: 0, attributes: 0, added: 0, removed: 0 },
  };
  (window as unknown as { __audit: typeof a }).__audit = a;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries() as unknown as {
      value: number;
      hadRecentInput: boolean;
      startTime: number;
      sources: { node?: Node; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }[];
    }[]) {
      a.shifts.push({
        value: e.value,
        recent: e.hadRecentInput,
        t: e.startTime,
        sources: e.sources.map((s) => {
          const p = s.previousRect;
          const c = s.currentRect;
          return `${describe(s.node)} (${Math.round(p.x)},${Math.round(p.y)} ${Math.round(p.width)}×${Math.round(p.height)} → ${Math.round(c.x)},${Math.round(c.y)} ${Math.round(c.width)}×${Math.round(c.height)})`;
        }),
      });
    }
  }).observe({ type: 'layout-shift', buffered: true });
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) a.longtasks.push({ t: e.startTime, d: e.duration });
    }).observe({ type: 'longtask', buffered: true });
  } catch {
    /* not supported */
  }
  new MutationObserver((recs) => {
    for (const r of recs) {
      a.mutations[r.type]++;
      a.mutations.added += r.addedNodes.length;
      a.mutations.removed += r.removedNodes.length;
    }
  }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
}

async function ensure(panel: Page) {
  const has = await panel.evaluate(() => '__audit' in window);
  // Init scripts don't run on chrome-extension:// pages; inject now. The
  // layout-shift observer is buffered, so earlier shifts still show up.
  if (!has) await panel.evaluate(`var __name = (f) => f; (${instrument.toString()})()`);
}

async function auditState(panel: Page) {
  await ensure(panel);
  return panel.evaluate(() => {
    const a = (window as unknown as { __audit: { shifts: unknown[]; longtasks: unknown[]; mutations: Record<string, number> } }).__audit;
    return { shifts: a.shifts.length, longtasks: a.longtasks.length, mutations: { ...a.mutations } };
  });
}
async function shiftsSince(panel: Page, from: number) {
  return panel.evaluate((n) => {
    const a = (window as unknown as { __audit: { shifts: { value: number; recent: boolean; sources: string[] }[] } }).__audit;
    return a.shifts.slice(n);
  }, from);
}

/* ------------------------------------------------------------------ */
/* Steps                                                               */
/* ------------------------------------------------------------------ */

interface Result {
  fixture: string;
  action: string;
  shifts: number;
  shiftScore: number;
  shiftSources: string[];
  drift: string[];
}
const results: Result[] = [];
let shotPrefix = '';

/** Transport options to audit on all.html (see entrypoints/sidepanel/transport). */
const VARIANTS = (process.env.VARIANTS ?? 'current,a,b,c').split(',');
/** Every option tags its stable parts with data-part. */
const STABLE_ANY = ['.top', '.top .host', '.top > .icon-btn', '.status', '.status-dot', '.variant-switch', '.transport', '.transport [data-part]', '.list-bar', '.seg-btn[data-filter]'];

/** Set the global scrubber: native range (current) or an option's role=slider. */
async function seekGlobal(panel: Page, value: number) {
  await panel.$eval(
    '.transport [data-part=scrubber]',
    (el, v) => {
      if (el instanceof HTMLInputElement) {
        el.value = String(v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else el.dispatchEvent(new CustomEvent('mi-seek', { detail: v }));
    },
    value,
  );
}

const STABLE_CHROME_CURRENT = ['.top', '.top .host', '.top .icon-btn', '.top .live-dot', 'button.play', '.transport .seg', '.transport .seg-btn', '.transport .icon-btn', '.status', '.status-dot', '.timeline', '.transport .time', '.list-bar', '.seg-btn[data-filter]'];

async function step(
  panel: Page,
  fixture: string,
  action: string,
  stable: string[],
  run: () => Promise<void>,
  opts: { settle?: number; shot?: string } = {},
) {
  const before = await rects(panel, stable);
  const { shifts: n } = await auditState(panel);
  if (opts.shot) await panel.screenshot({ path: join(OUT, `${shotPrefix}${opts.shot}-before.png`) });
  await run();
  await sleep(opts.settle ?? 500);
  const after = await rects(panel, stable);
  if (opts.shot) await panel.screenshot({ path: join(OUT, `${shotPrefix}${opts.shot}-after.png`) });
  const shifts = await shiftsSince(panel, n);
  const r: Result = {
    fixture,
    action,
    shifts: shifts.length,
    shiftScore: Number(shifts.reduce((s, e) => s + e.value, 0).toFixed(4)),
    shiftSources: [...new Set(shifts.flatMap((s) => s.sources.map((x) => `${s.recent ? '(input) ' : ''}${x}`)))].slice(0, 6),
    drift: diff(before, after),
  };
  results.push(r);
  const flag = r.shifts || r.drift.length ? 'SHIFT' : 'ok   ';
  console.log(`${flag} ${fixture} · ${action}${r.shifts ? `  [${r.shifts} layout-shift, ${r.shiftScore}]` : ''}${r.drift.length ? `\n        drift: ${r.drift.join('\n               ')}` : ''}${r.shiftSources.length ? `\n        sources: ${r.shiftSources.join('\n                 ')}` : ''}`);
  return r;
}

/** Sample rects every 250 ms while nothing is touched; report any movement. */
async function idle(panel: Page, fixture: string, action: string, selectors: string[], ms = 3000) {
  const cdp = await panel.context().newCDPSession(panel);
  await cdp.send('Performance.enable');
  const m0: Record<string, number> = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const a0 = await auditState(panel);
  const base = await rects(panel, selectors);
  const drift = new Set<string>();
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await sleep(250);
    for (const d of diff(base, await rects(panel, selectors))) drift.add(d.replace(/ \(".*$/, ''));
  }
  const a1 = await auditState(panel);
  const m1: Record<string, number> = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  await cdp.detach();
  const shifts = await shiftsSince(panel, a0.shifts);
  const polls = ms / 250;
  const per = (k: string) => ((a1.mutations[k]! - a0.mutations[k]!) / polls).toFixed(1);
  const perf = {
    layoutsPerPoll: (((m1.LayoutCount ?? 0) - (m0.LayoutCount ?? 0)) / polls).toFixed(2),
    styleRecalcsPerPoll: (((m1.RecalcStyleCount ?? 0) - (m0.RecalcStyleCount ?? 0)) / polls).toFixed(2),
    layoutMsPerPoll: ((((m1.LayoutDuration ?? 0) - (m0.LayoutDuration ?? 0)) * 1000) / polls).toFixed(2),
    styleMsPerPoll: ((((m1.RecalcStyleDuration ?? 0) - (m0.RecalcStyleDuration ?? 0)) * 1000) / polls).toFixed(2),
    scriptMsPerPoll: ((((m1.ScriptDuration ?? 0) - (m0.ScriptDuration ?? 0)) * 1000) / polls).toFixed(2),
    mutationsPerPoll: `childList ${per('childList')} (+${per('added')}/-${per('removed')} nodes), text ${per('characterData')}, attr ${per('attributes')}`,
    longtasks: a1.longtasks - a0.longtasks,
    nodes: (m1.Nodes ?? 0),
  };
  const r: Result = {
    fixture,
    action,
    shifts: shifts.length,
    shiftScore: Number(shifts.reduce((s, e) => s + e.value, 0).toFixed(4)),
    shiftSources: [...new Set(shifts.flatMap((s) => s.sources))].slice(0, 6),
    drift: [...drift],
  };
  results.push(r);
  perfRows.push({ fixture, action, ...perf });
  const flag = r.shifts || r.drift.length ? 'SHIFT' : 'ok   ';
  console.log(`${flag} ${fixture} · ${action}${r.drift.length ? `\n        drift: ${r.drift.join('\n               ')}` : ''}${r.shiftSources.length ? `\n        sources: ${r.shiftSources.join('\n                 ')}` : ''}`);
  console.log(`        perf: ${JSON.stringify(perf)}`);
}
const perfRows: Record<string, unknown>[] = [];
const alignRows: (Alignment & { where: string })[] = [];

/* ------------------------------------------------------------------ */

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

const ROW_PARTS = ['.rows .row', '.rows .row-name', '.rows .kind', '.rows .row-dur', '.rows .row-curve', '.rows .row-end', '.rows .row-state', '.rows .row-count'];
const DETAIL = ['.detail-bar', '.back', '.back svg', '.detail-bar .kind', '.detail-head h2', '.curve-card', '.big-curve', '.scrub-one', '.scrub-one [data-part]', '.facts', '.export-bar', '.seg-btn[data-tab]', '.copy', '.code', '.keyframes'];

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
  });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;

  /* ---------------- all.html, once per transport option ---------------- */
  for (const variant of VARIANTS) {
    const F = `all.html [${variant}]`;
    const STABLE_CHROME = variant === 'current' ? [...STABLE_ANY, ...STABLE_CHROME_CURRENT] : STABLE_ANY;
    shotPrefix = variant === 'current' ? '' : `${variant}-`;
    const page = await ctx.newPage();
    await page.goto(`${BASE}/all.html`);
    await sleep(900);
    const tabId = await tabIdFor(sw, page);

    // Connecting… → loaded: header + transport must already be in their final place.
    const panel = await ctx.newPage();
      await panel.setViewportSize(PANEL_SIZE);
    await panel.goto(`chrome-extension://${extId}/sidepanel.html?tabId=${tabId}&theme=light&transport=${variant}`, { waitUntil: 'commit' });
    await panel.waitForSelector('.top');
    await step(panel, F, 'Connecting… → loaded', STABLE_CHROME, () => panel.waitForSelector('.rows .row').then(() => {}), { settle: 900, shot: 'load' });

    alignRows.push({ where: `${F} list, live`, ...(await measureAlignment(panel)) });
    await idle(panel, F, 'idle polling, list, live (3 s)', [...STABLE_CHROME, ...ROW_PARTS]);

    for (const f of ['ended', 'all', 'live']) {
      await step(panel, F, `filter → ${f}`, [...STABLE_CHROME, '.seg-count'], () => panel.click(`.seg-btn[data-filter="${f}"]`), { shot: `filter-${f}` });
    }
    await step(panel, F, 'hover row', [...STABLE_CHROME, ...ROW_PARTS], () => panel.hover('.rows .row[data-id] >> nth=1'), { shot: 'hover' });
    await idle(panel, F, 'idle polling, pointer over list (6 s)', [...STABLE_CHROME, ...ROW_PARTS], 6000);
    await panel.mouse.move(5, 5);

    await step(panel, F, 'pause (button)', [...STABLE_CHROME, ...ROW_PARTS], () => panel.click('button.play'), { shot: 'pause' });
    alignRows.push({ where: `${F} list, paused`, ...(await measureAlignment(panel)) });
    await idle(panel, F, 'idle polling, list, paused (3 s)', [...STABLE_CHROME, ...ROW_PARTS]);
    await step(panel, F, 'play (Space)', [...STABLE_CHROME, ...ROW_PARTS], () => panel.keyboard.press(' '), { shot: 'play' });

    if (variant === 'current') {
      for (const r of ['0.1', '0.25', '0.5', '1']) {
        await step(panel, F, `speed → ${r}×`, STABLE_CHROME, () => panel.click(`.seg-btn[data-rate="${r}"]`));
      }
    } else {
      await panel.mouse.move(5, 5);
      for (const k of ['j', 'j', 'j', 'l', 'l', 'l']) await step(panel, F, `speed key ${k.toUpperCase()}`, STABLE_CHROME, () => panel.keyboard.press(k), { settle: 350 });
      await step(panel, F, 'pause + frame steps (. ×3, , ×1)', STABLE_CHROME, async () => {
        await panel.keyboard.press('k');
        for (const k of ['.', '.', '.', ',']) await panel.keyboard.press(k);
      });
      await step(panel, F, 'hover the scrubber', STABLE_CHROME, () => panel.hover('.transport [data-part=scrubber]'));
      await step(panel, F, 'drag the scrubber', STABLE_CHROME, async () => {
        const b = (await panel.locator('.transport [data-part=scrubber]').boundingBox())!;
        await panel.mouse.move(b.x + b.width * 0.2, b.y + b.height / 2);
        await panel.mouse.down();
        await panel.mouse.move(b.x + b.width * 0.7, b.y + b.height / 2, { steps: 10 });
        await panel.mouse.up();
      });
      await panel.mouse.move(5, 5);
      await step(panel, F, 'play (Space)', STABLE_CHROME, () => panel.keyboard.press(' '));
    }
    await step(panel, F, 'theme toggle ×3', [...STABLE_CHROME, ...ROW_PARTS], async () => {
      for (let i = 0; i < 3; i++) {
        await panel.click('.top .icon-btn');
        await sleep(150);
      }
    });

    // Drill in / out.
    await step(panel, F, 'drill in (click row)', STABLE_CHROME, () => panel.locator('.rows .row[data-id]', { hasText: 'drop' }).first().click(), { shot: 'drill-in' });
    alignRows.push({ where: `${F} detail, live`, ...(await measureAlignment(panel)) });
    await idle(panel, F, 'idle polling, detail, live (3 s)', [...STABLE_CHROME, ...DETAIL]);
    for (const t of ['linear', 'motion', 'gsap', 'css']) {
      await step(panel, F, `export tab → ${t}`, [...STABLE_CHROME, ...DETAIL], () => panel.click(`.seg-btn[data-tab="${t}"]`), { shot: `tab-${t}` });
    }
    await step(panel, F, 'copy code', [...STABLE_CHROME, ...DETAIL], () => panel.click('.export-bar .copy'), { settle: 300, shot: 'copy' });
    await sleep(1200);
    await step(panel, F, 'copy → resets', [...STABLE_CHROME, ...DETAIL], async () => void (await sleep(10)));
    await step(panel, F, 'pause in detail', [...STABLE_CHROME, ...DETAIL], () => panel.click('button.play'), { shot: 'detail-pause' });
    await idle(panel, F, 'idle polling, detail, paused (3 s)', [...STABLE_CHROME, ...DETAIL]);
    await step(panel, F, 'global scrub 400 ms', [...STABLE_CHROME, ...DETAIL], () => seekGlobal(panel, 400));
    await step(panel, F, 'play in detail', [...STABLE_CHROME, ...DETAIL], () => panel.click('button.play'));
    await step(panel, F, 'back (Esc)', STABLE_CHROME, () => panel.keyboard.press('Escape'), { shot: 'back-esc' });

    // Detail → detail with a different animation: back button and tabs should land in the same place.
    await panel.locator('.rows .row[data-id]', { hasText: 'slide' }).first().click();
    await sleep(400);
    const a = await rects(panel, DETAIL.slice(0, 4));
    await panel.click('.back');
    await sleep(300);
    await panel.locator('.rows .row[data-id]', { hasText: 'rotation' }).first().click();
    await sleep(400);
    const b = await rects(panel, DETAIL.slice(0, 4));
    const d = diff(a, b);
    results.push({ fixture: F, action: 'detail bar: slide vs rotation', shifts: 0, shiftScore: 0, shiftSources: [], drift: d });
    console.log(`${d.length ? 'SHIFT' : 'ok   '} ${F} · detail bar: slide vs rotation${d.length ? `\n        drift: ${d.join('\n               ')}` : ''}`);
    await step(panel, F, 'back (button)', STABLE_CHROME, () => panel.click('.back'));

    await panel.close();
    await page.close();
  }

  /* ---------------- noisy.html (current transport) ---------------- */
  {
    shotPrefix = '';
    const STABLE_CHROME = [...STABLE_ANY, ...STABLE_CHROME_CURRENT];
    const F = 'noisy.html';
    const page = await ctx.newPage();
    await page.goto(`${BASE}/${F}`);
    await sleep(600);
    const tabId = await tabIdFor(sw, page);
    const panel = await openPanel(ctx, extId, tabId);
    // Shorter than a real panel so the expanded list scrolls (tests scroll restore).
    await panel.setViewportSize({ width: PANEL_SIZE.width, height: 640 });
    await panel.waitForSelector('.rows .row');
    await sleep(3000);

    await idle(panel, F, 'idle polling, list, live (3 s)', [...STABLE_CHROME, ...ROW_PARTS]);
    for (const f of ['ended', 'all', 'live']) {
      await step(panel, F, `filter → ${f}`, [...STABLE_CHROME, '.seg-count'], () => panel.click(`.seg-btn[data-filter="${f}"]`), { shot: `noisy-filter-${f}` });
    }
    const groupSel = '.rows .row.is-group';
    await step(panel, F, 'expand pulse ×12', [...STABLE_CHROME, groupSel, `${groupSel} .row-name`, `${groupSel} .row-count`, `${groupSel} .kind`, `${groupSel} .row-end svg`], () => panel.locator(groupSel, { hasText: 'pulse' }).click(), { shot: 'expand' });
    await idle(panel, F, 'idle polling, expanded (3 s)', [...STABLE_CHROME, '.rows .row.is-child', '.rows .row.is-child .row-sub', '.rows .row.is-child .row-state', '.rows .row-size']);

    // Scroll the list, drill into a child, come back: scroll restored?
    const scroller = '.list';
    await panel.$eval(scroller, (el) => (el.scrollTop = 160));
    await sleep(200);
    const before = await panel.$eval(scroller, (el) => el.scrollTop);
    await step(panel, F, 'drill into child (scrolled list)', STABLE_CHROME, () => panel.locator('.rows .row.is-child').nth(6).click());
    await idle(panel, F, 'idle polling, child detail, live (3 s)', [...STABLE_CHROME, ...DETAIL]);
    await step(panel, F, 'pause, child detail', [...STABLE_CHROME, ...DETAIL], () => panel.click('button.play'), { shot: 'noisy-detail-pause' });
    await idle(panel, F, 'idle polling, child detail, paused (3 s)', [...STABLE_CHROME, ...DETAIL]);
    await step(panel, F, 'play, child detail', [...STABLE_CHROME, ...DETAIL], () => panel.click('button.play'));
    await step(panel, F, 'back (Esc) from child', [...STABLE_CHROME], () => panel.keyboard.press('Escape'));
    const after = await panel.$eval(scroller, (el) => el.scrollTop);
    const restored = Math.abs(after - before) <= 1;
    results.push({ fixture: F, action: 'list scroll restored after back', shifts: 0, shiftScore: 0, shiftSources: [], drift: restored ? [] : [`scrollTop ${before} → ${after}`] });
    console.log(`${restored ? 'ok   ' : 'SHIFT'} ${F} · list scroll restored after back (${before} → ${after})`);

    // Collapse with the list scrolled (group still on screen): the clicked row
    // must stay under the pointer even though the content gets shorter. A DOM
    // click, so Playwright doesn't scroll the row into view first.
    await panel.$eval(scroller, (el) => (el.scrollTop = 40));
    await sleep(200);
    await step(panel, F, 'collapse pulse ×12 (scrolled)', [...STABLE_CHROME, groupSel], () =>
      panel.$$eval(groupSel, (els) => (els.find((e) => e.textContent?.includes('pulse')) as HTMLElement).click()),
    );
    await panel.setViewportSize(PANEL_SIZE);
    await panel.$eval(scroller, (el) => (el.scrollTop = 0));
    await sleep(300);
    await step(panel, F, 'zero-length: Show', [...STABLE_CHROME, ...ROW_PARTS, '.noop-note', '.noop-note .link'], () => panel.click('.noop-note .link'), { shot: 'noop-show' });
    await step(panel, F, 'zero-length: Hide', [...STABLE_CHROME, ...ROW_PARTS, '.noop-note', '.noop-note .link'], () => panel.click('.noop-note .link'));
    await step(panel, F, 'pause, list', [...STABLE_CHROME, ...ROW_PARTS], () => panel.click('button.play'), { shot: 'noisy-pause' });
    await step(panel, F, 'play, list', [...STABLE_CHROME, ...ROW_PARTS], () => panel.click('button.play'));

    await panel.close();
    await page.close();
  }

  await ctx.close();
  server.close();
  rmSync(PROFILE, { recursive: true, force: true });

  writeFileSync(join(OUT, 'report.json'), JSON.stringify({ results, perf: perfRows, alignment: alignRows }, null, 2));
  console.log('\nalignment (px):');
  console.table(alignRows);
  if (process.env.AUDIT_JSON) console.log(JSON.stringify({ results, perf: perfRows }, null, 2));
  const bad = results.filter((r) => r.shifts || r.drift.length);
  console.log(`\n${results.length} steps, ${bad.length} with movement. Screenshots + report.json in .layout-audit/`);
  process.exit(process.env.AUDIT_STRICT && bad.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
