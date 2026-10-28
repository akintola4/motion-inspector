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

/**
 * `lingering`: ids of animations that just ended but still show under Live
 * (see lingeringIds). They're listed there, faded and marked Ended, but the
 * counts stay honest: they count as ended only.
 */
export function filterAnimations(
  entries: AnimationEntry[],
  filter: StatusFilter,
  showNoop: boolean,
  lingering: ReadonlySet<string> = new Set(),
): FilterResult {
  const counts = { live: 0, ended: 0, all: 0 };
  const shown: AnimationEntry[] = [];
  let hiddenNoop = 0;
  for (const e of entries) {
    const linger = e.live.ended && lingering.has(e.spec.id);
    const inLive = !e.live.ended || linger;
    const match = filter === 'all' || (filter === 'live' ? inLive : e.live.ended);
    if (isNoop(e.spec) && !showNoop) {
      if (match) hiddenNoop++;
      continue;
    }
    counts.all++;
    if (e.live.ended) counts.ended++;
    else counts.live++;
    if (match) shown.push(e);
  }
  return { shown, counts, hiddenNoop };
}

/**
 * One animation on one element, across re-triggers: a new transition each
 * hover, or one reversed halfway (shorter duration) is still "transform on
 * #toggle".
 */
export function targetKey(spec: AnimationSpec): string {
  return JSON.stringify([spec.kind, spec.name, spec.selector]);
}

/**
 * Animations that ended less than `ms` ago, so the Live list doesn't blink a
 * row out and back every time a short transition finishes and re-triggers.
 * One that's been re-triggered (the same animation running again on the
 * same element, whatever its timing) is dropped: the new one takes its place.
 *
 * `endedAt` is updated in place: first time each id was seen ended. Pass
 * `first` on the first poll after attaching: whatever has already ended by
 * then ended before the panel was looking, so it doesn't linger.
 */
export function lingeringIds(entries: AnimationEntry[], endedAt: Map<string, number>, now: number, ms: number, first = false): Set<string> {
  const running = new Set<string>();
  const present = new Set<string>();
  for (const e of entries) {
    present.add(e.spec.id);
    if (!e.live.ended) {
      running.add(targetKey(e.spec));
      endedAt.delete(e.spec.id);
    } else if (!endedAt.has(e.spec.id)) {
      endedAt.set(e.spec.id, first ? -Infinity : now);
    }
  }
  for (const id of endedAt.keys()) if (!present.has(id)) endedAt.delete(id);
  const out = new Set<string>();
  for (const e of entries) {
    if (!e.live.ended) continue;
    const at = endedAt.get(e.spec.id)!;
    if (now - at < ms && !running.has(targetKey(e.spec))) out.add(e.spec.id);
  }
  return out;
}
