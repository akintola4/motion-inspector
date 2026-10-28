/** Tiny syntax colouring for the export block: comments, strings, numbers, keywords. */

const TOKEN =
  /(\/\*[\s\S]*?\*\/|\/\/[^\n]*)|("(?:[^"\\\n]|\\.)*")|(@keyframes|\b(?:import|from|const|return|let)\b)|(-?\b\d+(?:\.\d+)?(?:ms|s|%|px|deg)?\b)/g;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function highlight(code: string): string {
  let out = '';
  let last = 0;
  for (const m of code.matchAll(TOKEN)) {
    const i = m.index ?? 0;
    out += esc(code.slice(last, i));
    const cls = m[1] ? 'c' : m[2] ? 's' : m[3] ? 'k' : 'n';
    out += `<span class="tok-${cls}">${esc(m[0])}</span>`;
    last = i + m[0].length;
  }
  return out + esc(code.slice(last));
}
