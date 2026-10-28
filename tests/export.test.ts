import { describe, expect, it } from 'vitest';
import { toCss, toGsap, toLinearExport, toMotion, toMotionReact, toMotionVanilla } from '../lib/export';
import { summarizeEasing } from '../lib/export/shared';
import { cssKeyframes, gsapSpec, springSpec, steps, transition, waapi } from './specs';

const all = [transition, cssKeyframes, waapi, springSpec, steps, gsapSpec];

function balanced(code: string) {
  let depth = 0;
  for (const c of code) {
    if (c === '{' || c === '(' || c === '[') depth++;
    if (c === '}' || c === ')' || c === ']') depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}

describe('every exporter on every spec', () => {
  for (const spec of all) {
    for (const [name, fn] of Object.entries({ toCss, toLinearExport, toMotion, toGsap })) {
      it(`${name}(${spec.id}) is well-formed`, () => {
        const out = fn(spec);
        expect(out.length).toBeGreaterThan(20);
        expect(out).not.toMatch(/undefined|NaN|\[object Object\]/);
        expect(balanced(out)).toBe(true);
      });
    }
  }
});

describe('summarizeEasing', () => {
  it('prefers effect easing, then uniform keyframe easing, then per-keyframe', () => {
    expect(summarizeEasing(waapi).source).toBe('effect');
    expect(summarizeEasing(cssKeyframes).source).toBe('per-keyframe');
    expect(summarizeEasing({ ...cssKeyframes, keyframes: cssKeyframes.keyframes.map((k) => ({ ...k, easing: 'ease-out' })) }).source).toBe('keyframes');
  });
});

describe('CSS', () => {
  it('writes a transition declaration with from/to state', () => {
    const out = toCss(transition);
    expect(out).toContain('transition: background-color 200ms ease-out;');
    expect(out).toContain('background-color: rgb(255, 255, 255);');
    expect(out).toContain('background-color: rgb(0, 112, 243);');
  });

  it('writes @keyframes with per-keyframe easing and the shorthand', () => {
    const out = toCss(cssKeyframes);
    expect(out).toContain('@keyframes pulse {');
    expect(out).toContain('30% {');
    expect(out).toContain('animation-timing-function: ease-out;');
    expect(out).toContain('animation: pulse 1.2s ease-in 100ms infinite alternate both;');
  });

  it('keeps linear() spring easing verbatim', () => {
    expect(toCss(springSpec)).toContain(`${springSpec.easing}`);
  });
});

describe('linear()', () => {
  it('samples a bezier into linear()', () => {
    const out = toLinearExport(waapi);
    expect(out).toMatch(/--ease: linear\(0, /);
    expect(out).toContain('animation-timing-function: var(--ease);');
  });

  it('labels a spring curve with its fitted parameters', () => {
    expect(toLinearExport(springSpec)).toMatch(/≈ spring, bounce 0\.3\d?, visualDuration 0\.\d+s/);
  });

  it('keeps steps exact', () => {
    expect(toLinearExport(steps)).toContain('steps(6, jump-start)');
  });

  it('lists each segment for per-keyframe easing', () => {
    const out = toLinearExport(cssKeyframes);
    expect(out).toContain('--ease-1');
    expect(out).toContain('--ease-2');
  });
});

describe('Motion', () => {
  it('converts timing to seconds, repeat and repeatType', () => {
    const out = toMotionVanilla(waapi);
    expect(out).toContain('import { animate } from "motion"');
    expect(out).toContain('animate(\n  ".box:nth-of-type(2)"');
    expect(out).toContain('transform: ["translateX(0px)", "translateX(200px)"]');
    expect(out).toContain('duration: 0.8');
    expect(out).toContain('ease: [0.65, 0, 0.35, 1]');
    expect(out).toContain('repeat: 2');
    expect(out).toContain('repeatType: "reverse"');
  });

  it('turns a linear() spring into a real spring transition', () => {
    const out = toMotionVanilla(springSpec);
    expect(out).toContain('type: "spring"');
    expect(out).toMatch(/bounce: 0\.3\d?/);
    expect(out).not.toContain('duration:');
  });

  it('uses per-segment ease arrays and times for uneven keyframes', () => {
    const out = toMotionVanilla(cssKeyframes);
    expect(out).toContain('ease: ["easeIn", "easeOut"]');
    expect(out).toContain('times: [0, 0.3, 1]');
    expect(out).toContain('opacity: [0, 1, 1]');
    expect(out).toContain('repeat: Infinity');
  });

  it('writes initial/animate for two keyframes in React', () => {
    const out = toMotionReact(transition);
    expect(out).toContain('initial={{');
    expect(out).toContain('backgroundColor: "rgb(255, 255, 255)"');
    expect(out).toContain('animate={{');
    expect(out).toContain('ease: "easeOut"');
  });

  it('emits an exact steps function', () => {
    const out = toMotionVanilla(steps);
    expect(out).toContain('const ease = (p) => Math.min(6, Math.max(0, Math.floor(p * 6) + 1)) / 6;');
    expect(out).toContain('ease: ease');
  });
});

describe('GSAP', () => {
  it('writes fromTo with CustomEase for an unknown bezier', () => {
    const out = toGsap({ ...waapi, easing: 'cubic-bezier(0.1, 0.7, 0.2, 1)' });
    expect(out).toContain('gsap.registerPlugin(CustomEase)');
    expect(out).toContain('gsap.fromTo(".box:nth-of-type(2)"');
    expect(out).toContain('CustomEase.create("ease", "0.1, 0.7, 0.2, 1")');
    expect(out).toContain('repeat: 2');
    expect(out).toContain('yoyo: true');
  });

  it('uses a GSAP name when the bezier is one', () => {
    expect(toGsap({ ...waapi, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' })).toContain('ease: "power4.out"');
    expect(toGsap({ ...waapi, easing: 'linear' })).toContain('ease: "none"');
  });

  it('writes percentage keyframes with per-segment eases', () => {
    const out = toGsap(cssKeyframes);
    expect(out).toContain('keyframes: {');
    expect(out).toContain('"30%": {');
    expect(out).toContain('repeat: -1');
    expect(out).toContain('ease: "none"');
    expect(out).toMatch(/"100%": \{[^}]*ease: CustomEase/);
  });

  it('echoes the original tween for GSAP-sourced animations', () => {
    const out = toGsap(gsapSpec);
    expect(out).toContain('gsap.to(".logo"');
    expect(out).toContain('x: 100');
    expect(out).toContain('rotation: 90');
    expect(out).toContain('ease: "back.out(1.7)"');
    expect(out).toContain('repeat: -1');
    expect(out).toContain('yoyo: true');
    expect(out).toContain('repeatDelay: 0.2');
  });

  it('turns a linear() spring into a piecewise ease function', () => {
    const out = toGsap(springSpec);
    expect(out).toContain('const easeStops = [');
    expect(out).toContain('ease: ease');
  });
});

describe('CSS for GSAP-sourced tweens', () => {
  it('uses the translated transform and the mapped easing', () => {
    const out = toCss(gsapSpec);
    expect(out).toContain('transform: translateX(100px) rotate(90deg);');
    expect(out).toContain('cubic-bezier(0.34, 1.56, 0.64, 1)');
  });
});
