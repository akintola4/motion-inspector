/** Shapes shared by the transport (global timeline) and the detail scrubber. */
import type { AnimationKind, AnimationSpec } from '../../../lib/types';

export const RATES = [0.1, 0.25, 0.5, 1];
/** One frame at 60 fps, in ms. */
export const FRAME = 1000 / 60;

/** A captured animation's active span on the global timeline (ms). */
export interface Lane {
  start: number;
  end: number;
  name: string;
  kind: AnimationKind;
}

export interface GlobalState {
  ready: boolean;
  paused: boolean;
  /** Playing and not scrubbed: there is no single position to show. */
  live: boolean;
  rate: number;
  /** Timeline length (ms). */
  end: number;
  /** Position to show / step from (ms). Meaningful even while live. */
  pos: number;
  lanes: Lane[];
  /** A scrub is queued or in flight: keep showing the local value. */
  holding: boolean;
}

export interface GlobalCallbacks {
  togglePlay(): void;
  setRate(rate: number): void;
  restart(): void;
  /** Called per input event; main coalesces to one agent call per frame. */
  scrub(t: number): void;
}

export interface DetailModel {
  max: number;
  value: number;
  /** oneScrub label, e.g. "372 / 2000 ms · iteration 14". */
  label: string;
  /** "Ended" / "Scroll-linked" instead of a time, or null. */
  word: string | null;
  disabled: boolean;
  /** currentTime for a slider value (for drawing per-iteration shapes). */
  toTime(v: number): number;
}

export interface DetailScrubber {
  el: HTMLElement;
  update(m: DetailModel): void;
  /** Move the playhead only (rAF glide between polls). */
  glide(value: number): void;
  readonly dragging: boolean;
}

export interface DetailOptions {
  spec: AnimationSpec;
  onScrub(value: number): void;
}

/** "1628"; values are fractional during frame stepping. */
export const ms = (n: number) => String(Math.round(n));

