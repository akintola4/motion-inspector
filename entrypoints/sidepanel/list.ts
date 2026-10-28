import type { AnimationEntry, AnimationKind, JsDrivenEntry } from '../../lib/types';
import type { AnimationGroup } from '../../lib/grouping';
import { iterationCurve } from '../../lib/timing';
import { fmtTime } from '../../lib/export/shared';
import { clear, h } from './h';
import { miniCurve } from './curve';
import { icons } from './icons';

export const KIND_LABEL: Record<AnimationKind, string> = {
  'css-animation': 'CSS',
  'css-transition': 'Transition',
  waapi: 'WAAPI',
  gsap: 'GSAP',
  js: 'JS',
};

/** A row's short state, shown only when it isn't simply "running". */
export function stateText(entry: AnimationEntry, globallyPaused: boolean): string {
  const { live } = entry;
  if (live.scrollLinked) return 'Scroll';
  if (live.ended) return 'Ended';
  if (live.playState === 'paused' && !globallyPaused) return 'Paused';
  if (live.playState === 'idle') return 'Idle';
  return '';
}

/** "972 ms", "1.6 s": the export format with a thin space for reading. */
export function fmtDur(ms: number): string {
  return fmtTime(ms).replace(/(\d)(m?s)$/, '$1 $2');
}

/** "1.6 s", or "1.6 s ∞" for loops. */
function durationText(entry: AnimationEntry): string {
  const s = entry.spec;
  const loops = s.iterations === 'infinite' ? ' ∞' : s.iterations > 1 ? ` ×${s.iterations}` : '';
  return fmtDur(s.duration) + loops;
}

interface RowParts {
  el: HTMLButtonElement;
  count?: HTMLElement;
  sub: HTMLElement;
  state: HTMLElement;
}

export interface ListCallbacks {
  onOpen(id: string): void;
  onToggle(key: string): void;
  /** Pointer over an animation row (or null when it leaves the list). */
  onHover(id: string | null): void;
}

export interface ListModel {
  groups: AnimationGroup[];
  js: JsDrivenEntry[];
  expanded: Set<string>;
  paused: boolean;
}

/**
 * Keyed list. Rows are built once per key and patched in place each poll,
 * so hover and focus survive and nothing flickers. Identical animations
 * collapse into a group row that expands to one child row per element.
 */
export function createList(root: HTMLElement, cb: ListCallbacks) {
  const rows = new Map<string, RowParts>();
  const animSection = h('div', { class: 'rows', role: 'list', 'aria-label': 'Animations' });
  const jsHeader = h('div', { class: 'section-label' }, 'JS-driven', h('span', { class: 'section-note' }, 'not controllable'));
  const jsSection = h('div', { class: 'rows js-rows' });
  root.append(animSection, jsHeader, jsSection);

  function leafRow(entry: AnimationEntry): RowParts {
    const { spec } = entry;
    const sub = h('span', { class: 'row-sub' });
    const state = h('span', { class: 'row-state' });
    const el = h(
      'button',
      { class: 'row', type: 'button', dataset: { id: spec.id, kind: spec.kind, nav: '' }, onclick: () => cb.onOpen(spec.id) },
      h('span', { class: 'row-curve' }, miniCurve(iterationCurve(spec))),
      h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, h('span', { class: 'row-name' }, spec.name)), sub),
      h('span', { class: 'row-meta' }, h('span', { class: 'row-dur' }, durationText(entry)), h('span', { class: 'kind', dataset: { kind: spec.kind } }, KIND_LABEL[spec.kind])),
      h('span', { class: 'row-end', html: icons.chevron }),
    );
    el.querySelector('.row-title')!.append(state);
    return { el, sub, state };
  }

  function groupRow(key: string, first: AnimationEntry): RowParts {
    const { spec } = first;
    const count = h('span', { class: 'row-count' });
    const sub = h('span', { class: 'row-sub' });
    const state = h('span', { class: 'row-state' });
    const el = h(
      'button',
      { class: 'row is-group', type: 'button', dataset: { kind: spec.kind, nav: '' }, 'aria-expanded': 'false', onclick: () => cb.onToggle(key) },
      h('span', { class: 'row-curve' }, miniCurve(iterationCurve(spec))),
      h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, h('span', { class: 'row-name' }, spec.name), count, state), sub),
      h('span', { class: 'row-meta' }, h('span', { class: 'row-dur' }, durationText(first)), h('span', { class: 'kind', dataset: { kind: spec.kind } }, KIND_LABEL[spec.kind])),
      h('span', { class: 'row-end row-toggle', html: icons.chevron }),
    );
    el.dataset.group = key.length > 64 ? String(hash(key)) : key;
    return { el, count, sub, state };
  }

  function childRow(entry: AnimationEntry): RowParts {
    const sub = h('span', { class: 'row-sub' });
    const state = h('span', { class: 'row-state' });
    const count = h('span', { class: 'row-index' });
    const el = h(
      'button',
      { class: 'row is-child', type: 'button', dataset: { id: entry.spec.id, kind: entry.spec.kind, nav: '' }, onclick: () => cb.onOpen(entry.spec.id) },
      count,
      h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, sub, state)),
      h('span', { class: 'row-size' }, entry.spec.size ?? ''),
      h('span', { class: 'row-end', html: icons.chevron }),
    );
    return { el, sub, state, count };
  }

  const setText = (el: HTMLElement, text: string) => {
    if (el.textContent !== text) el.textContent = text;
  };

  function render(model: ListModel) {
    const seen = new Set<string>();
    const order: HTMLElement[] = [];

    const use = (key: string, make: () => RowParts) => {
      let r = rows.get(key);
      if (!r) rows.set(key, (r = make()));
      seen.add(key);
      order.push(r.el);
      return r;
    };

    for (const g of model.groups) {
      const first = g.entries[0]!;
      if (g.entries.length === 1) {
        const r = use(`leaf:${first.spec.id}`, () => leafRow(first));
        setText(r.sub, first.spec.label);
        patchState(r, first, model.paused);
        continue;
      }
      const open = model.expanded.has(g.key);
      const r = use(`group:${g.key}`, () => groupRow(g.key, first));
      setText(r.count!, `×${g.entries.length}`);
      const labels = new Set(g.entries.map((e) => e.spec.label));
      setText(r.sub, labels.size === 1 ? `${g.entries.length} elements · ${first.spec.label}` : `${g.entries.length} elements`);
      const ended = g.entries.every((e) => e.live.ended);
      r.el.classList.toggle('is-ended', ended);
      setText(r.state, ended ? 'Ended' : '');
      r.el.classList.toggle('is-open', open);
      r.el.setAttribute('aria-expanded', String(open));
      if (open) {
        g.entries.forEach((e, i) => {
          const c = use(`child:${e.spec.id}`, () => childRow(e));
          setText(c.count!, String(i + 1));
          setText(c.sub, e.spec.label);
          patchState(c, e, model.paused);
        });
      }
    }

    // Reconcile DOM order without touching rows that are already in place.
    let cursor = animSection.firstElementChild;
    for (const el of order) {
      if (cursor === el) {
        cursor = cursor.nextElementSibling;
      } else {
        animSection.insertBefore(el, cursor);
      }
    }
    for (const [key, r] of rows) {
      if (!seen.has(key)) {
        r.el.remove();
        rows.delete(key);
      }
    }

    renderJs(model.js);
  }

  function patchState(r: RowParts, e: AnimationEntry, paused: boolean) {
    const text = stateText(e, paused);
    setText(r.state, text);
    r.el.classList.toggle('is-ended', e.live.ended);
  }

  let jsSig = '';
  function renderJs(js: JsDrivenEntry[]) {
    const sig = js.map((j) => `${j.id}:${j.properties.join(',')}`).join('|');
    jsHeader.hidden = js.length === 0;
    if (sig === jsSig) return;
    jsSig = sig;
    clear(jsSection);
    for (const j of js) {
      jsSection.append(
        h(
          'div',
          { class: 'row is-js', role: 'listitem', title: 'Inline styles change every frame: requestAnimationFrame or a JS spring. Can’t be paused or exported.' },
          h('span', { class: 'row-curve js-dot' }),
          h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, h('span', { class: 'row-name' }, j.properties.join(', ') || 'style')), h('span', { class: 'row-sub' }, j.label)),
          h('span', { class: 'row-meta' }, h('span', { class: 'kind', dataset: { kind: 'js' } }, 'JS')),
        ),
      );
    }
  }

  /* Hover preview: outline the element on the page while pointing at its row. */
  let hovered: string | null = null;
  const hover = (id: string | null) => {
    if (id === hovered) return;
    hovered = id;
    cb.onHover(id);
  };
  animSection.addEventListener('pointerover', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.row');
    hover(row?.dataset.id ?? null);
  });
  animSection.addEventListener('pointerleave', () => hover(null));

  /* Keyboard: ↑/↓ between rows, → / ← open and close groups. */
  root.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement;
    if (!target.matches('.row[data-nav]')) return;
    const all = Array.from(animSection.querySelectorAll<HTMLElement>('.row[data-nav]'));
    const i = all.indexOf(target);
    const focus = (el: HTMLElement | undefined) => {
      if (!el) return;
      e.preventDefault();
      el.focus();
      el.scrollIntoView({ block: 'nearest' });
    };
    switch (e.key) {
      case 'ArrowDown':
        focus(all[i + 1]);
        break;
      case 'ArrowUp':
        focus(all[i - 1]);
        break;
      case 'Home':
        focus(all[0]);
        break;
      case 'End':
        focus(all[all.length - 1]);
        break;
      case 'ArrowRight':
        if (target.classList.contains('is-group') && !target.classList.contains('is-open')) {
          e.preventDefault();
          target.click();
        }
        break;
      case 'ArrowLeft':
        if (target.classList.contains('is-group') && target.classList.contains('is-open')) {
          e.preventDefault();
          target.click();
        } else if (target.classList.contains('is-child')) {
          let p = target.previousElementSibling as HTMLElement | null;
          while (p && !p.classList.contains('is-group')) p = p.previousElementSibling as HTMLElement | null;
          focus(p ?? undefined);
        }
        break;
    }
  });

  /** Focus the row for an animation id (after coming back from the detail view). */
  function focusId(id: string) {
    const el = animSection.querySelector<HTMLElement>(`.row[data-id="${CSS.escape(id)}"]`);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: 'nearest' });
  }

  return { render, focusId };
}

function hash(s: string): number {
  let x = 0;
  for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) | 0;
  return x >>> 0;
}
