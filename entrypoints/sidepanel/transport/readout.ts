import { h, numSlot, setText } from '../h';

export interface Readout {
  el: HTMLElement;
  set(label: string, max: number): void;
}

/**
 * The per-animation readout, e.g. "588 / 2000 ms · iteration 3". The current
 * time and the iteration number sit in fixed-width slots, so the text (and
 * the slider beside it) don't move as the numbers tick each poll.
 */
export function createReadout(extraClass = ''): Readout {
  const cur = numSlot(4);
  const mid = h('span', {});
  const where = h('span', {});
  const iter = numSlot(2);
  iter.el.classList.add('num-start');
  const tail = h('span', {});
  const word = h('span', {});
  const el = h('span', { class: `time readout ${extraClass}`.trim(), 'data-part': 'readout' }, cur.el, mid, where, iter.el, tail, word);
  const RE = /^(\d+)( \/ \d+ ms)(?:( · iteration )(\d+)(.*)|(.*))$/;
  return {
    el,
    set(label, max) {
      const m = RE.exec(label);
      const show = (node: HTMLElement, on: boolean) => {
        if (node.hidden === on) node.hidden = !on;
      };
      show(word, !m);
      show(cur.el, !!m);
      show(mid, !!m);
      if (!m) {
        setText(word, label);
        show(where, false);
        show(iter.el, false);
        show(tail, false);
        return;
      }
      cur.digits(String(Math.round(max)).length);
      cur.set(m[1]!);
      setText(mid, m[2]!);
      show(where, true);
      show(tail, true);
      if (m[4] != null) {
        setText(where, m[3]!);
        iter.digits(Math.max(2, m[4].length));
        iter.set(m[4]);
        show(iter.el, true);
        setText(tail, m[5] ?? '');
      } else {
        setText(where, m[6] ?? '');
        show(iter.el, false);
        setText(tail, '');
      }
    },
  };
}
