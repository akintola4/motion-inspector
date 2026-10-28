import { describe, expect, it } from 'vitest';
import { filterAnimations, groupAnimations, isNoop } from '../lib/grouping';
import type { AnimationEntry, AnimationSpec } from '../lib/types';
import { cssKeyframes, transition } from './specs';

const live = { playState: 'running', currentTime: 0, progress: 0, playbackRate: 1, ended: false, scrollLinked: false };
const entry = (spec: AnimationSpec, ended = false): AnimationEntry => ({ spec, live: { ...live, ended } });

const pulse = (i: number) => entry({ ...cssKeyframes, id: `p${i}`, selector: `div:nth-of-type(${i})` });

describe('groupAnimations', () => {
  it('folds identical animations on different elements into one group', () => {
    const list = [...Array.from({ length: 12 }, (_, i) => pulse(i)), entry(transition)];
    const groups = groupAnimations(list);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.entries).toHaveLength(12);
    expect(groups[1]!.entries[0]!.spec.id).toBe('t1');
  });

  it('keeps animations apart when timing or keyframes differ', () => {
    const groups = groupAnimations([
      pulse(1),
      entry({ ...cssKeyframes, id: 'x', duration: 999 }),
      entry({ ...cssKeyframes, id: 'y', keyframes: cssKeyframes.keyframes.slice(0, 2) }),
    ]);
    expect(groups).toHaveLength(3);
  });
});

describe('isNoop', () => {
  it('flags zero-length and static animations', () => {
    expect(isNoop({ ...transition, duration: 0 })).toBe(true);
    const same = transition.keyframes.map((k) => ({ ...k, props: { opacity: '1' } }));
    expect(isNoop({ ...transition, keyframes: same })).toBe(true);
    expect(isNoop(transition)).toBe(false);
  });
});

describe('filterAnimations', () => {
  const list = [pulse(1), entry(transition, true), entry({ ...transition, id: 'z', duration: 0 })];

  it('shows live by default and counts the rest', () => {
    const r = filterAnimations(list, 'live', false);
    expect(r.shown.map((e) => e.spec.id)).toEqual(['p1']);
    expect(r.counts).toEqual({ live: 1, ended: 1, all: 2 });
  });

  it('hides no-ops unless asked', () => {
    expect(filterAnimations(list, 'all', false).hiddenNoop).toBe(1);
    expect(filterAnimations(list, 'all', true).shown).toHaveLength(3);
    expect(filterAnimations(list, 'ended', false).shown.map((e) => e.spec.id)).toEqual(['t1']);
  });
});
