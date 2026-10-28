/**
 * List shaping for the panel: fold identical animations into one row,
 * filter by live/ended, and hide animations that don't animate anything.
 */
import type { AnimationEntry, AnimationSpec } from './types';

export type StatusFilter = 'live' | 'ended' | 'all';

export interface AnimationGroup {
  key: string;
  entries: AnimationEntry[];
}

/** Same kind, name, timing, easing and keyframes → same key. Targets don't count. */
export function groupKey(spec: AnimationSpec): string {
  return JSON.stringify([
    spec.kind,
    spec.name,
    spec.duration,
    spec.delay,
    spec.endDelay,
    spec.iterations,
    spec.direction,
    spec.easing,
    spec.keyframes,
    spec.gsap?.easeName ?? null,
  ]);
}

/** Groups in order of first appearance; members keep list order. */
export function groupAnimations(entries: AnimationEntry[]): AnimationGroup[] {
  const groups = new Map<string, AnimationGroup>();
  for (const e of entries) {
    const key = groupKey(e.spec);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, entries: [] }));
    g.entries.push(e);
  }
  return [...groups.values()];
}

/** Zero-length, or every keyframe holds the same values: nothing visibly moves. */
export function isNoop(spec: AnimationSpec): boolean {
  if (!(spec.duration > 0)) return true;
  const kfs = spec.keyframes;
  if (kfs.length < 2) return false;
  const first = JSON.stringify(kfs[0]!.props);
  return kfs.every((k) => JSON.stringify(k.props) === first);
}

export interface FilterResult {
  shown: AnimationEntry[];
  counts: { live: number; ended: number; all: number };
  /** No-op animations left out of `shown` (0 when showNoop is on). */
  hiddenNoop: number;
}

export function filterAnimations(entries: AnimationEntry[], filter: StatusFilter, showNoop: boolean): FilterResult {
  const counts = { live: 0, ended: 0, all: 0 };
  const shown: AnimationEntry[] = [];
  let hiddenNoop = 0;
  for (const e of entries) {
    const noop = isNoop(e.spec);
    if (noop && !showNoop) {
      const match = filter === 'all' || (filter === 'ended') === e.live.ended;
      if (match) hiddenNoop++;
      continue;
    }
    counts.all++;
    if (e.live.ended) counts.ended++;
    else counts.live++;
    if (filter === 'all' || (filter === 'ended') === e.live.ended) shown.push(e);
  }
  return { shown, counts, hiddenNoop };
}
