import type { AnimationEntry, AnimationKind, JsDrivenEntry } from '../../lib/types';
import { iterationCurve, iterationProgress } from '../../lib/timing';
import { fmtTime } from '../../lib/export/shared';
import { clear, h } from './h';
import { miniCurve } from './curve';

export const KIND_LABEL: Record<AnimationKind, string> = {
  'css-animation': 'CSS',
  'css-transition': 'Transition',
  waapi: 'WAAPI',
  gsap: 'GSAP',
  js: 'JS',
};

interface Row {
  el: HTMLButtonElement;
  state: HTMLElement;
  bar: HTMLElement;
}

/**
 * Keyed list: rows are created once per animation and updated in place on
 * every poll, so nothing flickers or loses hover state.
 */
export function createList(root: HTMLElement, onSelect: (id: string) => void) {
  const rows = new Map<string, Row>();
  const animSection = h('div', { class: 'rows', role: 'listbox', 'aria-label': 'Animations' });
  const jsHeader = h('div', { class: 'section-label' }, 'JS-driven', h('span', { class: 'muted' }, ' · not controllable'));
  const jsSection = h('div', { class: 'rows js-rows' });
  root.append(animSection, jsHeader, jsSection);

  function makeRow(entry: AnimationEntry): Row {
    const { spec } = entry;
    const state = h('span', { class: 'row-state' });
    const bar = h('span', { class: 'row-bar' });
    const el = h(
      'button',
      {
        class: 'row',
        role: 'option',
        dataset: { id: spec.id, kind: spec.kind },
        onclick: () => onSelect(spec.id),
      },
      h('span', { class: 'row-curve' }, miniCurve(iterationCurve(spec))),
      h(
        'span',
        { class: 'row-main' },
        h('span', { class: 'row-name' }, spec.name),
        h('span', { class: 'row-sel' }, spec.selector),
      ),
      h(
        'span',
        { class: 'row-meta' },
        h('span', { class: 'row-dur' }, fmtTime(spec.duration)),
        h('span', { class: 'kind', dataset: { kind: spec.kind } }, KIND_LABEL[spec.kind]),
      ),
      state,
      h('span', { class: 'row-track' }, bar),
    );
    return { el, state, bar };
  }

  function render(list: AnimationEntry[], js: JsDrivenEntry[], selected: string | null) {
    const seen = new Set<string>();
    let prev: Element | null = null;
    for (const entry of list) {
      const id = entry.spec.id;
      seen.add(id);
      let row = rows.get(id);
      if (!row) {
        row = makeRow(entry);
        rows.set(id, row);
      }
      // Keep DOM order equal to list order without re-appending stable rows.
      const expected: Element | null = prev ? prev.nextElementSibling : animSection.firstElementChild;
      if (expected !== row.el) animSection.insertBefore(row.el, expected);
      prev = row.el;

      const { live } = entry;
      row.el.classList.toggle('is-ended', live.ended);
      row.el.classList.toggle('is-selected', id === selected);
      row.el.setAttribute('aria-selected', String(id === selected));
      const stateText = live.scrollLinked ? 'scroll' : live.ended ? 'ended' : live.playState === 'paused' ? 'paused' : '';
      if (row.state.textContent !== stateText) row.state.textContent = stateText;
      const p = iterationProgress(entry.spec, live.currentTime);
      row.bar.style.transform = `scaleX(${p == null ? 0 : Math.max(0, Math.min(1, p))})`;
    }
    for (const [id, row] of rows) {
      if (!seen.has(id)) {
        row.el.remove();
        rows.delete(id);
      }
    }

    clear(jsSection);
    jsHeader.hidden = js.length === 0;
    for (const j of js) {
      jsSection.append(
        h(
          'div',
          { class: 'row is-js', title: 'Inline styles changing every frame. Probably requestAnimationFrame or a JS spring. Can’t be paused or exported.' },
          h('span', { class: 'row-curve js-dot' }),
          h(
            'span',
            { class: 'row-main' },
            h('span', { class: 'row-name' }, j.properties.join(', ') || 'style'),
            h('span', { class: 'row-sel' }, j.selector),
          ),
          h(
            'span',
            { class: 'row-meta' },
            h('span', { class: 'row-dur' }, `${j.rate}/s`),
            h('span', { class: 'kind', dataset: { kind: 'js' } }, 'JS'),
          ),
        ),
      );
    }
  }

  return { render };
}
