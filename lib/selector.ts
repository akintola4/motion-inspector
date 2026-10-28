/**
 * Short, unique-ish CSS selector for an element. Runs in the page (agent)
 * and in tests under happy-dom.
 */

const MAX_DEPTH = 5;

function esc(s: string) {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, (c) => `\\${c}`);
}

function isUnique(root: ParentNode, sel: string) {
  try {
    return root.querySelectorAll(sel).length === 1;
  } catch {
    return false;
  }
}

/** Classes that look generated (hashes, utility soup) make poor labels. */
function usefulClasses(el: Element): string[] {
  return Array.from(el.classList)
    .filter((c) => c.length <= 40 && !/^(css|sc|jsx|svelte|astro)-[\w-]{4,}$/.test(c) && !/[[\]:/]/.test(c))
    .slice(0, 3);
}

function step(el: Element): string {
  const tag = el.localName;
  const classes = usefulClasses(el);
  let s = tag + classes.map((c) => `.${esc(c)}`).join('');
  const parent = el.parentElement;
  if (parent) {
    const same = Array.from(parent.children).filter((c) => c.localName === tag);
    if (same.length > 1) s += `:nth-of-type(${same.indexOf(el) + 1})`;
  }
  return s;
}

export function uniqueSelector(el: Element, pseudo?: string | null): string {
  const suffix = pseudo ?? '';
  const doc = el.ownerDocument;
  if (el.id && isUnique(doc, `#${esc(el.id)}`)) return `#${esc(el.id)}${suffix}`;
  if (el === doc.documentElement) return `html${suffix}`;
  if (el === doc.body) return `body${suffix}`;

  const classes = usefulClasses(el);
  if (classes.length) {
    const sel = el.localName + classes.map((c) => `.${esc(c)}`).join('');
    if (isUnique(doc, sel)) return sel + suffix;
  }

  const parts: string[] = [];
  let cur: Element | null = el;
  for (let depth = 0; cur && depth < MAX_DEPTH; depth++) {
    if (cur.id && isUnique(doc, `#${esc(cur.id)}`)) {
      parts.unshift(`#${esc(cur.id)}`);
      break;
    }
    if (cur === doc.body) break;
    parts.unshift(step(cur));
    const sel = parts.join(' > ');
    if (isUnique(doc, sel)) return sel + suffix;
    cur = cur.parentElement;
  }
  return parts.join(' > ') + suffix;
}
