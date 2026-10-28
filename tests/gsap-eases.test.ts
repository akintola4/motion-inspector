import { describe, expect, it } from 'vitest';
import { bezierToGsapEase, gsapEaseToBezier, gsapEaseToCss, normalizeGsapEase } from '../lib/gsap-eases';

describe('gsap eases', () => {
  it('normalizes old and new spellings', () => {
    expect(normalizeGsapEase('Power2.easeOut')).toBe('power2.out');
    expect(normalizeGsapEase('power3')).toBe('power3.out');
    expect(normalizeGsapEase('quad.inOut')).toBe('power1.inOut');
    expect(normalizeGsapEase('Linear.easeNone')).toBe('none');
    expect(normalizeGsapEase('back.out(1.7)')).toBe('back.out(1.7)');
  });

  it('maps names to beziers and back', () => {
    expect(gsapEaseToBezier('power4.out')).toEqual([0.22, 1, 0.36, 1]);
    expect(gsapEaseToBezier('back.out(1.7)')).toEqual([0.34, 1.56, 0.64, 1]);
    expect(gsapEaseToBezier('back.out(3)')).toBeNull();
    expect(gsapEaseToBezier('elastic.out(1, 0.3)')).toBeNull();
    expect(bezierToGsapEase([0.22, 1, 0.36, 1])).toBe('power4.out');
    expect(bezierToGsapEase([0.1, 0.2, 0.3, 0.4])).toBeNull();
  });

  it('uses the bezier only when it matches the samples', () => {
    // power2.out is a cubic ease-out: 1 - (1 - t)^3
    const cubicOut = Array.from({ length: 101 }, (_, i) => 1 - Math.pow(1 - i / 100, 3));
    expect(gsapEaseToCss('power2.out', cubicOut)).toBe('cubic-bezier(0.33, 1, 0.68, 1)');
    // Same name but the samples say otherwise → linear()
    const other = Array.from({ length: 101 }, (_, i) => Math.sqrt(i / 100));
    expect(gsapEaseToCss('power2.out', other)).toMatch(/^linear\(/);
    expect(gsapEaseToCss('none', [])).toBe('linear');
  });
});
