# Motion Inspector

![Motion Inspector: the side panel next to a page, paused mid-animation](./screenshots/overview.png)

> A Chrome extension that pauses and scrubs the animations running on any page, reads off each one's easing, duration, delay, iterations and animated properties, and exports it as code: CSS, a CSS `linear()` easing, Motion, or GSAP. Built in vanilla TypeScript on WXT.

Chrome DevTools' Animations panel can already inspect and scrub. It doesn't give you code. That's the gap this fills: find an animation you like, pause it, and copy it out in the format you work in.

It lives in Chrome's side panel, so it stays open while you hover, click and scroll the page.

## Screenshots

| Light | Dark |
| ----- | ---- |
| ![Light, spring selected](screenshots/panel-light.png) | ![Dark, spring selected](screenshots/panel-dark.png) |
| ![Light, list](screenshots/list-light.png) | ![Dark, list](screenshots/list-dark.png) |

## Install (no Node required)

1. Grab the latest zip from [**Releases**](https://github.com/akintola4/motion-inspector/releases/latest): `motion-inspector-<version>-chrome.zip`.
2. Unzip it anywhere.
3. Open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked** and pick the unzipped folder.
4. Pin **Motion Inspector** from the puzzle menu.

Click the icon on any page and the side panel opens.

> Updates aren't automatic. When a new release lands, download the new zip and click **Update** on the extension card. Version history is in [CHANGELOG.md](./CHANGELOG.md).

Needs Chrome 116 or newer (side panel API). Edge, Brave, Arc and other Chromium browsers with side panel support should work the same way; only Chrome has been tested.

## How to use

- **Open the panel** on the tab you want to inspect. It follows the active tab and re-attaches after reloads.
- **Pause / play** everything with the button or `Space`. GSAP's global timeline pauses with it.
- **Scrub** with the slider. Every animation is moved to the same time from its start, the same model DevTools uses.
- **Slow it down** with 0.1×, 0.25× or 0.5×. The rate also applies to animations that start later.
- **Click a row** to select it. The element is outlined on the page and the detail view shows:
  - the easing curve with a playhead, and the easing as written;
  - duration, delay, iterations, direction, fill, end delay;
  - a scrubber for that one animation;
  - the keyframes;
  - the export, in four tabs: **CSS**, **linear()**, **Motion**, **GSAP**, with a Copy button.
- **Catching hover transitions:** pause first, then hover. New animations are held the moment they start, and finished ones stay in the list (dimmed) so you can still export them.

### What the exports do

| Tab | Output |
| --- | --- |
| CSS | `@keyframes` plus an `animation:` rule, or a `transition:` declaration with the from/to states. Per-keyframe easings are kept. |
| linear() | The easing as a CSS `linear()` custom property. Beziers are sampled, springs are labelled with the bounce and duration they match. `steps()` stays `steps()`. |
| Motion | `animate()` for vanilla JS and a `<motion.div>` for `motion/react`. Times in seconds, `repeat`/`repeatType`, keyframe `times`, per-segment `ease` arrays. A `linear()` that looks like a spring is turned back into `type: "spring"` with `visualDuration` and `bounce`. |
| GSAP | `gsap.fromTo()` or percentage `keyframes`. Known curves map to GSAP names (`power4.out`), other beziers use `CustomEase`, anything else gets an exact ease function. Tweens that came from GSAP are echoed with their original vars and ease name. |

## What it can and can't capture

| Source | Captured | Controllable |
| --- | --- | --- |
| CSS `@keyframes` animations | yes | yes |
| CSS transitions | yes, while running (and kept after they end) | yes, while running |
| Web Animations API (`element.animate()`) | yes | yes |
| Motion, values it hands to WAAPI (`opacity`, `transform`, `filter`, `clipPath`, springs on those, and often `x`/`y`) | yes, as WAAPI | yes |
| GSAP tweens and timelines | yes, through `window.gsap` | yes, through the global timeline |
| Anything driven by `requestAnimationFrame` (Motion values it runs on the main thread, anime.js, React Spring, hand-rolled loops) | detected only: listed as **JS-driven** when an element's inline style changes many times a second | no |
| Scroll-driven animations (`animation-timeline: scroll()`/`view()`) | listed, tagged "scroll" | no |
| Canvas, WebGL, Lottie (canvas renderer), SMIL `<animate>` | no | no |
| Cross-origin iframes, closed shadow roots | no | no |

A few things worth knowing:

- Motion decides per value whether to use WAAPI or JS, so the same `animate()` call can show up as WAAPI, as WAAPI with dozens of pre-sampled keyframes, or as JS-driven. In testing with Motion 14, a spring with `repeatDelay` ran in JS while the same spring without it went to WAAPI as `linear()`.
- GSAP tweens inside a timeline export as standalone tweens, with a comment giving their position in the timeline.
- Chrome shortens a CSS transition that reverses mid-flight, so an interrupted hover can report a duration much shorter than the one in your stylesheet. That's what the browser actually ran.
- Chrome doesn't let extensions run on `chrome://` pages or the Web Store. The panel says so.

## Permissions

- `sidePanel` for the panel itself.
- `scripting` and host access to all sites, to inject the inspector into the tab you're looking at.

There are no declared content scripts. Nothing runs on a page until the side panel is open and pointed at it, and when the panel closes, the page is resumed at 1×. `activeTab` alone isn't enough here: its grant is lost on every navigation, and a side panel that sits open across reloads would keep losing access.

## Development

```bash
pnpm install        # also copies the Geist fonts into public/fonts/
pnpm build          # → dist/chrome-mv3/, load it unpacked
pnpm dev            # WXT dev mode with reload
pnpm zip            # → dist/motion-inspector-<version>-chrome.zip
```

```bash
pnpm test           # vitest: easing parser, spring fit, every exporter
pnpm compile        # tsc --noEmit
pnpm e2e            # build, then drive the extension in Playwright Chromium
pnpm fixtures       # serve fixtures/ on http://localhost:4599
pnpm icons          # rasterize public/icon.svg
```

`pnpm e2e` loads the built extension into Playwright's Chromium, opens each fixture page, and checks that the panel lists the right animations, that pause freezes `currentTime`, that scrubbing sets it, that the rate applies, that every export tab produces code, and that closing the panel leaves the page running at 1×. It also writes the screenshots in `screenshots/`. Playwright can't click the toolbar icon or read the real side panel's DOM, so the UI checks run on the same panel page opened in a tab with `?tabId=<fixture tab>`. One extra check opens the real side panel with `chrome.sidePanel.open` and confirms it follows the active tab and injects the inspector.

The fixtures cover CSS `@keyframes`, CSS transitions, WAAPI with a cubic-bezier, a spring via `linear()`, a GSAP timeline and Motion's `animate()`. GSAP and Motion are served from `node_modules`, no CDN.

## Architecture

```
entrypoints/
├── background.ts        # opens the panel from the toolbar; resets pages when it closes
├── agent.ts             # injected into the page (MAIN world) on demand: capture,
│                        # controls, GSAP, highlight overlay, JS-driven detection
└── sidepanel/
    ├── main.ts          # tab tracking, polling, transport controls
    ├── bridge.ts        # every agent call is one chrome.scripting.executeScript
    ├── list.ts          # keyed animation rows, updated in place
    ├── detail.ts        # curve, timing, keyframes, export tabs
    ├── curve.ts         # SVG curves
    └── style.css

lib/
├── easing.ts            # parse / evaluate / sample to linear() / spring + spring fit
├── gsap-eases.ts        # GSAP ease names ↔ beziers
├── timing.ts            # iteration progress and curves for the panel
├── selector.ts          # short unique selectors
└── export/              # css, linear, motion, gsap: pure functions, unit-tested

fixtures/                # test pages
scripts/                 # fixture server, e2e, icon + font helpers
docs/plan.md             # design notes and v1 scope
```

## Tech

- [WXT](https://wxt.dev) for the MV3 build.
- TypeScript strict, with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`. No UI framework, just a small `h()` DOM helper.
- [Geist](https://vercel.com/font) and Geist Mono.
- [Vitest](https://vitest.dev) and [Playwright](https://playwright.dev) for tests.

## License

MIT.
