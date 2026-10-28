import './style.css';
import type { AgentPoll, AgentSnapshot, AnimationEntry, AnimationSpec } from '../../lib/types';
import { iterationProgress } from '../../lib/timing';
import { filterAnimations, groupAnimations, groupKey, lingeringIds, type StatusFilter } from '../../lib/grouping';
import { h, numSlot, setAttr, setText } from './h';
import { icons } from './icons';
import { setupTheme } from './theme';
import { RestrictedPageError, TabBridge, isRestrictedUrl } from './bridge';
import { createList } from './list';
import { createDetail, type ExportTab } from './detail';

const POLL_MS = 250;
/** A just-ended animation stays under Live this long, so short re-triggering (and ping-ponging) transitions don’t blink rows in and out, and a hover transition stays put long enough to click. */
const LINGER_MS = 3000;
const RATES = [0.1, 0.25, 0.5, 1];
const FILTERS: { id: StatusFilter; label: string }[] = [
  { id: 'live', label: 'Live' },
  { id: 'ended', label: 'Ended' },
  { id: 'all', label: 'All' },
];

/* ------------------------------------------------------------------------ */
/* State                                                                    */
/* ------------------------------------------------------------------------ */

const params = new URLSearchParams(location.search);
const pinnedTab = params.has('tabId') ? Number(params.get('tabId')) : null;

let bridge: TabBridge | null = null;
let snap: AgentSnapshot | null = null;
let selectedId: string | null = null;
let exportTab: ExportTab = 'css';
let filter: StatusFilter = 'live';
let showNoop = false;
const expanded = new Set<string>();
const endedAt = new Map<string, number>();
let lingerPrimed = false;
/** Next list render lays rows out fresh instead of keeping their order. */
let reorder = true;
let status: 'loading' | 'ready' | 'restricted' | 'error' = 'loading';
let errorText = '';
let inFlight = false;
let draggingGlobal = false;
let pendingScrub: number | null = null;
let listScroll = 0;
let host = '';

/** Specs are static: cached here, the agent only sends ones we don't have. */
const specs = new Map<string, AnimationSpec>();
let specSession: string | null = null;

/**
 * The background uses this port to reset pages when the panel closes. It
 * drops when the service worker is stopped or the extension is reloaded, so
 * reconnect on demand and re-announce the attached tab. After a reload the
 * old panel's context is invalid and can't reconnect; say so instead.
 */
let port: chrome.runtime.Port | null = null;
let portTabId: number | null = null;

function connectPort(): chrome.runtime.Port | null {
  if (!chrome.runtime?.id) return null;
  try {
    const p = chrome.runtime.connect({ name: 'panel' });
    p.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (port === p) port = null;
      if (!chrome.runtime?.id) showReloaded();
    });
    return p;
  } catch {
    return null;
  }
}

function sendAttach(tabId: number) {
  portTabId = tabId;
  for (let attempt = 0; attempt < 2; attempt++) {
    port ??= connectPort();
    if (!port) {
      if (!chrome.runtime?.id) showReloaded();
      return;
    }
    try {
      port.postMessage({ type: 'attach', tabId });
      return;
    } catch {
      port = null;
    }
  }
}

function showReloaded() {
  if (document.body.dataset.reloaded) return;
  document.body.dataset.reloaded = 'true';
  const root = h('div', { class: 'state' });
  root.append(
    h('p', { class: 'state-title' }, 'Motion Inspector was reloaded'),
    h('p', { class: 'state-body' }, 'Close this panel and open it again to keep inspecting.'),
  );
  document.getElementById('app')!.replaceChildren(root);
}

port = connectPort();
// Re-announce after the worker restarts so the page still gets reset on close.
setInterval(() => {
  if (!port && portTabId != null && chrome.runtime?.id) sendAttach(portTabId);
}, 5000);

/* ------------------------------------------------------------------------ */
/* DOM                                                                      */
/* ------------------------------------------------------------------------ */

const app = document.getElementById('app')!;
const themeBtn = h('button', { class: 'icon-btn', type: 'button' });
const hostEl = h('span', { class: 'host' }, '');
const gsapEl = h('span', { class: 'badge', hidden: true, title: 'GSAP found on this page; its global timeline follows the controls.' }, 'GSAP');

/* Live / paused: a dot beside the host. The word is still there for screen
   readers (role=status) and on hover (title). */
const statusLabel = h('span', { class: 'sr-only', role: 'status' });
const statusEl = h('span', { class: 'status' }, h('span', { class: 'status-dot', 'aria-hidden': 'true' }), statusLabel);

const playBtn = h('button', { class: 'btn btn-primary play', type: 'button', 'aria-label': 'Pause all' });
const restartBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Restart all', title: 'Restart all', html: icons.restart });
const scrub = h('input', { type: 'range', min: '0', max: '1000', step: '1', value: '0', class: 'slider timeline', 'aria-label': 'Scrub all animations' });
/* "588 / 2000 ms" when paused, "2000 ms" when live. The current-time slot
   keeps its width in both, so the timeline never resizes. */
const timeCur = numSlot(4);
const timeSep = h('span', { class: 'time-sep' }, ' / ');
const timeEnd = numSlot(4);
const timeEl = h('span', { class: 'time' }, timeCur.el, timeSep, timeEnd.el, ' ms');
const rateBtns = RATES.map((r) =>
  h('button', { class: 'seg-btn', type: 'button', dataset: { rate: String(r) }, 'aria-label': `Speed ${r}×`, onclick: () => setRate(r) }, `${r}×`),
);
const filterBtns = FILTERS.map((f) => {
  // Two-digit slot: the label doesn't slide as the count goes 9 → 10.
  const count = numSlot(2);
  count.el.classList.add('seg-count', 'num-center');
  const b = h('button', { class: 'seg-btn', type: 'button', role: 'tab', dataset: { filter: f.id }, onclick: () => setFilter(f.id) }, f.label, count.el);
  return { b, count, id: f.id };
});
const noopEl = h('div', { class: 'noop-note', hidden: true });

const listRoot = h('div', { class: 'list' });
const detailRoot = h('div', { class: 'detail', hidden: true });
// Messages sit inside the list's scroll area, under the filter bar, so
// neither the bar nor the list box moves when one comes or goes.
const stateRoot = h('div', { class: 'state' });
const listView = h(
  'div',
  { class: 'list-view' },
  h('div', { class: 'list-bar' }, h('div', { class: 'seg seg-fill', role: 'tablist', 'aria-label': 'Show' }, ...filterBtns.map((f) => f.b))),
  listRoot,
);

app.append(
  h('header', { class: 'top' }, statusEl, hostEl, gsapEl, themeBtn),
  h(
    'section',
    { class: 'transport' },
    h(
      'div',
      { class: 'transport-row' },
      playBtn,
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Playback rate' }, ...rateBtns),
      restartBtn,
    ),
    h('div', { class: 'transport-row timeline-row' }, scrub, timeEl),
  ),
  h('main', { class: 'body' }, listView, detailRoot),
);
setupTheme(themeBtn);

const list = createList(listRoot, {
  onOpen: (id) => void open(id),
  onHover: (id) => {
    if (!selectedId) void call('select', id, false);
  },
  onToggle: (key) => {
    if (expanded.has(key)) expanded.delete(key);
    else expanded.add(key);
    render();
  },
});
listRoot.prepend(stateRoot);
const detail = createDetail(detailRoot, {
  onBack: () => void open(null),
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

function resetCache() {
  specs.clear();
  specSession = null;
}

/** Turn an incremental poll back into a full snapshot using the spec cache. */
function applyPoll(p: AgentPoll): AgentSnapshot {
  if (p.session !== specSession) {
    specs.clear();
    specSession = p.session;
  }
  for (const s of p.specs) specs.set(s.id, s);
  const animations: AnimationEntry[] = [];
  let missing = false;
  p.order.forEach((id, i) => {
    const spec = specs.get(id);
    if (spec) animations.push({ spec, live: p.live[i]! });
    else missing = true;
  });
  // Drop specs the agent no longer has so `known` stays small.
  const keep = new Set(p.order);
  for (const id of specs.keys()) if (!keep.has(id)) specs.delete(id);
  if (missing) specSession = null; // resend everything next time
  return {
    version: p.version,
    url: p.url,
    paused: p.paused,
    rate: p.rate,
    scrubEnd: p.scrubEnd,
    scrubTime: p.scrubTime,
    gsapDetected: p.gsapDetected,
    animations,
    jsDriven: p.jsDriven,
  };
}

async function poll() {
  if (!bridge || inFlight || document.visibilityState === 'hidden') return;
  inFlight = true;
  const b = bridge;
  try {
    const p = await b.call<AgentPoll>('poll', specSession, [...specs.keys()]);
    if (b !== bridge) return; // switched tabs mid-call
    snap = applyPoll(p);
    status = 'ready';
  } catch (err) {
    handleError(err);
  } finally {
    inFlight = false;
  }
  render(true);
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

function setFilter(f: StatusFilter) {
  filter = f;
  reorder = true;
  listRoot.scrollTop = 0;
  render();
}

/** Drill in (id) or back out (null) of the detail view. */
async function open(id: string | null) {
  const from = selectedId;
  if (id && !selectedId) listScroll = listRoot.scrollTop;
  selectedId = id;
  render();
  if (!id) {
    listRoot.scrollTop = listScroll;
    if (from) list.focusId(from);
  } else {
    detailRoot.querySelector<HTMLElement>('.back')?.focus({ preventScroll: true });
  }
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
scrub.addEventListener('pointerdown', () => {
  draggingGlobal = true;
  app.classList.add('is-scrubbing');
});
window.addEventListener('pointerup', () => (draggingGlobal = false));
scrub.addEventListener('input', () => {
  const first = pendingScrub == null;
  pendingScrub = Number(scrub.value);
  app.classList.add('is-scrubbing');
  setTime(pendingScrub, Number(scrub.max));
  if (first) requestAnimationFrame(flushScrub);
});
playBtn.addEventListener('click', togglePlay);
restartBtn.addEventListener('click', async () => {
  await call('restart');
  await poll();
});

/* Keyboard: Space toggles play, Escape goes back. */
document.addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (e.key === ' ') {
    e.preventDefault();
    void togglePlay();
  } else if (e.key === 'Escape' && selectedId) {
    void open(null);
  }
});

/* ------------------------------------------------------------------------ */
/* Render                                                                   */
/* ------------------------------------------------------------------------ */

function stateMessage(title: string, body: string, action?: HTMLElement) {
  stateRoot.append(h('p', { class: 'state-title' }, title), h('p', { class: 'state-body' }, body));
  if (action) stateRoot.append(action);
}

let stateSig = '';
function renderState(shownCount: number, endedCount: number) {
  const sig = `${status}|${errorText}|${host}|${!!snap}|${!!selectedId}|${shownCount === 0}|${snap?.jsDriven.length === 0}|${filter}|${endedCount}`;
  if (sig === stateSig) return;
  stateSig = sig;
  stateRoot.replaceChildren();
  if (status === 'restricted') {
    stateMessage('Can’t inspect this page', 'Chrome doesn’t let extensions run on browser pages or the Web Store. Open a regular site.');
  } else if (status === 'error') {
    stateMessage('Something went wrong', errorText);
  } else if (status === 'loading') {
    stateMessage(host ? `Connecting to ${host}…` : 'Connecting…', 'Waiting for the page to answer.');
  } else if (snap && !selectedId && shownCount === 0 && snap.jsDriven.length === 0) {
    if (filter === 'live' && endedCount > 0) {
      stateMessage(
        'Nothing running right now',
        `${endedCount} animation${endedCount === 1 ? '' : 's'} already finished. Interact with the page, or look at what ran.`,
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => setFilter('ended') }, 'Show ended'),
      );
    } else if (filter === 'ended') {
      stateMessage('Nothing has ended yet', 'Finished animations stay here so you can still export them.');
    } else {
      stateMessage(
        'No animations yet',
        'Interact with the page or reload it. To catch a hover transition, pause first, then hover: it’s held the moment it starts.',
      );
    }
  }
  stateRoot.hidden = stateRoot.childElementCount === 0;
}

function hostOf(url: string) {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** Transport readout. `cur` null = live: only the length shows, the slot keeps its width. */
function setTime(cur: number | null, end: number) {
  const digits = String(Math.round(end)).length;
  timeCur.digits(digits);
  timeEnd.digits(digits);
  timeCur.set(cur == null ? '' : String(Math.round(cur)));
  timeEnd.set(String(Math.round(end)));
  timeEl.classList.toggle('is-idle', cur == null);
}

function setStatus(state: 'live' | 'paused' | 'none') {
  if (statusEl.dataset.state === state) return;
  statusEl.dataset.state = state;
  const word = state === 'live' ? 'Live' : state === 'paused' ? 'Paused' : '';
  statusLabel.textContent = word;
  statusEl.title = state === 'live' ? 'Live: the page is playing' : state === 'paused' ? 'Paused' : '';
}

let playIcon = '';
function setPlayIcon(paused: boolean) {
  const want = paused ? 'play' : 'pause';
  if (playIcon === want) return;
  playIcon = want;
  playBtn.innerHTML = paused ? icons.play : icons.pause;
  playBtn.setAttribute('aria-label', paused ? 'Play all' : 'Pause all');
  playBtn.title = paused ? 'Play all (Space)' : 'Pause all (Space)';
  playBtn.classList.toggle('is-paused', paused);
}

function setDisabled(els: (HTMLButtonElement | HTMLInputElement)[], disabled: boolean) {
  for (const el of els) if (el.disabled !== disabled) el.disabled = disabled;
}

/** `background`: called from a poll rather than a user action. */
function render(background = false) {
  const ready = status === 'ready' && !!snap;
  setDisabled([playBtn, restartBtn, scrub, ...rateBtns, ...filterBtns.map((f) => f.b)], !ready);

  if (!ready || !snap) {
    renderState(0, 0);
    list.render({ groups: [], js: [], expanded, paused: false });
    noopEl.hidden = true;
    listView.hidden = false;
    app.classList.remove('has-detail');
    detail.render(null, { siblings: 0, paused: false });
    setStatus('none');
    setPlayIcon(false);
    for (const f of filterBtns) f.count.set('');
    scrub.value = '0';
    app.classList.add('is-live');
    setTime(null, 0);
    timeEl.classList.add('is-empty');
    return;
  }
  timeEl.classList.remove('is-empty');

  host = hostOf(snap.url);
  setText(hostEl, host);
  if (hostEl.title !== snap.url) hostEl.title = snap.url;
  if (gsapEl.hidden === snap.gsapDetected) gsapEl.hidden = !snap.gsapDetected;

  /* Transport */
  const live = !snap.paused && snap.scrubTime == null;
  setPlayIcon(snap.paused);
  setStatus(snap.paused ? 'paused' : 'live');

  for (const b of rateBtns) {
    const on = Number(b.dataset.rate) === snap.rate;
    b.classList.toggle('is-on', on);
    setAttr(b, 'aria-pressed', String(on));
  }

  const max = String(snap.scrubEnd);
  if (scrub.max !== max) scrub.max = max;
  if (!draggingGlobal && pendingScrub == null) {
    // While the page plays, the timeline is idle: no moving thumb, no
    // ticking number. The playhead only shows once you pause or scrub.
    app.classList.toggle('is-live', live);
    if (!live) app.classList.remove('is-scrubbing');
    if (live) {
      if (scrub.value !== '0') scrub.value = '0';
      setTime(null, snap.scrubEnd);
      setAttr(timeEl, 'title', 'Timeline length. Drag to pause and scrub.');
    } else {
      const ref = snap.scrubTime ?? referenceTime(snap);
      const v = String(Math.round(Math.min(snap.scrubEnd, Math.max(0, ref))));
      if (scrub.value !== v) scrub.value = v;
      setTime(Number(v), snap.scrubEnd);
      setAttr(timeEl, 'title', '');
    }
  }

  /* List */
  const lingering = lingeringIds(snap.animations, endedAt, performance.now(), LINGER_MS, !lingerPrimed);
  lingerPrimed = true;
  const { shown, counts, hiddenNoop } = filterAnimations(snap.animations, filter, showNoop, lingering);
  for (const f of filterBtns) {
    const on = f.id === filter;
    f.b.classList.toggle('is-on', on);
    setAttr(f.b, 'aria-selected', String(on));
    f.count.set(String(counts[f.id]));
    f.count.digits(Math.max(2, String(counts[f.id]).length));
  }
  const sel = snap.animations.find((a) => a.spec.id === selectedId) ?? null;
  if (selectedId && !sel) selectedId = null;
  // The list is hidden behind the detail view: don't patch it every poll.
  if (!sel) {
    const groups = groupAnimations(shown);
    list.render({ groups, js: filter === 'ended' ? [] : snap.jsDriven, expanded, paused: snap.paused, background, reorder });
    reorder = false;
  }
  const noopHidden = hiddenNoop === 0 && !showNoop;
  if (noopEl.hidden !== noopHidden) noopEl.hidden = noopHidden;
  const noopSig = `${showNoop}:${hiddenNoop}`;
  if (noopEl.dataset.sig !== noopSig) {
    noopEl.dataset.sig = noopSig;
    noopEl.replaceChildren(
      showNoop ? 'Showing zero-length animations. ' : `${hiddenNoop} zero-length animation${hiddenNoop === 1 ? '' : 's'} hidden. `,
      h('button', { class: 'link', type: 'button', onclick: () => ((showNoop = !showNoop), (reorder = true), render()) }, showNoop ? 'Hide' : 'Show'),
    );
  }
  if (noopEl.nextElementSibling !== list.spacer) listRoot.insertBefore(noopEl, list.spacer);

  /* Detail */
  const siblings = sel ? snap.animations.filter((a) => a !== sel && groupKey(a.spec) === groupKey(sel.spec)).length : 0;
  detail.render(sel, { siblings, paused: snap.paused });
  if (listView.hidden !== !!sel) listView.hidden = !!sel;
  app.classList.toggle('has-detail', !!sel);
  renderState(shown.length, counts.ended);
}

/** Paused position for the timeline: the selected (or first live) animation's time. */
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
  expanded.clear();
  endedAt.clear();
  lingerPrimed = false;
  reorder = true;
  resetCache();
  host = url ? hostOf(url) : '';
  setText(hostEl, host);
  status = isRestrictedUrl(url) ? 'restricted' : 'loading';
  sendAttach(tabId);
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
      expanded.clear();
      endedAt.clear();
      lingerPrimed = false;
      reorder = true;
      resetCache();
      host = hostOf(info.url);
      setText(hostEl, host);
      status = isRestrictedUrl(tab.url) ? 'restricted' : 'loading';
      render();
    }
    if (info.status === 'complete') {
      if (!snap) status = isRestrictedUrl(tab.url) ? 'restricted' : 'loading';
      void poll();
    }
  });
  setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', () => void poll());
}

void init();
