/** Property-name helpers shared by the agent and the exporters. */

/** Keys WAAPI puts on keyframe objects that aren't animated properties. */
export const KEYFRAME_META = new Set(['offset', 'computedOffset', 'easing', 'composite']);

export function camelToKebab(prop: string): string {
  if (prop.startsWith('--')) return prop;
  if (prop === 'cssFloat') return 'float';
  if (prop === 'cssOffset') return 'offset';
  return prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

export function kebabToCamel(prop: string): string {
  if (prop.startsWith('--')) return prop;
  return prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** A string that's safe as a JS object key without quotes. */
export function jsKey(prop: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(prop) ? prop : JSON.stringify(prop);
}

const GSAP_TRANSFORMS: Record<string, (v: string) => string> = {
  x: (v) => `translateX(${withUnit(v, 'px')})`,
  y: (v) => `translateY(${withUnit(v, 'px')})`,
  z: (v) => `translateZ(${withUnit(v, 'px')})`,
  xPercent: (v) => `translateX(${withUnit(v, '%')})`,
  yPercent: (v) => `translateY(${withUnit(v, '%')})`,
  rotation: (v) => `rotate(${withUnit(v, 'deg')})`,
  rotate: (v) => `rotate(${withUnit(v, 'deg')})`,
  rotationX: (v) => `rotateX(${withUnit(v, 'deg')})`,
  rotationY: (v) => `rotateY(${withUnit(v, 'deg')})`,
  rotateX: (v) => `rotateX(${withUnit(v, 'deg')})`,
  rotateY: (v) => `rotateY(${withUnit(v, 'deg')})`,
  scale: (v) => `scale(${v})`,
  scaleX: (v) => `scaleX(${v})`,
  scaleY: (v) => `scaleY(${v})`,
  skewX: (v) => `skewX(${withUnit(v, 'deg')})`,
  skewY: (v) => `skewY(${withUnit(v, 'deg')})`,
};

function withUnit(v: string, unit: string) {
  return /^[-+]?(\d+\.?\d*|\.\d+)$/.test(v.trim()) ? `${v.trim()}${unit}` : v.trim();
}

/** GSAP tween vars that configure the tween rather than animate a property. */
export const GSAP_SPECIAL = new Set([
  'duration', 'delay', 'ease', 'repeat', 'repeatDelay', 'yoyo', 'yoyoEase', 'stagger',
  'onStart', 'onUpdate', 'onComplete', 'onRepeat', 'onReverseComplete', 'onInterrupt',
  'onStartParams', 'onUpdateParams', 'onCompleteParams', 'onRepeatParams',
  'callbackScope', 'paused', 'immediateRender', 'overwrite', 'lazy', 'runBackwards',
  'startAt', 'keyframes', 'id', 'data', 'inherit', 'reversed', 'snap', 'modifiers',
  'transformOrigin', 'svgOrigin', 'force3D', 'smoothOrigin', 'scrollTrigger', 'parent',
  'defaults', 'easeEach', 'autoRound', 'clearProps', 'css', 'attr', 'onToggle',
]);

/**
 * Turn GSAP property values into CSS ones: transform shorthands are folded
 * into one `transform`, autoAlpha becomes opacity, numbers on length
 * properties get px.
 */
export function gsapPropsToCss(vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const transforms: string[] = [];
  for (const [k, v] of Object.entries(vars)) {
    const t = GSAP_TRANSFORMS[k];
    if (t) transforms.push(t(v));
    else if (k === 'autoAlpha') out.opacity = v;
    else out[k] = /^[-+]?(\d+\.?\d*|\.\d+)$/.test(v) && LENGTH_PROPS.has(k) ? `${v}px` : v;
  }
  if (transforms.length) out.transform = out.transform ? `${out.transform} ${transforms.join(' ')}` : transforms.join(' ');
  return out;
}

const LENGTH_PROPS = new Set([
  'width', 'height', 'top', 'left', 'right', 'bottom', 'margin', 'marginTop', 'marginLeft',
  'marginRight', 'marginBottom', 'padding', 'paddingTop', 'paddingLeft', 'paddingRight',
  'paddingBottom', 'borderRadius', 'borderWidth', 'fontSize', 'letterSpacing', 'gap',
  'maxWidth', 'maxHeight', 'minWidth', 'minHeight',
]);
