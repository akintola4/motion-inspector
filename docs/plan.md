# Motion Inspector — plan

A Chrome MV3 extension that pauses and scrubs the animations running on a page,
reads off each one's timing, easing and animated properties, and exports it as
code: CSS, a CSS `linear()` easing, Motion, and GSAP.

Chrome DevTools' Animations panel already inspects and scrubs. It doesn't hand
you code. That export step is the whole point of this tool.

## 1. Capture

### What gets captured

| Source | How | Controllable |
| --- | --- | --- |
| CSS `@keyframes` animations | `document.getAnimations()` → `CSSAnimation` | yes |
| CSS transitions | `document.getAnimations()` → `CSSTransition` | yes, while running |
| WAAPI (`element.animate()`) | `document.getAnimations()` → `Animation` | yes |
| Motion, hardware-accelerated values (`opacity`, `transform`, `filter`, `clipPath`, springs on those) | Motion hands these to WAAPI, so they show up as WAAPI animations, often with a `linear()` easing | yes |
| GSAP tweens and timelines | `window.gsap.globalTimeline.getChildren(true, true, false)` from the MAIN world | yes, through the global timeline |
| JS-driven animation (rAF loops, Motion's `x`/`y`/`scale` independent transforms, anime.js, React Spring) | Heuristic only: a `MutationObserver` on `style` attributes flags elements whose inline style changes more than ~8 times a second and that aren't owned by GSAP | no, listed as "JS-driven" |

`document.getAnimations()` already covers the whole document including open
shadow roots' animations (it returns every animation whose target is in the
document). Closed shadow roots and cross-origin iframes are not reached.

### Catching short-lived animations

CSS transitions and many WAAPI animations finish in 200–400 ms and are then
dropped from `getAnimations()`. Polling alone misses them, so the page agent:

- listens (capture phase) for `animationstart`, `transitionrun` and
  `transitionstart` on `document` and registers new animations immediately;
- wraps `Element.prototype.animate` so WAAPI calls (including Motion's) are
  registered the moment they're created;
- keeps a registry (`Map<id, entry>`) that holds on to finished animations for
  the session (capped at 100), so a 200 ms hover transition can still be
  inspected and exported after it ends. Finished entries are marked "ended";
  they export but aren't scrubbed.
- when the global state is "paused", every newly registered animation is paused
  on arrival. That's the workflow for transitions: pause, hover the thing,
  scrub what got caught.

### Not captured in v1 (and how it's labelled)

- **rAF / JS-driven animation** — no timing model to read. Shown as "JS-driven"
  rows with the element selector and a note; no controls, no export.
- **Canvas / WebGL / Lottie (canvas renderer)** — pixels, not DOM. Not detected.
- **Lottie SVG renderer** — mutates SVG attributes from JS; may show up as
  JS-driven, nothing more.
- **SMIL (`<animate>` in SVG)** — not exposed through `getAnimations()`. Out of
  scope.
- **Scroll-driven animations** (`animation-timeline: scroll()/view()`) — they
  appear in `getAnimations()`, but their `currentTime` is a percentage of a
  scroll range. Listed with a "scroll-linked" tag; pause/scrub don't apply.
- **View transitions** — pseudo-element animations on `::view-transition-*` are
  listed when caught mid-flight, nothing special.
- **Cross-origin iframes / closed shadow roots** — not reached.
- **Motion springs that run in JS** (any value Motion can't hand to WAAPI) —
  JS-driven heuristic only.

## 2. Controls

All controls go through one page agent (section 7). One global state:
`{ paused, rate, scrubTime }`.

- **Pause / play.** `anim.pause()` / `anim.play()` on every live registered
  animation; `gsap.globalTimeline.pause()/resume()`. New animations are paused
  on arrival while paused.
- **Scrub.** One slider, `0 → T`, where `T` is the longest "first pass" among
  live animations: `delay + duration × iterations`, with infinite iterations
  counted as one, clamped to `[100 ms, 20 s]`. Scrubbing pauses everything and
  sets each animation's `currentTime = min(t, endTime)` — the same group model
  DevTools uses. GSAP: pause the global timeline and call `totalTime(t)` on
  each top-level child (clamped to its `totalDuration()`).
  Scrub input is throttled to one agent call per animation frame.
- **Playback rate.** 0.1×, 0.25×, 0.5×, 1×. `anim.updatePlaybackRate(r)` for
  WAAPI/CSS (keeps the visual position steady), `globalTimeline.timeScale(r)`
  for GSAP. Applied to animations that arrive later, too. Reset to 1× and
  resumed when the panel disconnects.
- **Select + highlight.** Clicking a row selects it and draws an outline over
  the target on the page: a fixed-position box in a closed shadow root,
  `pointer-events: none`, re-positioned per frame while visible. The overlay
  host is excluded from capture so it never shows up in its own list.
- **Per-animation scrub.** The detail view has its own slider that only moves
  the selected animation.

## 3. Reading data

Per animation:

- `effect.getTiming()` → `duration`, `delay`, `endDelay`, `iterations`,
  `direction`, `fill`, `easing`, `iterationStart`.
- `effect.getComputedTiming()` → `activeDuration`, `endTime`, `progress`,
  `currentIteration`.
- `effect.getKeyframes()` → offsets, per-keyframe `easing`, `composite` and
  property values. `computedOffset` fills in missing offsets.
- `CSSAnimation.animationName`, `CSSTransition.transitionProperty`.
- `anim.playState`, `currentTime`, `playbackRate`, `timeline` (to spot scroll
  timelines), `anim.id`.
- **Target label.** A short unique selector: `#id` if unique, else
  `tag.class1.class2` if unique, else a `:nth-of-type` path from the nearest
  ancestor with an id (max 5 levels). Pseudo-elements append `::before` etc.
  from `effect.pseudoElement`.

GSAP tweens: `targets()`, `duration()`, `delay()`, `repeat()`, `yoyo()`,
`repeatDelay()`, `vars` (ease name and end values), `startTime()`,
`totalDuration()`. The ease function comes from `gsap.parseEase(name)` and is
sampled in the page (101 points) since the panel can't run page functions.
GSAP's shorthand props (`x`, `y`, `rotation`, `scale`, `autoAlpha`) are
translated to CSS (`transform`, `opacity`) for the CSS export.

Everything sent to the panel is plain JSON (infinite iterations become
`"infinite"`).

### Which easing is "the" easing

CSS animations put easing on each keyframe (`animation-timing-function`) and
leave the effect easing at `linear`. WAAPI usually does the reverse. The panel
shows:

1. the effect easing, if it isn't `linear`;
2. else the keyframe easing, if every segment shares one;
3. else "per keyframe", with each segment's easing listed in the keyframe table.

## 4. Easing

`lib/easing.ts`, pure and unit-tested:

- `parseEasing(css)` → `cubic-bezier` (including the `ease*` keywords), `steps`
  (`jump-start/end/none/both`, `start/end`, `step-start/step-end`), `linear`, or
  `linear()` with its stop list (handles the optional input percentages and
  two-percentage stops, fills missing inputs per spec).
- `evaluate(def, t)` → output for `t ∈ [0, 1]`. Cubic-bezier solved with
  Newton–Raphson plus bisection fallback.
- `toSvgPath(def, w, h)` → the curve preview. Overshoot (`linear()` springs,
  `back` eases) is drawn by giving the viewBox headroom above 1 and below 0.
- `sampleToLinear(fn, { samples, tolerance })` → a `linear()` string. Samples
  densely, then drops points that a straight line between their neighbours
  already reproduces within `tolerance` (greedy simplification), and rounds to
  3–4 decimals. Inputs are only written where points aren't evenly spaced.
- `springToLinear({ bounce, visualDuration })` → the same model Motion uses
  (damping ratio `1 − bounce`, stiffness from `visualDuration`), simulated until
  settled, returned as `{ duration, easing }`. Used by the fixtures and tests.
- `fitSpring(def)` → for `linear()` curves that look like springs (overshoot or
  a long settle), grid-search damping ratio and natural frequency, and if the
  RMS error is under ~1.5 % return `{ bounce, visualDuration }`. This lets the
  Motion export say `type: "spring"` instead of pasting a sampled curve.
- GSAP eases: a table mapping common names (`power1-4`, `sine`, `expo`, `circ`,
  `back` with default overshoot, `none`) to their usual cubic-bezier
  approximations. Anything else (`elastic`, `bounce`, `steps`, `CustomEase`,
  `rough`) uses the sampled points → `linear()`.

## 5. Export generators

`lib/export/*.ts`. Pure functions of one normalized `AnimationSpec`. Each returns
a string; the panel copies it with `navigator.clipboard.writeText`.

- **CSS** — CSS transitions export as a `transition:` declaration (property,
  duration, easing, delay) with the from/to values in a comment. Everything else
  exports as `@keyframes <name>` (CSS name, WAAPI `id`, or a generated name) plus
  an `animation:` rule on the target selector. Per-keyframe easings that differ
  from the main one are written as `animation-timing-function` inside that
  keyframe. camelCase WAAPI properties → kebab-case; custom properties pass
  through. Durations in `ms` under 1 s, else `s`.
- **`linear()`** — the easing as `linear()`: passed through if it already is
  one, sampled from cubic-bezier otherwise (steps are left as `steps()` since
  that's already exact). Emitted as a custom property plus a usage line.
- **Motion** — vanilla `animate(selector, values, options)` and a
  `<motion.div>` snippet for `motion/react`. Values become keyframe arrays,
  non-even offsets become `times`, per-segment easings become an `ease` array.
  Cubic-bezier → `[x1, y1, x2, y2]`; keywords → Motion names (`easeIn`,
  `easeOut`, `easeInOut`, `linear`); steps → `steps(n, dir)` import;
  spring-shaped `linear()` → `type: "spring"` with `bounce`/`visualDuration`
  when the fit is good, else an inline `linear()`-points ease function.
  Iterations → `repeat` (`Infinity`), `alternate` → `repeatType: "reverse"`,
  `reverse` direction → reversed keyframes. Seconds, not ms.
- **GSAP** — two keyframes → `gsap.fromTo`; more → percentage `keyframes` with
  `easeEach`. Cubic-bezier → `CustomEase.create()` with the bezier string
  (CustomEase is free since GSAP 3.13), known GSAP names pass through, linear
  → `"none"`, steps → `"steps(n)"`, other curves → an inline ease function.
  `repeat: -1` for infinite, `yoyo` for alternate.

## 6. UI surface

Choice: **side panel** (`chrome.sidePanel`).

- **Popup** — closes the moment you click the page. You can't scrub while
  watching, and transitions need you to hover the page. Out.
- **DevTools panel** — the natural neighbour of the Animations panel, but it
  means opening DevTools (which itself shifts layout and steals width), it's
  awkward to screenshot, and it's harder to reach from the toolbar.
- **Side panel** — stays open while you hover, click and scroll the page; sits
  next to the content at a fixed narrow width; opens from the toolbar icon
  (`openPanelOnActionClick`); follows the active tab. Best fit for "scrub while
  watching".

Layout (≈360–420 px wide, Geist + Geist Mono, same tokens as RPC):

- **Header** — mark + name, current host, theme toggle (system / light / dark,
  saved in `localStorage`).
- **Transport** — play/pause, scrub slider with `t / T ms`, rate segmented
  control.
- **List** — one row per animation: kind tag, name, selector (mono), a small
  easing curve, duration, live progress line. Ended and JS-driven rows are
  dimmed.
- **Detail** (selected row) — large curve with a playhead dot, timing grid,
  property chips, keyframe table, per-animation scrub, export tabs
  (CSS / linear() / Motion / GSAP) with a code block and Copy.
- Empty state ("No animations yet — interact with the page or reload"),
  restricted-page state (`chrome://`, Web Store), and a GSAP-detected badge.

Motion in the panel itself: almost none. Tab and row selection change
instantly; the only transitions are colour/background at 140 ms. Respect
`prefers-reduced-motion` anyway.

## 7. Architecture and permissions

```
side panel ──chrome.scripting.executeScript({ world: 'MAIN', func, args })──▶ page agent
           ◀───────────────── return value (JSON) ─────────────────────────
```

- The **page agent** (`entrypoints/agent.ts`, an unlisted script) is injected
  into the MAIN world with `chrome.scripting.executeScript({ files })` the
  first time the panel talks to a tab, and again after navigation. It installs
  `window.__motionInspector` (idempotent, versioned). MAIN world is required to
  see `window.gsap` and to wrap `Element.prototype.animate`.
- Every panel command is one `executeScript({ world: 'MAIN', func, args })`
  call whose `func` calls into the agent and returns JSON. No message bridge,
  no isolated-world relay, no long-lived port.
- The panel polls `snapshot()` every 250 ms while visible (and right after
  each command). `executeScript` round trips are a few ms.
- Script injection through `chrome.scripting` isn't subject to the page's CSP.

**Permissions:** `sidePanel`, `scripting`, `host_permissions: ["<all_urls>"]`.

- `activeTab` alone was considered and rejected. Its grant is per tab and
  revoked on navigation; a scrubbing tool that sits in a side panel across
  reloads, HMR refreshes and tab switches would lose access constantly and need
  a toolbar click each time.
- There are **no declared content scripts**. Nothing runs on any page until the
  side panel is open and pointed at that tab, so the broad host permission
  costs nothing during normal browsing.
- No `tabs` (the host permission already exposes `tab.url`), no `storage`
  (theme lives in the panel's `localStorage`).
- `file://` pages need "Allow access to file URLs" on the extension card;
  the fixtures are served over `http://localhost` to avoid that.

## 8. Project layout

```
entrypoints/
  background.ts          # setPanelBehavior({ openPanelOnActionClick: true })
  agent.ts               # unlisted MAIN-world script: registry, controls, GSAP, overlay
  sidepanel/
    index.html
    main.ts              # bootstrap, polling, tab tracking
    bridge.ts            # inject + call agent via chrome.scripting
    transport.ts         # play/pause, scrub, rate
    list.ts              # animation rows
    detail.ts            # curve, timing, keyframes, export tabs
    theme.ts
    h.ts                 # same 30-line DOM helper as RPC
    style.css
lib/
  types.ts               # AnimationSpec and friends (shared by agent + panel)
  easing.ts              # parse / evaluate / svg / sample / spring / fit
  gsap-eases.ts          # name → bezier table
  css-props.ts           # camel ↔ kebab, GSAP shorthand → CSS
  selector.ts            # unique selector (DOM, tested with happy-dom)
  export/{css,linear,motion,gsap,shared}.ts
tests/                   # vitest
fixtures/                # local pages, served by scripts/serve-fixtures.ts
scripts/
  extract-geist-assets.mjs
  serve-fixtures.ts
  e2e.ts                 # Playwright: load extension, drive fixtures, screenshots
screenshots/
```

Stack: WXT, vanilla TypeScript (strict, `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess` like RPC), pnpm, vitest. No React — the panel is a
list, a detail view and a slider; the `h()` helper from RPC is enough.
GSAP and Motion are dev dependencies used only by the fixtures, served from
`node_modules` by the fixture server. No CDN at runtime.

## 9. Test plan

**Unit (vitest):**

- `parseEasing` on keywords, cubic-bezier, steps variants, `linear()` with and
  without percentages, junk input.
- `evaluate` against known points (ease at 0.5, steps edges, linear() interp).
- `sampleToLinear` round-trips a cubic-bezier within tolerance and stays short.
- `springToLinear` settles at 1, overshoots for bounce > 0, doesn't for 0.
- `fitSpring` recovers bounce/visualDuration from a generated spring within a
  tolerance, rejects a plain ease-out.
- GSAP ease table lookups.
- Each exporter against fixed `AnimationSpec`s: CSS transition, multi-keyframe
  CSS animation with per-keyframe easing, WAAPI with infinite alternate,
  linear() spring, steps, GSAP-sourced spec. Assert on key substrings and that
  the CSS output parses (balanced braces, no `undefined`/`NaN`).
- `uniqueSelector` on a small DOM.

**Typecheck:** `tsc --noEmit`.

**E2E (Playwright, `scripts/e2e.ts`):** build, serve fixtures, launch Chromium
with `--load-extension`, open the side panel page as a tab with
`?tabId=<fixture tab>` (Playwright can't click the toolbar to open a real side
panel; the panel accepts a `tabId` override for exactly this), then per fixture:

- the list shows the expected kinds and names;
- pause → `currentTime` stops moving (read straight from the page);
- scrub to t → page `currentTime` equals t for each live animation;
- rate 0.25× → `playbackRate` is 0.25 on the page;
- each export tab produces non-empty code with the expected markers
  (`@keyframes`, `linear(`, `animate(`, `gsap.`);
- screenshots of the panel in light and dark at 400 × 900 into `screenshots/`.

What can't be automated: opening the real side panel from the toolbar icon, and
the feel of scrubbing. Those get a manual check and are called out in the
README.

## 10. v1 scope

In:

- capture of CSS animations, CSS transitions, WAAPI (incl. Motion's WAAPI
  path), GSAP tweens/timelines; JS-driven detection (label only);
- global pause/play/scrub/rate, per-animation scrub, select + highlight;
- timing/easing/keyframe readout, curve preview;
- CSS, linear(), Motion (vanilla + React), GSAP export, copy;
- light/dark; fixtures; unit + E2E tests; README, CHANGELOG.

Out (later):

- editing timing/easing live and pushing it back to the page;
- scroll-driven animation scrubbing;
- SMIL, canvas, Lottie, rAF libraries beyond the "JS-driven" label;
- iframes and closed shadow roots;
- grouping animations by start time the way DevTools does;
- Firefox build;
- Web Store listing.

## 11. v0.2 UI polish

Feedback from running 0.1.0 on a real Next.js/Tailwind site: too much mono,
low-contrast small gray text, the panel "keeps loading", a wrong iteration
readout, a duplicated title, and a list buried under skeleton pulses and
ended transitions. The changes, by issue:

1. **Type: sans first.** Geist is the UI face everywhere. Geist Mono is kept
   for code only: the export block, the full selector in the detail view,
   easing strings and keyframe values. Numbers (durations, times, counts) use
   Geist with `tabular-nums`.
2. **Tokens and contrast.** Same tokens as RPC (dark `#0a0a0a / #ededed /
   #8a8a8a / #161616`, light `#f3f3f3 / #0a0a0a / #6b6b6b / #fff`). Muted
   text is checked against every surface it sits on (bg, elevated, hover,
   selected) for ≥ 4.5:1; anything that reads as body copy (row subtitles,
   fact values) uses `--fg` or a stronger secondary, not `--fg-muted`. Sizes:
   13px body, 12px secondary, 11px uppercase labels (0.06em), nothing under
   11px except kind tags.
3. **"Keeps loading".** Three causes, three fixes:
   - The global scrubber moved every poll while the page played, so it read
     as a progress bar. While playing, the transport shows a static **Live**
     indicator and the scrubber is an idle timeline (no moving thumb, readout
     shows the range). The playhead (a thin vertical line, not a round knob or
     a filled bar) only appears when paused or scrubbing.
   - Per-row progress bars ticking on every row are gone from the list;
     a row shows a small static state dot (running / paused / ended).
     Progress lives in the detail view's curve, interpolated locally with
     rAF between polls so it moves smoothly instead of jumping at 4 Hz
     (and only updates at poll rate under reduced motion).
   - The 250 ms poll used to resend every spec with all keyframes. The agent
     now has `poll(known)`: static specs are sent once, then only live state
     (`playState`, `currentTime`, ended) plus the id order. A per-injection
     session id tells the panel to drop its cache after a reload.
4. **Iteration readout.** A new `iterationPosition(spec, t)` in
   `lib/timing.ts` returns `{ phase, iteration, local }`. The detail scrubber
   for infinite animations covers one iteration (`0 → duration`) and scrubs
   within the current iteration; the readout says `372 / 2000 ms · iteration
   14`. Finite animations keep the absolute `0 → active end` range.
5. **Header.** Chrome already titles the side panel. The panel header is just
   the host and the theme toggle.
6. **List noise.** `groupAnimations()` in `lib/grouping.ts` folds animations
   with the same kind, name, timing, easing and keyframes into one row
   (`pulse ×12`) that expands to its members. A segmented **Live / Ended /
   All** filter defaults to Live. Zero-length and no-op animations (0 ms, or
   every keyframe identical) are hidden behind a "show" link with a count.
7. **Labels.** The agent computes a short human label per target
   (`elementLabel()`: aria-label → `#id` → most specific non-utility class →
   short text snippet → tag; Tailwind-style utilities are ignored). Rows show
   the label; the full selector moves to the detail view, wrapped, mono, with
   a Copy button.
8. **Layout: drill-in, not split.** The list takes the full panel height;
   opening an animation replaces it with the detail view, which has a back
   button (and `Escape`). Why not a split: at side-panel width both halves
   need height — the list to scan a noisy page, the detail for the curve and
   the code block — and a split gave each about a third of the screen. A
   resizable divider would make the user manage layout on every visit. A
   drill-in keeps both full-height, keeps the list's scroll position and
   focus when you come back, and mirrors how Chrome's own side panels
   (Reading list, Bookmarks) navigate.
9. **Rhythm and states.** 4px spacing grid, one row height, consistent 12px
   panel gutter. Hover (pointer devices only), `:focus-visible` rings in a
   neutral colour, `scale(0.97)` press on buttons. Keyboard: ↑/↓ moves through
   rows, → / ← expands / collapses a group, Enter opens, Escape goes back.
   The curve gets a cleaner frame, 0/1 guides for overshoot and a soft area
   fill. `prefers-reduced-motion` drops the press scale and the rAF playhead
   interpolation; colour fades stay.

Tests: unit tests for `iterationPosition`, the per-animation scrub mapping,
`groupAnimations`, the no-op check and `elementLabel`. E2E: a `noisy.html`
fixture (12 Tailwind-style `animate-pulse` skeletons, dozens of short
transitions, zero-length WAAPI calls) checks grouping, the ended filter and
the iteration readout. Screenshots are regenerated in light and dark for
the list, the detail view and the noisy page.
