import './style.css';
import type { AgentSnapshot } from '../../lib/types';
import { iterationProgress } from '../../lib/timing';
import { h } from './h';
import { icons } from './icons';
import { setupTheme } from './theme';
import { RestrictedPageError, TabBridge, isRestrictedUrl } from './bridge';
import { createList } from './list';
import { createDetail, type ExportTab } from './detail';

const POLL_MS = 250;
const RATES = [0.1, 0.25, 0.5, 1];

/* ------------------------------------------------------------------------ */
/* State                                                                    */
/* ------------------------------------------------------------------------ */

const params = new URLSearchParams(location.search);
const pinnedTab = params.has('tabId') ? Number(params.get('tabId')) : null;

let bridge: TabBridge | null = null;
let snap: AgentSnapshot | null = null;
let selectedId: string | null = null;
let exportTab: ExportTab = 'css';
let status: 'loading' | 'ready' | 'restricted' | 'error' = 'loading';
let errorText = '';
let inFlight = false;
let draggingGlobal = false;
let pendingScrub: number | null = null;

const port = chrome.runtime.connect({ name: 'panel' });

/* ------------------------------------------------------------------------ */
/* DOM                                                                      */
/* ------------------------------------------------------------------------ */

const app = document.getElementById('app')!;
const themeBtn = h('button', { class: 'icon-btn', type: 'button' });
const hostEl = h('span', { class: 'host mono' }, '');

const playBtn = h('button', { class: 'btn btn-primary play', type: 'button', 'aria-label': 'Pause all' });
const restartBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Restart all', title: 'Restart all', html: icons.restart });
const scrub = h('input', { type: 'range', min: '0', max: '1000', step: '1', value: '0', class: 'slider', 'aria-label': 'Scrub all animations' });
const timeEl = h('span', { class: 'time mono' }, '0 ms');
const rateBtns = RATES.map((r) =>
  h('button', { class: 'seg-btn', type: 'button', dataset: { rate: String(r) }, onclick: () => setRate(r) }, `${r}×`),
);
const countEl = h('span', { class: 'count' });

const listRoot = h('div', { class: 'list' });
const detailRoot = h('div', { class: 'detail', hidden: true });
const stateRoot = h('div', { class: 'state' });

app.append(
  h(
    'header',
    { class: 'top' },
    h('span', { class: 'brand', html: icons.mark }),
    h('span', { class: 'brand-text' }, h('strong', {}, 'Motion Inspector'), hostEl),
    themeBtn,
  ),
  h(
    'section',
    { class: 'transport' },
    h('div', { class: 'transport-row' }, playBtn, restartBtn, scrub, timeEl),
    h(
      'div',
      { class: 'transport-row' },
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Playback rate' }, ...rateBtns),
      countEl,
    ),
  ),
  h('main', { class: 'body' }, stateRoot, listRoot, detailRoot),
);

setupTheme(themeBtn);

const list = createList(listRoot, (id) => select(id === selectedId ? null : id));
const detail = createDetail(detailRoot, {
  onClose: () => select(null),
  onScrub: (id, t) => void call('scrubOne', id, t).then(poll),
  getTab: () => exportTab,
  setTab: (t) => (exportTab = t),
});

/* ------------------------------------------------------------------------ */
/* Agent calls                                                              */
/* ------------------------------------------------------------------------ */

async function call<T>(method: Parameters<TabBridge['call']>[0], ...args: unknown[]): Promise<T | undefined> {
  if (!bridge) return undefined;
  try {
    return await bridge.call<T>(method, ...args);
  } catch (err) {
    handleError(err);
    return undefined;
  }
}

function handleError(err: unknown) {
  if (err instanceof RestrictedPageError) {
    status = 'restricted';
  } else {
    const msg = err instanceof Error ? err.message : String(err);
    // Tab closed / navigating mid-call: the next poll recovers.
    if (/No tab with id|Frame with ID|was removed|navigat/i.test(msg)) return;
    status = 'error';
    errorText = msg;
  }
  render();
}

async function poll() {
  if (!bridge || inFlight || document.visibilityState === 'hidden') return;
  inFlight = true;
  try {
    const s = await bridge.call<AgentSnapshot>('snapshot');
    snap = s;
    status = 'ready';
  } catch (err) {
    handleError(err);
  } finally {
    inFlight = false;
  }
  render();
}

async function togglePlay() {
  if (!snap) return;
  await call(snap.paused ? 'play' : 'pause');
  await poll();
}

async function setRate(r: number) {
  await call('setRate', r);
  await poll();
}

async function select(id: string | null) {
  selectedId = id;
  render();
  await call('select', id);
}

/* Global scrub: coalesce input events to one agent call per frame. */
function flushScrub() {
  if (pendingScrub == null) return;
  const t = pendingScrub;
  pendingScrub = null;
  void call('scrub', t).then(() => {
    if (pendingScrub != null) requestAnimationFrame(flushScrub);
    else void poll();
  });
}
scrub.addEventListener('pointerdown', () => (draggingGlobal = true));
window.addEventListener('pointerup', () => (draggingGlobal = false));
scrub.addEventListener('input', () => {
  const first = pendingScrub == null;
  pendingScrub = Number(scrub.value);
  timeEl.textContent = `${pendingScrub} ms`;
  if (first) requestAnimationFrame(flushScrub);
});
playBtn.addEventListener('click', togglePlay);
restartBtn.addEventListener('click', async () => {
  await call('restart');
  await poll();
});

/* Keyboard: space toggles, arrows nudge the scrubber when it isn't focused. */
document.addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (e.key === ' ') {
    e.preventDefault();
    void togglePlay();
  } else if (e.key === 'Escape' && selectedId) {
    void select(null);
  }
});

/* ------------------------------------------------------------------------ */
/* Render                                                                   */
/* ------------------------------------------------------------------------ */

function renderState() {
  stateRoot.replaceChildren();
  if (status === 'restricted') {
    stateRoot.append(
      h('p', { class: 'state-title' }, 'Can’t inspect this page'),
      h('p', { class: 'muted' }, 'Chrome doesn’t let extensions run on browser pages or the Web Store. Open a regular site.'),
    );
  } else if (status === 'error') {
    stateRoot.append(h('p', { class: 'state-title' }, 'Something went wrong'), h('p', { class: 'muted mono' }, errorText));
  } else if (status === 'loading') {
    stateRoot.append(h('p', { class: 'muted' }, 'Connecting…'));
  } else if (snap && snap.animations.length === 0 && snap.jsDriven.length === 0) {
    stateRoot.append(
      h('p', { class: 'state-title' }, 'No animations yet'),
      h(
        'p',
        { class: 'muted' },
        'Interact with the page or reload it. To catch a hover transition, pause first, then hover: it’s held the moment it starts.',
      ),
    );
  }
  stateRoot.hidden = stateRoot.childElementCount === 0;
}

function render() {
  renderState();
  const ready = status === 'ready' && !!snap;
  listRoot.hidden = !ready;
  for (const el of [playBtn, restartBtn, scrub, ...rateBtns]) (el as HTMLButtonElement).disabled = !ready;
  if (!ready || !snap) {
    detail.render(null);
    return;
  }

  try {
    hostEl.textContent = new URL(snap.url).host || snap.url;
  } catch {
    hostEl.textContent = snap.url;
  }

  playBtn.innerHTML = snap.paused ? icons.play : icons.pause;
  playBtn.setAttribute('aria-label', snap.paused ? 'Play all' : 'Pause all');
  playBtn.title = snap.paused ? 'Play all (Space)' : 'Pause all (Space)';
  playBtn.classList.toggle('is-paused', snap.paused);

  for (const b of rateBtns) {
    const on = Number(b.dataset.rate) === snap.rate;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', String(on));
  }

  scrub.max = String(snap.scrubEnd);
  if (!draggingGlobal && pendingScrub == null) {
    const ref = snap.scrubTime ?? referenceTime(snap);
    scrub.value = String(Math.min(snap.scrubEnd, Math.max(0, ref)));
    timeEl.textContent = `${Math.round(Number(scrub.value))} ms`;
  }

  const live = snap.animations.filter((a) => !a.live.ended).length;
  const ended = snap.animations.length - live;
  countEl.textContent = [
    `${live} live`,
    ended ? `${ended} ended` : '',
    snap.jsDriven.length ? `${snap.jsDriven.length} JS` : '',
    snap.gsapDetected ? 'GSAP' : '',
  ]
    .filter(Boolean)
    .join(' · ');

  list.render(snap.animations, snap.jsDriven, selectedId);
  const sel = snap.animations.find((a) => a.spec.id === selectedId) ?? null;
  if (selectedId && !sel) selectedId = null;
  detail.render(sel);
  document.body.classList.toggle('has-detail', !!sel);
}

/** What the global scrubber shows while playing: the selected (or first live) animation's time. */
function referenceTime(s: AgentSnapshot): number {
  const pick = s.animations.find((a) => a.spec.id === selectedId) ?? s.animations.find((a) => !a.live.ended && !a.live.scrollLinked);
  if (!pick || pick.live.currentTime == null) return 0;
  const p = iterationProgress(pick.spec, pick.live.currentTime);
  return p == null ? Math.min(pick.live.currentTime, s.scrubEnd) : pick.live.currentTime % Math.max(1, s.scrubEnd);
}

/* ------------------------------------------------------------------------ */
/* Tab tracking                                                             */
/* ------------------------------------------------------------------------ */

async function attach(tabId: number, url?: string) {
  if (bridge?.tabId === tabId) return;
  if (bridge) void bridge.call('reset').catch(() => {});
  bridge = new TabBridge(tabId);
  snap = null;
  selectedId = null;
  status = isRestrictedUrl(url) ? 'restricted' : 'loading';
  port.postMessage({ type: 'attach', tabId });
  render();
  if (status !== 'restricted') await poll();
}

async function init() {
  if (pinnedTab != null) {
    const tab = await chrome.tabs.get(pinnedTab).catch(() => null);
    await attach(pinnedTab, tab?.url);
  } else {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id != null) await attach(tab.id, tab.url);
    const win = await chrome.windows.getCurrent();
    chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
      if (windowId !== win.id) return;
      const t = await chrome.tabs.get(tabId).catch(() => null);
      await attach(tabId, t?.url);
    });
  }
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (tabId !== bridge?.tabId) return;
    if (info.status === 'loading' && info.url) {
      snap = null;
      selectedId = null;
      status = isRestrictedUrl(tab.url) ? 'restricted' : 'loading';
      render();
    }
    if (info.status === 'complete') {
      status = isRestrictedUrl(tab.url) ? 'restricted' : 'loading';
      void poll();
    }
  });
  setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', () => void poll());
}

void init();
