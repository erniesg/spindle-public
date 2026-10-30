# Life in weeks in the Workspace

The account portal's Pomodoro view (`/portal/#pomodoro`, after signing in and choosing to view the workspace) has a separate **Life in weeks** card. It does not replace the synchronized focus timer or add another focus clock. This is the smallest optional, per-view age illustration, not whole-UI parity or a persistent profile feature.

The numeric field starts empty: the neutral week face has no hand or age centre, and says **No age supplied**. Explicit input accepts whole-year ages 0–130. Negative, fractional, nonfinite and greater-than-130 inputs are invalid; this is an input bound, not a life-expectancy rule. Weeks are `floor(age × 4174 / 80)`, an approximation from whole years, not a birth-date calculation. For example, invented age 23 shows an estimated 1,200 weeks.

The face is explicitly an illustrative **80-year / 4,174-week grid, not a lifespan prediction**. Ages over 80 remain visible as entered (with their estimated weeks), while dots and hand stop at the grid's 80-year boundary and a beyond-grid note explains why. Graphite dots represent estimated earlier weeks, gold the entered year, and pale dots later weeks within the illustration. With no valid age all dots are neutral. A browser without a working canvas reports **Canvas renderer unavailable**, not success or a substitute picture.

## Source and boundaries

`core/ui/life-dial-geometry.ts` is a browser-safe typed ESM port of the owner's approved complete-site export:

- Export snapshot `ba2f72a002fa985cddeb309b84cda1afcc4f0fda`, Sites v85, received 28 October 2026.
- `ui/prototype/dist/life-dial.js`, SHA-256 `dbf6461a462ccbf7c51646e41e62e286f7a3691b38c4771498156cb9a12480ff`.
- The export's `ui/prototype/PROVENANCE.json` and `README.md` record provenance (see [shared UI design source](SHARED_UI.md#design-source)).
- Retained: exact year-boundary math, radial week-point geometry, face ticks/labels, default taper hand shape and age-angle semantics. Unused hand variants, animation, global/CommonJS wrapper and hard-coded font fallbacks are omitted. Shared `--sp-*` roles provide canvas colors and fonts. Existing verified local font staging/OFL notices are reused; system fallback remains valid.

`core/ui/life-dial.ts` owns only this local DOM/canvas illustration, reusing shared card/text-field/button/status primitives. No account/profile/schema/server or timer semantics changed. It makes no requests, writes no storage and emits no telemetry. Clear forgets the value. Route unmount/signout disposes listeners and its ResizeObserver, clears the input and canvas, and fences pending font-ready redraws. Navigating back creates an empty view.

The portal exposes only two exact new browser module URLs, both under existing self-only CSP. The geometry, component and CSS bytes participate in the portal fingerprint and package import closure. The native preview's bundled-but-unused portal modules are not native life-dial acceptance.

## Verification

Build with the existing tooling (`NODE_OPTIONS=--max-old-space-size=768 npm run build`). No new dependencies, fonts or browser downloads are required.

```sh
# Compare the port against the explicitly retained approved source as well as deterministic/HTTP checks:
SPINDLE_LIFE_DIAL_SOURCE=/path/to/approved/dist/life-dial.js \
  node --max-old-space-size=256 --test --test-concurrency=1 build/tests/life-dial/*.test.js
# Actual backend-served Workspace, existing Chromium with its sandbox enabled:
SPINDLE_CHROMIUM=/path/to/existing/chrome \
SPINDLE_LIFE_DIAL_EVIDENCE=/path/to/private/task-output \
  node --max-old-space-size=256 tests/life-dial/browser.mjs
```

The browser journey uses an invented account and age 23, actual portal HTML/modules/CSS routes, real canvas rendering (instrumented to count dots/hand rotation), HTTP timer reads and existing Chromium. It checks empty/no hand, entered age, 0/80/103/130, invalid ranges, clear, mobile layout, no age requests/storage, route cleanup and unavailable-canvas fallback. Screenshots/recording remain private local evidence, outside Git. `SPINDLE_LIFE_DIAL_BASELINE=1` captures the pre-change served view before the missing-card assertion fails.

Linux browser/source/package checks are not installed Mac/Windows proof, independent visual approval, public deployment or full integrated-journey acceptance. A fresh independent agent must review the exact revision and actual media before public enablement.
