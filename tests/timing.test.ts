import { describe, expect, it } from 'vitest';
import { iterationPosition, oneScrub } from '../lib/timing';
import type { AnimationSpec } from '../lib/types';
import { cssKeyframes, transition } from './specs';

const loop: AnimationSpec = { ...cssKeyframes, duration: 2000, delay: 0, iterations: 'infinite', direction: 'normal' };

describe('iterationPosition', () => {
  it('finds the iteration and the time inside it for a long-running loop', () => {
    expect(iterationPosition(loop, 26372)).toEqual({ phase: 'active', iteration: 13, local: 372 });
  });

  it('reports the start delay', () => {
    expect(iterationPosition({ ...loop, delay: 300 }, 120)).toEqual({ phase: 'before', iteration: 0, local: 0 });
  });

  it('clamps finite animations to their last iteration', () => {
    expect(iterationPosition({ ...loop, iterations: 2 }, 9000)).toEqual({ phase: 'after', iteration: 1, local: 2000 });
    expect(iterationPosition({ ...loop, iterations: 1.5 }, 9000)).toEqual({ phase: 'after', iteration: 1, local: 1000 });
  });

  it('returns null without a time or a duration', () => {
    expect(iterationPosition(loop, null)).toBeNull();
    expect(iterationPosition({ ...loop, duration: 0 }, 100)).toBeNull();
  });
});

describe('oneScrub', () => {
  it('keeps an infinite loop in range and says which iteration', () => {
    const s = oneScrub(loop, 26372);
    expect(s.max).toBe(2000);
    expect(s.value).toBe(372);
    expect(s.label).toBe('372 / 2000 ms · iteration 14');
  });

  it('scrubs inside the current iteration, after the delay', () => {
    const s = oneScrub({ ...loop, delay: 200 }, 200 + 2000 * 3 + 50);
    expect(s.toTime(500)).toBe(200 + 2000 * 3 + 500);
    expect(s.toTime(99999)).toBe(200 + 2000 * 4);
  });

  it('first iteration with no delay maps straight through', () => {
    expect(oneScrub({ ...loop, duration: 1200 }, 150).toTime(777)).toBe(777);
  });

  it('uses the whole first pass for finite animations', () => {
    const s = oneScrub(transition, 120);
    expect(s.max).toBe(200);
    expect(s.label).toBe('120 / 200 ms');
    const multi = oneScrub({ ...loop, iterations: 3 }, 4500);
    expect(multi.max).toBe(6000);
    expect(multi.label).toBe('4500 / 6000 ms · iteration 3 of 3');
  });

  it('labels the delay', () => {
    expect(oneScrub({ ...loop, delay: 300 }, 100).label).toBe('0 / 2000 ms · in delay');
  });
});
