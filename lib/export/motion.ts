import type { AnimationSpec } from '../types';
import { evaluate, fitSpring, fmt, parseEasing, simplifyStops, type EasingDef } from '../easing';
import { jsKey } from '../css-props';
import {
  describe,
  directionalKeyframes,
  isEvenlySpaced,
  jsValue,
  piecewiseEaseFn,
  propertyTracks,
  seconds,
  stepsEaseFn,
  summarizeEasing,
} from './shared';

interface EaseOut {
  code: string;
  prelude: string[];
}

const MOTION_KEYWORDS: Record<string, string> = {
  linear: '"linear"',
  'ease-in': '"easeIn"',
  'ease-out': '"easeOut"',
  'ease-in-out': '"easeInOut"',
};

export function motionEase(def: EasingDef, name: string): EaseOut {
  switch (def.type) {
    case 'linear':
      return { code: '"linear"', prelude: [] };
    case 'cubic-bezier': {
      const kw = def.keyword && MOTION_KEYWORDS[def.keyword];
      if (kw) return { code: kw, prelude: [] };
      return { code: `[${[def.x1, def.y1, def.x2, def.y2].map((n) => fmt(n)).join(', ')}]`, prelude: [] };
    }
    case 'steps':
      return { code: name, prelude: [stepsEaseFn(def.steps, def.position, name)] };
    case 'linear-fn':
      return {
        code: name,
        prelude: [`// piecewise-linear ease sampled from the page's linear() curve`, piecewiseEaseFn(simplifyStops(def.stops), name)],
      };
  }
}

interface MotionParts {
  values: Map<string, string[]>;
  transition: string[];
  prelude: string[];
  /** Two-keyframe animations split nicely into initial/animate. */
  twoKeyframes: boolean;
}

function buildParts(spec: AnimationSpec): MotionParts {
  const kfs = directionalKeyframes(spec);
  const tracks = propertyTracks(kfs);
  const values = new Map<string, string[]>();
  for (const [prop, vals] of tracks) values.set(prop, vals.map(jsValue));

  const ease = summarizeEasing(spec);
  const transition: string[] = [];
  const prelude: string[] = [];
  const twoKeyframes = kfs.length === 2;

  const spring =
    twoKeyframes && ease.def.type === 'linear-fn'
      ? fitSpring((t) => evaluate(ease.def, t), spec.duration)
      : null;

  if (spring) {
    transition.push(`type: "spring"`, `visualDuration: ${spring.visualDuration}`, `bounce: ${spring.bounce}`);
    prelude.push(
      `// the page used a sampled linear() spring; this is the spring it matches`,
      `// (stiffness ${spring.stiffness}, damping ${spring.damping}, mass 1)`,
    );
  } else {
    transition.push(`duration: ${seconds(spec.duration)}`);
    if (ease.source === 'per-keyframe') {
      const segs = kfs.slice(0, -1).map((k, i) => motionEase(parseEasing(k.easing) ?? { type: 'linear' }, `ease${i + 1}`));
      transition.push(`ease: [${segs.map((s) => s.code).join(', ')}]`);
      for (const s of segs) prelude.push(...s.prelude);
    } else {
      const e = motionEase(ease.def, 'ease');
      transition.push(`ease: ${e.code}`);
      prelude.push(...e.prelude);
    }
    const offsets = kfs.map((k) => k.offset);
    if (kfs.length > 2 && !isEvenlySpaced(offsets)) {
      transition.push(`times: [${offsets.map((o) => fmt(o, 4)).join(', ')}]`);
    }
  }

  if (spec.delay) transition.push(`delay: ${seconds(spec.delay)}`);
  if (spec.iterations === 'infinite') transition.push(`repeat: Infinity`);
  else if (spec.iterations > 1) transition.push(`repeat: ${Number((spec.iterations - 1).toFixed(3))}`);
  if (spec.iterations === 'infinite' || spec.iterations > 1) {
    if (spec.direction === 'alternate' || spec.direction === 'alternate-reverse') transition.push(`repeatType: "reverse"`);
    if (spec.endDelay) transition.push(`repeatDelay: ${seconds(spec.endDelay)}`);
  }
  return { values, transition, prelude, twoKeyframes };
}

function objectLiteral(entries: [string, string][], indent: string): string {
  if (!entries.length) return '{}';
  return `{\n${entries.map(([k, v]) => `${indent}  ${jsKey(k)}: ${v},`).join('\n')}\n${indent}}`;
}

const valueList = (v: string[]) => (v.length === 1 ? v[0]! : `[${v.join(', ')}]`);

export function toMotionVanilla(spec: AnimationSpec): string {
  const p = buildParts(spec);
  const values = [...p.values].map(([k, v]): [string, string] => [k, valueList(v)]);
  return [
    `// ${describe(spec)}`,
    `import { animate } from "motion"`,
    '',
    ...(p.prelude.length ? [...p.prelude, ''] : []),
    `animate(`,
    `  ${JSON.stringify(spec.selector)},`,
    `  ${objectLiteral(values, '  ')},`,
    `  ${objectLiteral(p.transition.map((t) => splitEntry(t)), '  ')}`,
    `)`,
  ].join('\n');
}

export function toMotionReact(spec: AnimationSpec): string {
  const p = buildParts(spec);
  const lines = [`// ${describe(spec)}`, `import { motion } from "motion/react"`, ''];
  if (p.prelude.length) lines.push(...p.prelude, '');
  lines.push(`<motion.div`);
  if (p.twoKeyframes) {
    const from = [...p.values].map(([k, v]): [string, string] => [k, v[0] ?? 'null']);
    const to = [...p.values].map(([k, v]): [string, string] => [k, v[1] ?? 'null']);
    lines.push(`  initial={${objectLiteral(from, '  ')}}`);
    lines.push(`  animate={${objectLiteral(to, '  ')}}`);
  } else {
    const values = [...p.values].map(([k, v]): [string, string] => [k, valueList(v)]);
    lines.push(`  animate={${objectLiteral(values, '  ')}}`);
  }
  lines.push(`  transition={${objectLiteral(p.transition.map((t) => splitEntry(t)), '  ')}}`);
  lines.push(`/>`);
  return lines.join('\n');
}

function splitEntry(entry: string): [string, string] {
  const i = entry.indexOf(':');
  return [entry.slice(0, i).trim(), entry.slice(i + 1).trim()];
}

export function toMotion(spec: AnimationSpec): string {
  return `${toMotionVanilla(spec)}\n\n// — or in React —\n\n${toMotionReact(spec).split('\n').slice(1).join('\n')}`;
}
