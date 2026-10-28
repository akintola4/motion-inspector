import { describe, expect, it } from 'vitest';
import { filterAnimations, groupAnimations, isNoop, lingeringIds } from '../lib/grouping';
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

describe('lingeringIds', () => {
  it('keeps a just-ended animation under Live for a moment, then lets it go', () => {
    const endedAt = new Map<string, number>();
    const t = entry(transition, true);
    expect([...lingeringIds([t], endedAt, 1000, 1500)]).toEqual(['t1']);
    expect([...lingeringIds([t], endedAt, 2400, 1500)]).toEqual(['t1']);
    expect([...lingeringIds([t], endedAt, 2600, 1500)]).toEqual([]);
    const r = filterAnimations([t], 'live', false, lingeringIds([t], new Map(), 0, 1500));
    expect(r.shown.map((e) => e.spec.id)).toEqual(['t1']);
    // Listed under Live, but counted honestly as ended.
    expect(r.counts).toEqual({ live: 0, ended: 1, all: 1 });
  });

  it('doesn’t linger animations that had already ended when the panel attached', () => {
    const endedAt = new Map<string, number>();
    const t = entry(transition, true);
    expect([...lingeringIds([t], endedAt, 1000, 3000, true)]).toEqual([]);
    expect([...lingeringIds([t], endedAt, 1250, 3000)]).toEqual([]);
    // Something that ends after that does linger.
    const later = entry({ ...transition, id: 't9', selector: '#late' }, true);
    expect([...lingeringIds([t, later], endedAt, 1500, 3000)]).toEqual(['t9']);
  });

  it('drops the ended one as soon as the same animation re-triggers on that element', () => {
    const endedAt = new Map<string, number>();
    const old = entry(transition, true);
    const again = entry({ ...transition, id: 't2' });
    expect([...lingeringIds([old, again], endedAt, 0, 1500)]).toEqual([]);
    // Reversed halfway: shorter duration, still the same transition on the same element.
    const reversed = entry({ ...transition, id: 't4', duration: 77 });
    expect([...lingeringIds([old, reversed], new Map(), 0, 1500)]).toEqual([]);
    // Same timing on another element doesn't count as a re-trigger.
    const other = entry({ ...transition, id: 't3', selector: '#other' });
    expect([...lingeringIds([old, other], new Map(), 0, 1500)]).toEqual(['t1']);
  });

  it('forgets animations the page no longer has', () => {
    const endedAt = new Map<string, number>();
    lingeringIds([entry(transition, true)], endedAt, 0, 1500);
    lingeringIds([], endedAt, 10, 1500);
    expect(endedAt.size).toBe(0);
  });
});
