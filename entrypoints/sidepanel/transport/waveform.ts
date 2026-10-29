/**
 * The waveform scrubber (SoundCloud's waveform, YouTube's hover preview).
 *
 * Geometry is in device pixels. A ResizeObserver reads the width and lays
 * out bars (about 3px, gaps about 2px, never fewer than 24) that fill it
 * exactly: the first bar starts on the left gutter and the last ends on the
 * right one. Bar widths and positions are whole device pixels (see
 * fitBars). The element never asks for a width of its own, so it can't
 * push the panel wider.
 *
 * The playhead and the played part are drawn at x = p × run, rounded to a
 * device pixel: the played copy of the bars is clipped at x and the 2px
 * playhead line is centred on x. They move with transform and clip-path.
 *
 * Bars are full height and clipped to their value with a rounded inset
 * (caps of radius = half the bar width), so a data change repaints but never
 * reflows or registers as a layout shift.
 */
import { h, setText } from '../h';
import { createScrubber, type Scrubber } from './scrubber';

const MIN_BARS = 24;
/** Field height (px). Even, so even bar heights centre on whole pixels. */
const FIELD = 28;

export interface Fit {
  /** Bar width (CSS px, a whole number of device pixels). */
  bar: number;
  n: number;
  /** Left edge of each bar (CSS px, on device pixels), first at 0. */
  xs: number[];
  /** First bar's left edge to the last bar's right edge: the full width. */
  run: number;
  /** True when every gap is the same; otherwise gaps differ by one device pixel. */
  uniform: boolean;
}

/**
 * Bars and gaps of whole device pixels that fill `width` exactly, so the
 * first and last bars sit on the gutters. Prefers one bar width and one gap
 * (close to 3px / 2px) that divide the width evenly; when no such pair
 * exists, it keeps 3px bars and spreads the left-over device pixels one per
 * gap, evenly across the run (a 1-device-pixel difference).
 */
export function fitBars(width: number, dpr: number): Fit {
  const W = Math.round(width * dpr);
  let best: { b: number; g: number; n: number; cost: number } | null = null;
  for (let b = Math.round(2.75 * dpr); b <= Math.round(3.25 * dpr); b++) {
    for (let g = Math.max(1, Math.round(1.75 * dpr)); g <= Math.round(2.25 * dpr); g++) {
      if ((W + g) % (b + g) !== 0) continue;
      const n = (W + g) / (b + g);
      if (n < MIN_BARS) continue;
      const cost = Math.abs(b / dpr - 3) + Math.abs(g / dpr - 2);
      if (!best || cost < best.cost) best = { b, g, n, cost };
    }
  }
  const b = best?.b ?? Math.round(3 * dpr);
  const g = best?.g ?? Math.round(2 * dpr);
  const n = best?.n ?? Math.max(MIN_BARS, Math.floor((W + g) / (b + g)));
  const rem = W - (n * b + (n - 1) * g); // 0 for an exact fit
  const xs: number[] = [];
  let x = 0;
  for (let i = 0; i < n; i++) {
    xs.push(x / dpr);
    // Gap i gets one extra device pixel when the running share crosses a whole one.
    const extra = n > 1 ? Math.floor(((i + 1) * rem) / (n - 1)) - Math.floor((i * rem) / (n - 1)) : 0;
    x += b + g + extra;
  }
  return { bar: b / dpr, n, xs, run: W / dpr, uniform: rem === 0 };
}

export interface Mark {
  /** Slider value of the marker. */
  at: number;
  kind: string;
}

export interface WaveOptions {
  label: string;
  valueText(value: number, max: number): string;
  onInput(value: number): void;
  /** Bar heights 0..1 for `n` bars across 0 → max. */
  heights(n: number): number[];
  /** Markers under the bars, snapped to the bar they fall in. */
  marks(): Mark[];
  /** Hover preview text for a value. */
  tip(value: number): string;
}

export interface Wave {
  el: HTMLElement;
  s: Scrubber;
  /** Data changed: recompute heights and markers. */
  redraw(): void;
}

export function createWave(o: WaveOptions): Wave {
  const base = h('div', { class: 'tc-bars tc-base' });
  const played = h('div', { class: 'tc-bars tc-played' });
  const head = h('span', { class: 'tc-ph' });
  const hover = h('span', { class: 'tc-hover' });
  const field = h('div', { class: 'tc-field', 'aria-hidden': 'true' }, base, played, hover, head);
  const marks = h('div', { class: 'tc-marks', 'aria-hidden': 'true' });
  const tip = h('span', { class: 'tc-tip', 'aria-hidden': 'true' });
  const el = h('div', { class: 'tc-wave', 'data-part': 'scrubber' }, field, marks, tip);

  let width = 0;
  let dpr = 0;
  let n = 0;
  let fit: Fit = { bar: 3, n: 0, xs: [], run: 0, uniform: true };
  let run = 0; // px from the first bar's left edge to the last bar's right edge
  let left = 0;
  let p = 0;
  /** Round to a whole device pixel. */
  const snap = (x: number) => Math.round(x * dpr) / dpr;

  const s = createScrubber({
    el,
    track: field,
    label: o.label,
    valueText: o.valueText,
    paint(next) {
      p = next;
      paint();
    },
    onInput: o.onInput,
    onHover(v, hp) {
      if (v == null || !run) {
        el.classList.remove('is-hovering');
        tip.style.transform = ''; // a hidden tip parked off to the right still counts as overflow
        return;
      }
      el.classList.add('is-hovering');
      const x = snap(hp * run);
      hover.style.transform = `translateX(${x}px)`;
      setText(tip, o.tip(v));
      // Centre under the pointer, clamped inside the scrubber so it never
      // reaches past the panel's edges.
      const w = tip.offsetWidth;
      const tx = Math.max(0, Math.min(width - w, left + x - Math.round(w / 2)));
      tip.style.transform = `translateX(${tx}px)`;
    },
  });

  function paint() {
    const x = snap(p * run);
    played.style.clipPath = `inset(0 ${run - x}px 0 0)`;
    head.style.transform = `translateX(${x}px)`;
  }

  function layout() {
    const w = el.clientWidth;
    const d = window.devicePixelRatio || 1;
    if (!w || (w === width && d === dpr)) return;
    width = w;
    dpr = d;
    tip.style.transform = '';
    const f = fitBars(w, d);
    fit = f;
    run = f.run;
    left = 0;
    const count = f.n;
    field.style.left = marks.style.left = `${left}px`;
    field.style.width = marks.style.width = `${run}px`;
    el.style.setProperty('--bar', `${f.bar}px`);
    if (count !== n) {
      n = count;
      const bars = () => Array.from({ length: n }, () => h('span', { class: 'tc-b' }));
      base.replaceChildren(...bars());
      played.replaceChildren(...bars());
    }
    for (let i = 0; i < n; i++) {
      const t = `translateX(${f.xs[i]}px)`;
      (base.children[i] as HTMLElement).style.transform = t;
      (played.children[i] as HTMLElement).style.transform = t;
    }
    redraw();
    paint();
  }

  function redraw() {
    if (!n) return;
    const hs = o.heights(n);
    for (let i = 0; i < n; i++) {
      const v = hs[i] ?? 0;
      // Even pixel heights (a bar-width dot for silence), centred: the inset
      // is a whole pixel top and bottom, with round caps.
      const px = v <= 0 ? 0 : Math.max(6, 2 * Math.round((v * FIELD) / 2));
      const inset = v <= 0 ? (FIELD - Math.max(2, Math.round(fit.bar))) / 2 : (FIELD - Math.min(FIELD, px)) / 2;
      const t = `inset(${inset}px 0 round ${fit.bar / 2}px)`;
      const a = base.children[i] as HTMLElement;
      const b = played.children[i] as HTMLElement;
      if (a.style.clipPath !== t) a.style.clipPath = b.style.clipPath = t;
    }
    // One marker per bar: the first kind that lands in it.
    const max = s.max;
    const byBar = new Map<number, string>();
    for (const m of o.marks()) {
      const i = Math.max(0, Math.min(n - 1, Math.floor((m.at / max) * n)));
      if (!byBar.has(i)) byBar.set(i, m.kind);
    }
    marks.replaceChildren(...[...byBar].map(([i, kind]) => h('span', { class: 'tc-mark', dataset: { kind }, style: { transform: `translateX(${fit.xs[i] ?? 0}px)` } })));
  }

  new ResizeObserver(layout).observe(el);

  return { el, s, redraw };
}

/** Bar index → [start, end) value range, for tooltips and heights. */
export function barRange(i: number, n: number, max: number): [number, number] {
  return [(i / n) * max, ((i + 1) / n) * max];
}
