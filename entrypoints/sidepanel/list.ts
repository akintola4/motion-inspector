import type { AnimationEntry, AnimationKind, JsDrivenEntry } from '../../lib/types';
import { targetKey, type AnimationGroup } from '../../lib/grouping';
import { iterationCurve } from '../../lib/timing';
import { fmtTime } from '../../lib/export/shared';
import { clear, h, setAttr, setText } from './h';
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
  /** Leaf rows: the group key whose timing the row currently shows. */
  sig?: string;
  curve?: HTMLElement;
  dur?: HTMLElement;
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
  /**
   * A background update (poll), not something the user just did. While the
   * pointer is over the list these may patch rows but not move them.
   */
  background?: boolean;
  /** The user changed what's listed (filter, zero-length toggle, new tab): lay rows out fresh. */
  reorder?: boolean;
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
  /* Collapsing a group near the end of a scrolled list shrinks the content
     and the browser clamps scrollTop, dragging the row you clicked down
     under the pointer. A spacer at the end makes up the difference so the
     row stays put; it goes once it has scrolled out of view. */
  const spacer = h('div', { class: 'list-spacer', 'aria-hidden': 'true' });
  let spacerH = 0;
  const setSpacer = (px: number) => {
    spacerH = Math.max(0, px);
    spacer.style.height = spacerH ? `${spacerH}px` : '';
  };
  root.addEventListener(
    'scroll',
    () => {
      if (spacerH && spacer.getBoundingClientRect().top >= root.getBoundingClientRect().bottom) setSpacer(0);
    },
    { passive: true },
  );
  function toggle(key: string) {
    const top = root.scrollTop;
    cb.onToggle(key); // renders synchronously
    if (!top) return;
    // Height of the content without the spacer, in scroll coordinates.
    setSpacer(0);
    const pad = parseFloat(getComputedStyle(root).paddingBottom) || 0;
    const content = spacer.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop + pad;
    const need = top + root.clientHeight - content;
    if (need > 0) setSpacer(need);
    if (root.scrollTop !== top) root.scrollTop = top;
  }

  root.append(animSection, jsHeader, jsSection, spacer);

  /* While the pointer is over the list, polls don't remove or reorder rows:
     an animation ending would otherwise pull every row below it up under
     the cursor. Rows that left stay (faded) and new ones join at the end;
     the list settles on the next poll after the pointer leaves. */
  let pointerInside = false;
  root.addEventListener('pointerenter', () => (pointerInside = true));
  root.addEventListener('pointerleave', () => (pointerInside = false));

  function leafRow(entry: AnimationEntry): RowParts {
    const { spec } = entry;
    const sub = h('span', { class: 'row-sub' });
    const state = h('span', { class: 'row-state' });
    const curve = h('span', { class: 'row-curve' });
    const dur = h('span', { class: 'row-dur' });
    const el = h(
      'button',
      { class: 'row', type: 'button', dataset: { id: spec.id, kind: spec.kind, nav: '' }, onclick: () => cb.onOpen(el.dataset.id!) },
      curve,
      h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, h('span', { class: 'row-name' }, spec.name)), sub),
      h('span', { class: 'row-meta' }, dur, h('span', { class: 'kind', dataset: { kind: spec.kind } }, KIND_LABEL[spec.kind])),
      h('span', { class: 'row-end', html: icons.chevron }),
    );
    el.querySelector('.row-title')!.append(state);
    return { el, sub, state, curve, dur };
  }

  /** A leaf row follows its animation across re-triggers; redraw timing only if it changed. */
  function patchTiming(r: RowParts, key: string, entry: AnimationEntry) {
    if (r.sig === key) return;
    r.sig = key;
    r.curve!.replaceChildren(miniCurve(iterationCurve(entry.spec)));
    setText(r.dur!, durationText(entry));
  }

  function groupRow(key: string, first: AnimationEntry): RowParts {
    const { spec } = first;
    const count = h('span', { class: 'row-count' });
    const sub = h('span', { class: 'row-sub' });
    const state = h('span', { class: 'row-state' });
    const el = h(
      'button',
      { class: 'row is-group', type: 'button', dataset: { kind: spec.kind, nav: '' }, 'aria-expanded': 'false', onclick: () => toggle(key) },
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
      { class: 'row is-child', type: 'button', dataset: { id: entry.spec.id, kind: entry.spec.kind, nav: '' }, onclick: () => cb.onOpen(el.dataset.id!) },
      count,
      h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, sub, state)),
      h('span', { class: 'row-size' }, entry.spec.size ?? ''),
      h('span', { class: 'row-end', html: icons.chevron }),
    );
    return { el, sub, state, count };
  }

  /*
   * Rows are keyed by what they show, not by Animation instance: a leaf by
   * animation + element, a child by group key + element. A transition that
   * re-triggers is a new Animation with a new id but keeps its row.
   *
   * The list is a sequence of blocks (a row plus, for an open group, its
   * children). Blocks keep their previous order and new ones join at the
   * end, so polling (or coming back from the detail view) never reshuffles
   * rows; only `reorder` lays them out fresh. While the pointer is over the
   * list, rows that a poll removed are held in place (faded) until it
   * moves away.
   */
  interface Block {
    key: string;
    el: HTMLElement;
    children: { key: string; el: HTMLElement }[];
  }
  let prevOrder: string[] = [];
  let prevChildren = new Map<string, string[]>();

  function render(model: ListModel) {
    const blocks = new Map<string, Block>();
    const leafSeen = new Map<string, number>();
    const use = (key: string, make: () => RowParts) => {
      let r = rows.get(key);
      if (!r) rows.set(key, (r = make()));
      return r;
    };

    for (const g of model.groups) {
      const first = g.entries[0]!;
      if (g.entries.length === 1) {
        // Keyed by animation + element, not timing: a transition reversed
        // halfway (shorter duration) keeps its row.
        const t = targetKey(first.spec);
        const n = (leafSeen.get(t) ?? 0) + 1;
        leafSeen.set(t, n);
        const key = `leaf:${t}#${n}`;
        const r = use(key, () => leafRow(first));
        patchTiming(r, g.key, first);
        setAttr(r.el, 'data-id', first.spec.id);
        setText(r.sub, first.spec.label);
        patchState(r, first, model.paused);
        blocks.set(key, { key, el: r.el, children: [] });
        continue;
      }
      const open = model.expanded.has(g.key);
      const key = `group:${g.key}`;
      const r = use(key, () => groupRow(g.key, first));
      setText(r.count!, `×${g.entries.length}`);
      const labels = new Set(g.entries.map((e) => e.spec.label));
      setText(r.sub, labels.size === 1 ? `${g.entries.length} elements · ${first.spec.label}` : `${g.entries.length} elements`);
      const ended = g.entries.every((e) => e.live.ended);
      r.el.classList.toggle('is-ended', ended);
      setText(r.state, ended ? 'Ended' : '');
      r.el.classList.toggle('is-open', open);
      setAttr(r.el, 'aria-expanded', String(open));
      const block: Block = { key, el: r.el, children: [] };
      if (open) {
        const dup = new Map<string, number>();
        g.entries.forEach((e, i) => {
          const n = (dup.get(e.spec.selector) ?? 0) + 1;
          dup.set(e.spec.selector, n);
          const ck = `child:${g.key}|${e.spec.selector}#${n}`;
          const c = use(ck, () => childRow(e));
          setAttr(c.el, 'data-id', e.spec.id);
          setText(c.count!, String(i + 1));
          setText(c.sub, e.spec.label);
          patchState(c, e, model.paused);
          block.children.push({ key: ck, el: c.el });
        });
      }
      blocks.set(key, block);
    }

    if (model.reorder) setSpacer(0);
    const held = new Set<string>();
    let ordered = [...blocks.values()];
    if (!model.reorder) {
      const hold = !!model.background && pointerInside;
      const keep = (k: string) => {
        if (!hold || !rows.has(k)) return null;
        held.add(k);
        return rows.get(k)!.el;
      };
      const prevSet = new Set(prevOrder);
      const sticky: Block[] = [];
      for (const k of prevOrder) {
        const b = blocks.get(k);
        if (b) sticky.push(b);
        else {
          const el = keep(k);
          if (el) sticky.push({ key: k, el, children: [] });
        }
      }
      for (const b of ordered) if (!prevSet.has(b.key)) sticky.push(b);
      for (const b of sticky) {
        const prev = prevChildren.get(b.key);
        if (!prev?.length) continue;
        const now = new Map(b.children.map((c) => [c.key, c]));
        const blockHeld = held.has(b.key);
        if (!blockHeld && b.children.length === 0) continue; // collapsed
        const kids: Block['children'] = [];
        for (const ck of prev) {
          const c = now.get(ck);
          if (c) kids.push(c);
          else {
            const el = keep(ck);
            if (el) kids.push({ key: ck, el });
          }
        }
        const prevKids = new Set(prev);
        for (const c of b.children) if (!prevKids.has(c.key)) kids.push(c);
        b.children = kids;
      }
      ordered = sticky;
    }

    const shown = new Set<string>();
    const els: HTMLElement[] = [];
    for (const b of ordered) {
      shown.add(b.key);
      els.push(b.el);
      for (const c of b.children) {
        shown.add(c.key);
        els.push(c.el);
      }
    }
    prevOrder = ordered.map((b) => b.key);
    prevChildren = new Map(ordered.map((b) => [b.key, b.children.map((c) => c.key)]));

    // Reconcile DOM order without touching rows that are already in place.
    let cursor = animSection.firstElementChild;
    for (const el of els) {
      if (cursor === el) {
        cursor = cursor.nextElementSibling;
      } else {
        animSection.insertBefore(el, cursor);
      }
    }
    for (const [key, r] of rows) {
      if (!shown.has(key)) {
        r.el.remove();
        rows.delete(key);
      } else {
        r.el.classList.toggle('is-held', held.has(key));
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

  return { render, focusId, spacer };
}

function hash(s: string): number {
  let x = 0;
  for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) | 0;
  return x >>> 0;
}
