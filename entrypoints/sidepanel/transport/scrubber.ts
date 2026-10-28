/**
 * The slider engine shared by options A, B and C: a div with role=slider
 * that options decorate with their own track, fill, playhead, ruler or
 * waveform. It owns value, pointer capture, keyboard and ARIA; the option
 * only paints.
 *
 * - Hit area is the whole element (at least 24px tall), however thin the
 *   drawing inside it is.
 * - Keyboard (APG slider): ←/↓ and →/↑ one frame (Shift: 10 frames), `,`/`.`
 *   one frame, Page Up/Down 10%, Home/End.
 * - `fine`: Apple-style precision. While dragging, the further the pointer is
 *   from the track vertically, the slower the value follows it (full, half,
 *   quarter, fine).
 * - Test hook: a `mi-seek` CustomEvent with a value in `detail` sets the
 *   value as if the user had dragged there (e2e uses it for exact times).
 */
import { FRAME } from './types';

export type FineMode = 0 | 1 | 2 | 3;
export const FINE_LABEL = ['', 'Half-speed scrubbing', 'Quarter-speed scrubbing', 'Fine scrubbing'];
const FINE_FACTOR = [1, 0.5, 0.25, 0.1];
/** Vertical distance (px) from the track centre where each mode starts. */
const FINE_AT = [0, 36, 72, 108];

export interface ScrubberOptions {
  el: HTMLElement;
  /** Element whose box is the 0 → max range. Defaults to `el`. */
  track?: HTMLElement;
  label: string;
  fine?: boolean;
  valueText(value: number, max: number): string;
  /** Draw the position, 0..1. */
  paint(p: number): void;
  onInput(value: number): void;
  onStart?(): void;
  onEnd?(): void;
  /** Pointer position as a value (null when it leaves). Fires while dragging too. */
  onHover?(value: number | null, p: number): void;
  onFineMode?(mode: FineMode): void;
}

export interface Scrubber {
  /** Set value and max from outside (polls). Ignored while dragging. */
  set(value: number, max: number): void;
  /** Paint a value without touching ARIA (rAF glide). */
  paintOnly(value: number): void;
  setDisabled(disabled: boolean): void;
  setValueText(text: string): void;
  readonly value: number;
  readonly max: number;
  readonly dragging: boolean;
}

export function createScrubber(o: ScrubberOptions): Scrubber {
  const el = o.el;
  const track = o.track ?? el;
  let value = 0;
  let max = 1;
  let disabled = false;
  let dragging = false;
  let anchorX = 0;
  let anchorV = 0;
  let mode: FineMode = 0;

  el.setAttribute('role', 'slider');
  el.setAttribute('tabindex', '0');
  el.setAttribute('aria-label', o.label);
  el.setAttribute('aria-valuemin', '0');
  el.classList.add('scrub');

  const clamp = (v: number) => Math.max(0, Math.min(max, v));
  const p = (v: number) => (max > 0 ? v / max : 0);

  function aria() {
    setA('aria-valuemax', String(Math.round(max)));
    setA('aria-valuenow', String(Math.round(value)));
    setA('aria-valuetext', o.valueText(value, max));
  }
  function setA(name: string, v: string) {
    if (el.getAttribute(name) !== v) el.setAttribute(name, v);
  }

  function commit(v: number) {
    v = clamp(v);
    if (v === value) return;
    value = v;
    o.paint(p(value));
    aria();
    o.onInput(value);
  }

  function fromX(clientX: number) {
    const r = track.getBoundingClientRect();
    return clamp(((clientX - r.left) / Math.max(1, r.width)) * max);
  }

  el.addEventListener('pointerdown', (e) => {
    if (disabled || e.button !== 0 || dragging) return; // ignore extra touches mid-drag
    // No preventDefault: the native mousedown focus keeps :focus-visible off
    // for pointer users (a programmatic focus() would turn the ring on).
    el.setPointerCapture(e.pointerId);
    dragging = true;
    el.dataset.pressed = '';
    o.onStart?.();
    const v = fromX(e.clientX);
    anchorX = e.clientX;
    anchorV = v;
    commit(v);
    o.onHover?.(v, p(v));
  });

  el.addEventListener('pointermove', (e) => {
    if (disabled) return;
    if (!dragging) {
      const v = fromX(e.clientX);
      o.onHover?.(v, p(v));
      return;
    }
    let v: number;
    if (o.fine) {
      const r = track.getBoundingClientRect();
      const dy = Math.abs(e.clientY - (r.top + r.height / 2));
      const next = (FINE_AT.filter((t) => dy >= t).length - 1) as FineMode;
      if (next !== mode) {
        // Re-anchor so changing speed never makes the value jump.
        mode = next;
        anchorX = e.clientX;
        anchorV = value;
        o.onFineMode?.(mode);
      }
      v = anchorV + ((e.clientX - anchorX) / Math.max(1, r.width)) * max * FINE_FACTOR[mode]!;
    } else {
      v = fromX(e.clientX);
    }
    commit(v);
    o.onHover?.(clamp(v), p(clamp(v)));
  });

  const end = () => {
    if (!dragging) return;
    dragging = false;
    delete el.dataset.pressed;
    if (mode !== 0) {
      mode = 0;
      o.onFineMode?.(0);
    }
    o.onEnd?.();
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('lostpointercapture', end);
  el.addEventListener('pointerleave', () => {
    if (!dragging) o.onHover?.(null, 0);
  });

  el.addEventListener('keydown', (e) => {
    if (disabled || e.metaKey || e.ctrlKey || e.altKey) return;
    const frames = e.shiftKey ? 10 : 1;
    let v: number | null = null;
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
      case ',':
        v = value - FRAME * frames;
        break;
      case 'ArrowRight':
      case 'ArrowUp':
      case '.':
        v = value + FRAME * frames;
        break;
      case 'PageDown':
        v = value - max / 10;
        break;
      case 'PageUp':
        v = value + max / 10;
        break;
      case 'Home':
        v = 0;
        break;
      case 'End':
        v = max;
        break;
    }
    if (v == null) return;
    e.preventDefault();
    e.stopPropagation();
    o.onStart?.();
    commit(v);
    o.onEnd?.();
  });

  el.addEventListener('mi-seek', (e) => {
    const v = Number((e as CustomEvent).detail);
    if (!Number.isFinite(v) || disabled) return;
    o.onStart?.();
    commit(v);
    o.onEnd?.();
  });

  aria();

  return {
    set(v, m) {
      if (dragging) return;
      max = Math.max(1, m);
      value = clamp(v);
      o.paint(p(value));
      aria();
    },
    paintOnly(v) {
      if (dragging) return;
      o.paint(p(clamp(v)));
    },
    setDisabled(d) {
      if (d === disabled) return;
      disabled = d;
      setA('aria-disabled', String(d));
      setA('tabindex', d ? '-1' : '0');
      if (d) end();
    },
    setValueText(text) {
      setA('aria-valuetext', text);
    },
    get value() {
      return value;
    },
    get max() {
      return max;
    },
    get dragging() {
      return dragging;
    },
  };
}
