/**
 * Option A: Now Playing (Apple Music / Podcasts).
 *
 *   [1×]          [|◀] (▶) [▶|]          [⟲]
 *   372 ms  ━━━━━━━━●─────────────  −1628 ms
 *
 * Thin track that thickens while pressed, a round knob once paused, elapsed
 * and remaining at the two ends, fine scrubbing by dragging away from the
 * bar, and a speed pill that cycles on click like Apple Podcasts. While the
 * page plays there is no position: the track is empty, the left label says
 * Live and the right one shows the length.
 *
 * Detail: the iOS layout. Track on top, elapsed under the left end,
 * remaining under the right, and the iteration as a centred badge (where
 * Apple Music puts "Lossless").
 */
import { h, numSlot, setAttr, setText } from '../h';
import { playButton, rateText, restartButton, setDisabled, stepButton } from './controls';
import { FINE_LABEL, createScrubber, type FineMode } from './scrubber';
import { RATES, detailValueText, globalValueText, ms, parseLabel, type DetailOptions, type DetailScrubber, type GlobalCallbacks, type GlobalTransport, type TransportFactory } from './types';

/**
 * "372 ms" in a box that never changes width: the ghost is the widest value
 * ("8888 ms", or "−8888 ms" for remaining) in tabular figures. Elapsed hugs
 * the left end of the bar, remaining the right.
 */
function timeSlot(align: 'start' | 'end') {
  const s = numSlot(1);
  if (align === 'start') s.el.classList.add('num-start');
  return {
    el: s.el,
    set: s.set,
    ghost(digits: number, minus: boolean) {
      setAttr(s.el, 'data-ghost', `${minus ? '−' : ''}${'8'.repeat(Math.max(1, digits))} ms`);
    },
  };
}

/** Track + fill + knob, shared by the global and detail scrubbers. */
function bar(fine: boolean, label: string, onInput: (v: number) => void, valueText: (v: number, max: number) => string) {
  const fill = h('span', { class: 'ta-fill' });
  const track = h('span', { class: 'ta-track' }, fill);
  const knob = h('span', { class: 'ta-knob' });
  const rail = h('span', { class: 'ta-rail', 'aria-hidden': 'true' }, knob);
  const fineEl = h('span', { class: 'ta-fine', 'aria-hidden': 'true' });
  const el = h('div', { class: 'ta-scrub', 'data-part': 'scrubber' }, track, rail, fineEl);
  const s = createScrubber({
    el,
    track,
    label,
    fine,
    valueText,
    paint(p) {
      fill.style.transform = `scaleX(${p})`;
      rail.style.transform = `translateX(${p * 100}%)`;
    },
    onInput,
    onFineMode(mode: FineMode) {
      if (mode) setText(fineEl, FINE_LABEL[mode]!);
      el.classList.toggle('is-fine', mode > 0);
    },
  });
  return { el, s };
}

function global(cb: GlobalCallbacks): GlobalTransport {
  const play = playButton(cb.togglePlay, 'ta-play play');
  const back = stepButton(-1, () => cb.step(-1));
  const fwd = stepButton(1, () => cb.step(1));
  const restart = restartButton(cb.restart);
  let rate = 1;
  const speed = h('button', {
    class: 'ta-speed',
    type: 'button',
    'data-part': 'speed',
    title: 'Playback speed: click to cycle (J slower, L faster)',
    onclick: () => cb.setRate(RATES[(RATES.indexOf(rate) + 1) % RATES.length]!),
  });
  // Fixed width: the widest label is held open by a hidden ghost.
  const speedText = h('span', { class: 'ta-speed-text' });
  speed.append(h('span', { class: 'ta-speed-ghost', 'aria-hidden': 'true' }, '0.25×'), speedText);
  speed.dataset.align = 'start';
  restart.dataset.align = 'end';

  const { el: scrubEl, s } = bar(true, 'Scrub all animations', (v) => {
    setTimes(v, s.max, false);
    el.dataset.state = 'scrubbing';
    cb.scrub(v);
  }, (v, max) => globalValueText({ live: false, pos: v, end: max }));

  const elapsed = timeSlot('start');
  const liveWord = h('span', { class: 'ta-live' }, 'Live');
  const left = h('span', { class: 'ta-time ta-elapsed', 'data-part': 'elapsed' }, elapsed.el, liveWord);
  const remain = timeSlot('end');
  const right = h('span', { class: 'ta-time ta-remaining', 'data-part': 'remaining' }, remain.el);

  const el = h(
    'section',
    { class: 'transport t-a', 'data-variant': 'a', 'data-state': 'live' },
    h('div', { class: 'ta-controls' }, speed, h('div', { class: 'ta-cluster' }, back, play.el, fwd), restart),
    h('div', { class: 'ta-bar' }, left, scrubEl, right),
  );

  function setTimes(pos: number | null, end: number, live: boolean) {
    const d = String(Math.round(end)).length;
    elapsed.ghost(d, false);
    remain.ghost(d, true);
    elapsed.set(pos == null ? '' : `${ms(pos)} ms`);
    remain.set(live || pos == null ? `${ms(end)} ms` : `−${ms(Math.max(0, end - pos))} ms`);
  }

  return {
    el,
    get dragging() {
      return s.dragging;
    },
    render(st) {
      setDisabled([play.el, back, fwd, restart, speed], !st.ready);
      s.setDisabled(!st.ready);
      play.set(st.ready && st.paused);
      rate = st.rate;
      setText(speedText, rateText(st.rate));
      setAttr(speed, 'aria-label', `Speed ${rateText(st.rate)}. Click for ${rateText(RATES[(RATES.indexOf(st.rate) + 1) % RATES.length]!)}`);
      if (!st.ready) {
        el.dataset.state = 'idle';
        s.set(0, 1);
        setTimes(null, 0, true);
        return;
      }
      if (s.dragging || st.holding) return;
      el.dataset.state = st.live ? 'live' : 'paused';
      s.set(st.live ? 0 : st.pos, st.end);
      if (st.live) s.setValueText(globalValueText(st));
      setTimes(st.live ? null : st.pos, st.end, st.live);
    },
    destroy() {},
  };
}

function detail(o: DetailOptions): DetailScrubber {
  let model: Parameters<DetailScrubber['update']>[0] | null = null;
  const { el: scrubEl, s } = bar(true, 'Scrub this animation', (v) => {
    if (model) paintTimes(v, model.max, model.label);
    o.onScrub(v);
  }, () => (model ? detailValueText(model) : ''));
  const elapsed = timeSlot('start');
  const remain = timeSlot('end');
  const iterNum = numSlot(2);
  iterNum.el.classList.add('num-start');
  const badgeText = h('span', {});
  const badge = h('span', { class: 'ta-badge', 'data-part': 'badge' }, badgeText, iterNum.el);
  const left = h('span', { class: 'ta-time ta-elapsed', 'data-part': 'elapsed' }, elapsed.el);
  const right = h('span', { class: 'ta-time ta-remaining', 'data-part': 'remaining' }, remain.el);
  const el = h('div', { class: 'scrub-one ta-detail' }, scrubEl, h('div', { class: 'ta-under' }, left, badge, right));

  function paintTimes(v: number, max: number, label: string) {
    const d = String(Math.round(max)).length;
    elapsed.ghost(d, false);
    remain.ghost(d, true);
    elapsed.set(`${ms(v)} ms`);
    remain.set(`−${ms(Math.max(0, max - v))} ms`);
    // "iteration 14" → badge "Iteration" + number slot; "iteration 2 of 3" keeps "of 3" in the text.
    const where = parseLabel(label)?.where ?? '';
    const m = /^iteration (\d+)(.*)$/.exec(where);
    if (m) {
      setText(badgeText, 'Iteration');
      iterNum.digits(Math.max(2, m[1]!.length));
      iterNum.set(m[1]! + (m[2] ?? ''));
      iterNum.el.hidden = false;
    } else {
      setText(badgeText, where ? where[0]!.toUpperCase() + where.slice(1) : '');
      iterNum.el.hidden = true;
    }
    badge.classList.toggle('is-empty', !where);
  }

  return {
    el,
    get dragging() {
      return s.dragging;
    },
    update(m) {
      if (s.dragging) return;
      model = m;
      s.setDisabled(m.disabled);
      s.set(m.value, m.max);
      el.classList.toggle('is-word', !!m.word);
      if (m.word) {
        setText(badgeText, m.word);
        iterNum.el.hidden = true;
        badge.classList.remove('is-empty');
      } else {
        paintTimes(m.value, m.max, m.label);
      }
    },
    glide(v) {
      s.paintOnly(v);
    },
  };
}

export const optionA: TransportFactory = { global, detail };
