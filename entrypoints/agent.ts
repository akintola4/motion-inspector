/**
 * Page agent. Injected into the page's MAIN world by the side panel with
 * chrome.scripting.executeScript, so it can see `window.gsap` and wrap
 * `Element.prototype.animate`. Installs `window.__motionInspector`; every
 * panel command is a follow-up executeScript call into that object.
 *
 * Nothing in here runs until the side panel is open on this tab.
 */
import type {
  AgentPoll,
  AgentSnapshot,
  AnimationEntry,
  AnimationKind,
  AnimationSpec,
  JsDrivenEntry,
  Keyframe,
  LiveState,
} from '../lib/types';
import { uniqueSelector } from '../lib/selector';
import { elementLabel } from '../lib/label';
import { GSAP_SPECIAL, KEYFRAME_META, gsapPropsToCss } from '../lib/css-props';
import { gsapEaseToCss } from '../lib/gsap-eases';
import { AGENT_VERSION, AGENT_GLOBAL } from '../lib/agent-protocol';

/* Minimal GSAP surface we touch. */
interface GsapAnimation {
  vars: Record<string, unknown>;
  parent: GsapAnimation | null;
  duration(): number;
  totalDuration(): number;
  delay(): number;
  repeat(): number;
  repeatDelay(): number;
  yoyo(): boolean;
  totalTime(): number;
  startTime?(): number;
  totalTime(t: number, suppressEvents?: boolean): GsapAnimation;
  progress(): number;
  isActive(): boolean;
  paused(): boolean;
  targets?(): unknown[];
  getChildren?(nested?: boolean, tweens?: boolean, timelines?: boolean): GsapAnimation[];
}
interface Gsap {
  version: string;
  globalTimeline: GsapAnimation & {
    pause(): void;
    resume(): void;
    timeScale(v?: number): number;
    paused(): boolean;
    getChildren(nested?: boolean, tweens?: boolean, timelines?: boolean): GsapAnimation[];
  };
  parseEase(ease: unknown): ((p: number) => number) | undefined;
  defaults(): Record<string, unknown>;
}

interface Entry {
  id: string;
  anim?: Animation;
  tween?: GsapAnimation;
  target: Element | null;
  spec: AnimationSpec;
  firstSeen: number;
  ended: boolean;
  scrollLinked: boolean;
}

export default defineUnlistedScript(() => {
  const w = window as unknown as Record<string, unknown>;
  const existing = w[AGENT_GLOBAL] as { version?: number; dispose?: () => void } | undefined;
  if (existing && existing.version === AGENT_VERSION) return;
  existing?.dispose?.();

  const MAX_ENTRIES = 100;
  /** Changes on every injection, so the panel knows its spec cache is stale. */
  const session = Math.random().toString(36).slice(2, 10);
  const entries = new Map<string, Entry>();
  const animIds = new WeakMap<Animation, string>();
  const tweenIds = new WeakMap<object, string>();
  const pausedByUs = new Set<Animation>();
  let counter = 0;
  let paused = false;
  let rate = 1;
  let scrubTime: number | null = null;
  let gsapPausedByUs = false;

  const gsap = () => (w.gsap as Gsap | undefined)?.globalTimeline ? (w.gsap as Gsap) : undefined;

  /* ------------------------------------------------------------------ */
  /* Overlay (highlight)                                                 */
  /* ------------------------------------------------------------------ */

  const host = document.createElement('motion-inspector-overlay');
  host.setAttribute('data-motion-inspector', '');
  host.style.cssText =
    'position:fixed;inset:0;pointer-events:none;z-index:2147483647;display:block;contain:strict;';
  const shadow = host.attachShadow({ mode: 'closed' });
  const box = document.createElement('div');
  const label = document.createElement('div');
  const style = document.createElement('style');
  style.textContent = `
    div{position:fixed;box-sizing:border-box;pointer-events:none}
    .box{border:1.5px solid #0070f3;background:rgba(0,112,243,.08);border-radius:2px;display:none}
    .label{display:none;font:500 12px/1.4 ui-sans-serif,system-ui,-apple-system,sans-serif;color:#fff;
      background:#0070f3;padding:2px 6px;border-radius:4px;white-space:nowrap;max-width:60vw;
      overflow:hidden;text-overflow:ellipsis}`;
  box.className = 'box';
  label.className = 'label';
  shadow.append(style, box, label);
  let highlighted: Entry | null = null;
  let rafId = 0;

  function placeOverlay() {
    rafId = 0;
    const el = highlighted?.target;
    if (!el || !el.isConnected) {
      box.style.display = label.style.display = 'none';
      return;
    }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, {
      display: 'block',
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
    label.textContent = highlighted!.spec.label;
    const above = r.top > 24;
    Object.assign(label.style, {
      display: 'block',
      left: `${Math.max(4, r.left)}px`,
      top: `${above ? r.top - 22 : r.bottom + 4}px`,
    });
    rafId = requestAnimationFrame(placeOverlay);
  }

  /** Outline an animation's target. `scroll: false` for hover previews. */
  function select(id: string | null, scroll = true) {
    highlighted = id ? entries.get(id) ?? null : null;
    if (highlighted && !host.isConnected) document.documentElement.append(host);
    if (rafId) cancelAnimationFrame(rafId);
    if (highlighted) {
      if (scroll) highlighted.target?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      placeOverlay();
    } else {
      box.style.display = label.style.display = 'none';
    }
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Reading WAAPI / CSS animations                                      */
  /* ------------------------------------------------------------------ */

  const isOurs = (el: Element | null) => !!el && (el === host || host.contains(el));

  function kindOf(a: Animation): AnimationKind {
    if (typeof CSSTransition !== 'undefined' && a instanceof CSSTransition) return 'css-transition';
    if (typeof CSSAnimation !== 'undefined' && a instanceof CSSAnimation) return 'css-animation';
    return 'waapi';
  }

  function str(v: unknown): string {
    return typeof v === 'number' ? String(v) : String(v ?? '');
  }

  function readKeyframes(effect: KeyframeEffect): Keyframe[] {
    return effect.getKeyframes().map((k) => {
      const props: Record<string, string> = {};
      for (const [key, v] of Object.entries(k)) {
        if (!KEYFRAME_META.has(key) && v != null) props[key] = str(v);
      }
      const offset = typeof k.offset === 'number' ? k.offset : Number(k.computedOffset ?? 0);
      return { offset: Number(offset.toFixed(4)), easing: k.easing ?? 'linear', props };
    });
  }

  function specFor(a: Animation, id: string): AnimationSpec | null {
    const effect = a.effect as KeyframeEffect | null;
    if (!effect || typeof effect.getKeyframes !== 'function') return null;
    const target = effect.target;
    const timing = effect.getTiming();
    const kind = kindOf(a);
    const keyframes = readKeyframes(effect);
    const properties = [...new Set(keyframes.flatMap((k) => Object.keys(k.props)))];
    let name = a.id;
    if (kind === 'css-animation') name = (a as CSSAnimation).animationName;
    if (kind === 'css-transition') name = (a as CSSTransition).transitionProperty;
    const nameIsGenerated = !name;
    if (!name) name = properties.slice(0, 2).join(', ') || 'animation';
    const iterations = timing.iterations ?? 1;
    return {
      id,
      kind,
      name,
      selector: target ? uniqueSelector(target, effect.pseudoElement) : '(no target)',
      label: target ? elementLabel(target, effect.pseudoElement) : '(no target)',
      ...(target ? { size: sizeOf(target) } : {}),
      duration: typeof timing.duration === 'number' ? timing.duration : 0,
      delay: timing.delay ?? 0,
      endDelay: timing.endDelay ?? 0,
      iterations: Number.isFinite(iterations) ? iterations : 'infinite',
      direction: timing.direction ?? 'normal',
      fill: timing.fill ?? 'auto',
      easing: timing.easing ?? 'linear',
      keyframes,
      properties,
      ...(nameIsGenerated ? { nameIsGenerated } : {}),
    };
  }

  function sizeOf(el: Element): string {
    const r = el.getBoundingClientRect();
    return `${Math.round(r.width)}×${Math.round(r.height)}`;
  }

  function isScrollLinked(a: Animation) {
    const tl = a.timeline;
    return !!tl && typeof DocumentTimeline !== 'undefined' && !(tl instanceof DocumentTimeline);
  }

  function register(a: Animation) {
    if (animIds.has(a)) return;
    const effect = a.effect as KeyframeEffect | null;
    const target = effect?.target ?? null;
    if (isOurs(target)) return;
    const id = `a${++counter}`;
    const spec = specFor(a, id);
    if (!spec) return;
    animIds.set(a, id);
    // Re-running the same transition/animation creates a new Animation
    // object each time; keep only the newest one instead of a growing list.
    for (const [otherId, e] of entries) {
      if (e.ended && e.spec.kind === spec.kind && e.spec.selector === spec.selector && e.spec.name === spec.name) {
        entries.delete(otherId);
      }
    }
    const scrollLinked = isScrollLinked(a);
    entries.set(id, { id, anim: a, target, spec, firstSeen: performance.now(), ended: false, scrollLinked });
    if (scrollLinked) return;
    if (rate !== 1) a.updatePlaybackRate(rate);
    if (paused && a.playState === 'running') {
      a.pause();
      pausedByUs.add(a);
    }
    trim();
  }

  function trim() {
    if (entries.size <= MAX_ENTRIES) return;
    for (const [id, e] of entries) {
      if (entries.size <= MAX_ENTRIES) break;
      if (e.ended) {
        entries.delete(id);
        if (e.anim) pausedByUs.delete(e.anim);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Reading GSAP                                                        */
  /* ------------------------------------------------------------------ */

  function plainVars(vars: Record<string, unknown> | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    if (!vars) return out;
    for (const [k, v] of Object.entries(vars)) {
      if (GSAP_SPECIAL.has(k)) continue;
      if (typeof v === 'number' || typeof v === 'string') out[k] = String(v);
    }
    return out;
  }

  function gsapSpec(t: GsapAnimation, id: string, g: Gsap): AnimationSpec {
    const targets = (t.targets?.() ?? []).filter((x): x is Element => x instanceof Element);
    const first = targets[0] ?? null;
    const vars = plainVars(t.vars);
    const startAt = t.vars.startAt as Record<string, unknown> | undefined;
    const fromVars = startAt ? plainVars(startAt) : undefined;
    const rawEase = t.vars.ease ?? g.defaults().ease ?? 'power1.out';
    const easeName = typeof rawEase === 'string' ? rawEase : 'custom';
    const fn = g.parseEase(rawEase) ?? ((p: number) => p);
    const easeSamples = Array.from({ length: 101 }, (_, i) => Number(fn(i / 100).toFixed(5)));
    const repeat = t.repeat();
    const toCss = gsapPropsToCss(vars);
    const keyframes: Keyframe[] = fromVars
      ? [
          { offset: 0, easing: 'linear', props: gsapPropsToCss(fromVars) },
          { offset: 1, easing: 'linear', props: toCss },
        ]
      : [{ offset: 1, easing: 'linear', props: toCss }];
    const hasId = typeof t.vars.id === 'string';
    const name = hasId ? (t.vars.id as string) : Object.keys(vars).slice(0, 3).join(', ') || 'tween';
    const inTimeline = !!t.parent && t.parent !== g.globalTimeline;
    return {
      id,
      kind: 'gsap',
      name: targets.length > 1 ? `${name} ×${targets.length}` : name,
      ...(hasId ? {} : { nameIsGenerated: true }),
      selector: first ? uniqueSelector(first) : '(non-element target)',
      label: first ? (targets.length > 1 ? `${elementLabel(first)} +${targets.length - 1}` : elementLabel(first)) : '(non-element target)',
      duration: t.duration() * 1000,
      delay: t.delay() * 1000,
      endDelay: 0,
      iterations: repeat < 0 ? 'infinite' : repeat + 1,
      direction: t.yoyo() ? 'alternate' : 'normal',
      fill: 'both',
      easing: gsapEaseToCss(easeName === 'custom' ? '' : easeName, easeSamples),
      keyframes,
      properties: Object.keys(toCss),
      gsap: {
        easeName,
        easeSamples,
        yoyo: t.yoyo(),
        repeatDelay: t.repeatDelay(),
        vars,
        ...(fromVars ? { fromVars } : {}),
        ...(inTimeline && t.startTime ? { timelinePosition: t.startTime() } : {}),
      },
    };
  }

  function collectGsap(seen: Set<string>) {
    const g = gsap();
    if (!g) return;
    let tweens: GsapAnimation[] = [];
    try {
      tweens = g.globalTimeline.getChildren(true, true, false);
    } catch {
      return;
    }
    for (const t of tweens) {
      let id = tweenIds.get(t);
      if (!id) {
        id = `g${++counter}`;
        tweenIds.set(t, id);
        const first = (t.targets?.() ?? []).find((x): x is Element => x instanceof Element) ?? null;
        entries.set(id, {
          id,
          tween: t,
          target: first,
          spec: gsapSpec(t, id, g),
          firstSeen: performance.now(),
          ended: false,
          scrollLinked: false,
        });
      }
      seen.add(id);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Collection                                                          */
  /* ------------------------------------------------------------------ */

  function collect() {
    const seen = new Set<string>();
    for (const a of document.getAnimations()) {
      register(a);
      const id = animIds.get(a);
      if (id) seen.add(id);
    }
    collectGsap(seen);
    for (const e of entries.values()) {
      if (!seen.has(e.id) && !e.ended) {
        e.ended = true;
        if (e.anim) pausedByUs.delete(e.anim);
      }
      // A finished CSS transition can come back (hover again) on the same object.
      if (seen.has(e.id) && e.ended) e.ended = false;
    }
  }

  function liveState(e: Entry): LiveState {
    if (e.anim) {
      const a = e.anim;
      const ct = a.currentTime;
      const timing = a.effect?.getComputedTiming();
      return {
        playState: a.playState,
        currentTime: typeof ct === 'number' ? ct : ct == null ? null : Number((ct as CSSNumericValue).to?.('percent')?.value ?? 0),
        progress: timing?.progress ?? null,
        playbackRate: a.playbackRate,
        ended: e.ended,
        scrollLinked: e.scrollLinked,
      };
    }
    const t = e.tween!;
    const g = gsap();
    const globalPaused = !!g?.globalTimeline.paused();
    const topLevel = !t.parent || t.parent === g?.globalTimeline;
    return {
      playState: e.ended ? 'finished' : globalPaused || t.paused() ? 'paused' : t.isActive() ? 'running' : 'idle',
      currentTime: t.totalTime() * 1000 + (topLevel ? t.delay() * 1000 : 0),
      progress: t.progress(),
      playbackRate: g ? g.globalTimeline.timeScale() : 1,
      ended: e.ended,
      scrollLinked: false,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Controls                                                            */
  /* ------------------------------------------------------------------ */

  const live = () => [...entries.values()].filter((e) => !e.ended && !e.scrollLinked);

  function pauseAll() {
    paused = true;
    for (const e of live()) {
      const a = e.anim;
      if (a && a.playState === 'running') {
        a.pause();
        pausedByUs.add(a);
      }
    }
    const g = gsap();
    if (g && !g.globalTimeline.paused()) {
      g.globalTimeline.pause();
      gsapPausedByUs = true;
    }
    return true;
  }

  function playAll() {
    paused = false;
    scrubTime = null;
    for (const a of pausedByUs) {
      if (a.playState === 'paused') a.play();
    }
    pausedByUs.clear();
    const g = gsap();
    if (g && gsapPausedByUs) {
      g.globalTimeline.resume();
      gsapPausedByUs = false;
    }
    return true;
  }

  function endTimeOf(a: Animation) {
    const end = a.effect?.getComputedTiming().endTime;
    return typeof end === 'number' ? end : Number(end ?? Infinity);
  }

  function scrub(t: number) {
    collect();
    pauseAll();
    scrubTime = t;
    for (const e of live()) {
      if (e.anim) {
        if (e.anim.playState !== 'paused') {
          e.anim.pause();
          pausedByUs.add(e.anim);
        }
        e.anim.currentTime = Math.min(t, endTimeOf(e.anim));
      }
    }
    const g = gsap();
    if (g) {
      for (const child of g.globalTimeline.getChildren(false, true, true)) {
        const local = t / 1000 - child.delay();
        child.totalTime(Math.max(0, Math.min(local, child.totalDuration())), true);
      }
    }
    return true;
  }

  function scrubOne(id: string, t: number) {
    const e = entries.get(id);
    if (!e || e.ended || e.scrollLinked) return false;
    if (e.anim) {
      if (e.anim.playState !== 'paused') {
        e.anim.pause();
        pausedByUs.add(e.anim);
      }
      e.anim.currentTime = Math.min(t, endTimeOf(e.anim));
    } else if (e.tween) {
      const g = gsap();
      if (g && !g.globalTimeline.paused()) {
        g.globalTimeline.pause();
        gsapPausedByUs = true;
      }
      const local = t / 1000 - (e.tween.parent === g?.globalTimeline ? e.tween.delay() : 0);
      e.tween.totalTime(Math.max(0, Math.min(local, e.tween.totalDuration())), true);
    }
    return true;
  }

  function setRate(r: number) {
    rate = r;
    for (const e of live()) e.anim?.updatePlaybackRate(r);
    gsap()?.globalTimeline.timeScale(r);
    return true;
  }

  function restart() {
    collect();
    const wasPaused = paused;
    for (const e of live()) {
      if (!e.anim) continue;
      e.anim.currentTime = 0;
      if (!wasPaused && e.anim.playState !== 'running') e.anim.play();
    }
    const g = gsap();
    if (g) for (const child of g.globalTimeline.getChildren(false, true, true)) child.totalTime(0, true);
    scrubTime = wasPaused ? 0 : null;
    return true;
  }

  function reset() {
    playAll();
    setRate(1);
    select(null);
    host.remove();
    return true;
  }

  function scrubEnd() {
    let end = 0;
    for (const e of live()) {
      const s = e.spec;
      const iterations = s.iterations === 'infinite' ? 1 : s.iterations;
      end = Math.max(end, s.delay + s.duration * iterations + Math.max(0, s.endDelay));
    }
    return Math.round(Math.min(20000, Math.max(100, end)));
  }

  /* ------------------------------------------------------------------ */
  /* JS-driven detection                                                 */
  /* ------------------------------------------------------------------ */

  const styleChanges = new Map<Element, { count: number; props: Set<string> }>();
  let jsDriven: JsDrivenEntry[] = [];
  const jsIds = new WeakMap<Element, string>();

  function parseInline(s: string | null): Map<string, string> {
    const m = new Map<string, string>();
    for (const part of (s ?? '').split(';')) {
      const i = part.indexOf(':');
      if (i > 0) m.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
    return m;
  }

  const observer = new MutationObserver((records) => {
    for (const r of records) {
      const el = r.target as Element;
      if (isOurs(el)) continue;
      let rec = styleChanges.get(el);
      if (!rec) styleChanges.set(el, (rec = { count: 0, props: new Set() }));
      rec.count++;
      if (rec.props.size < 6) {
        const before = parseInline(r.oldValue);
        const after = parseInline(el.getAttribute('style'));
        for (const [k, v] of after) if (before.get(k) !== v) rec.props.add(k);
      }
    }
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
    attributeOldValue: true,
    subtree: true,
  });

  const WINDOW_MS = 1000;
  const sampler = setInterval(() => {
    const g = gsap();
    const gsapTargets = new Set<Element>();
    if (g) {
      try {
        for (const t of g.globalTimeline.getChildren(true, true, false)) {
          for (const x of t.targets?.() ?? []) if (x instanceof Element) gsapTargets.add(x);
        }
      } catch {
        /* ignore */
      }
    }
    const next: JsDrivenEntry[] = [];
    for (const [el, rec] of styleChanges) {
      const perSecond = (rec.count * 1000) / WINDOW_MS;
      if (perSecond < 8 || !el.isConnected || gsapTargets.has(el)) continue;
      let id = jsIds.get(el);
      if (!id) jsIds.set(el, (id = `j${++counter}`));
      next.push({ id, selector: uniqueSelector(el), label: elementLabel(el), rate: Math.round(perSecond), properties: [...rec.props] });
    }
    jsDriven = next.sort((a, b) => b.rate - a.rate).slice(0, 20);
    styleChanges.clear();
  }, WINDOW_MS);

  /* ------------------------------------------------------------------ */
  /* Catch short-lived animations the moment they start                  */
  /* ------------------------------------------------------------------ */

  const onStart = () => collect();
  for (const type of ['animationstart', 'transitionrun', 'transitionstart']) {
    document.addEventListener(type, onStart, true);
  }

  const proto = Element.prototype as Element & { __miAnimate?: Element['animate'] };
  if (!proto.__miAnimate) {
    const original = Element.prototype.animate;
    proto.__miAnimate = original;
    Element.prototype.animate = function (this: Element, ...args: Parameters<Element['animate']>) {
      const a = original.apply(this, args);
      const agent = w[AGENT_GLOBAL] as { onAnimate?: (a: Animation) => void } | undefined;
      try {
        agent?.onAnimate?.(a);
      } catch {
        /* never break the page */
      }
      return a;
    };
  }

  /* ------------------------------------------------------------------ */
  /* Public surface                                                      */
  /* ------------------------------------------------------------------ */

  function ordered(): Entry[] {
    collect();
    return [...entries.values()].sort((a, b) => Number(a.ended) - Number(b.ended) || a.firstSeen - b.firstSeen);
  }

  function snapshot(): AgentSnapshot {
    const list: AnimationEntry[] = ordered().map((e) => ({ spec: e.spec, live: liveState(e) }));
    return {
      version: AGENT_VERSION,
      url: location.href,
      paused,
      rate,
      scrubEnd: scrubEnd(),
      scrubTime,
      gsapDetected: !!gsap(),
      animations: list,
      jsDriven,
    };
  }

  /**
   * What the panel polls: specs are static, so only the ones it hasn't seen
   * are sent; everything else is live state keyed by id.
   */
  function poll(knownSession: string | null, known: string[]): AgentPoll {
    const have = knownSession === session ? new Set(known) : new Set<string>();
    const list = ordered();
    return {
      version: AGENT_VERSION,
      session,
      url: location.href,
      paused,
      rate,
      scrubEnd: scrubEnd(),
      scrubTime,
      gsapDetected: !!gsap(),
      order: list.map((e) => e.id),
      live: list.map((e) => liveState(e)),
      specs: list.filter((e) => !have.has(e.id)).map((e) => e.spec),
      jsDriven,
    };
  }

  /** Raw page values for tests: currentTime/playbackRate of every live animation. */
  function probe() {
    const g = gsap();
    return {
      animations: live()
        .filter((e) => e.anim)
        .map((e) => ({
          id: e.id,
          name: e.spec.name,
          kind: e.spec.kind,
          currentTime: e.anim!.currentTime as number | null,
          playState: e.anim!.playState,
          playbackRate: e.anim!.playbackRate,
        })),
      gsap: g
        ? {
            paused: g.globalTimeline.paused(),
            timeScale: g.globalTimeline.timeScale(),
            times: g.globalTimeline.getChildren(false, true, true).map((c) => c.totalTime() * 1000),
          }
        : null,
    };
  }

  function dispose() {
    reset();
    observer.disconnect();
    clearInterval(sampler);
    for (const type of ['animationstart', 'transitionrun', 'transitionstart']) {
      document.removeEventListener(type, onStart, true);
    }
    delete w[AGENT_GLOBAL];
    return true;
  }

  w[AGENT_GLOBAL] = {
    version: AGENT_VERSION,
    onAnimate: (a: Animation) => queueMicrotask(() => register(a)),
    snapshot,
    poll,
    pause: pauseAll,
    play: playAll,
    scrub,
    scrubOne,
    setRate,
    restart,
    select,
    reset,
    probe,
    dispose,
  };

  collect();
});
