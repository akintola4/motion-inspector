/**
 * Transport options (preview). Three designs from docs/transport-research.md
 * plus the current one, switchable from the header. Everything for the
 * switch lives in this folder, so dropping the losers is a delete here plus
 * the switcher lines in main.ts.
 */
import type { AnimationSpec } from '../../../lib/types';

export type Variant = 'current' | 'a' | 'b' | 'c';

export const VARIANTS: { id: Variant; short: string; name: string }[] = [
  { id: 'current', short: 'Old', name: 'Current transport' },
  { id: 'a', short: 'A', name: 'A · Now Playing (Apple Music)' },
  { id: 'b', short: 'B', name: 'B · Editor (DAW / NLE)' },
  { id: 'c', short: 'C', name: 'C · Waveform (SoundCloud / YouTube)' },
];

export const RATES = [0.1, 0.25, 0.5, 1];
/** One frame at 60 fps, in ms. */
export const FRAME = 1000 / 60;

/** A captured animation's active span on the global timeline (ms). */
export interface Lane {
  start: number;
  end: number;
  name: string;
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
  /** Pause and move by whole frames (negative = back). */
  step(frames: number): void;
}

export interface GlobalTransport {
  el: HTMLElement;
  render(s: GlobalState): void;
  /** True while a pointer drag is in progress (main skips poll updates). */
  readonly dragging: boolean;
  destroy(): void;
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

export type DetailFactory = (o: DetailOptions) => DetailScrubber;

export interface TransportFactory {
  global(cb: GlobalCallbacks): GlobalTransport;
  detail: DetailFactory;
}

/** "1628 ms"; values are fractional during frame stepping. */
export const ms = (n: number) => String(Math.round(n));

/** Spoken value for the global slider. */
export function globalValueText(s: { live: boolean; pos: number; end: number }) {
  return s.live ? `Live, timeline ${ms(s.end)} milliseconds` : `${ms(s.pos)} of ${ms(s.end)} milliseconds`;
}

/** Spoken value for a detail slider, from its label ("372 / 2000 ms · iteration 14"). */
export function detailValueText(m: DetailModel) {
  if (m.word) return m.word;
  return m.label.replace(' / ', ' of ').replace(' ms', ' milliseconds').replace(' · ', ', ');
}

/** Split a oneScrub label into its parts. */
export function parseLabel(label: string) {
  const m = /^(\d+) \/ (\d+) ms(?: · (.*))?$/.exec(label);
  if (!m) return null;
  return { cur: Number(m[1]), max: Number(m[2]), where: m[3] ?? '' };
}
