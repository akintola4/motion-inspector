/**
 * Layout probes for the panel, shared by scripts/layout-audit.ts and
 * scripts/e2e.ts: bounding-box snapshots and diffs for no-shift checks, and
 * a pixel alignment probe for the header and transport.
 *
 * Cap height and x-height come from canvas text metrics in the element's
 * own font; the baseline comes from a Range over the rendered text (its box
 * is the font's content area), so both use the font the page rendered.
 */
import type { Page } from 'playwright';

const TOLERANCE = 0.5;

/** tsx (esbuild keepNames) wraps named functions in __name(); define it in the page. */
const shim = (page: Page) => page.evaluate('globalThis.__name ??= (f) => f');

export type Rect = { x: number; y: number; w: number; h: number; text: string };
export type Rects = Record<string, Rect>;

export async function rects(panel: Page, selectors: string[]): Promise<Rects> {
  await shim(panel);
  return panel.evaluate((sels) => {
    const out: Record<string, { x: number; y: number; w: number; h: number; text: string }> = {};
    for (const sel of sels) {
      document.querySelectorAll(sel).forEach((el, i) => {
        if (i > 11) return;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        // Key list rows by identity, not index: rows come and go as animations start and end.
        const row = el.closest<HTMLElement>('.row');
        const key = row?.dataset.id ?? row?.dataset.group;
        out[key ? `${sel}{${key.slice(0, 40)}}` : `${sel}[${i}]`] = { x: r.x, y: r.y, w: r.width, h: r.height, text: (el.textContent ?? '').trim().slice(0, 30) };
      });
    }
    return out;
  }, selectors);
}

export function diff(a: Rects, b: Rects): string[] {
  const out: string[] = [];
  for (const [k, r] of Object.entries(a)) {
    const s = b[k];
    if (!s) continue;
    const d = { x: s.x - r.x, y: s.y - r.y, w: s.w - r.w, h: s.h - r.h };
    const moved = Object.entries(d).filter(([, v]) => Math.abs(v) > TOLERANCE);
    if (moved.length) out.push(`${k} ${moved.map(([p, v]) => `${p}${v > 0 ? '+' : ''}${v.toFixed(1)}`).join(' ')}${r.text !== s.text ? ` ("${r.text}"→"${s.text}")` : ''}`);
  }
  return out;
}

export interface Alignment {
  /** Dot centre minus host cap-height centre (px, + = dot lower). */
  dotVsCap: number;
  /** Dot centre minus host x-height centre. */
  dotVsX: number;
  /** Back chevron centre minus its label's cap-height centre (detail view only). */
  chevronVsCap: number | null;
  /** Centre-line offsets in the transport row, relative to the play button. */
  segVsPlay: number;
  restartVsPlay: number;
  /** Left edges: status dot box vs play button. Right edges: theme vs restart. */
  dotLeftVsPlayLeft: number;
  themeRightVsRestartRight: number;
  /** Sanity: rendered content-area height minus canvas ascent + descent (≈0 if the metrics agree). */
  metricCheck: number;
}

export async function measureAlignment(page: Page): Promise<Alignment> {
  await shim(page);
  return page.evaluate(() => {
    const rect = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
    const mid = (r: DOMRect) => r.top + r.height / 2;
    const ctx = document.createElement('canvas').getContext('2d')!;

    /** Cap / x-height centres of an element's first text run, in page px. */
    function textCentres(el: HTMLElement) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent!.trim() ? 1 : 3) });
      const node = walker.nextNode()!;
      const cs = getComputedStyle(node.parentElement!);
      ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const m = ctx.measureText('H');
      const cap = m.actualBoundingBoxAscent;
      const x = ctx.measureText('x').actualBoundingBoxAscent;
      // A Range over the text spans the font's content area (ascent + descent),
      // whatever the line-height or flex alignment, so its top + ascent is the baseline.
      const range = document.createRange();
      range.selectNodeContents(node);
      const box = range.getClientRects()[0]!;
      const baseline = box.top + m.fontBoundingBoxAscent;
      return { cap: baseline - cap / 2, x: baseline - x / 2, contentTop: box.top, contentBottom: box.bottom, ascent: m.fontBoundingBoxAscent, descent: m.fontBoundingBoxDescent };
    }

    const host = document.querySelector<HTMLElement>('.top .host')!;
    const t = textCentres(host);
    const dot = mid(rect('.status-dot'));

    let chevronVsCap: number | null = null;
    const back = document.querySelector<HTMLElement>('.detail .back');
    if (back && back.offsetParent) {
      const label = textCentres(back);
      chevronVsCap = mid(back.querySelector('svg')!.getBoundingClientRect()) - label.cap;
    }

    const play = rect('button.play');
    const r3 = (n: number) => Math.round(n * 1000) / 1000;
    return {
      dotVsCap: r3(dot - t.cap),
      dotVsX: r3(dot - t.x),
      chevronVsCap: chevronVsCap == null ? null : r3(chevronVsCap),
      segVsPlay: r3(mid(rect('.transport .seg')) - mid(play)),
      restartVsPlay: r3(mid(rect('.transport-row > .icon-btn')) - mid(play)),
      dotLeftVsPlayLeft: r3(rect('.top .status').left - play.left),
      metricCheck: r3(t.contentBottom - t.contentTop - t.ascent - t.descent),
      themeRightVsRestartRight: r3(rect('.top .icon-btn').right - rect('.transport-row > .icon-btn').right),
    };
  });
}
