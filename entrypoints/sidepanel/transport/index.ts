import { h, setAttr } from '../h';
import { current } from './current';
import { optionA } from './option-a';
import { optionB } from './option-b';
import { optionC } from './option-c';
import { VARIANTS, type TransportFactory, type Variant } from './types';

export * from './types';

export const FACTORIES: Record<Variant, TransportFactory> = { current, a: optionA, b: optionB, c: optionC };

const KEY = 'mi-transport';

/** ?transport=a|b|c|current wins (e2e), then the saved choice, then the current design. */
export function readVariant(): Variant {
  const q = new URLSearchParams(location.search).get('transport');
  const ok = (v: string | null): v is Variant => VARIANTS.some((x) => x.id === v);
  if (ok(q)) return q;
  try {
    const v = localStorage.getItem(KEY);
    if (ok(v)) return v;
  } catch {
    /* private mode */
  }
  return 'current';
}

function saveVariant(v: Variant) {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* private mode */
  }
}

/**
 * Preview-only switch in the header: Old · A · B · C. Delete this (and the
 * transport folder's losing options) once one is picked.
 */
export function variantSwitch(initial: Variant, onChange: (v: Variant) => void) {
  const btns = VARIANTS.map((v) =>
    h('button', { class: 'seg-btn', type: 'button', role: 'radio', title: v.name, 'aria-label': v.name, dataset: { variant: v.id } }, v.short),
  );
  const el = h('div', { class: 'seg variant-switch', role: 'radiogroup', 'aria-label': 'Transport design (preview)' }, ...btns);
  const set = (id: Variant) => {
    for (const b of btns) {
      const on = b.dataset.variant === id;
      b.classList.toggle('is-on', on);
      setAttr(b, 'aria-checked', String(on));
    }
  };
  for (const b of btns) {
    b.addEventListener('click', () => {
      const id = b.dataset.variant as Variant;
      saveVariant(id);
      set(id);
      onChange(id);
    });
  }
  set(initial);
  return el;
}
