# Side panel layout audit

What moves when you use the panel, why, and what changed. Measured with
`pnpm audit:layout` (`scripts/layout-audit.ts`). It builds the extension,
opens the panel page in a tab at 400×900 against `fixtures/all.html` and
`fixtures/noisy.html`, and walks every navigation. For each step it records:

- `layout-shift` entries from a PerformanceObserver in the panel, including
  ones Chrome attributes to recent input (CLS ignores those, but you still
  see them),
- bounding-box drift (> 0.5px) of elements that should stay put: header,
  status dot, host, play, speed buttons, restart, timeline, time readout,
  filter tabs and counts, row parts (keyed by row, not index), back button,
  export tabs, copy button, code block, Keyframes section,
- before/after screenshots in `.layout-audit/` (gitignored), plus
  `report.json`,
- for idle polling: rects sampled every 250ms, DOM mutations per poll
  (MutationObserver), and CDP layout/style/script counters.

`scripts/panel-probes.ts` holds the rect diff and a pixel alignment probe.
It takes cap height and x-height from canvas text metrics and the baseline
from a Range over the rendered text, so it measures the font actually drawn.
e2e uses the same probes for its no-shift and alignment assertions.

## Shifts found and fixed

"Before" is the first audit run on 0.2.0; "after" is the current run.

| Action | Before | Cause | Fix | After |
| --- | --- | --- | --- | --- |
| Live → Ended filter with 0 ended | Filter bar **and** list jump down 142px, then back up when a transition ends (CLS 0.274) | The empty-state message rendered above the list view | The message sits inside the list's scroll area, under the bar | 0 |
| Pause / play (button or Space) | Timeline −9.8 to −17px wide; time text slides left by the same | `1800 ms` vs `626 / 1800 ms` in a `min-width: 72px` box | Current time and length in fixed-width tabular slots (`numSlot`: hidden ghost of 8s); while live the current slot is kept, just invisible | 0 |
| Polling, detail view, playing | Per-animation slider ±7.2px **every poll**; 6 layout-shift entries in 3s | Readout `16 / 972 ms · iteration 22` → `250 / 972 ms …` changes width | Readout split into fixed-width slots for the time (digits of the length) and the iteration (2+ digits) | 0 |
| Global scrub in detail | Both readouts ±7.2px | Same as above | Same | 0 |
| Export tab CSS → linear() → Motion → GSAP | Code block height −77 / +145 / −69px; Keyframes section moves with it | Each format has a different line count | All four formats generated once per drill-in; block min-height locked to the tallest (still capped at 340px) | 0 |
| Copy → Copied | Button grows 10.6px to the left | Label text changed | Label stays "Copy"; icon swaps to a check and turns green; "Copied" goes to a `role=status` label and the tooltip | 0 |
| First drill-in | Code block 1px (layout-shift 0.0003) | Geist Mono first used here, `font-display: swap` | Both Geist faces preloaded in `sidepanel.html` | 0 |
| Connecting… → loaded | Status went from empty to "Live" (box +16.8px); time empty → `1800 ms` | Nothing reserved before the first poll | Dot box is fixed (grey until connected); time slot reserved (`visibility: hidden`); filter bar always present (disabled while connecting) | Only the host's box narrows when the GSAP badge appears; the text doesn't move |
| Idle polling, noisy.html list, playing | Rows blink in and out every chip cycle; zero-length note moves ±98px (2 shifts / 3s) | 150ms transitions leave Live as they end and come back as new Animations | Just-ended animations linger 3s under Live (faded, marked Ended, counted as ended); rows are keyed by animation + element, not instance; order is sticky between polls (new rows join at the end) | 0 |
| Idle polling, all.html list | Rows below `#toggle` jump 49–98px | A transition reversed halfway has a new duration, so a new row each time | Leaf rows keyed by kind + name + element; duration and mini-curve patched in place | 0 |
| Polling with the pointer over the list | Rows slide under the cursor as animations end | Same | While the pointer is over the list, polls only patch rows; removals wait until it leaves | 0 (6s test) |
| Duration text changes (`877 ms` → `77 ms`) | Text box slides 8px | Right-aligned box shrank | Duration span stretches to the column; only the glyphs change | 0 |
| Collapse a group with the list scrolled | Clicked group drops 40–160px under the pointer | Content gets shorter and Chrome clamps scrollTop | A spacer at the end makes up the difference, removed once it's scrolled out of view | Group stays put; rows below move up (that's the collapse) |
| Drill in / Esc / back button | Header and transport still | | | 0 (asserted in e2e) |
| Speed 0.1×–1×, theme toggle ×3, hover a row | Still | | | 0 |
| Back to the list | Scroll restored 160 → 160, focus returns to the row | | | Unchanged |

## Still moves, by design

| Action | What moves | Why it stays |
| --- | --- | --- |
| Filter Live / Ended / All, zero-length Show / Hide | Rows below the change | You asked for different rows. The filter bar, tabs and counts stay still (asserted in e2e). |
| Expand / collapse `pulse ×12` | Rows below the group | That's the expansion. Instant on purpose (see Motion). |
| Opening a different animation | Kind badge width (`WAAPI` vs `GSAP`) on the right of the detail bar | Different content, not movement. The back button never moves. |
| An animation ends while you're not pointing at the list | Rows below it move up, 3s after it ended | The Live list has to reflect the page eventually. It never reorders, never moves while you point at it, and short re-triggers no longer cause it. |
| Speed 1× ↔ 0.25× (menu, J / L) | The label glyphs inside the speed trigger re-centre (Chrome logs a layout-shift entry with score 0) | The trigger is sized to its widest state and keeps its box; the label and chevron are centred as a group, by request, so a shorter label sits centred rather than pushed right. Nothing outside the button moves (asserted in e2e). |
| A group's count changes (`×12` → `×8`) on narrow panels | The count text in that row | Content, not movement. |

## Transport (0.3.0)

The audit runs the transport through: load, live polling, pause / play
(button and Space), speed from the menu and from J / L, pause plus frame
steps (`.` ×3, `,`), hovering and dragging the waveform, global scrub,
drill-in and the detail scrubber, then the same page at 300, 320, 360,
400, 480 and 600px with about 100 animations (`fixtures/many.html`).
Transport parts are tagged `data-part` and all tracked; none of them
moved. Zero horizontal overflow at every width.

What changed to get there:

| Problem | Cause | Fix |
| --- | --- | --- |
| Side panel scrolled sideways, left half cut off | Full-width playhead layers moved with `translateX(p × 100%)` reached past the right edge near the end of the timeline (scrollWidth 684 at 360px) | Playhead, hover line and preview are placed in pixels inside the waveform; the waveform clips on x; `overflow-x: hidden` on html/body as a safety net only |
| Waveform logged layout shifts on every poll | Bar heights changed as transitions started and ended | Bars are full height and clipped to their value (`clip-path: inset(… round …)`): repaint, no reflow; ended animations stay in the waveform so it keeps its shape |
| Hover tooltip covered the filter tabs | It floated below the bars | The preview replaces the readout in the readout's own slot (e2e: no overlap with any control or tab at 1%, 50%, 99.5% and 300, 360, 600px) |
| Readout slid as digits changed | Figure spaces (U+2007) in Geist are narrower than tabular digits | Fixed-width slots (hidden ghost of 8s) |
| Filter tabs resized when a count went 99 → 100 | Slot width followed each count | Slot width only grows, shared by all three tabs |

## Alignment (px, from `scripts/panel-probes.ts`)

| Measure | Value |
| --- | --- |
| Status dot centre − host cap-height centre | −0.33 (dot box nudged −1px; line-box centre was +0.67) |
| Status dot centre − host x-height centre | −1.40 (cap height chosen: the host has digits and ascenders) |
| Back chevron centre − label cap-height centre | −0.33 (same offset as the dot) |
| Restart / speed box centre − play centre | 0.008 (sub-pixel from the text line box) |
| Readout digits' cap centre − play centre | +0.33 (readout nudged 1px down; line-box centre was −0.67) |
| Speed label cap centre − play centre | +0.33 (same nudge) |
| Speed chevron centre − label cap centre | −0.35 |
| Dot box left − play left − first bar left | 0 / 0 at 300, 320, 360, 400, 480, 600px |
| Theme toggle right − speed right − last bar right | 0 / 0 at the same widths |
| Bars | One width (3px, whole device pixels); gaps 2px, or one device pixel wider where the width can't be split evenly |
| Rendered content area − canvas ascent + descent | 0 (sanity check that the metrics match the drawn font) |

e2e asserts all of these within ±0.5px.

## Performance per 250ms poll

| View | Before | After |
| --- | --- | --- |
| List, idle (all.html) | 1.08 layouts, +4.5/−4.5 nodes, 17 attribute writes | 0.5–0.7 layouts, +1.7/−1.7 nodes, ~3.7 attribute writes |
| Detail, paused | 1.08 layouts, +4.8/−4.8 nodes, 27 attribute writes | 0 layouts, +0.2 nodes, ~2 attribute writes |
| Child detail, paused (noisy) | +10.8/−10.7 nodes, 26.5 attribute writes | +2.2 nodes, ~3.3 attribute writes (list isn't patched behind the detail view) |
| Detail, playing | 16.3 layouts, +4.8 nodes, 85 attribute writes | ~17 layouts, +1.3–2.2 nodes, ~35 attribute writes |
| Long tasks | 0 | 0 |

Where the churn came from: `hostEl.textContent`, `timeEl.textContent`,
`playBtn.innerHTML`, the status label, `aria-*`, `slider.max/value`, and
the detail's state and sibling lines were rewritten on every poll even when
unchanged. Each now writes only on change (`setText`, `setAttr`, guarded
property writes). The playing detail view's ~17 layouts per poll are the
playhead glide: one `requestAnimationFrame` per frame moves the curve dot
and the slider thumb, at about 0.12ms of layout per frame. The dot and its
guide line now move with a transform instead of rewriting `cx`/`cy`/`x1`/`x2`.
The slider thumb still needs layout. It's off under reduced motion.

## Motion

Reviewed against the emil-animations and emil-performance guidance.

| Where | Before | After | Why |
| --- | --- | --- | --- |
| Drill-in / back | Instant | Instant | Used constantly, often from the keyboard (Enter / Esc). Animating it would make a power tool feel slower. |
| Group expand | Instant rows, 140ms chevron rotation | Same | Same frequency argument. The chevron rotation is a transition, so it's interruptible, and it's off under reduced motion. |
| Press feedback | `scale(0.97)` on every button, including segmented tabs | `scale(0.96)` on discrete buttons; none on segment tabs or rows | Tabs inside a track are high-frequency toggles; scaling them looks wobbly. |
| Theme switch | Every button's colour tweened over 140ms | Swapped at once (`.no-transitions` for two frames) | A theme change shouldn't animate dozens of controls independently. |
| Status dot | (new) | 200ms colour/halo transition; none under reduced motion | Colour only. The box never changes size. |
| Transitions | Named properties already (no `transition: all`) | Same | |
| Curve playhead | Attributes per frame | Transform per frame | Fewer attribute writes per frame. |
