import { curveGeometry } from '../../lib/easing';

const NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/** Small curve for list rows. */
export function miniCurve(fn: (t: number) => number): SVGSVGElement {
  const w = 28;
  const h = 20;
  const g = curveGeometry(fn, w, h, 2.5, 48);
  const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, width: w, height: h, class: 'mini-curve', 'aria-hidden': 'true' });
  svg.append(el('path', { d: g.path, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  return svg;
}

export interface BigCurve {
  root: SVGSVGElement;
  /** Directed progress 0..1 (before easing), or null to hide the playhead. */
  setProgress(p: number | null): void;
}

/**
 * Large curve: 0 and 1 guides (so overshoot reads as overshoot), keyframe
 * ticks, a soft fill under the curve, and a playhead.
 */
export function bigCurve(fn: (t: number) => number, ticks: number[] = []): BigCurve {
  const w = 320;
  const h = 168;
  const pad = 12;
  const g = curveGeometry(fn, w, h, pad, 240);
  const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, class: 'big-curve', role: 'img', 'aria-label': 'Easing curve' });

  const [x0, y0] = g.point(0, 0);
  const [x1, y1] = g.point(1, 1);
  svg.append(
    el('rect', { x: x0, y: y1, width: x1 - x0, height: y0 - y1, class: 'curve-frame' }),
    el('line', { x1: x0, y1: y0, x2: x1, y2: y1, class: 'curve-diagonal' }),
  );
  for (const t of ticks) {
    if (t <= 0 || t >= 1) continue;
    const [x] = g.point(t, 0);
    svg.append(el('line', { x1: x, y1: y1, x2: x, y2: y0, class: 'curve-tick' }));
  }
  // Area between the curve and the 0 line.
  svg.append(el('path', { d: `${g.path} L${x1.toFixed(2)} ${y0.toFixed(2)} L${x0.toFixed(2)} ${y0.toFixed(2)} Z`, class: 'curve-area' }));
  svg.append(el('path', { d: g.path, class: 'curve-path' }));
  svg.append(
    el('circle', { cx: x0, cy: y0, r: 2.5, class: 'curve-end' }),
    el('circle', { cx: x1, cy: g.point(1, fn(1))[1], r: 2.5, class: 'curve-end' }),
  );

  const head = el('line', { x1: 0, y1: pad / 2, x2: 0, y2: h - pad / 2, class: 'curve-head' });
  const dot = el('circle', { r: 4.5, class: 'curve-dot' });
  svg.append(head, dot);

  return {
    root: svg,
    setProgress(p) {
      const show = p != null && Number.isFinite(p);
      head.style.display = dot.style.display = show ? '' : 'none';
      if (!show) return;
      const [x, y] = g.point(p, fn(p));
      head.setAttribute('x1', String(x));
      head.setAttribute('x2', String(x));
      dot.setAttribute('cx', String(x));
      dot.setAttribute('cy', String(y));
    },
  };
}
