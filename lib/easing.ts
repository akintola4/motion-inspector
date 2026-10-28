/**
 * Easing parsing, evaluation, sampling and spring fitting. Pure functions,
 * no DOM, unit-tested in tests/easing.test.ts.
 */

export type StepPosition = 'jump-start' | 'jump-end' | 'jump-none' | 'jump-both';

export interface LinearStop {
  input: number;
  output: number;
}

export type EasingDef =
  | { type: 'linear' }
  | { type: 'cubic-bezier'; x1: number; y1: number; x2: number; y2: number; keyword?: string }
  | { type: 'steps'; steps: number; position: StepPosition }
  | { type: 'linear-fn'; stops: LinearStop[] };

export const KEYWORD_BEZIERS: Record<string, [number, number, number, number]> = {
  ease: [0.25, 0.1, 0.25, 1],
  'ease-in': [0.42, 0, 1, 1],
  'ease-out': [0, 0, 0.58, 1],
  'ease-in-out': [0.42, 0, 0.58, 1],
};

const NUM = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?`;

/** Parse a CSS <easing-function>. Returns null for anything unrecognized. */
export function parseEasing(input: string): EasingDef | null {
  const s = input.trim().toLowerCase();
  if (s === 'linear') return { type: 'linear' };
  const kw = KEYWORD_BEZIERS[s];
  if (kw) return { type: 'cubic-bezier', x1: kw[0], y1: kw[1], x2: kw[2], y2: kw[3], keyword: s };
  if (s === 'step-start') return { type: 'steps', steps: 1, position: 'jump-start' };
  if (s === 'step-end') return { type: 'steps', steps: 1, position: 'jump-end' };

  const fn = /^([a-z-]+)\((.*)\)$/s.exec(s);
  if (!fn) return null;
  const [, name, rawArgs = ''] = fn;
  const args = rawArgs.split(',').map((a) => a.trim());

  if (name === 'cubic-bezier') {
    if (args.length !== 4) return null;
    const n = args.map(Number);
    if (n.some((v) => !Number.isFinite(v))) return null;
    const [x1, y1, x2, y2] = n as [number, number, number, number];
    if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) return null;
    return { type: 'cubic-bezier', x1, y1, x2, y2 };
  }

  if (name === 'steps') {
    const steps = Number(args[0]);
    if (!Number.isInteger(steps) || steps < 1) return null;
    const pos = (args[1] ?? 'end').replace(/^start$/, 'jump-start').replace(/^end$/, 'jump-end');
    if (!['jump-start', 'jump-end', 'jump-none', 'jump-both'].includes(pos)) return null;
    if (pos === 'jump-none' && steps < 2) return null;
    return { type: 'steps', steps, position: pos as StepPosition };
  }

  if (name === 'linear') return parseLinearFn(args);
  return null;
}

function parseLinearFn(args: string[]): EasingDef | null {
  const re = new RegExp(`^(${NUM})(?:\\s+(${NUM})%)?(?:\\s+(${NUM})%)?$`, 'i');
  const raw: { output: number; input: number | null }[] = [];
  for (const a of args) {
    const m = re.exec(a);
    if (!m) return null;
    const output = Number(m[1]);
    raw.push({ output, input: m[2] != null ? Number(m[2]) / 100 : null });
    if (m[3] != null) raw.push({ output, input: Number(m[3]) / 100 });
  }
  if (raw.length < 2) return null;

  // Spec: first input defaults to 0, last to 1, inputs are clamped to be
  // non-decreasing, and runs of missing inputs are spread evenly.
  if (raw[0]!.input == null) raw[0]!.input = 0;
  if (raw[raw.length - 1]!.input == null) raw[raw.length - 1]!.input = Math.max(1, maxInput(raw));
  let max = -Infinity;
  for (const p of raw) {
    if (p.input != null) {
      p.input = Math.max(p.input, max);
      max = p.input;
    }
  }
  for (let i = 0; i < raw.length; i++) {
    if (raw[i]!.input != null) continue;
    const start = i - 1;
    let end = i;
    while (raw[end]!.input == null) end++;
    const a = raw[start]!.input!;
    const b = raw[end]!.input!;
    for (let j = i; j < end; j++) raw[j]!.input = a + ((b - a) * (j - start)) / (end - start);
    i = end;
  }
  return { type: 'linear-fn', stops: raw.map((p) => ({ input: p.input!, output: p.output })) };
}

function maxInput(raw: { input: number | null }[]) {
  return raw.reduce((m, p) => (p.input != null && p.input > m ? p.input : m), 0);
}

/* -------------------------------------------------------------------------- */
/* Evaluation                                                                 */
/* -------------------------------------------------------------------------- */

export function evaluate(def: EasingDef, t: number): number {
  switch (def.type) {
    case 'linear':
      return t;
    case 'cubic-bezier':
      return bezier(def.x1, def.y1, def.x2, def.y2, t);
    case 'steps':
      return steps(def.steps, def.position, t);
    case 'linear-fn':
      return linearFn(def.stops, t);
  }
}

/** Returns an (t) => y function, with a parsed fallback to linear. */
export function easingFn(css: string): (t: number) => number {
  const def = parseEasing(css) ?? { type: 'linear' as const };
  return (t) => evaluate(def, t);
}

function bezier(x1: number, y1: number, x2: number, y2: number, t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sx = (s: number) => ((ax * s + bx) * s + cx) * s;
  const sy = (s: number) => ((ay * s + by) * s + cy) * s;
  const dx = (s: number) => (3 * ax * s + 2 * bx) * s + cx;

  let s = t;
  for (let i = 0; i < 8; i++) {
    const err = sx(s) - t;
    if (Math.abs(err) < 1e-7) return sy(s);
    const d = dx(s);
    if (Math.abs(d) < 1e-6) break;
    s -= err / d;
  }
  let lo = 0;
  let hi = 1;
  s = t;
  for (let i = 0; i < 40; i++) {
    const x = sx(s);
    if (Math.abs(x - t) < 1e-7) break;
    if (x < t) lo = s;
    else hi = s;
    s = (lo + hi) / 2;
  }
  return sy(s);
}

function steps(n: number, pos: StepPosition, t: number): number {
  let step = Math.floor(t * n);
  if (pos === 'jump-start' || pos === 'jump-both') step += 1;
  const jumps = pos === 'jump-both' ? n + 1 : pos === 'jump-none' ? n - 1 : n;
  if (t >= 0 && step < 0) step = 0;
  if (t <= 1 && step > jumps) step = jumps;
  return step / jumps;
}

function linearFn(stops: LinearStop[], t: number): number {
  const first = stops[0]!;
  const last = stops[stops.length - 1]!;
  if (t <= first.input) return first.output;
  if (t >= last.input) return last.output;
  for (let i = 1; i < stops.length; i++) {
    const b = stops[i]!;
    if (t <= b.input) {
      const a = stops[i - 1]!;
      if (b.input === a.input) return b.output;
      return a.output + ((b.output - a.output) * (t - a.input)) / (b.input - a.input);
    }
  }
  return last.output;
}

/* -------------------------------------------------------------------------- */
/* Serialization                                                              */
/* -------------------------------------------------------------------------- */

export function fmt(n: number, digits = 3): string {
  const r = Number(n.toFixed(digits));
  return Object.is(r, -0) ? '0' : String(r);
}

export function toCss(def: EasingDef): string {
  switch (def.type) {
    case 'linear':
      return 'linear';
    case 'cubic-bezier':
      return def.keyword ?? `cubic-bezier(${[def.x1, def.y1, def.x2, def.y2].map((n) => fmt(n)).join(', ')})`;
    case 'steps':
      return `steps(${def.steps}, ${def.position})`;
    case 'linear-fn':
      return stopsToLinear(def.stops);
  }
}

export function stopsToLinear(stops: LinearStop[], digits = 4): string {
  const n = stops.length;
  const even = stops.every((p, i) => Math.abs(p.input - i / (n - 1)) < 1e-4);
  const parts = stops.map((p, i) => {
    const out = fmt(p.output, digits);
    if (even || i === 0 || i === n - 1) return out;
    return `${out} ${fmt(p.input * 100, 2)}%`;
  });
  return `linear(${parts.join(', ')})`;
}

/* -------------------------------------------------------------------------- */
/* Sampling                                                                   */
/* -------------------------------------------------------------------------- */

export interface SampleOptions {
  samples?: number;
  tolerance?: number;
}

/**
 * Sample `fn` over [0, 1] and keep only the points needed to stay within
 * `tolerance` of the dense curve when linearly interpolated.
 */
export function sampleStops(fn: (t: number) => number, opts: SampleOptions = {}): LinearStop[] {
  const samples = opts.samples ?? 240;
  const pts: LinearStop[] = [];
  for (let i = 0; i <= samples; i++) {
    const input = i / samples;
    pts.push({ input, output: fn(input) });
  }
  return simplifyStops(pts, opts.tolerance ?? 0.0015);
}

/** Drop stops that linear interpolation between their neighbours already reproduces. */
export function simplifyStops(pts: LinearStop[], tol = 0.001): LinearStop[] {
  if (pts.length <= 2) return pts;
  const last = pts.length - 1;
  const kept: LinearStop[] = [pts[0]!];
  let anchor = 0;
  for (let j = 2; j <= last; j++) {
    if (!segmentFits(pts, anchor, j, tol)) {
      kept.push(pts[j - 1]!);
      anchor = j - 1;
    }
  }
  kept.push(pts[last]!);
  return kept;
}

/**
 * A tidier spelling of an easing: linear() lists (which browsers serialize
 * with long percentages) are simplified, cubic-beziers are rounded.
 * Anything unparseable is returned untouched.
 */
export function tidyEasing(css: string): string {
  const def = parseEasing(css);
  if (!def) return css;
  if (def.type === 'linear-fn') return stopsToLinear(simplifyStops(def.stops));
  return toCss(def);
}

function segmentFits(pts: LinearStop[], a: number, b: number, tol: number) {
  const pa = pts[a]!;
  const pb = pts[b]!;
  for (let k = a + 1; k < b; k++) {
    const p = pts[k]!;
    const y = pa.output + ((pb.output - pa.output) * (p.input - pa.input)) / (pb.input - pa.input);
    if (Math.abs(y - p.output) > tol) return false;
  }
  return true;
}

export function sampleToLinear(fn: (t: number) => number, opts: SampleOptions = {}): string {
  return stopsToLinear(sampleStops(fn, opts));
}

/** linear() for any easing def. Steps stay exact as steps(). */
export function toLinear(def: EasingDef, opts: SampleOptions = {}): string {
  if (def.type === 'linear-fn') return stopsToLinear(simplifyStops(def.stops));
  if (def.type === 'linear') return 'linear';
  if (def.type === 'steps') return toCss(def);
  return sampleToLinear((t) => evaluate(def, t), opts);
}

/** Linear-interpolating function over evenly spaced samples (GSAP eases). */
export function samplesFn(samples: number[]): (t: number) => number {
  const n = samples.length - 1;
  return (t) => {
    if (t <= 0) return samples[0] ?? 0;
    if (t >= 1) return samples[n] ?? 1;
    const x = t * n;
    const i = Math.floor(x);
    const a = samples[i] ?? 0;
    const b = samples[i + 1] ?? a;
    return a + (b - a) * (x - i);
  };
}

/* -------------------------------------------------------------------------- */
/* Curve preview                                                              */
/* -------------------------------------------------------------------------- */

export interface CurveGeometry {
  path: string;
  /** Output range drawn, for placing guide lines. */
  minY: number;
  maxY: number;
  /** Maps a (t, y) pair into the box. */
  point: (t: number, y: number) => [number, number];
}

export function curveGeometry(
  fn: (t: number) => number,
  width: number,
  height: number,
  pad = 4,
  samples = 160,
): CurveGeometry {
  const ys: number[] = [];
  for (let i = 0; i <= samples; i++) ys.push(fn(i / samples));
  const minY = Math.min(0, ...ys);
  const maxY = Math.max(1, ...ys);
  const span = maxY - minY || 1;
  const point = (t: number, y: number): [number, number] => [
    pad + t * (width - pad * 2),
    pad + (1 - (y - minY) / span) * (height - pad * 2),
  ];
  const path = ys
    .map((y, i) => {
      const [x, py] = point(i / samples, y);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${py.toFixed(2)}`;
    })
    .join(' ');
  return { path, minY, maxY, point };
}

/* -------------------------------------------------------------------------- */
/* Springs                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Normalized spring response from 0 → 1 with zero initial velocity.
 * `zeta` is the damping ratio (0 < zeta ≤ 1), `omega` the natural
 * frequency in rad per unit time.
 */
export function springResponse(zeta: number, omega: number, t: number): number {
  if (zeta >= 1) return 1 - Math.exp(-omega * t) * (1 + omega * t);
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  const decay = Math.exp(-zeta * omega * t);
  return 1 - decay * (Math.cos(wd * t) + ((zeta * omega) / wd) * Math.sin(wd * t));
}

export interface SpringParams {
  /** 0 = no overshoot, 1 = maximum wobble (Motion's definition). */
  bounce: number;
  /** Seconds the motion appears to take (Motion's definition). */
  visualDuration: number;
}

/** Motion's mapping from bounce/visualDuration to physical params (mass 1). */
export function springPhysics({ bounce, visualDuration }: SpringParams) {
  const omega = (2 * Math.PI) / (visualDuration * 1.2);
  const zeta = Math.min(1, Math.max(0.05, 1 - bounce));
  return { stiffness: omega * omega, damping: 2 * zeta * omega, mass: 1, zeta, omega };
}

/** Time (seconds) after which the spring stays within `restDelta` of 1. */
export function springSettleTime(zeta: number, omega: number, restDelta = 0.001): number {
  const dt = 0.002;
  let lastOutside = 0;
  for (let t = 0; t < 20; t += dt) {
    if (Math.abs(1 - springResponse(zeta, omega, t)) > restDelta) lastOutside = t;
    else if (t - lastOutside > 0.25) break;
  }
  return lastOutside + dt;
}

export function springToLinear(params: SpringParams, opts: SampleOptions = {}) {
  const { zeta, omega, stiffness, damping } = springPhysics(params);
  const seconds = springSettleTime(zeta, omega);
  const stops = sampleStops((t) => (t >= 1 ? 1 : springResponse(zeta, omega, t * seconds)), opts);
  return {
    duration: Math.round(seconds * 1000),
    easing: stopsToLinear(stops),
    stiffness,
    damping,
  };
}

export interface SpringFit extends SpringParams {
  stiffness: number;
  damping: number;
  /** RMS error between the curve and the fitted spring, in output units. */
  error: number;
}

/**
 * Try to explain a curve played over `durationMs` as a Motion spring.
 * Returns null unless the curve looks like a spring (it settles on 1 with an
 * overshoot or a long tail) and the fit is close.
 */
export function fitSpring(
  fn: (t: number) => number,
  durationMs: number,
  maxError = 0.015,
): SpringFit | null {
  if (!(durationMs > 0)) return null;
  const N = 60;
  const target: number[] = [];
  for (let i = 0; i <= N; i++) target.push(fn(i / N));
  if (Math.abs(target[0]!) > 0.02 || Math.abs(target[N]! - 1) > 0.02) return null;

  const overshoot = Math.max(...target) - 1;
  // A spring-shaped curve either overshoots or is already ~settled well
  // before the end (the long tail a settle adds). Plain ease-outs reach 1
  // only at t = 1.
  const settledAt = target.findIndex((y, i) => i > 0 && target.slice(i).every((v) => Math.abs(v - 1) < 0.01));
  if (overshoot < 0.005 && (settledAt < 0 || settledAt > N * 0.8)) return null;

  const D = durationMs / 1000;
  const errorFor = (zeta: number, Omega: number) => {
    let sum = 0;
    for (let i = 0; i <= N; i++) {
      const d = springResponse(zeta, Omega, i / N) - target[i]!;
      sum += d * d;
    }
    return Math.sqrt(sum / (N + 1));
  };

  let best = { zeta: 1, Omega: 10, error: Infinity };
  for (let zeta = 0.05; zeta <= 1.0001; zeta += 0.025) {
    for (let k = 0; k <= 120; k++) {
      const Omega = 2 * Math.pow(60, k / 120); // 2 … 120 rad per duration
      const e = errorFor(zeta, Omega);
      if (e < best.error) best = { zeta, Omega, error: e };
    }
  }
  // Local refinement.
  let step = { z: 0.0125, o: best.Omega * 0.02 };
  for (let iter = 0; iter < 40; iter++) {
    let improved = false;
    for (const [dz, dO] of [
      [step.z, 0],
      [-step.z, 0],
      [0, step.o],
      [0, -step.o],
    ] as const) {
      const zeta = Math.min(1, Math.max(0.05, best.zeta + dz));
      const Omega = Math.max(0.5, best.Omega + dO);
      const e = errorFor(zeta, Omega);
      if (e < best.error) {
        best = { zeta, Omega, error: e };
        improved = true;
      }
    }
    if (!improved) step = { z: step.z / 2, o: step.o / 2 };
  }
  if (best.error > maxError) return null;

  const omega = best.Omega / D;
  const bounce = Math.max(0, Math.min(1, 1 - best.zeta));
  const visualDuration = (2 * Math.PI) / (1.2 * omega);
  return {
    bounce: Number(bounce.toFixed(2)),
    visualDuration: Number(visualDuration.toFixed(3)),
    stiffness: Number((omega * omega).toFixed(1)),
    damping: Number((2 * best.zeta * omega).toFixed(1)),
    error: best.error,
  };
}
