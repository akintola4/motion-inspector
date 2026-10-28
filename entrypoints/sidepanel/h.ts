/**
 * Tiny DOM helper. ~30 LOC. No JSX, no framework runtime.
 *
 * Usage:
 *   const btn = h('button', { class: 'icon', onclick: () => ... }, 'Hi');
 *   parent.append(btn);
 *
 * - Properties prefixed with `on` attach event listeners.
 * - `class`, `style`, `dataset` get special handling.
 * - Anything else is set via setAttribute.
 * - `html: '<svg…>'` sets innerHTML (used for inlined Geist Pixel SVGs).
 */

type Child = Node | string | number | false | null | undefined;

type Props = Record<string, unknown> & {
  class?: string;
  style?: Partial<CSSStyleDeclaration>;
  dataset?: Record<string, string>;
  html?: string;
};

export function h<T extends keyof HTMLElementTagNameMap>(
  tag: T,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[T] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') {
      el.className = String(v);
    } else if (k === 'style' && typeof v === 'object') {
      Object.assign(el.style, v as object);
    } else if (k === 'dataset' && typeof v === 'object') {
      Object.assign(el.dataset, v as Record<string, string>);
    } else if (k === 'html') {
      el.innerHTML = String(v);
    } else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else {
      el.setAttribute(k, String(v));
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el: Element) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Write text only when it changed: no text-node churn or style work per poll. */
export function setText(el: Element, text: string) {
  if (el.textContent !== text) el.textContent = text;
}

/** setAttribute only when the value changed (setAttribute always queues a mutation). */
export function setAttr(el: Element, name: string, value: string) {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

/**
 * A number that never changes width while it ticks: a hidden ghost of
 * `digits` eights (tabular figures, so every digit is the same width) holds
 * the box open and the real value sits right-aligned on top of it.
 */
export function numSlot(digits = 1) {
  const value = h('span', { class: 'num-value' });
  const el = h('span', { class: 'num', 'data-ghost': '8'.repeat(digits) }, value);
  return {
    el,
    value,
    set(text: string) {
      setText(value, text);
    },
    digits(n: number) {
      setAttr(el, 'data-ghost', '8'.repeat(Math.max(1, n)));
    },
  };
}
