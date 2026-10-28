# Changelog

All notable changes to Motion Inspector will land here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

Nothing yet.

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
