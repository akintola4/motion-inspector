import type { AnimationEntry, AnimationSpec } from '../../lib/types';
import { iterationCurve, iterationProgress, scrubLength } from '../../lib/timing';
import { fmtTime, summarizeEasing } from '../../lib/export/shared';
import { toCss, toGsap, toLinearExport, toMotion } from '../../lib/export';
import { camelToKebab } from '../../lib/css-props';
import { tidyEasing } from '../../lib/easing';
import { clear, h } from './h';
import { bigCurve, type BigCurve } from './curve';
import { icons } from './icons';
import { highlight } from './code';
import { KIND_LABEL } from './list';

export type ExportTab = 'css' | 'linear' | 'motion' | 'gsap';

const TABS: { id: ExportTab; label: string; fn: (s: AnimationSpec) => string }[] = [
  { id: 'css', label: 'CSS', fn: toCss },
  { id: 'linear', label: 'linear()', fn: toLinearExport },
  { id: 'motion', label: 'Motion', fn: toMotion },
  { id: 'gsap', label: 'GSAP', fn: toGsap },
];

export interface DetailCallbacks {
  onClose(): void;
  onScrub(id: string, t: number): void;
  getTab(): ExportTab;
  setTab(tab: ExportTab): void;
}

export function createDetail(root: HTMLElement, cb: DetailCallbacks) {
  let currentId: string | null = null;
  let curve: BigCurve | null = null;
  let slider: HTMLInputElement | null = null;
  let timeOut: HTMLElement | null = null;
  let dragging = false;
  let spec: AnimationSpec | null = null;

  function build(entry: AnimationEntry) {
    spec = entry.spec;
    const s = spec;
    clear(root);
    root.scrollTop = 0;
    const ease = summarizeEasing(s);
    const curveFn = iterationCurve(s);
    curve = bigCurve(curveFn, s.keyframes.map((k) => k.offset));

    const length = Math.max(1, scrubLength(s));
    slider = h('input', {
      type: 'range',
      min: '0',
      max: String(Math.round(length)),
      step: '1',
      class: 'slider',
      'aria-label': 'Scrub this animation',
    });
    slider.addEventListener('pointerdown', () => (dragging = true));
    slider.addEventListener('pointerup', () => (dragging = false));
    slider.addEventListener('input', () => {
      cb.onScrub(s.id, Number(slider!.value));
      if (timeOut) timeOut.textContent = `${Math.round(Number(slider!.value))} / ${Math.round(length)} ms`;
    });
    timeOut = h('span', { class: 'time mono' });

    const iterations = s.iterations === 'infinite' ? '∞' : String(s.iterations);
    const facts: [string, string][] = [
      ['Duration', fmtTime(s.duration)],
      ['Delay', fmtTime(s.delay)],
      ['Iterations', iterations],
      ['Direction', s.direction],
      ['Fill', s.fill],
      ['End delay', fmtTime(s.endDelay)],
    ];

    const codeEl = h('code', {});
    const pre = h('pre', { class: 'code' }, codeEl);
    const copyBtn = h('button', { class: 'btn btn-ghost copy', 'aria-label': 'Copy code', html: icons.copy });
    const copyLabel = h('span', {}, 'Copy');
    copyBtn.append(copyLabel);
    const tabButtons = TABS.map((t) =>
      h(
        'button',
        {
          class: 'seg-btn',
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
    let code = '';
    function showTab() {
      const tab = cb.getTab();
      for (const b of tabButtons) {
        const on = b.dataset.tab === tab;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-selected', String(on));
      }
      const t = TABS.find((x) => x.id === tab) ?? TABS[0]!;
      try {
        code = t.fn(s);
      } catch (err) {
        code = `/* couldn't generate ${t.label}: ${(err as Error).message} */`;
      }
      codeEl.innerHTML = highlight(code);
      pre.scrollTop = 0;
    }
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(code);
      } catch {
        // Clipboard API can be blocked when the panel isn't focused.
        const ta = h('textarea', {});
        ta.value = code;
        document.body.append(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      copyBtn.innerHTML = icons.check;
      copyBtn.append(h('span', {}, 'Copied'));
      copyBtn.classList.add('is-done');
      setTimeout(() => {
        copyBtn.innerHTML = icons.copy;
        copyBtn.append(h('span', {}, 'Copy'));
        copyBtn.classList.remove('is-done');
      }, 1200);
    });

    const easeNote =
      ease.source === 'per-keyframe'
        ? 'Easing per keyframe — curve shows the whole iteration'
        : ease.source === 'keyframes'
          ? 'Easing set on keyframes'
          : s.kind === 'gsap'
            ? `GSAP ease “${s.gsap?.easeName ?? ''}”`
            : 'Effect easing';

    root.append(
      h(
        'div',
        { class: 'detail-head' },
        h(
          'div',
          { class: 'detail-title' },
          h('span', { class: 'kind', dataset: { kind: s.kind } }, KIND_LABEL[s.kind]),
          h('h2', {}, s.name),
          h('div', { class: 'detail-sel mono' }, s.selector),
        ),
        h('button', { class: 'icon-btn', 'aria-label': 'Close details', html: icons.close, onclick: cb.onClose }),
      ),
      h(
        'section',
        { class: 'card' },
        curve.root,
        h('div', { class: 'ease-note' }, easeNote),
        h('div', { class: 'ease-text mono', title: tidyEasing(ease.css) }, ease.source === 'per-keyframe' ? 'per keyframe' : tidyEasing(ease.css)),
      ),
      h('section', { class: 'scrub-one' }, slider, timeOut),
      h(
        'dl',
        { class: 'facts' },
        ...facts.map(([k, v]) => h('div', { class: 'fact' }, h('dt', {}, k), h('dd', { class: 'mono' }, v))),
      ),
      h(
        'section',
        { class: 'export' },
        h('div', { class: 'export-bar' }, h('div', { class: 'seg', role: 'tablist', 'aria-label': 'Export format' }, ...tabButtons), copyBtn),
        pre,
      ),
      h(
        'section',
        { class: 'keyframes' },
        h('div', { class: 'section-label' }, `Keyframes · ${s.properties.map(camelToKebab).join(', ')}`),
        ...s.keyframes.map((k, i) =>
          h(
            'div',
            { class: 'kf' },
            h('span', { class: 'kf-offset mono' }, `${Number((k.offset * 100).toFixed(1))}%`),
            h(
              'span',
              { class: 'kf-props mono' },
              ...Object.entries(k.props).map(([p, v]) => h('span', {}, h('span', { class: 'muted' }, `${camelToKebab(p)}: `), v)),
              i < s.keyframes.length - 1 && k.easing !== 'linear'
                ? h('span', { class: 'kf-ease' }, h('span', { class: 'muted' }, 'easing: '), tidyEasing(k.easing))
                : null,
            ),
          ),
        ),
      ),
    );
    showTab();
  }

  function render(entry: AnimationEntry | null) {
    if (!entry) {
      currentId = null;
      root.hidden = true;
      clear(root);
      return;
    }
    root.hidden = false;
    if (entry.spec.id !== currentId) {
      currentId = entry.spec.id;
      build(entry);
    }
    const { live } = entry;
    curve?.setProgress(iterationProgress(entry.spec, live.currentTime));
    const length = Math.round(Math.max(1, scrubLength(entry.spec)));
    const disabled = live.ended || live.scrollLinked;
    if (slider) {
      slider.disabled = disabled;
      if (!dragging && live.currentTime != null) slider.value = String(Math.min(length, Math.max(0, live.currentTime)));
    }
    if (timeOut && !dragging) {
      timeOut.textContent = disabled
        ? live.scrollLinked
          ? 'scroll-linked'
          : 'ended'
        : `${live.currentTime == null ? '–' : Math.round(live.currentTime)} / ${length} ms`;
    }
  }

  return { render, get spec() { return spec; } };
}
