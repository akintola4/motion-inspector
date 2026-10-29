/** Transport buttons. */
import { h } from '../h';
import { icons } from '../icons';
import { RATES } from './types';

export function playButton(onClick: () => void) {
  const el = h('button', { class: 'btn btn-primary play', type: 'button', 'aria-label': 'Pause all', 'data-part': 'play', onclick: onClick });
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

export const rateText = (r: number) => `${r}×`;

/** The next speed up or down the RATES ladder (J / L). */
export function nextRate(r: number, dir: 1 | -1) {
  const i = RATES.indexOf(r);
  const j = Math.max(0, Math.min(RATES.length - 1, (i < 0 ? RATES.length - 1 : i) + dir));
  return RATES[j]!;
}

export function setDisabled(els: (HTMLButtonElement | HTMLInputElement)[], disabled: boolean) {
  for (const el of els) if (el.disabled !== disabled) el.disabled = disabled;
}
