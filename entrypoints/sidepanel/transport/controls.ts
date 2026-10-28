/** Buttons shared by the transport options. */
import { h, setAttr } from '../h';
import { icons } from '../icons';
import { RATES } from './types';

export function playButton(onClick: () => void, cls = 'btn btn-primary play') {
  const el = h('button', { class: cls, type: 'button', 'aria-label': 'Pause all', 'data-part': 'play', onclick: onClick });
  let shown = '';
  return {
    el,
    set(paused: boolean) {
      const want = paused ? 'play' : 'pause';
      if (shown === want) return;
      shown = want;
      el.innerHTML = paused ? icons.play : icons.pause;
      el.setAttribute('aria-label', paused ? 'Play all' : 'Pause all');
      el.title = paused ? 'Play all (Space or K)' : 'Pause all (Space or K)';
      el.classList.toggle('is-paused', paused);
    },
  };
}

export function restartButton(onClick: () => void) {
  return h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Restart all', title: 'Restart all (R)', html: icons.restart, 'data-part': 'restart', onclick: onClick });
}

export function stepButton(dir: -1 | 1, onClick: () => void) {
  return h('button', {
    class: 'icon-btn step',
    type: 'button',
    'aria-label': dir < 0 ? 'Back one frame' : 'Forward one frame',
    title: dir < 0 ? 'Back one frame (, or ←)' : 'Forward one frame (. or →)',
    html: dir < 0 ? icons.stepBack : icons.stepFwd,
    'data-part': dir < 0 ? 'step-back' : 'step-fwd',
    onclick: onClick,
  });
}

export const rateText = (r: number) => `${r}×`;

export function nextRate(r: number, dir: 1 | -1) {
  const i = RATES.indexOf(r);
  const j = Math.max(0, Math.min(RATES.length - 1, (i < 0 ? RATES.length - 1 : i) + dir));
  return RATES[j]!;
}

/** The current segmented control: 0.1× 0.25× 0.5× 1×. */
export function rateSegment(setRate: (r: number) => void) {
  const btns = RATES.map((r) =>
    h('button', { class: 'seg-btn', type: 'button', dataset: { rate: String(r) }, 'aria-label': `Speed ${r}×`, onclick: () => setRate(r) }, `${r}×`),
  );
  const el = h('div', { class: 'seg', role: 'group', 'aria-label': 'Playback rate', 'data-part': 'speed' }, ...btns);
  return {
    el,
    btns,
    set(rate: number) {
      for (const b of btns) {
        const on = Number(b.dataset.rate) === rate;
        b.classList.toggle('is-on', on);
        setAttr(b, 'aria-pressed', String(on));
      }
    },
  };
}

export function setDisabled(els: (HTMLButtonElement | HTMLInputElement)[], disabled: boolean) {
  for (const el of els) if (el.disabled !== disabled) el.disabled = disabled;
}
