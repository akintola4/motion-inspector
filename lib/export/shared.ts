import type { AnimationSpec, Keyframe } from '../types';
import { parseEasing, type EasingDef } from '../easing';

export function fmtTime(ms: number): string {
  if (!Number.isFinite(ms)) return '0ms';
  if (Math.abs(ms) >= 1000) return `${Number((ms / 1000).toFixed(3))}s`;
  return `${Math.abs(ms) >= 10 ? Math.round(ms) : Number(ms.toFixed(1))}ms`;
}

export function seconds(ms: number): number {
  return Number((ms / 1000).toFixed(3));
}

export interface EasingSummary {
  /** The easing to show/export as "the" easing. */
  css: string;
  def: EasingDef;
  /** Where it lives on the animation. */
  source: 'effect' | 'keyframes' | 'per-keyframe';
  /** Easing per segment (keyframes.length - 1 entries). */
  segments: string[];
}

const LINEAR: EasingDef = { type: 'linear' };

/**
 * CSS animations put easing on keyframes and leave the effect linear;
 * WAAPI usually does the reverse. Pick the one that carries the curve.
 */
export function summarizeEasing(spec: AnimationSpec): EasingSummary {
  const segments = spec.keyframes.slice(0, -1).map((k) => k.easing || 'linear');
  const effect = spec.easing || 'linear';
  if (effect !== 'linear' || segments.every((s) => s === 'linear')) {
    return { css: effect, def: parseEasing(effect) ?? LINEAR, source: 'effect', segments };
  }
  const first = segments[0] ?? 'linear';
  if (segments.every((s) => s === first)) {
    return { css: first, def: parseEasing(first) ?? LINEAR, source: 'keyframes', segments };
  }
  return { css: first, def: parseEasing(first) ?? LINEAR, source: 'per-keyframe', segments };
}

/** Apply `direction: reverse` by flipping keyframes (offsets and segment easings). */
export function directionalKeyframes(spec: AnimationSpec): Keyframe[] {
  const reversed = spec.direction === 'reverse' || spec.direction === 'alternate-reverse';
  if (!reversed) return spec.keyframes;
  const kfs = [...spec.keyframes].reverse();
  // Segment easing belongs to the keyframe that starts the segment.
  const easings = spec.keyframes.map((k) => k.easing);
  return kfs.map((k, i) => ({
    offset: Number((1 - k.offset).toFixed(4)),
    props: k.props,
    easing: easings[kfs.length - 2 - i] ?? 'linear',
  }));
}

/** Every property with a value in every keyframe (carrying the last known one forward). */
export function propertyTracks(kfs: Keyframe[]): Map<string, (string | null)[]> {
  const props = new Set<string>();
  for (const k of kfs) for (const p of Object.keys(k.props)) props.add(p);
  const tracks = new Map<string, (string | null)[]>();
  for (const p of props) {
    let last: string | null = null;
    tracks.set(
      p,
      kfs.map((k) => {
        const v = k.props[p];
        if (v != null) last = v;
        return v ?? last;
      }),
    );
  }
  return tracks;
}

/** Numeric-looking values become numbers in JS output; everything else a string. */
export function jsValue(v: string | null): string {
  if (v == null) return 'null';
  const t = v.trim();
  if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(t)) return String(Number(t));
  return JSON.stringify(t);
}

export function isEvenlySpaced(offsets: number[]): boolean {
  const n = offsets.length;
  return offsets.every((o, i) => Math.abs(o - i / (n - 1)) < 1e-3);
}

export function cssIdent(s: string): string {
  const id = s.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!id) return 'motion';
  return /^(\d|-\d)/.test(id) ? `a-${id}` : id;
}

export function describe(spec: AnimationSpec): string {
  const kind = {
    'css-animation': 'CSS animation',
    'css-transition': 'CSS transition',
    waapi: 'Web Animation',
    gsap: 'GSAP tween',
    js: 'JS-driven',
  }[spec.kind];
  return `${spec.selector} — ${kind} "${spec.name}"`;
}

/** Piecewise-linear JS ease from linear() stops, for libraries without linear(). */
export function piecewiseEaseFn(stops: { input: number; output: number }[], name = 'ease'): string {
  const pts = stops.map((s) => `[${Number(s.input.toFixed(4))}, ${Number(s.output.toFixed(4))}]`);
  const rows: string[] = [];
  for (let i = 0; i < pts.length; i += 6) rows.push(`  ${pts.slice(i, i + 6).join(', ')},`);
  return [
    `const ${name}Stops = [`,
    ...rows,
    `];`,
    `const ${name} = (p) => {`,
    `  let i = 1;`,
    `  while (i < ${name}Stops.length - 1 && ${name}Stops[i][0] < p) i++;`,
    `  const [x0, y0] = ${name}Stops[i - 1];`,
    `  const [x1, y1] = ${name}Stops[i];`,
    `  return x1 === x0 ? y1 : y0 + ((y1 - y0) * (p - x0)) / (x1 - x0);`,
    `};`,
  ].join('\n');
}

/** Exact JS for a CSS steps() easing. */
export function stepsEaseFn(steps: number, position: string, name = 'ease'): string {
  const add = position === 'jump-start' || position === 'jump-both' ? ' + 1' : '';
  const jumps = position === 'jump-both' ? steps + 1 : position === 'jump-none' ? steps - 1 : steps;
  return `const ${name} = (p) => Math.min(${jumps}, Math.max(0, Math.floor(p * ${steps})${add})) / ${jumps};`;
}
