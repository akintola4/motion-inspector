/**
 * Shapes shared by the page agent and the side panel. Everything here must
 * survive JSON serialization (chrome.scripting.executeScript return values),
 * so no Infinity, no functions, no DOM nodes.
 */

export type AnimationKind =
  | 'css-animation'
  | 'css-transition'
  | 'waapi'
  | 'gsap'
  | 'js';

export type Iterations = number | 'infinite';

export interface Keyframe {
  /** 0..1, always filled in (computedOffset when the author left it out). */
  offset: number;
  /** Easing for the segment that starts at this keyframe. */
  easing: string;
  /** Property → value, CSS property names in camelCase (as WAAPI reports them). */
  props: Record<string, string>;
}

export interface GsapInfo {
  /** Ease name as written in the tween vars, e.g. "power2.out". */
  easeName: string;
  /** 101 samples of the parsed ease function, t = 0, 0.01 … 1. */
  easeSamples: number[];
  yoyo: boolean;
  repeatDelay: number;
  /** Animated vars exactly as written in the tween (GSAP shorthands kept). */
  vars: Record<string, string>;
  /** Start values from fromTo()/startAt, when present. */
  fromVars?: Record<string, string>;
  /** Start time (s) inside its parent timeline, when it isn't top-level. */
  timelinePosition?: number;
}

export interface AnimationSpec {
  id: string;
  kind: AnimationKind;
  /** animationName, transitionProperty, WAAPI id, or a generated label. */
  name: string;
  /** True when `name` was made up from the properties (no id / animationName). */
  nameIsGenerated?: boolean;
  /** Short unique selector for the target, e.g. ".card:nth-of-type(2)". */
  selector: string;
  /** Human label for the target, e.g. `div.skeleton`, `button “Save”`. */
  label: string;
  /** All timing values in milliseconds. */
  duration: number;
  delay: number;
  endDelay: number;
  iterations: Iterations;
  direction: PlaybackDirection;
  fill: FillMode;
  /** Effect-level easing (CSS syntax). */
  easing: string;
  keyframes: Keyframe[];
  /** Animated properties, camelCase. */
  properties: string[];
  gsap?: GsapInfo;
}

export interface LiveState {
  playState: string;
  /** ms, or null when idle/unresolved. */
  currentTime: number | null;
  /** 0..1 within the current iteration, or null when not in effect. */
  progress: number | null;
  playbackRate: number;
  /** True once the animation was dropped from document.getAnimations(). */
  ended: boolean;
  /** Scroll-driven: currentTime is a scroll percentage, controls don't apply. */
  scrollLinked: boolean;
}

export interface AnimationEntry {
  spec: AnimationSpec;
  live: LiveState;
}

export interface JsDrivenEntry {
  id: string;
  selector: string;
  label: string;
  /** Inline style mutations per second over the last sampling window. */
  rate: number;
  /** Which inline properties were changing, best effort. */
  properties: string[];
}

export interface AgentSnapshot {
  version: number;
  url: string;
  paused: boolean;
  rate: number;
  /** Global scrub range in ms. */
  scrubEnd: number;
  /** Last global scrub position (ms) or null when playing freely. */
  scrubTime: number | null;
  gsapDetected: boolean;
  animations: AnimationEntry[];
  jsDriven: JsDrivenEntry[];
}

/** Incremental snapshot: specs only for ids the panel hasn't cached. */
export interface AgentPoll {
  version: number;
  /** Random per injection; a change means cached specs are stale. */
  session: string;
  url: string;
  paused: boolean;
  rate: number;
  scrubEnd: number;
  scrubTime: number | null;
  gsapDetected: boolean;
  /** Animation ids in list order. */
  order: string[];
  /** Live state per id, same order as `order`. */
  live: LiveState[];
  /** Specs the panel didn't pass in `known`. */
  specs: AnimationSpec[];
  jsDriven: JsDrivenEntry[];
}
