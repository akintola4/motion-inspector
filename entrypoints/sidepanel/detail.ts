import type { AnimationEntry, AnimationSpec } from '../../lib/types';
import { iterationCurve, iterationProgress, oneScrub, type OneScrub } from '../../lib/timing';
import { summarizeEasing } from '../../lib/export/shared';
import { toCss, toGsap, toLinearExport, toMotion } from '../../lib/export';
import { camelToKebab } from '../../lib/css-props';
import { tidyEasing } from '../../lib/easing';
import { clear, h, setAttr, setText } from './h';
import { bigCurve, type BigCurve } from './curve';
import { icons } from './icons';
import { highlight } from './code';
import { KIND_LABEL, fmtDur, stateText } from './list';
import type { DetailFactory, DetailScrubber } from './transport/types';

export type ExportTab = 'css' | 'linear' | 'motion' | 'gsap';

const TABS: { id: ExportTab; label: string; fn: (s: AnimationSpec) => string }[] = [
  { id: 'css', label: 'CSS', fn: toCss },
  { id: 'linear', label: 'linear()', fn: toLinearExport },
  { id: 'motion', label: 'Motion', fn: toMotion },
  { id: 'gsap', label: 'GSAP', fn: toGsap },
];

export interface DetailCallbacks {
  onBack(): void;
  onScrub(id: string, t: number): void;
  /** The current transport option's detail scrubber. */
  scrubber(): DetailFactory;
  getTab(): ExportTab;
  setTab(tab: ExportTab): void;
}

export interface DetailContext {
  /** Other elements running the identical animation. */
  siblings: number;
  paused: boolean;
}

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API can be blocked when the panel isn't focused.
    const ta = h('textarea', {});
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

/**
 * A copy button that confirms for a moment, then resets. Only the icon and
 * colour change (copy → check, green): the label stays "Copy" so the button
 * keeps its width. The word "Copied" goes to screen readers and the tooltip.
 */
function copyButton(getText: () => string, label: string, withText: boolean) {
  const icon = h('span', { class: 'copy-icon', html: icons.copy });
  const said = h('span', { class: 'sr-only', role: 'status' });
  const btn = h('button', { class: withText ? 'btn btn-ghost copy' : 'icon-btn copy', type: 'button', 'aria-label': label, title: label }, icon, withText ? h('span', {}, 'Copy') : null, said);
  const show = (done: boolean) => {
    icon.innerHTML = done ? icons.check : icons.copy;
    said.textContent = done ? 'Copied' : '';
    btn.title = done ? 'Copied' : label;
    btn.classList.toggle('is-done', done);
  };
  let timer = 0;
  btn.addEventListener('click', async () => {
    await copyText(getText());
    show(true);
    clearTimeout(timer);
    timer = window.setTimeout(() => show(false), 1200);
  });
  return btn;
}

export function createDetail(root: HTMLElement, cb: DetailCallbacks) {
  let currentId: string | null = null;
  let curve: BigCurve | null = null;
  let scrubber: DetailScrubber | null = null;
  /** Model frozen for the current drag / key presses; cleared on each poll. */
  let dragModel: OneScrub | null = null;
  let stateEl: HTMLElement | null = null;
  let siblingsEl: HTMLElement | null = null;
  let scrollEl: HTMLElement | null = null;
  let spec: AnimationSpec | null = null;
  let model: OneScrub | null = null;

  /* Playhead interpolation between polls, so the dot glides instead of
     jumping every 250 ms. Off under reduced motion. */
  let sample: { t: number; at: number; rate: number; running: boolean } | null = null;
  let raf = 0;
  function tick() {
    raf = 0;
    if (!spec || !sample || !sample.running || scrubber?.dragging || root.hidden) return;
    const elapsed = Math.min(600, performance.now() - sample.at);
    const t = sample.t + elapsed * sample.rate;
    curve?.setProgress(iterationProgress(spec, t));
    scrubber?.glide(oneScrub(spec, t).value);
    raf = requestAnimationFrame(tick);
  }

  function build(entry: AnimationEntry) {
    spec = entry.spec;
    const s = spec;
    clear(root);
    const ease = summarizeEasing(s);
    curve = bigCurve(iterationCurve(s), s.keyframes.map((k) => k.offset));

    // The scrubber maps its value with the model from when the drag started,
    // so an iteration rolling over mid-drag doesn't move the range.
    scrubber = cb.scrubber()({
      spec: s,
      onScrub(v) {
        dragModel ??= model;
        if (!dragModel) return;
        const t = dragModel.toTime(v);
        // Move the curve's playhead with the scrubber now, not on the next poll.
        curve?.setProgress(iterationProgress(s, t));
        cb.onScrub(s.id, t);
      },
    });
    stateEl = h('span', { class: 'row-state' });
    siblingsEl = h('p', { class: 'note' });

    const iterations = s.iterations === 'infinite' ? '∞' : String(s.iterations);
    const facts: [string, string][] = [
      ['Duration', fmtDur(s.duration)],
      ['Delay', fmtDur(s.delay)],
      ['Iterations', iterations],
      ['Direction', s.direction],
      ['Fill', s.fill],
      ['End delay', fmtDur(s.endDelay)],
    ];

    const codeEl = h('code', {});
    const pre = h('pre', { class: 'code', tabindex: '0' }, codeEl);
    let code = '';
    // Every format is generated once per drill-in; tab clicks only swap text.
    const codes = new Map<ExportTab, string>();
    for (const t of TABS) {
      try {
        codes.set(t.id, t.fn(s));
      } catch (err) {
        codes.set(t.id, `/* couldn't generate ${t.label}: ${(err as Error).message} */`);
      }
    }
    const tabButtons = TABS.map((t) =>
      h(
        'button',
        {
          class: 'seg-btn',
          type: 'button',
          role: 'tab',
          dataset: { tab: t.id },
          onclick: () => {
            cb.setTab(t.id);
            showTab();
          },
        },
        t.label,
      ),
    );
    function showTab() {
      const tab = cb.getTab();
      for (const b of tabButtons) {
        const on = b.dataset.tab === tab;
        b.classList.toggle('is-on', on);
        setAttr(b, 'aria-selected', String(on));
      }
      const t = TABS.find((x) => x.id === tab) ?? TABS[0]!;
      code = codes.get(t.id)!;
      codeEl.innerHTML = highlight(code);
      pre.scrollTop = 0;
      pre.scrollLeft = 0;
    }
    /* Size the block to the tallest format (capped by max-height), so
       switching tabs never moves the Keyframes section or the page. */
    function lockHeight() {
      let max = 0;
      for (const t of TABS) {
        codeEl.innerHTML = highlight(codes.get(t.id)!);
        max = Math.max(max, pre.offsetHeight);
      }
      pre.style.minHeight = `${max}px`;
    }

    const easeNote =
      ease.source === 'per-keyframe'
        ? 'Easing per keyframe · curve shows the whole iteration'
        : ease.source === 'keyframes'
          ? 'Easing on keyframes'
          : s.kind === 'gsap'
            ? `GSAP ease “${s.gsap?.easeName ?? ''}”`
            : 'Easing';

    const back = h(
      'button',
      { class: 'back', type: 'button', 'aria-label': 'Back to animations', title: 'Back (Esc)', onclick: cb.onBack },
      h('span', { html: icons.back }),
      'Animations',
    );

    scrollEl = h(
      'div',
      { class: 'detail-scroll' },
      h(
        'header',
        { class: 'detail-head' },
        h('h2', {}, s.name),
        h('p', { class: 'detail-label' }, s.label, stateEl),
      ),
      h(
        'section',
        { class: 'card curve-card' },
        curve.root,
        h(
          'div',
          { class: 'ease-row' },
          h('span', { class: 'label' }, easeNote),
          h('code', { class: 'ease-text', title: tidyEasing(ease.css) }, ease.source === 'per-keyframe' ? 'per keyframe' : tidyEasing(ease.css)),
        ),
        scrubber.el,
      ),
      h('dl', { class: 'facts' }, ...facts.map(([k, v]) => h('div', { class: 'fact' }, h('dt', {}, k), h('dd', {}, v)))),
      h(
        'section',
        { class: 'section' },
        h('div', { class: 'section-head' }, h('h3', { class: 'label' }, 'Target'), copyButton(() => s.selector, 'Copy selector', false)),
        h('code', { class: 'selector' }, s.selector),
        siblingsEl,
      ),
      h(
        'section',
        { class: 'section export' },
        h('div', { class: 'section-head' }, h('h3', { class: 'label' }, 'Export')),
        h(
          'div',
          { class: 'export-bar' },
          h('div', { class: 'seg', role: 'tablist', 'aria-label': 'Export format' }, ...tabButtons),
          copyButton(() => code, 'Copy code', true),
        ),
        pre,
      ),
      h(
        'section',
        { class: 'section keyframes' },
        h('div', { class: 'section-head' }, h('h3', { class: 'label' }, 'Keyframes'), h('span', { class: 'section-note' }, s.properties.map(camelToKebab).join(', '))),
        h(
          'div',
          { class: 'kf-table' },
          ...s.keyframes.map((k, i) =>
            h(
              'div',
              { class: 'kf' },
              h('span', { class: 'kf-offset' }, `${Number((k.offset * 100).toFixed(1))}%`),
              h(
                'span',
                { class: 'kf-props' },
                ...Object.entries(k.props).map(([p, v]) => h('span', {}, h('span', { class: 'kf-prop' }, `${camelToKebab(p)}: `), v)),
                i < s.keyframes.length - 1 && k.easing !== 'linear'
                  ? h('span', { class: 'kf-ease' }, h('span', { class: 'kf-prop' }, 'easing: '), tidyEasing(k.easing))
                  : null,
              ),
            ),
          ),
        ),
      ),
    );

    root.append(
      h('div', { class: 'detail-bar' }, back, h('span', { class: 'kind', dataset: { kind: s.kind } }, KIND_LABEL[s.kind])),
      scrollEl,
    );
    lockHeight();
    showTab();
  }

  function render(entry: AnimationEntry | null, ctx: DetailContext) {
    if (!entry) {
      if (currentId == null && root.hidden) return;
      currentId = null;
      spec = null;
      sample = null;
      root.hidden = true;
      clear(root);
      return;
    }
    if (root.hidden) root.hidden = false;
    const fresh = entry.spec.id !== currentId;
    if (fresh) {
      currentId = entry.spec.id;
      build(entry);
    }
    const { live } = entry;
    const s = entry.spec;
    const disabled = live.ended || live.scrollLinked;
    if (stateEl) {
      const text = stateText(entry, ctx.paused);
      setText(stateEl, text);
      if (stateEl.hidden !== !text) stateEl.hidden = !text;
    }
    if (siblingsEl) {
      setText(siblingsEl, ctx.siblings ? `Same animation on ${ctx.siblings} other element${ctx.siblings === 1 ? '' : 's'}.` : '');
      if (siblingsEl.hidden !== !ctx.siblings) siblingsEl.hidden = !ctx.siblings;
    }
    if (!scrubber?.dragging) {
      const m = oneScrub(s, live.currentTime);
      model = m;
      dragModel = null;
      scrubber?.update({
        max: m.max,
        value: m.value,
        label: m.label,
        word: live.scrollLinked ? 'Scroll-linked' : live.ended ? 'Ended' : null,
        disabled,
        toTime: (v) => m.toTime(v),
      });
      curve?.setProgress(iterationProgress(s, live.currentTime));
    }
    const running = live.playState === 'running' && !disabled && live.currentTime != null;
    sample = running ? { t: live.currentTime!, at: performance.now(), rate: live.playbackRate, running } : null;
    if (running && !reducedMotion.matches && !raf) raf = requestAnimationFrame(tick);
    if (fresh && scrollEl) scrollEl.scrollTop = 0;
  }

  return {
    render,
    /** Rebuild with the current transport option's scrubber on the next render. */
    rebuild() {
      currentId = null;
    },
    get id() {
      return currentId;
    },
  };
}
