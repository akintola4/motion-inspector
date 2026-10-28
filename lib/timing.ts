/**
 * Timing helpers used by the panel: where in the curve an animation is,
 * and the "whole iteration" curve for multi-keyframe animations.
 */
import type { AnimationSpec } from './types';
import { evaluate, parseEasing, type EasingDef } from './easing';

const LINEAR: EasingDef = { type: 'linear' };

/**
 * Directed progress (0..1, before easing) for a given currentTime, or null
 * before the start / after the end of the active interval.
 */
export function iterationProgress(spec: AnimationSpec, currentTime: number | null): number | null {
  if (currentTime == null || !(spec.duration > 0)) return null;
  const local = currentTime - spec.delay;
  if (local < 0) return null;
  const iterations = spec.iterations === 'infinite' ? Infinity : spec.iterations;
  const active = spec.duration * iterations;
  let iteration: number;
  let p: number;
  if (local >= active) {
    iteration = Math.max(0, Math.ceil(iterations) - 1);
    p = iterations % 1 || 1;
  } else {
    iteration = Math.floor(local / spec.duration);
    p = (local % spec.duration) / spec.duration;
  }
  const odd = iteration % 2 === 1;
  switch (spec.direction) {
    case 'reverse':
      return 1 - p;
    case 'alternate':
      return odd ? 1 - p : p;
    case 'alternate-reverse':
      return odd ? p : 1 - p;
    default:
      return p;
  }
}

/** Last time worth scrubbing to: one pass of the active interval (infinite counts as one). */
export function scrubLength(spec: AnimationSpec): number {
  const iterations = spec.iterations === 'infinite' ? 1 : spec.iterations;
  return spec.delay + spec.duration * iterations + Math.max(0, spec.endDelay);
}

/**
 * The curve to draw for one iteration: effect easing applied first, then the
 * per-segment keyframe easings, mapped onto keyframe offsets. For a plain
 * two-keyframe animation this is just the easing.
 */
export function iterationCurve(spec: AnimationSpec): (t: number) => number {
  const effect = parseEasing(spec.easing) ?? LINEAR;
  const kfs = spec.keyframes;
  const segs = kfs.slice(0, -1).map((k, i) => ({
    from: k.offset,
    to: kfs[i + 1]!.offset,
    ease: parseEasing(k.easing) ?? LINEAR,
  }));
  return (t: number) => {
    const x = evaluate(effect, t);
    if (segs.length === 0) return x;
    const seg =
      segs.find((s) => x >= s.from && x <= s.to) ?? (x < segs[0]!.from ? segs[0]! : segs[segs.length - 1]!);
    const span = seg.to - seg.from;
    if (span <= 0) return seg.to;
    const local = (x - seg.from) / span;
    return seg.from + span * evaluate(seg.ease, local);
  };
}

export interface IterationPosition {
  /** `before`: still in the start delay. `after`: past the active interval. */
  phase: 'before' | 'active' | 'after';
  /** Zero-based iteration index. */
  iteration: number;
  /** ms into the current iteration (0 while in the delay). */
  local: number;
}

/**
 * Where an animation is in its own timeline: which iteration, and how far
 * into it. `currentTime` includes the start delay (as WAAPI reports it).
 */
export function iterationPosition(spec: AnimationSpec, currentTime: number | null): IterationPosition | null {
  if (currentTime == null || !Number.isFinite(currentTime) || !(spec.duration > 0)) return null;
  const local = currentTime - spec.delay;
  if (local < 0) return { phase: 'before', iteration: 0, local: 0 };
  if (spec.iterations !== 'infinite') {
    const active = spec.duration * spec.iterations;
    if (local >= active) {
      const frac = spec.iterations % 1;
      return {
        phase: 'after',
        iteration: Math.max(0, Math.ceil(spec.iterations) - 1),
        local: spec.duration * (frac || 1),
      };
    }
  }
  return { phase: 'active', iteration: Math.floor(local / spec.duration), local: local % spec.duration };
}

/**
 * The per-animation scrubber. Infinite animations scrub within the current
 * iteration (0 → duration) so the slider stays in range however long the
 * page has been running; finite ones scrub the whole first pass.
 */
export interface OneScrub {
  max: number;
  value: number;
  /** currentTime to set for a slider value. */
  toTime(value: number): number;
  label: string;
}

export function oneScrub(spec: AnimationSpec, currentTime: number | null): OneScrub {
  const pos = iterationPosition(spec, currentTime);
  const ms = (n: number) => String(Math.round(n));
  if (spec.iterations === 'infinite' && spec.duration > 0) {
    const iteration = pos?.iteration ?? 0;
    const value = pos ? pos.local : 0;
    const base = spec.delay + iteration * spec.duration;
    const where = pos?.phase === 'before' ? 'in delay' : `iteration ${iteration + 1}`;
    return {
      max: spec.duration,
      value,
      toTime: (v) => base + Math.max(0, Math.min(spec.duration, v)),
      label: `${ms(value)} / ${ms(spec.duration)} ms · ${where}`,
    };
  }
  const max = Math.max(1, scrubLength(spec));
  const value = Math.max(0, Math.min(max, currentTime ?? 0));
  const n = spec.iterations === 'infinite' ? 1 : spec.iterations;
  let where = '';
  if (pos?.phase === 'before') where = ' · in delay';
  else if (pos && n > 1) where = ` · iteration ${pos.iteration + 1} of ${Math.ceil(n)}`;
  return {
    max,
    value,
    toTime: (v) => Math.max(0, Math.min(max, v)),
    label: `${ms(value)} / ${ms(max)} ms${where}`,
  };
}
