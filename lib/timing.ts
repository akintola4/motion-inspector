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
