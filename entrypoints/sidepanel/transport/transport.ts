/**
 * The transport (see docs/transport-research.md, option C).
 *
 *   (▶) [⟲]  810 / 1800 ms                               [1× ⌄]
 *   ▂▄▆█▆▄▂ ▂▄▄▂ ▂▂   ← how many animations run at each moment
 *   ▪    ▪    ▪       ← where animations start, coloured by kind
 *
 * The scrubber is a waveform of activity: bar height is how many captured
 * animations are running at that point on the timeline. Left of the
 * playhead is drawn solid (played), the rest muted. Hovering previews the
 * time and what runs there, below the bars, without moving anything. While
 * the page plays there is no single position, so the bars sit still in one
 * muted tone with no playhead. Speed is a popover.
 *
 * The detail scrubber is the same waveform drawn from the animation's own
 * eased value, with its keyframes as markers.
 */
import { iterationCurve, iterationProgress } from '../../../lib/timing';
import { h, numSlot, setAttr, setText } from '../h';
import { icons } from '../icons';
import { playButton, rateText, restartButton, setDisabled } from './controls';
import { keyframeTimes, shapeSig } from './geometry';
import { barRange, createWave } from './waveform';
import { RATES, ms, type DetailModel, type DetailOptions, type DetailScrubber, type GlobalCallbacks, type GlobalState, type Lane } from './types';

/** "3 running: pulse, slide, drop" / "pulse" / "nothing running". */
function runningText(on: Lane[], names = 3) {
  if (on.length === 0) return 'nothing running';
  const uniq = [...new Set(on.map((l) => l.name))];
  const list = uniq.slice(0, names).join(', ') + (uniq.length > names ? ` and ${uniq.length - names} more` : '');
  return on.length === 1 ? `${list} running` : `${on.length} running: ${list}`;
}

const runningAt = (lanes: Lane[], v: number) => lanes.filter((l) => l.start <= v && l.end > v);

export function createTransport(cb: GlobalCallbacks) {
  const play = playButton(cb.togglePlay);
  const restart = restartButton(cb.restart);
  play.el.dataset.align = 'start';

  let lanes: Lane[] = [];
  let lanesSig = '';
  let end = 1;
  let st: GlobalState | null = null;

  /* Readout "810 / 1800 ms": tabular figures in fixed-width slots (a hidden
     ghost of 8s holds each slot open; Geist's figure space is narrower than
     its tabular digits, so padding with U+2007 would still shift). No
     leading zeros. While live the current slot says Live. At narrow widths
     CSS drops " ms". */
  const cur = numSlot(4);
  const liveWord = h('span', { class: 'tc-live' }, 'Live');
  const endN = numSlot(4);
  endN.el.classList.add('tc-end');
  const time = h(
    'span',
    { class: 'tc-time', 'data-part': 'time' },
    h('span', { class: 'tc-cur' }, cur.el, liveWord),
    h('span', { class: 'tc-sep' }, ' / '),
    endN.el,
    h('span', { class: 'tc-unit' }, ' ms'),
  );

  /* Speed popover. */
  const speedVal = h('span', { class: 'tc-speed-val' });
  /* The trigger is sized by a hidden copy of its widest state ("0.25× ⌄"),
     and the real label + chevron sit centred on top as one group, so
     "1×" ↔ "0.25×" never changes its width and never looks right-pushed. */
  const caret = () => h('span', { class: 'tc-caret', html: icons.chevronDown });
  const speed = h(
    'button',
    { class: 'btn btn-ghost tc-speed', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-part': 'speed', title: 'Playback speed (J slower, L faster)' },
    h('span', { class: 'tc-speed-group tc-speed-ghost', 'aria-hidden': 'true' }, h('span', { class: 'tc-speed-label' }, '0.25×'), caret()),
    h('span', { class: 'tc-speed-group' }, h('span', { class: 'tc-speed-label' }, speedVal), caret()),
  );
  speed.dataset.align = 'end';
  const items = RATES.map((r) =>
    h(
      'button',
      { class: 'tc-item', type: 'button', role: 'menuitemradio', 'aria-checked': 'false', tabindex: '-1', dataset: { rate: String(r) } },
      h('span', { class: 'tc-check', html: icons.check }),
      h('span', {}, rateText(r)),
      h('span', { class: 'tc-item-note' }, r === 1 ? 'Normal' : r === 0.1 ? 'Slowest' : ''),
    ),
  );
  const menu = h('div', { class: 'tc-menu', role: 'menu', 'aria-label': 'Playback speed' }, ...items, h('p', { class: 'tc-menu-hint' }, 'J slower · L faster'));
  const speedWrap = h('div', { class: 'tc-speed-wrap' }, speed, menu);

  const isOpen = () => 'open' in menu.dataset;
  function openMenu(focusChecked: boolean) {
    menu.dataset.open = '';
    setAttr(speed, 'aria-expanded', 'true');
    if (focusChecked) (items.find((b) => b.getAttribute('aria-checked') === 'true') ?? items[0]!).focus();
    document.addEventListener('pointerdown', outside, true);
  }
  function closeMenu(refocus: boolean) {
    if (!isOpen()) return;
    delete menu.dataset.open;
    setAttr(speed, 'aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    if (refocus) speed.focus();
  }
  const outside = (e: PointerEvent) => {
    if (!speedWrap.contains(e.target as Node)) closeMenu(false);
  };
  speed.addEventListener('click', (e) => {
    if (isOpen()) closeMenu(false);
    // Keyboard clicks (detail 0) move focus into the menu; pointer clicks don't.
    else openMenu(e.detail === 0);
  });
  speed.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      openMenu(true);
    } else if (e.key === 'Escape' && isOpen()) {
      e.preventDefault();
      e.stopPropagation();
      closeMenu(true);
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
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]!.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      items[e.key === 'Home' ? 0 : items.length - 1]!.focus();
    }
    // Space, Enter and letter keys stay inside the menu (no play/pause, no J/L).
    if (e.key.length === 1) e.stopPropagation();
  });
  for (const b of items) {
    b.addEventListener('click', () => {
      cb.setRate(Number(b.dataset.rate));
      closeMenu(true);
    });
  }

  const valueText = (v: number, max: number) => `${ms(v)} of ${ms(max)} milliseconds, ${runningText(runningAt(lanes, v))}`;
  const liveText = () => `Live, timeline ${ms(end)} milliseconds, ${lanes.length} animation${lanes.length === 1 ? '' : 's'}`;

  const wave = createWave({
    label: 'Scrub all animations',
    valueText,
    onInput(v) {
      setTime(v, false);
      el.dataset.state = 'scrubbing';
      cb.scrub(v);
    },
    heights(n) {
      // How many lanes run in each bar's slice of the timeline, normalised.
      const counts = Array.from({ length: n }, (_, i) => {
        const [a, b] = barRange(i, n, end);
        return lanes.filter((l) => l.start < b && l.end > a).length;
      });
      const top = Math.max(1, ...counts);
      return counts.map((c) => (c === 0 ? 0 : 0.15 + 0.85 * (c / top)));
    },
    marks: () => lanes.filter((l) => l.start < end).map((l) => ({ at: l.start, kind: l.kind })),
    tip(v) {
      const on = runningAt(lanes, v);
      const starts = lanes.filter((l) => Math.abs(l.start - v) <= end / 80);
      const what = starts.length ? `${starts[0]!.name}${starts.length > 1 ? ` +${starts.length - 1}` : ''} starts` : on.length === 0 ? 'nothing running' : on.length === 1 ? on[0]!.name : `${on.length} running`;
      return `${ms(v)} ms · ${what}`;
    },
  });
  const s = wave.s;

  const el = h(
    'section',
    { class: 'transport', 'data-state': 'idle' },
    h('div', { class: 'tc-bar' }, play.el, restart, time, h('span', { class: 'tc-flex' }), speedWrap),
    wave.el,
  );

  function setTime(pos: number | null, live: boolean) {
    const d = Math.max(4, ms(end).length);
    cur.digits(d);
    endN.digits(d);
    cur.set(live || pos == null ? '' : ms(pos));
    endN.set(ms(end));
    time.classList.toggle('is-live', live);
  }

  function setLanes(ls: Lane[], e: number) {
    const sig = `${e}|${ls.map((l) => `${l.kind}:${Math.round(l.start)}-${Math.round(l.end)}`).join(',')}`;
    lanes = ls;
    end = e;
    if (sig === lanesSig) return;
    lanesSig = sig;
    s.set(s.value, e);
    wave.redraw();
  }

  return {
    el,
    get dragging() {
      return s.dragging;
    },
    render(next: GlobalState) {
      st = next;
      setDisabled([play.el, restart, speed], !st.ready);
      s.setDisabled(!st.ready);
      play.set(st.ready && st.paused);
      setText(speedVal, rateText(st.rate));
      setAttr(speed, 'aria-label', `Speed ${rateText(st.rate)}`);
      for (const b of items) setAttr(b, 'aria-checked', String(Number(b.dataset.rate) === st.rate));
      if (!st.ready) {
        closeMenu(false);
        el.dataset.state = 'idle';
        setLanes([], 1000);
        s.set(0, 1000);
        setTime(null, true);
        return;
      }
      setLanes(st.lanes, st.end);
      if (s.dragging || st.holding) return;
      el.dataset.state = st.live ? 'live' : 'paused';
      s.set(st.live ? 0 : st.pos, st.end);
      if (st.live) s.setValueText(liveText());
      setTime(st.pos, st.live);
    },
  };
}

export type Transport = ReturnType<typeof createTransport>;

/** "372 / 2000 ms · iteration 14" for a value. */
function readoutText(m: DetailModel, v: number) {
  return m.word ?? m.label.replace(/^\d+/, ms(v));
}

/**
 * The detail readout. The current time sits in a fixed-width slot (digits
 * of the length), so the rest of the line never moves while it ticks.
 */
function detailReadout() {
  const curN = numSlot(4);
  const rest = h('span', {});
  const el = h('span', { class: 'time tc-readout', 'data-part': 'readout' }, curN.el, rest);
  return {
    el,
    set(m: DetailModel, v: number) {
      const text = readoutText(m, v);
      const match = /^(\d+)(.*)$/.exec(text);
      curN.el.hidden = !match;
      if (!match) return setText(rest, text);
      curN.digits(ms(m.max).length);
      curN.set(match[1]!);
      setText(rest, match[2]!);
    },
  };
}

export function createDetailScrubber(o: DetailOptions): DetailScrubber {
  let model: DetailModel | null = null;
  const curve = iterationCurve(o.spec);
  const readout = detailReadout();
  const wave = createWave({
    label: 'Scrub this animation',
    valueText: (v) => (model ? (model.word ?? readoutText(model, v).replace(' / ', ' of ').replace(' ms', ' milliseconds').replace(' · ', ', ')) : ''),
    onInput(v) {
      if (model) readout.set(model, v);
      o.onScrub(v);
    },
    heights(n) {
      // Bar height = the eased value at that time; outside the active interval, flat.
      if (!model) return [];
      const m = model;
      return Array.from({ length: n }, (_, i) => {
        const [a, b] = barRange(i, n, m.max);
        const p = iterationProgress(o.spec, m.toTime((a + b) / 2));
        return p == null ? 0 : 0.12 + 0.88 * Math.max(0, Math.min(1, curve(p)));
      });
    },
    marks: () => (model ? keyframeTimes(o.spec, model).map((at) => ({ at, kind: o.spec.kind })) : []),
    tip(v) {
      if (!model) return `${ms(v)} ms`;
      const p = iterationProgress(o.spec, model.toTime(v));
      return p == null ? `${ms(v)} ms · delay` : `${ms(v)} ms · value ${Math.round(curve(p) * 100)}%`;
    },
  });
  wave.el.classList.add('tc-detail-wave');
  const el = h('div', { class: 'scrub-one tc-detail' }, wave.el, readout.el);
  let sig = '';
  return {
    el,
    get dragging() {
      return wave.s.dragging;
    },
    update(m) {
      if (wave.s.dragging) return;
      model = m;
      wave.s.setDisabled(m.disabled);
      wave.s.set(m.value, m.max);
      const next = shapeSig(o.spec, m);
      if (next !== sig) {
        sig = next;
        wave.redraw();
      }
      readout.set(m, m.value);
      el.classList.toggle('is-word', !!m.word);
    },
    glide(v) {
      wave.s.paintOnly(v);
    },
  };
}
