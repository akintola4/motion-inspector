import { evaluate, fmt, samplesFn, sampleToLinear } from './easing';

/**
 * GSAP ease names ↔ cubic-bezier approximations (the usual Penner fits).
 * These are approximations: the CSS exporter only uses one when it matches
 * the sampled GSAP curve closely, and falls back to linear() otherwise.
 */

type Bezier = [number, number, number, number];

const FAMILIES: Record<string, { in: Bezier; out: Bezier; inOut: Bezier }> = {
  power1: { in: [0.11, 0, 0.5, 0], out: [0.5, 1, 0.89, 1], inOut: [0.45, 0, 0.55, 1] },
  power2: { in: [0.32, 0, 0.67, 0], out: [0.33, 1, 0.68, 1], inOut: [0.65, 0, 0.35, 1] },
  power3: { in: [0.5, 0, 0.75, 0], out: [0.25, 1, 0.5, 1], inOut: [0.76, 0, 0.24, 1] },
  power4: { in: [0.64, 0, 0.78, 0], out: [0.22, 1, 0.36, 1], inOut: [0.83, 0, 0.17, 1] },
  sine: { in: [0.12, 0, 0.39, 0], out: [0.61, 1, 0.88, 1], inOut: [0.37, 0, 0.63, 1] },
  expo: { in: [0.7, 0, 0.84, 0], out: [0.16, 1, 0.3, 1], inOut: [0.87, 0, 0.13, 1] },
  circ: { in: [0.55, 0, 1, 0.45], out: [0, 0.55, 0.45, 1], inOut: [0.85, 0, 0.15, 1] },
  back: { in: [0.36, 0, 0.66, -0.56], out: [0.34, 1.56, 0.64, 1], inOut: [0.68, -0.6, 0.32, 1.6] },
};

const ALIASES: Record<string, string> = {
  quad: 'power1',
  cubic: 'power2',
  quart: 'power3',
  quint: 'power4',
  strong: 'power4',
};

/** Normalize "Power2.easeOut", "power2", "quad.inOut" → "power2.out" style. */
export function normalizeGsapEase(name: string): string {
  const s = name.trim();
  if (!s) return 'power1.out';
  const lower = s.toLowerCase();
  if (lower === 'none' || lower === 'linear' || lower === 'power0' || lower.startsWith('power0.') || lower.startsWith('linear.')) return 'none';
  const m = /^([a-z]+\d?)(?:\.(?:ease)?(in|out|inout))?(\(.*\))?$/i.exec(s);
  if (!m) return s;
  const fam = m[1]!.toLowerCase();
  const family = ALIASES[fam] ?? fam;
  const dirRaw = (m[2] ?? 'out').toLowerCase();
  const dir = dirRaw === 'inout' ? 'inOut' : dirRaw;
  return `${family}.${dir}${m[3] ?? ''}`;
}

/** Bezier approximation for a GSAP ease name, or null when there isn't one. */
export function gsapEaseToBezier(name: string): Bezier | null {
  const n = normalizeGsapEase(name);
  if (n === 'none') return [0, 0, 1, 1];
  const m = /^([a-z]+\d?)\.(in|out|inOut)(?:\((.*)\))?$/.exec(n);
  if (!m) return null;
  const fam = FAMILIES[m[1]!];
  if (!fam) return null;
  // back(1.7) is the default overshoot; any other parameter changes the shape.
  if (m[3] != null && !(m[1] === 'back' && /^1\.70?\d*$/.test(m[3].trim()))) return null;
  return fam[m[2] as 'in' | 'out' | 'inOut'];
}

/** GSAP name for a bezier, if it matches one of the table entries. */
export function bezierToGsapEase(b: Bezier, tolerance = 0.005): string | null {
  if (b[0] === b[1] && b[2] === b[3]) return 'none';
  for (const [family, dirs] of Object.entries(FAMILIES)) {
    for (const [dir, ref] of Object.entries(dirs)) {
      if (ref.every((v, i) => Math.abs(v - b[i]!) <= tolerance)) return `${family}.${dir}`;
    }
  }
  return null;
}

/**
 * CSS easing for a GSAP ease: the bezier approximation when it really
 * matches the sampled curve, else a sampled linear().
 */
export function gsapEaseToCss(name: string, samples: number[]): string {
  const b = gsapEaseToBezier(name);
  if (b && normalizeGsapEase(name) === 'none') return 'linear';
  const fn = samplesFn(samples);
  if (b && samples.length > 2) {
    const css = `cubic-bezier(${b.map((n) => fmt(n)).join(', ')})`;
    // Compare against the bezier; accept within 2% everywhere.
    const def = { type: 'cubic-bezier' as const, x1: b[0], y1: b[1], x2: b[2], y2: b[3] };
    const bez = (t: number) => evaluate(def, t);
    let maxErr = 0;
    for (let i = 0; i <= 50; i++) maxErr = Math.max(maxErr, Math.abs(bez(i / 50) - fn(i / 50)));
    if (maxErr < 0.02) return css;
  }
  if (samples.length < 2) return 'linear';
  return sampleToLinear(fn);
}
