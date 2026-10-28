import type { AnimationSpec } from '../types';
import { fmt, parseEasing, simplifyStops, type EasingDef } from '../easing';
import { bezierToGsapEase } from '../gsap-eases';
import { jsKey } from '../css-props';
import {
  describe,
  directionalKeyframes,
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
  customEase: boolean;
}

export function gsapEase(def: EasingDef, name: string): EaseOut {
  switch (def.type) {
    case 'linear':
      return { code: '"none"', prelude: [], customEase: false };
    case 'cubic-bezier': {
      const b: [number, number, number, number] = [def.x1, def.y1, def.x2, def.y2];
      const known = bezierToGsapEase(b);
      if (known) return { code: JSON.stringify(known), prelude: [], customEase: false };
      return {
        code: `CustomEase.create(${JSON.stringify(name)}, "${b.map((n) => fmt(n)).join(', ')}")`,
        prelude: [],
        customEase: true,
      };
    }
    case 'steps':
      return { code: name, prelude: [stepsEaseFn(def.steps, def.position, name)], customEase: false };
    case 'linear-fn':
      return {
        code: name,
        prelude: [`// piecewise-linear ease sampled from the page's linear() curve`, piecewiseEaseFn(simplifyStops(def.stops), name)],
        customEase: false,
      };
  }
}

function obj(entries: [string, string][], indent = ''): string {
  if (!entries.length) return '{}';
  return `{\n${entries.map(([k, v]) => `${indent}  ${jsKey(k)}: ${v},`).join('\n')}\n${indent}}`;
}

function timing(spec: AnimationSpec): [string, string][] {
  const out: [string, string][] = [['duration', String(seconds(spec.duration))]];
  if (spec.delay) out.push(['delay', String(seconds(spec.delay))]);
  if (spec.iterations === 'infinite') out.push(['repeat', '-1']);
  else if (spec.iterations > 1) out.push(['repeat', String(Math.round(spec.iterations - 1))]);
  const repeats = spec.iterations === 'infinite' || spec.iterations > 1;
  if (repeats && (spec.direction === 'alternate' || spec.direction === 'alternate-reverse' || spec.gsap?.yoyo)) {
    out.push(['yoyo', 'true']);
  }
  if (repeats && spec.gsap?.repeatDelay) out.push(['repeatDelay', String(spec.gsap.repeatDelay)]);
  return out;
}

function header(customEase: boolean): string[] {
  return customEase
    ? [`import gsap from "gsap"`, `import { CustomEase } from "gsap/CustomEase"`, '', `gsap.registerPlugin(CustomEase)`]
    : [`import gsap from "gsap"`];
}

/** Recreate a tween that came from GSAP itself: original vars and ease name. */
function fromGsapSource(spec: AnimationSpec): string {
  const g = spec.gsap!;
  const to = Object.entries(g.vars).map(([k, v]): [string, string] => [k, jsValue(v)]);
  const opts: [string, string][] = [...to, ...timing(spec), ['ease', JSON.stringify(g.easeName)]];
  const target = JSON.stringify(spec.selector);
  const call = g.fromVars
    ? `gsap.fromTo(${target}, ${obj(Object.entries(g.fromVars).map(([k, v]) => [k, jsValue(v)]))}, ${obj(opts)})`
    : `gsap.to(${target}, ${obj(opts)})`;
  const note =
    g.timelinePosition != null
      ? [`// this tween sits inside a timeline at ${Number(g.timelinePosition.toFixed(3))}s; use tl.to(…, ${Number(g.timelinePosition.toFixed(3))}) to keep its place`]
      : [];
  return [`// ${describe(spec)}`, ...note, ...header(false), '', call].join('\n');
}

export function toGsap(spec: AnimationSpec): string {
  if (spec.kind === 'gsap' && spec.gsap) return fromGsapSource(spec);

  const kfs = directionalKeyframes(spec);
  const tracks = propertyTracks(kfs);
  const ease = summarizeEasing(spec);
  const target = JSON.stringify(spec.selector);
  const prelude: string[] = [];
  let customEase = false;
  let call: string;

  if (kfs.length === 2) {
    const e = gsapEase(ease.def, 'ease');
    prelude.push(...e.prelude);
    customEase ||= e.customEase;
    const from = [...tracks].map(([k, v]): [string, string] => [k, jsValue(v[0] ?? null)]);
    const to = [...tracks].map(([k, v]): [string, string] => [k, jsValue(v[1] ?? null)]);
    call = `gsap.fromTo(${target}, ${obj(from)}, ${obj([...to, ...timing(spec), ['ease', e.code]])})`;
  } else {
    // Percentage keyframes. A keyframe's `ease` drives the segment that ends
    // at it; CSS puts the easing on the keyframe that starts the segment.
    const entries: [string, string][] = [];
    const perSegment = ease.source === 'per-keyframe' || ease.source === 'keyframes';
    kfs.forEach((k, i) => {
      const props = [...tracks].map(([p, v]): [string, string] => [p, jsValue(v[i] ?? null)]);
      if (perSegment && i > 0 && ease.source === 'per-keyframe') {
        const e = gsapEase(parseEasing(kfs[i - 1]!.easing) ?? { type: 'linear' }, `ease${i}`);
        prelude.push(...e.prelude);
        customEase ||= e.customEase;
        props.push(['ease', e.code]);
      }
      entries.push([`${Number((k.offset * 100).toFixed(2))}%`, obj(props, '    ')]);
    });
    const opts: [string, string][] = [];
    if (ease.source === 'keyframes') {
      const e = gsapEase(ease.def, 'ease');
      prelude.push(...e.prelude);
      customEase ||= e.customEase;
      entries.push(['easeEach', e.code]);
      opts.push(['ease', '"none"']);
    } else if (ease.source === 'effect') {
      const e = gsapEase(ease.def, 'ease');
      prelude.push(...e.prelude);
      customEase ||= e.customEase;
      entries.push(['easeEach', '"none"']);
      opts.push(['ease', e.code]);
    } else {
      opts.push(['ease', '"none"']);
    }
    call = `gsap.to(${target}, ${obj([['keyframes', obj(entries, '  ')], ...timing(spec), ...opts])})`;
  }

  return [`// ${describe(spec)}`, ...header(customEase), '', ...(prelude.length ? [...prelude, ''] : []), call].join('\n');
}
