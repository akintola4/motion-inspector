import type { AnimationSpec } from '../types';
import { camelToKebab } from '../css-props';
import { cssIdent, describe, directionalKeyframes, fmtTime, summarizeEasing } from './shared';

function decls(props: Record<string, string>, indent: string): string[] {
  return Object.entries(props).map(([k, v]) => `${indent}${camelToKebab(k)}: ${v};`);
}

function pct(offset: number): string {
  return `${Number((offset * 100).toFixed(2))}%`;
}

export function toCssTransition(spec: AnimationSpec): string {
  const ease = summarizeEasing(spec);
  const props = spec.properties.length ? spec.properties : [spec.name];
  const first = spec.keyframes[0]?.props ?? {};
  const last = spec.keyframes[spec.keyframes.length - 1]?.props ?? {};
  const list = props
    .map((p) => {
      const parts = [camelToKebab(p), fmtTime(spec.duration), ease.css];
      if (spec.delay) parts.push(fmtTime(spec.delay));
      return parts.join(' ');
    })
    .join(',\n    ');
  const out = [
    `/* ${describe(spec)} */`,
    `${spec.selector} {`,
    ...decls(first, '  '),
    `  transition: ${list};`,
    `}`,
  ];
  if (Object.keys(last).length) {
    out.push('', `/* the state it transitions to — swap in your own trigger */`);
    out.push(`${spec.selector}:is(:hover, .is-active) {`, ...decls(last, '  '), `}`);
  }
  return out.join('\n');
}

export function toCssAnimation(spec: AnimationSpec): string {
  const ease = summarizeEasing(spec);
  const name = cssIdent(spec.name || 'motion');
  const kfs = directionalKeyframes({ ...spec, direction: 'normal' });
  const notes: string[] = [];

  // In CSS, animation-timing-function applies per keyframe segment. A WAAPI
  // effect-level easing spans the whole iteration, so they only agree when
  // there's a single segment.
  if (ease.source === 'effect' && spec.easing !== 'linear' && kfs.length > 2) {
    notes.push(
      `/* note: the source applies "${ease.css}" across the whole iteration;`,
      `   CSS applies it to each keyframe segment, so the in-between timing differs. */`,
    );
  }
  if (spec.endDelay) notes.push(`/* note: endDelay ${fmtTime(spec.endDelay)} has no CSS equivalent */`);

  const body: string[] = [];
  kfs.forEach((k, i) => {
    const isLast = i === kfs.length - 1;
    const lines = decls(k.props, '    ');
    if (!isLast && ease.source === 'per-keyframe' && k.easing !== ease.css) {
      lines.push(`    animation-timing-function: ${k.easing};`);
    }
    body.push(`  ${pct(k.offset)} {`, ...lines, `  }`);
  });

  const iterations = spec.iterations === 'infinite' ? 'infinite' : spec.iterations !== 1 ? String(spec.iterations) : '';
  const shorthand = [
    name,
    fmtTime(spec.duration),
    ease.css,
    spec.delay ? fmtTime(spec.delay) : '',
    iterations,
    spec.direction !== 'normal' ? spec.direction : '',
    spec.fill !== 'none' && spec.fill !== 'auto' ? spec.fill : '',
  ]
    .filter(Boolean)
    .join(' ');

  return [
    `/* ${describe(spec)} */`,
    ...notes,
    `@keyframes ${name} {`,
    ...body,
    `}`,
    '',
    `${spec.selector} {`,
    `  animation: ${shorthand};`,
    `}`,
  ].join('\n');
}

export function toCss(spec: AnimationSpec): string {
  return spec.kind === 'css-transition' ? toCssTransition(spec) : toCssAnimation(spec);
}
