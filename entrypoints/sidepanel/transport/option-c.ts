/**
 * Option C: Waveform (SoundCloud + YouTube).
 *
 *   (▶) [⟲]  372 / 2000 ms                          [1× ▾]
 *   ▁▃▅▇▇▅▃▂▁ ▁▂▃▃▂▁▁ ▁▁▂▂▁   ← how many animations run at each moment
 *   '    '       '                ← where animations start
 *
 * The track is a waveform of activity: bar height is how many captured
 * animations are running at that point on the timeline. Left of the
 * playhead is drawn solid (played), right of it muted, as SoundCloud does.
 * Hovering shows a preview of the time and what runs there (YouTube's
 * hover preview), without moving anything. While the page plays, the
 * waveform is all one muted tone with no playhead. Speed is a popover.
 *
 * Detail: the animation's own eased value as bars, split at keyframes like
 * YouTube chapters.
 */
import type { AnimationSpec } from '../../../lib/types';
import { iterationCurve, iterationProgress } from '../../../lib/timing';
import { h, numSlot, setAttr, setText } from '../h';
import { icons } from '../icons';
import { playButton, rateText, restartButton, setDisabled } from './controls';
import { createReadout } from './readout';
import { createScrubber } from './scrubber';
import { keyframeTimes, shapeSig } from './geometry';
import { RATES, detailValueText, globalValueText, ms, type DetailModel, type DetailOptions, type DetailScrubber, type GlobalCallbacks, type GlobalTransport, type Lane, type TransportFactory } from './types';

const BARS = 64;

/** Two identical bar rows; the top one is clipped to the played part. */
function wave(label: string, onInput: (v: number) => void, valueText: (v: number, max: number) => string, tipText: (v: number) => string) {
  const mk = (cls: string) => h('div', { class: `tc-bars ${cls}`, 'aria-hidden': 'true' }, ...Array.from({ length: BARS }, () => h('span', { class: 'tc-b' })));
  const base = mk('tc-base');
  const played = mk('tc-played');
  const marks = h('div', { class: 'tc-marks', 'aria-hidden': 'true' });
  const gaps = h('div', { class: 'tc-gaps', 'aria-hidden': 'true' });
  const head = h('span', { class: 'tc-rail tc-ph', 'aria-hidden': 'true' }, h('span', { class: 'tc-ph-line' }));
  const tip = h('span', { class: 'tc-tip' });
  const tipRail = h('span', { class: 'tc-rail tc-tip-rail', 'aria-hidden': 'true' }, tip);
  const hover = h('span', { class: 'tc-rail tc-hover', 'aria-hidden': 'true' }, h('span', { class: 'tc-hover-line' }));
  const field = h('div', { class: 'tc-field' }, base, played, gaps, hover, head);
  const el = h('div', { class: 'tc-wave', 'data-part': 'scrubber' }, field, marks, tipRail);
  const s = createScrubber({
    el,
    track: field,
    label,
    valueText,
    paint(p) {
      played.style.clipPath = `inset(0 ${(1 - p) * 100}% 0 0)`;
      head.style.transform = `translateX(${p * 100}%)`;
    },
    onInput,
    onHover(v, p) {
      if (v == null) {
        el.classList.remove('is-hovering');
        return;
      }
      el.classList.add('is-hovering');
      setText(tip, tipText(v));
      hover.style.transform = tipRail.style.transform = `translateX(${p * 100}%)`;
      // Keep the bubble inside the panel near the ends.
      tip.dataset.edge = p < 0.12 ? 'start' : p > 0.88 ? 'end' : '';
    },
  });
  const bars = [...base.children, ...played.children] as HTMLElement[];
  return {
    el,
    s,
    marks,
    gaps,
    /** Heights 0..1, one per bar. */
    setHeights(hs: number[]) {
      hs.forEach((v, i) => {
        const t = `scaleY(${Math.max(0.08, Math.min(1, v)).toFixed(3)})`;
        bars[i]!.style.transform = t;
        bars[i + BARS]!.style.transform = t;
      });
    },
  };
}

/** How many lanes are running in each bucket, normalised. */
function activity(lanes: Lane[], end: number) {
  const counts = Array.from({ length: BARS }, (_, i) => {
    const a = (i / BARS) * end;
    const b = ((i + 1) / BARS) * end;
    return lanes.filter((l) => l.start < b && l.end > a).length;
  });
  const top = Math.max(1, ...counts);
  return counts.map((c) => (c === 0 ? 0 : 0.15 + 0.85 * (c / top)));
}

function global(cb: GlobalCallbacks): GlobalTransport {
  const play = playButton(cb.togglePlay, 'btn btn-primary play');
  const restart = restartButton(cb.restart);
  play.el.dataset.align = 'start';

  let lanes: Lane[] = [];
  let lanesSig = '';
  let end = 1;

  /* Readout: "372 / 2000 ms"; while live the current slot says Live. */
  const cur = numSlot(4);
  const endN = numSlot(4);
  const liveWord = h('span', { class: 'tc-live' }, 'Live');
  const time = h('span', { class: 'time tc-time', 'data-part': 'time' }, h('span', { class: 'tc-cur' }, cur.el, liveWord), ' / ', endN.el, ' ms');

  /* Speed popover. */
  let rate = 1;
  const speedVal = h('span', { class: 'tc-speed-val' });
  const speed = h(
    'button',
    { class: 'btn btn-ghost tc-speed', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-part': 'speed', title: 'Playback speed (J slower, L faster)' },
    h('span', { class: 'tc-speed-box' }, h('span', { class: 'tc-speed-ghost', 'aria-hidden': 'true' }, '0.25×'), speedVal),
    h('span', { class: 'tc-caret', html: icons.chevronDown }),
  );
  speed.dataset.align = 'end';
  const items = RATES.map((r) =>
    h('button', { class: 'tc-item', type: 'button', role: 'menuitemradio', 'aria-checked': 'false', tabindex: '-1', dataset: { rate: String(r) } }, h('span', { class: 'tc-check', html: icons.check }), h('span', {}, rateText(r)), h('span', { class: 'tc-item-note' }, r === 1 ? 'Normal' : r === 0.1 ? 'Slowest' : '')),
  );
  const menu = h('div', { class: 'tc-menu', role: 'menu', 'aria-label': 'Playback speed' }, ...items, h('p', { class: 'tc-menu-hint' }, 'J slower · L faster'));
  const speedWrap = h('div', { class: 'tc-speed-wrap' }, speed, menu);

  function openMenu(focusChecked: boolean) {
    menu.dataset.open = '';
    setAttr(speed, 'aria-expanded', 'true');
    if (focusChecked) (items.find((b) => b.getAttribute('aria-checked') === 'true') ?? items[0]!).focus();
    document.addEventListener('pointerdown', outside, true);
  }
  function closeMenu(refocus: boolean) {
    if (!('open' in menu.dataset)) return;
    delete menu.dataset.open;
    setAttr(speed, 'aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    if (refocus) speed.focus();
  }
  const outside = (e: PointerEvent) => {
    if (!speedWrap.contains(e.target as Node)) closeMenu(false);
  };
  speed.addEventListener('click', (e) => {
    if ('open' in menu.dataset) closeMenu(false);
    // Keyboard clicks (detail 0) move focus into the menu; pointer clicks don't.
    else openMenu(e.detail === 0);
  });
  speed.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      openMenu(true);
    }
  });
  menu.addEventListener('keydown', (e) => {
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.stopPropagation();
      if (e.key === 'Escape') e.preventDefault();
      closeMenu(e.key === 'Escape');
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const j = (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[j]!.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      items[e.key === 'Home' ? 0 : items.length - 1]!.focus();
    }
    // Space/K/J/L etc. stay inside the menu.
    if (e.key === ' ' || e.key.length === 1) e.stopPropagation();
  });
  for (const b of items) {
    b.addEventListener('click', () => {
      cb.setRate(Number(b.dataset.rate));
      closeMenu(true);
    });
  }

  const w = wave(
    'Scrub all animations',
    (v) => {
      setTime(v, end, false);
      el.dataset.state = 'scrubbing';
      cb.scrub(v);
    },
    (v, max) => globalValueText({ live: false, pos: v, end: max }),
    (v) => {
      const on = lanes.filter((l) => l.start <= v && l.end > v);
      const what = on.length === 0 ? 'nothing running' : on.length === 1 ? on[0]!.name : `${on[0]!.name} +${on.length - 1}`;
      return `${ms(v)} ms · ${what}`;
    },
  );
  const s = w.s;

  const el = h(
    'section',
    { class: 'transport t-c', 'data-variant': 'c', 'data-state': 'live' },
    h('div', { class: 'tc-bar' }, play.el, restart, time, h('span', { class: 'tc-flex' }), speedWrap),
    w.el,
  );

  function setTime(pos: number | null, e: number, live: boolean) {
    const d = String(Math.round(e)).length;
    cur.digits(d);
    endN.digits(d);
    cur.set(live || pos == null ? '' : ms(pos));
    endN.set(ms(e));
    time.classList.toggle('is-live', live);
  }

  function drawLanes(ls: Lane[], e: number) {
    const sig = `${e}|${ls.map((l) => `${Math.round(l.start)}-${Math.round(l.end)}`).join(',')}`;
    if (sig === lanesSig) return;
    lanesSig = sig;
    w.setHeights(activity(ls, e));
    const starts = [...new Set(ls.map((l) => Math.round(l.start)))].filter((t) => t > 0 && t < e).slice(0, 40);
    w.marks.replaceChildren(...[0, ...starts].map((t) => h('span', { class: 'tc-mark', style: { left: `${(t / e) * 100}%` } })));
  }

  return {
    el,
    get dragging() {
      return s.dragging;
    },
    render(st) {
      setDisabled([play.el, restart, speed], !st.ready);
      s.setDisabled(!st.ready);
      play.set(st.ready && st.paused);
      rate = st.rate;
      setText(speedVal, rateText(rate));
      setAttr(speed, 'aria-label', `Speed ${rateText(rate)}`);
      for (const b of items) setAttr(b, 'aria-checked', String(Number(b.dataset.rate) === rate));
      if (!st.ready) {
        el.dataset.state = 'idle';
        drawLanes([], 1);
        s.set(0, 1);
        setTime(null, 0, true);
        return;
      }
      lanes = st.lanes;
      end = st.end;
      drawLanes(st.lanes, st.end);
      if (s.dragging || st.holding) return;
      el.dataset.state = st.live ? 'live' : 'paused';
      s.set(st.live ? 0 : st.pos, st.end);
      if (st.live) s.setValueText(globalValueText(st));
      setTime(st.pos, st.end, st.live);
    },
    destroy() {
      document.removeEventListener('pointerdown', outside, true);
    },
  };
}

function detail(o: DetailOptions): DetailScrubber {
  let model: DetailModel | null = null;
  const curve = iterationCurve(o.spec);
  const readout = createReadout('tc-readout');
  const w = wave(
    'Scrub this animation',
    (v) => {
      if (model) readout.set(model.label.replace(/^\d+/, ms(v)), model.max);
      o.onScrub(v);
    },
    () => (model ? detailValueText(model) : ''),
    (v) => {
      if (!model) return `${ms(v)} ms`;
      const p = iterationProgress(o.spec, model.toTime(v));
      return p == null ? `${ms(v)} ms · delay` : `${ms(v)} ms · ${Math.round(curve(p) * 100)}%`;
    },
  );
  w.el.classList.add('tc-detail-wave');
  let sig = '';
  function shape(spec: AnimationSpec, m: DetailModel) {
    const next = shapeSig(spec, m);
    if (next === sig) return;
    sig = next;
    // Bar height = the eased value at that time; outside the active interval, flat.
    const hs = Array.from({ length: BARS }, (_, i) => {
      const p = iterationProgress(spec, m.toTime(((i + 0.5) / BARS) * m.max));
      return p == null ? 0 : 0.12 + 0.88 * Math.max(0, Math.min(1, curve(p)));
    });
    w.setHeights(hs);
    // Keyframes split the bars into chapters, like YouTube's chapter gaps.
    w.gaps.replaceChildren(...keyframeTimes(spec, m, true).map((t) => h('span', { class: 'tc-gap', style: { left: `${(t / m.max) * 100}%` } })));
    w.marks.replaceChildren(...keyframeTimes(spec, m).map((t) => h('span', { class: 'tc-mark', style: { left: `${(t / m.max) * 100}%` } })));
  }
  const el = h('div', { class: 'scrub-one tc-detail' }, w.el, readout.el);
  return {
    el,
    get dragging() {
      return w.s.dragging;
    },
    update(m) {
      if (w.s.dragging) return;
      model = m;
      shape(o.spec, m);
      w.s.setDisabled(m.disabled);
      w.s.set(m.value, m.max);
      readout.set(m.word ?? m.label, m.max);
      el.classList.toggle('is-word', !!m.word);
    },
    glide(v) {
      w.s.paintOnly(v);
    },
  };
}

export const optionC: TransportFactory = { global, detail };
