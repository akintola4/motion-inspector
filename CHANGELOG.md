# Changelog

All notable changes to Motion Inspector will land here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

Nothing moves unless you moved it. Measured with `pnpm audit:layout`;
findings in `docs/layout-audit.md`.

### Changed

- **Live / paused is a dot before the site name** in the header (green
  live, amber paused). The word is still there for screen readers and on
  hover. The transport row is now play, speed, restart, with restart in
  the theme toggle's column.
- **Just-ended animations stay under Live for 3 s**, faded and marked
  Ended, so short transitions that re-trigger don't blink rows in and out.
  Counts stay honest.
- **The list holds still while you point at it.** Polls patch rows in
  place; they don't remove or reorder them until the pointer leaves.
  Rows keep their order between polls, and a re-triggered transition
  keeps its row.

### Fixed

- Pause / play no longer resizes the timeline (`1800 ms` vs
  `626 / 1800 ms`); the per-animation readout no longer nudges its slider
  every poll as digits come and go.
- Switching export tabs no longer changes the code block's height or
  moves the Keyframes section.
- `Copy` → `Copied` no longer widens the button.
- The Ended filter's empty message no longer pushes the filter bar down.
- Collapsing a group near the end of a scrolled list keeps the group
  under the pointer.
- Geist Mono is preloaded, so the first drill-in doesn't reflow the code.
- Theme changes swap colours at once instead of tweening each control.
- Each poll only writes what changed: idle polling went from ~4.5 replaced
  nodes and 17–85 attribute writes per poll to ~1 and ~3, and the list is
  no longer patched while hidden behind the detail view.

## [0.2.0] — 2026-10-28

UI polish after trying 0.1.0 on a real Next.js/Tailwind site.

### Changed

- **Type.** Geist for the whole UI; Geist Mono only for code (export,
  selector, easing strings, keyframe values). Numbers use tabular figures.
  Same tokens as RPC, with every text colour at 4.5:1 or better on the
  surfaces it sits on.
- **No more "loading" look.** The transport shows a static Live / Paused
  state. While live, the timeline is idle instead of crawling like a
  progress bar; the playhead appears when you pause or scrub. List rows
  no longer carry ticking progress bars.
- **Layout.** The detail view is a drill-in with a back button (and
  `Escape`), so neither the list nor the detail is squeezed into a third
  of the panel. The list keeps its scroll position and focus.
- **Header.** Just the host, a GSAP badge when present, and the theme
  toggle; Chrome already titles the panel.
- **Labels.** Rows name elements the way you would (`div.skeleton`,
  `button.chip “Design”`, `div in article.card`), skipping Tailwind
  utilities and generated names. The full selector is in the detail view,
  wrapped and copyable.
- **Polling.** Specs are sent once; each 250 ms poll carries live state
  only.

### Added

- Identical animations fold into one row with a count (`pulse ×12`) that
  expands to the elements, with their sizes.
- Live / Ended / All filter, Live by default. Zero-length animations are
  hidden behind a note.
- Hovering a row outlines its element on the page.
- Keyboard: `↑`/`↓` between rows, `→`/`←` to open and close a group,
  `Enter` to open, `Escape` to go back.
- A noisy fixture page and E2E checks for grouping, the ended filter and
  the iteration readout.

### Fixed

- The per-animation readout for loops showed the total elapsed time
  (`26372 / 2000 ms`). It now shows the position inside the current
  iteration (`372 / 2000 ms · iteration 14`) and the slider stays in range.
- The panel no longer flashes back to "Connecting…" when a page that's
  already attached fires another load-complete event.

## [0.1.0] — 2026-10-28

First release.

### Added

- **Side panel inspector.** Opens from the toolbar icon, follows the
  active tab, re-attaches after reloads, and resets the page (resumed,
  1×, no highlight) when closed.
- **Capture** of CSS `@keyframes` animations, CSS transitions, Web
  Animations (including Motion's WAAPI path) and GSAP tweens and
  timelines. Short transitions are caught as they start and kept after
  they end. Elements animated from JS (rAF loops, main-thread Motion
  values) are detected and listed as JS-driven.
- **Controls:** pause/play all (`Space`), a global scrubber, playback
  rate (0.1×, 0.25×, 0.5×, 1×), per-animation scrubbing, and an outline
  on the selected element.
- **Readout:** easing curve with playhead, duration, delay, iterations,
  direction, fill, end delay, and the keyframes.
- **Export** to CSS (`@keyframes` + `animation`, or `transition`), CSS
  `linear()`, Motion (`animate()` and `<motion.div>`), and GSAP
  (`fromTo` or percentage keyframes). Spring-shaped `linear()` curves
  export to Motion as `type: "spring"` with the fitted `visualDuration`
  and `bounce`.
- Light and dark themes (follows the system, or pick one).
- Fixture pages for every capture path, unit tests for the easing
  library and exporters, and a Playwright end-to-end run against the
  built extension.
