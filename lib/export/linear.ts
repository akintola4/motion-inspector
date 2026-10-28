import type { AnimationSpec } from '../types';
import { fitSpring, parseEasing, toLinear, evaluate } from '../easing';
import { describe, summarizeEasing } from './shared';

/** The easing written as CSS linear(), plus a usage line. */
export function toLinearExport(spec: AnimationSpec): string {
  const ease = summarizeEasing(spec);
  const prop = spec.kind === 'css-transition' ? 'transition-timing-function' : 'animation-timing-function';
  const out = [`/* ${describe(spec)} */`];

  const easings = ease.source === 'per-keyframe' ? ease.segments : [ease.css];
  const lines = easings.map((css, i) => {
    const def = parseEasing(css) ?? { type: 'linear' as const };
    const varName = easings.length > 1 ? `--ease-${i + 1}` : '--ease';
    let comment = `from ${css.length > 60 ? css.slice(0, 57) + '…' : css}`;
    if (def.type === 'steps') comment = 'steps() is already exact';
    if (def.type === 'linear-fn') {
      const fit = fitSpring((t) => evaluate(def, t), spec.duration);
      comment = fit
        ? `≈ spring, bounce ${fit.bounce}, visualDuration ${fit.visualDuration}s`
        : 'already linear()';
    }
    return { varName, value: toLinear(def), comment };
  });

  out.push(':root {');
  for (const l of lines) out.push(`  /* ${l.comment} */`, `  ${l.varName}: ${l.value};`);
  out.push('}', '');
  if (lines.length === 1) {
    out.push(`${spec.selector} {`, `  ${prop}: var(--ease);`, `}`);
  } else {
    out.push(`/* one easing per keyframe segment — set each inside @keyframes: */`);
    lines.forEach((l, i) => {
      const at = Number(((spec.keyframes[i]?.offset ?? 0) * 100).toFixed(2));
      out.push(`/* ${at}% { animation-timing-function: var(${l.varName}); } */`);
    });
  }
  return out.join('\n');
}
