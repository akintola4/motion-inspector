/**
 * Option B: Editor (DAW / NLE / DevTools Animations).
 *
 *   [|◀] (▶) [▶|]  [0372 / 2000 ms]          [− 1× +]  [⟲]
 *   0        500       1000      1500      2000
 *   |''''|''''|''''|''''|''''|''''|''''|''''|
 *   ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▼▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
 *
 * A ruler with minor and major ticks, a playhead line with a head (only
 * when paused or scrubbing), a skimmer line that follows the pointer without
 * moving the playhead (Final Cut), a zero-padded timecode in fixed fields,
 * a frame-step cluster, and speed as a compact stepper.
 *
 * Detail: the same ruler over the iteration, with the delay hatched and
 * keyframes as diamonds on the lane, like the DevTools Animations panel.
 */
import type { AnimationSpec } from '../../../lib/types';
import { h, numSlot, setAttr, setText } from '../h';
import { icons } from '../icons';
import { nextRate, playButton, rateText, restartButton, setDisabled, stepButton } from './controls';
import { createReadout } from './readout';
import { createScrubber } from './scrubber';
import { keyframeTimes, passes, shapeSig } from './geometry';
import { RATES, detailValueText, globalValueText, type DetailModel, type DetailOptions, type DetailScrubber, type GlobalCallbacks, type GlobalTransport, type TransportFactory } from './types';

const STEPS = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000];

/** Major tick spacing for a length: at most 4 gaps, so labels never crowd. */
function majorStep(end: number) {
  return STEPS.find((s) => end / s <= 4) ?? 10000;
}

/** Ruler ticks and labels for 0 → end, positioned in % so no measuring is needed. */
function buildRuler(ruler: HTMLElement, end: number) {
  if (ruler.dataset.end === String(end)) return;
  ruler.dataset.end = String(end);
  ruler.replaceChildren();
  const major = majorStep(end);
  const minor = major / 5;
  for (let t = 0; t <= end + 0.001; t += minor) {
    const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
    const x = (t / end) * 100;
    ruler.append(h('span', { class: `tb-tick${isMajor ? ' is-major' : ''}`, style: { left: `${x}%` } }));
    if (isMajor) {
      // End labels hug the edges; the rest centre on their tick.
      const near = end - t < major * 0.6;
      if (near) continue;
      const lbl = h('span', { class: 'tb-label', style: { left: `${x}%` } }, String(Math.round(t)));
      if (t === 0) lbl.classList.add('is-first');
      ruler.append(lbl);
    }
  }
  const last = h('span', { class: 'tb-label is-last' }, String(Math.round(end)));
  ruler.append(last);
}

/** Ruler + lane + skimmer + playhead in one 24px+ hit area. */
function timeline(label: string, onInput: (v: number) => void, valueText: (v: number, max: number) => string) {
  const ruler = h('div', { class: 'tb-ruler', 'aria-hidden': 'true' });
  const lane = h('div', { class: 'tb-lane', 'aria-hidden': 'true' });
  const skim = h('span', { class: 'tb-rail tb-skim', 'aria-hidden': 'true' }, h('span', { class: 'tb-skim-line' }));
  const head = h('span', { class: 'tb-rail tb-ph', 'aria-hidden': 'true' }, h('span', { class: 'tb-ph-line' }), h('span', { class: 'tb-ph-head' }));
  const el = h('div', { class: 'tb-timeline', 'data-part': 'scrubber' }, ruler, lane, skim, head);
  const s = createScrubber({
    el,
    label,
    valueText,
    paint(p) {
      head.style.transform = `translateX(${p * 100}%)`;
    },
    onInput,
    onHover(_v, p) {
      if (_v == null) {
        el.classList.remove('is-skimming');
        return;
      }
      el.classList.add('is-skimming');
      skim.style.transform = `translateX(${p * 100}%)`;
    },
  });
  return { el, s, ruler, lane };
}

function global(cb: GlobalCallbacks): GlobalTransport {
  const play = playButton(cb.togglePlay, 'btn btn-primary play');
  const back = stepButton(-1, () => cb.step(-1));
  const fwd = stepButton(1, () => cb.step(1));
  const restart = restartButton(cb.restart);
  back.dataset.align = 'start';
  restart.dataset.align = 'end';

  let rate = 1;
  const slower = h('button', { class: 'tb-step-rate', type: 'button', 'aria-label': 'Slower (J)', title: 'Slower (J)', html: icons.minus, onclick: () => cb.setRate(nextRate(rate, -1)) });
  const faster = h('button', { class: 'tb-step-rate', type: 'button', 'aria-label': 'Faster (L)', title: 'Faster (L)', html: icons.plus, onclick: () => cb.setRate(nextRate(rate, 1)) });
  const rateVal = h('span', { class: 'tb-rate-val' });
  const rateBox = h('span', { class: 'tb-rate', role: 'status', 'aria-label': 'Speed' }, h('span', { class: 'tb-rate-ghost', 'aria-hidden': 'true' }, '0.25×'), rateVal);
  const speed = h('div', { class: 'tb-speed', role: 'group', 'aria-label': 'Playback speed', 'data-part': 'speed' }, slower, rateBox, faster);

  const cur = numSlot(4);
  const endN = numSlot(4);
  const tc = h('span', { class: 'tb-tc', 'data-part': 'time', title: 'Position / length' }, cur.el, h('span', { class: 'tb-tc-sep' }, '/'), endN.el, h('span', { class: 'tb-tc-unit' }, 'ms'));

  const { el: tl, s, ruler } = timeline('Scrub all animations', (v) => {
    setTc(v, s.max, false);
    el.dataset.state = 'scrubbing';
    cb.scrub(v);
  }, (v, max) => globalValueText({ live: false, pos: v, end: max }));

  const el = h(
    'section',
    { class: 'transport t-b', 'data-variant': 'b', 'data-state': 'live' },
    h('div', { class: 'tb-bar' }, h('div', { class: 'tb-cluster' }, back, play.el, fwd), tc, h('span', { class: 'tb-flex' }), speed, restart),
    tl,
  );

  function setTc(pos: number | null, end: number, live: boolean) {
    const d = Math.max(4, String(Math.round(end)).length);
    cur.digits(d);
    endN.digits(d);
    cur.set(live || pos == null ? '–'.repeat(d) : String(Math.round(pos)).padStart(d, '0'));
    endN.set(String(Math.round(end)).padStart(d, '0'));
  }

  return {
    el,
    get dragging() {
      return s.dragging;
    },
    render(st) {
      setDisabled([play.el, back, fwd, restart], !st.ready);
      s.setDisabled(!st.ready);
      play.set(st.ready && st.paused);
      rate = st.rate;
      setText(rateVal, rateText(st.rate));
      setDisabled([slower], !st.ready || st.rate <= RATES[0]!);
      setDisabled([faster], !st.ready || st.rate >= RATES[RATES.length - 1]!);
      if (!st.ready) {
        el.dataset.state = 'idle';
        buildRuler(ruler, 1000);
        s.set(0, 1);
        setTc(null, 0, true);
        return;
      }
      buildRuler(ruler, st.end);
      if (s.dragging || st.holding) return;
      el.dataset.state = st.live ? 'live' : 'paused';
      s.set(st.live ? 0 : st.pos, st.end);
      if (st.live) s.setValueText(globalValueText(st));
      setTc(st.pos, st.end, st.live);
      setAttr(tc, 'aria-label', st.live ? `Live, ${Math.round(st.end)} ms timeline` : `${Math.round(st.pos)} of ${Math.round(st.end)} ms`);
    },
    destroy() {},
  };
}

/** Delay hatch, iteration passes and keyframe diamonds for one animation. */
function buildLane(lane: HTMLElement, spec: AnimationSpec, m: DetailModel) {
  const sig = shapeSig(spec, m);
  if (lane.dataset.sig === sig) return;
  lane.dataset.sig = sig;
  lane.replaceChildren();
  const pct = (t: number) => `${(Math.max(0, Math.min(m.max, t)) / m.max) * 100}%`;
  if (spec.iterations !== 'infinite' && spec.delay > 0) lane.append(h('span', { class: 'tb-delay', style: { left: '0', width: pct(spec.delay) } }));
  const ps = passes(spec, m);
  for (const p of ps) lane.append(h('span', { class: 'tb-pass', style: { left: pct(p.start), width: pct(spec.duration) } }));
  if (ps.length <= 6) for (const t of keyframeTimes(spec, m)) lane.append(h('span', { class: 'tb-kf', style: { left: pct(t) } }));
}

function detail(o: DetailOptions): DetailScrubber {
  let model: DetailModel | null = null;
  const readout = createReadout('tb-readout');
  const { el: tl, s, ruler, lane } = timeline('Scrub this animation', (v) => {
    if (model) readout.set(model.label.replace(/^\d+/, String(Math.round(v))), model.max);
    o.onScrub(v);
  }, () => (model ? detailValueText(model) : ''));
  tl.classList.add('tb-detail-tl');
  const el = h('div', { class: 'scrub-one tb-detail' }, tl, readout.el);
  return {
    el,
    get dragging() {
      return s.dragging;
    },
    update(m) {
      if (s.dragging) return;
      model = m;
      buildRuler(ruler, Math.round(m.max));
      buildLane(lane, o.spec, m);
      s.setDisabled(m.disabled);
      s.set(m.value, m.max);
      readout.set(m.word ?? m.label, m.max);
      el.classList.toggle('is-word', !!m.word);
    },
    glide(v) {
      s.paintOnly(v);
    },
  };
}

export const optionB: TransportFactory = { global, detail };
