/**
 * A short, human label for an element: what you'd call it when pointing at
 * it, not a selector. Runs in the page (agent) and under happy-dom in tests.
 *
 *   aria-label → #id → tag.meaningful-class → tag “text” → tag in <ancestor>
 *
 * Tailwind-style utilities, hashed class names and generated ids are skipped.
 */

const UTILITY =
  /^-?(?:min-w|min-h|max-w|max-h|gap(?:-[xy])?|space-[xy]|inset(?:-[xy])?|top|left|right|bottom|start|end|z|order|col|row|basis|grow|shrink|flex|grid|text|font|leading|tracking|bg|from|via|to|border|rounded|shadow|ring|outline|opacity|blur|backdrop|transition|duration|ease|delay|animate|transform|scale|rotate|translate|skew|origin|cursor|select|overflow|object|aspect|fill|stroke|line-clamp|divide|place|items|justify|content|self|decoration|whitespace|break|align|list|indent|columns|float|clear|box|appearance|resize|snap|scroll|touch|accent|caret|pointer-events|will-change|mix-blend|drop-shadow|underline-offset|auto-cols|auto-rows|grid-cols|grid-rows|col-span|row-span)(?:-|$)/;
// Spacing and sizing need a value, so `m-spring` or `p-card` stay meaningful.
const SIZING = /^-?(?:[pm][xytrblse]?|w|h|size)-(?:\d|px|auto|full|screen|min|max|fit|[dsl]vh|\[)/;
const UTILITY_WORDS = new Set([
  'hidden', 'block', 'inline', 'inline-block', 'inline-flex', 'inline-grid', 'contents', 'table', 'flow-root',
  'absolute', 'relative', 'fixed', 'sticky', 'static', 'visible', 'invisible', 'collapse', 'container',
  'uppercase', 'lowercase', 'capitalize', 'normal-case', 'italic', 'not-italic', 'antialiased',
  'subpixel-antialiased', 'truncate', 'underline', 'overline', 'line-through', 'no-underline', 'isolate',
  'sr-only', 'not-sr-only', 'group', 'peer', 'dark', 'light', 'filter', 'grayscale', 'invert', 'sepia',
  'shadow', 'rounded', 'border', 'grow', 'shrink', 'transform', 'transition', 'ring', 'outline', 'blur',
]);
const HASHED = /^(?:css|sc|jsx|svelte|astro|emotion|tw)-[\w-]{4,}$|^_[\w-]{5,}$|^[a-z]{1,3}[A-Z0-9][\w-]{4,}$/;

export function isUtilityClass(c: string): boolean {
  return /[:[\]/.!@%#()]/.test(c) || UTILITY_WORDS.has(c) || SIZING.test(c) || UTILITY.test(c) || HASHED.test(c);
}

/** CSS-modules names like `Card_root__a1B2c` → `Card_root`. */
function tidyClass(c: string): string {
  return c.replace(/__[\w-]{5,}$/, '');
}

function meaningfulClasses(el: Element): string[] {
  return Array.from(el.classList)
    .filter((c) => c.length <= 40 && !isUtilityClass(c))
    .map(tidyClass);
}

function goodId(id: string): boolean {
  return !!id && id.length <= 32 && !/^[:_]|:|^\d|[0-9a-f]{8,}/i.test(id);
}

function snippet(text: string | null | undefined, max = 24): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function own(el: Element): string {
  const tag = el.localName;
  const aria = snippet(el.getAttribute('aria-label'), 28);
  if (aria) return `${tag} “${aria}”`;
  if (goodId(el.id)) return `#${el.id}`;
  const classes = meaningfulClasses(el);
  if (classes.length) {
    const doc = el.ownerDocument;
    const unique = classes.find((c) => {
      try {
        return doc.getElementsByClassName(c).length === 1;
      } catch {
        return false;
      }
    });
    return `${tag}.${unique ?? classes[0]}`;
  }
  return '';
}

export function elementLabel(el: Element, pseudo?: string | null): string {
  const suffix = pseudo ?? '';
  const doc = el.ownerDocument;
  if (el === doc.documentElement) return `html${suffix}`;
  if (el === doc.body) return `body${suffix}`;
  const mine = own(el);
  if (mine) return mine + suffix;
  const tag = el.localName;
  // Short visible text: buttons, links, headings, chips.
  const text = el.textContent ?? '';
  if (text.trim() && text.replace(/\s+/g, ' ').trim().length <= 60) return `${tag} “${snippet(text)}”${suffix}`;
  // Otherwise, name it by the nearest ancestor that has a name.
  let cur = el.parentElement;
  for (let depth = 0; cur && cur !== doc.body && depth < 4; depth++, cur = cur.parentElement) {
    const name = own(cur);
    if (name) return `${tag}${suffix} in ${name}`;
  }
  return tag + suffix;
}
