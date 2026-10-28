/**
 * The transport as it shipped in 0.2.0, kept as an option so it can be
 * compared with A, B and C. Native range inputs, the speed segment, and a
 * dashed timeline while live.
 */
import { h, numSlot, setAttr } from '../h';
import { playButton, rateSegment, restartButton, setDisabled } from './controls';
import { createReadout } from './readout';
import type { DetailOptions, DetailScrubber, GlobalCallbacks, GlobalState, GlobalTransport, TransportFactory } from './types';

function global(cb: GlobalCallbacks): GlobalTransport {
  const play = playButton(cb.togglePlay);
  const restart = restartButton(cb.restart);
  const rates = rateSegment(cb.setRate);
  const scrub = h('input', { type: 'range', min: '0', max: '1000', step: '1', value: '0', class: 'slider timeline', 'aria-label': 'Scrub all animations', 'data-part': 'scrubber' });
  /* "588 / 2000 ms" when paused, "2000 ms" when live. The current-time slot
     keeps its width in both, so the timeline never resizes. */
  const timeCur = numSlot(4);
  const timeSep = h('span', { class: 'time-sep' }, ' / ');
  const timeEnd = numSlot(4);
  const timeEl = h('span', { class: 'time', 'data-part': 'time' }, timeCur.el, timeSep, timeEnd.el, ' ms');
  const el = h(
    'section',
    { class: 'transport t-current', 'data-variant': 'current' },
    h('div', { class: 'transport-row' }, play.el, rates.el, restart),
    h('div', { class: 'transport-row timeline-row' }, scrub, timeEl),
  );
  play.el.dataset.align = 'start';
  restart.dataset.align = 'end';

  let dragging = false;

  function setTime(cur: number | null, end: number) {
    const digits = String(Math.round(end)).length;
    timeCur.digits(digits);
    timeEnd.digits(digits);
    timeCur.set(cur == null ? '' : String(Math.round(cur)));
    timeEnd.set(String(Math.round(end)));
    timeEl.classList.toggle('is-idle', cur == null);
  }

  scrub.addEventListener('pointerdown', () => {
    dragging = true;
    el.classList.add('is-scrubbing');
  });
  const up = () => (dragging = false);
  window.addEventListener('pointerup', up);
  scrub.addEventListener('input', () => {
    const v = Number(scrub.value);
    el.classList.add('is-scrubbing');
    setTime(v, Number(scrub.max));
    cb.scrub(v);
  });

  return {
    el,
    get dragging() {
      return dragging;
    },
    render(s: GlobalState) {
      setDisabled([play.el, restart, scrub, ...rates.btns], !s.ready);
      if (!s.ready) {
        play.set(false);
        scrub.value = '0';
        el.classList.add('is-live');
        setTime(null, 0);
        timeEl.classList.add('is-empty');
        return;
      }
      timeEl.classList.remove('is-empty');
      play.set(s.paused);
      rates.set(s.rate);
      const max = String(s.end);
      if (scrub.max !== max) scrub.max = max;
      if (dragging || s.holding) return;
      // While the page plays, the timeline is idle: no moving thumb, no
      // ticking number. The playhead only shows once you pause or scrub.
      el.classList.toggle('is-live', s.live);
      if (!s.live) el.classList.remove('is-scrubbing');
      if (s.live) {
        if (scrub.value !== '0') scrub.value = '0';
        setTime(null, s.end);
        setAttr(timeEl, 'title', 'Timeline length. Drag to pause and scrub.');
      } else {
        const v = String(Math.round(Math.min(s.end, Math.max(0, s.pos))));
        if (scrub.value !== v) scrub.value = v;
        setTime(Number(v), s.end);
        setAttr(timeEl, 'title', '');
      }
    },
    destroy() {
      window.removeEventListener('pointerup', up);
    },
  };
}

function detail(o: DetailOptions): DetailScrubber {
  const slider = h('input', { type: 'range', min: '0', max: '1', step: '1', class: 'slider', 'aria-label': 'Scrub this animation', 'data-part': 'scrubber' });
  const readout = createReadout();
  let dragging = false;
  let max = 1;
  slider.addEventListener('pointerdown', () => (dragging = true));
  slider.addEventListener('pointerup', () => (dragging = false));
  slider.addEventListener('change', () => (dragging = false));
  slider.addEventListener('input', () => {
    const v = Number(slider.value);
    o.onScrub(v);
    readout.set(label.replace(/^\d+/, String(v)), max);
  });
  let label = '';
  return {
    el: h('div', { class: 'scrub-one' }, slider, readout.el),
    get dragging() {
      return dragging;
    },
    update(m) {
      if (dragging) return;
      max = m.max;
      label = m.label;
      const mx = String(Math.round(m.max));
      const v = String(Math.round(m.value));
      if (slider.max !== mx) slider.max = mx;
      if (slider.value !== v) slider.value = v;
      if (slider.disabled !== m.disabled) slider.disabled = m.disabled;
      readout.set(m.word ?? m.label, m.max);
    },
    glide(v) {
      if (!dragging) slider.value = String(v);
    },
  };
}

export const current: TransportFactory = { global, detail };
