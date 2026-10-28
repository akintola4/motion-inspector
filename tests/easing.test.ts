import { describe, expect, it } from 'vitest';
import {
  evaluate,
  fitSpring,
  parseEasing,
  sampleStops,
  sampleToLinear,
  springToLinear,
  tidyEasing,
  toCss,
  toLinear,
  type EasingDef,
} from '../lib/easing';

const ev = (css: string, t: number) => evaluate(parseEasing(css)!, t);

describe('parseEasing', () => {
  it('reads keywords as their beziers', () => {
    expect(parseEasing('ease')).toMatchObject({ type: 'cubic-bezier', x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 });
    expect(parseEasing('ease-in-out')).toMatchObject({ x1: 0.42, x2: 0.58, keyword: 'ease-in-out' });
    expect(parseEasing('linear')).toEqual({ type: 'linear' });
  });

  it('reads cubic-bezier and rejects x outside [0, 1]', () => {
    expect(parseEasing('cubic-bezier(0.34, 1.56, 0.64, 1)')).toMatchObject({ y1: 1.56 });
    expect(parseEasing('cubic-bezier(1.2, 0, 0, 1)')).toBeNull();
    expect(parseEasing('cubic-bezier(0, 0, 1)')).toBeNull();
  });

  it('reads steps in all spellings', () => {
    expect(parseEasing('steps(4)')).toEqual({ type: 'steps', steps: 4, position: 'jump-end' });
    expect(parseEasing('steps(4, start)')).toEqual({ type: 'steps', steps: 4, position: 'jump-start' });
    expect(parseEasing('steps(3, jump-both)')).toMatchObject({ position: 'jump-both' });
    expect(parseEasing('step-end')).toEqual({ type: 'steps', steps: 1, position: 'jump-end' });
    expect(parseEasing('steps(1, jump-none)')).toBeNull();
  });

  it('reads linear() and fills missing inputs', () => {
    const def = parseEasing('linear(0, 0.25, 1)') as Extract<EasingDef, { type: 'linear-fn' }>;
    expect(def.stops.map((s) => s.input)).toEqual([0, 0.5, 1]);
    const pct = parseEasing('linear(0, 0.9 20%, 1)') as Extract<EasingDef, { type: 'linear-fn' }>;
    expect(pct.stops.map((s) => s.input)).toEqual([0, 0.2, 1]);
    const two = parseEasing('linear(0, 0.5 25% 75%, 1)') as Extract<EasingDef, { type: 'linear-fn' }>;
    expect(two.stops).toHaveLength(4);
    expect(two.stops[2]).toEqual({ input: 0.75, output: 0.5 });
  });

  it('returns null for junk', () => {
    expect(parseEasing('bouncy')).toBeNull();
    expect(parseEasing('linear(abc)')).toBeNull();
    expect(parseEasing('')).toBeNull();
  });
});

describe('evaluate', () => {
  it('matches known bezier values', () => {
    expect(ev('ease', 0.5)).toBeCloseTo(0.8024, 3);
    expect(ev('ease-in-out', 0.25)).toBeCloseTo(0.1291, 3);
    expect(ev('ease-out', 0)).toBe(0);
    expect(ev('ease-out', 1)).toBe(1);
  });

  it('handles steps edges', () => {
    expect(ev('steps(4)', 0)).toBe(0);
    expect(ev('steps(4)', 0.99)).toBe(0.75);
    expect(ev('steps(4)', 1)).toBe(1);
    expect(ev('steps(4, jump-start)', 0)).toBe(0.25);
    expect(ev('steps(2, jump-none)', 0.6)).toBe(1);
    expect(ev('steps(3, jump-both)', 0)).toBe(0.25);
  });

  it('interpolates linear()', () => {
    expect(ev('linear(0, 1 50%, 0.5)', 0.25)).toBeCloseTo(0.5);
    expect(ev('linear(0, 1 50%, 0.5)', 0.75)).toBeCloseTo(0.75);
  });
});

describe('sampling to linear()', () => {
  it('round-trips a bezier within tolerance with few stops', () => {
    const def = parseEasing('cubic-bezier(0.22, 1, 0.36, 1)')!;
    const lin = parseEasing(toLinear(def))!;
    expect(lin.type).toBe('linear-fn');
    for (let i = 0; i <= 100; i++) {
      expect(Math.abs(evaluate(lin, i / 100) - evaluate(def, i / 100))).toBeLessThan(0.004);
    }
    const stops = sampleStops((t) => evaluate(def, t));
    expect(stops.length).toBeLessThan(40);
  });

  it('collapses a straight line to two stops', () => {
    expect(sampleToLinear((t) => t)).toBe('linear(0, 1)');
  });

  it('leaves steps as steps()', () => {
    expect(toLinear(parseEasing('steps(5)')!)).toBe('steps(5, jump-end)');
  });

  it('serializes canonical CSS', () => {
    expect(toCss(parseEasing('cubic-bezier(0.1, 0.2, 0.3, 0.4)')!)).toBe('cubic-bezier(0.1, 0.2, 0.3, 0.4)');
    expect(toCss(parseEasing('ease-out')!)).toBe('ease-out');
  });
});

describe('springs', () => {
  it('settles at 1 and overshoots only with bounce', () => {
    const bouncy = springToLinear({ bounce: 0.4, visualDuration: 0.4 });
    const firm = springToLinear({ bounce: 0, visualDuration: 0.4 });
    const peak = (css: string) => {
      const d = parseEasing(css)!;
      let m = 0;
      for (let i = 0; i <= 200; i++) m = Math.max(m, evaluate(d, i / 200));
      return m;
    };
    expect(peak(bouncy.easing)).toBeGreaterThan(1.05);
    expect(peak(firm.easing)).toBeLessThanOrEqual(1.0001);
    expect(evaluate(parseEasing(bouncy.easing)!, 1)).toBe(1);
    expect(bouncy.duration).toBeGreaterThan(400);
  });

  it('fits a generated spring back to its parameters', () => {
    const s = springToLinear({ bounce: 0.3, visualDuration: 0.5 });
    const def = parseEasing(s.easing)!;
    const fit = fitSpring((t) => evaluate(def, t), s.duration);
    expect(fit).not.toBeNull();
    expect(fit!.bounce).toBeCloseTo(0.3, 1);
    expect(fit!.visualDuration).toBeGreaterThan(0.45);
    expect(fit!.visualDuration).toBeLessThan(0.55);
  });

  it('does not call a plain ease-out a spring', () => {
    const def = parseEasing('cubic-bezier(0.22, 1, 0.36, 1)')!;
    expect(fitSpring((t) => evaluate(def, t), 400)).toBeNull();
    expect(fitSpring((t) => t, 400)).toBeNull();
  });
});

describe('tidyEasing', () => {
  it('simplifies a browser-serialized linear() without changing its shape', () => {
    const verbose = `linear(${Array.from({ length: 101 }, (_, i) => `${(i / 100) ** 2} ${i}%`).join(', ')})`;
    const tidy = tidyEasing(verbose);
    expect(tidy.length).toBeLessThan(verbose.length / 2);
    const a = parseEasing(verbose)!;
    const b = parseEasing(tidy)!;
    for (let i = 0; i <= 50; i++) expect(Math.abs(evaluate(a, i / 50) - evaluate(b, i / 50))).toBeLessThan(0.0015);
  });

  it('keeps keywords and leaves junk alone', () => {
    expect(tidyEasing('ease-out')).toBe('ease-out');
    expect(tidyEasing('var(--x)')).toBe('var(--x)');
  });
});
