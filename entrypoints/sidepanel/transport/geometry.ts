/** Where an animation's passes and keyframes fall on its detail scrubber. */
import type { AnimationSpec } from '../../../lib/types';
import type { DetailModel } from './types';

export function isReversed(spec: AnimationSpec, iteration: number) {
  const odd = iteration % 2 === 1;
  return spec.direction === 'reverse' || (spec.direction === 'alternate' && odd) || (spec.direction === 'alternate-reverse' && !odd);
}

export interface Pass {
  /** Slider value where this iteration starts. */
  start: number;
  reversed: boolean;
}

/**
 * The iterations visible on the scrubber. Infinite animations scrub one
 * iteration (which one decides the direction for alternate); finite ones
 * show every pass after the delay, capped at 12.
 */
export function passes(spec: AnimationSpec, m: DetailModel): Pass[] {
  if (spec.iterations === 'infinite') {
    const it = Math.max(0, Math.floor((m.toTime(0) - spec.delay) / Math.max(1, spec.duration)));
    return [{ start: 0, reversed: isReversed(spec, it) }];
  }
  const n = Math.min(12, Math.ceil(spec.iterations));
  return Array.from({ length: n }, (_, i) => ({ start: spec.delay + i * spec.duration, reversed: isReversed(spec, i) }));
}

/** Keyframe times (slider values) for each pass, inner keyframes only when `inner`. */
export function keyframeTimes(spec: AnimationSpec, m: DetailModel, inner = false): number[] {
  const offs = spec.keyframes.map((k) => k.offset).filter((o) => !inner || (o > 0 && o < 1));
  const out: number[] = [];
  for (const p of passes(spec, m)) for (const o of offs) out.push(p.start + (p.reversed ? 1 - o : o) * spec.duration);
  return out;
}

/** Changes only when the shape on the scrubber would change. */
export function shapeSig(spec: AnimationSpec, m: DetailModel) {
  const p = passes(spec, m);
  return `${Math.round(m.max)}|${p.length}|${p[0]?.reversed ? 1 : 0}`;
}
