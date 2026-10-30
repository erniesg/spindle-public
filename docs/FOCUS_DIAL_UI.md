# Focus dial UI (portal Pomodoro)

First real product consumer of the shared UI for [issue #134](https://github.com/erniesg/spindle/issues/134) (timer vertical of [#92](https://github.com/erniesg/spindle/issues/92)). It puts the owner-approved **Lock-in focus-timer composition** on the existing portal Pomodoro screen. It is a Linux-served-web slice. It does not complete the life-dial or whole-UI parity, and it is not Mac, WKWebView, installed-extension or human visual acceptance.

## Which dial this is, and which it is not

| Source in the export | What it is | Used here |
| --- | --- | --- |
| `dist/lock-in.js` `.li-clock` and `dist/lock-in.css` | The **focus-timer ring**: remaining time, phase, progress arc, Start/Pause/Resume controls, a "Timing" disclosure | **Yes.** This is the one product timer, so it is the applicable first slice |
| `dist/life-dial.js` | An **age / life-in-weeks canvas** on the landing page. It is not a timer | **No.** It is not relabelled as a timer. No profile age is invented. Still open (below) |

No retained decision selects a different owner dial for the timer. If one exists, the evidence should be reported before this choice is replaced.

## Source and provenance

Export `ba2f72a002` (Sites v85), `ui/prototype` at `6a86395`, Lock-in files verified by SHA-256:

- `dist/lock-in.js` `3375ae0811c064994250cfa17ecd18ceba72392b4b1f6a7b875e8fbbd6c50de7`
- `dist/lock-in.css` `fde2f0fd34c236aea8ba3d24709fc394e54013aff9519cd764385523b3224cf2`

**Preserved:** SVG `viewBox 0 0 300 300`, centre `150,150`, radius `141`, `pathLength 1`, the `.8` hairline track, the `2` round-capped progress arc, the rotate-`-90deg` start, the 236 px dial (220 px under 680 px), 62 px (56 px compact) tabular central time, the lowercase phase word, the uppercase state eyebrow, centred actions, the closed "Timing" disclosure with its summary line and 25/50/90 presets, and the open layout with no nested tiles. The arc is the source's `remaining / duration`: it draws nothing at the start and closes at the end. The `fd-*` classes in `core/pomodoro/focus-dial-style.ts` map to the source's `li-*` rules, expressed only through the shared `--sp-*` tokens.

**Not taken:** `lock-in-state.js`, `localStorage`, demo tasks, blocks and history, the activity picker, the "Distractions" section, the commitment links, and the prototype's *"break follows automatically"* claim. The product's finished phase waits for the owner ("Phase complete — start the next phase when you are ready"), so that wording is kept and the claim is not copied. No fake unsupported controls were added.

## Code

- `core/pomodoro/focus-dial.ts`: browser-safe and pure. `createFocusDial(document)` builds the state label, ring, central time and phase word. `update({phase,status,remainingMs,totalMs})` only paints values it is given. It has no imports, timers, storage, network or HTML sinks, and it is tested for that. SVG nodes use `createElementNS` when available.
- `core/pomodoro/focus-dial-style.ts`: shared-token-only styles (no palette literal, no token override, every `var()` is a defined token), plus the `@font-face` rules.
- `core/account/portal/pomodoro.ts`: **presentation only.** It now builds the screen from the dial and the shared `core/ui` primitives (`button`, `textField`, `statusRegion`, `setStatus`). The timer logic is unchanged: `PomodoroClient`, the `/pomodoro/read` and `/pomodoro/command` adapters, the failure classification and the 250 ms redraw and 2 s poll are the same as before. The ring and time come from `timer.remaining()` and the snapshot's actual phase duration, so there is no second clock, no persistence and no backend change. Mount never starts or resets a timer, and an uncertain command is never replayed.
- Preserved selectors and data attributes: `.pomodoro-view`, `data-pomodoro-state|status|revision|session`, `data-pomodoro-action`, `.pomodoro-countdown`, `.pomodoro-phase`, `.pomodoro-focus-minutes`, `.pomodoro-break-minutes`, `.pomodoro-refresh`, `.pomodoro-error`. The countdown stays an `<output aria-label="Remaining time">` and gains `role="timer"`, so it is no longer announced every second.
- `core/account/portal/page.ts`: the stylesheet is now shared UI CSS, then portal layout rules using shared theme tokens, then the dial CSS. The page links `/portal/fonts.css`.
- `core/account/portal/assets.ts`: allowlist entries only: `focus-dial.js`, `ui/dom.js`, `/portal/fonts.css` and the two font files plus their licence notices. The Node-only `ui/styles.js`, `ui/theme.js` and `focus-dial-style.js` are not served as modules.

## Fonts (DM Sans and Instrument Serif)

Parity is claimed only with the approved faces. The binaries stay out of Git and out of release assets.

- Input is explicit and hash-bound. Set `SPINDLE_FOCUS_DIAL_FONT_SOURCE` to the retained export's `dist` directory (the one holding `instrument.woff2` and `fonts/`). `tools/focus-dial-fonts.ts` verifies SHA-256 against its manifest, then stages copies in the ignored `.local/focus-dial-fonts` and emits them flat into `build/core/account/portal/`. Flat output means `package_files()` already includes them.
  - `instrument.woff2` `5eb09b5ac0e28b67c2f041c8ba6d244604ca0c0980d65912ab2d47fed84ddc31`
  - `fonts/dm-sans-normal.woff2` `9fea608a947e67020c33cad9a6fe3d60c54119dfb8cff87768a8117a15ed7543`
  - `fonts/dm-sans-OFL.txt` `9af36190332437f5ecd09974de43c1f7c77a310a996cdd8ceb25628b458840e1`
- A wrong hash fails the build. With no input and nothing staged, the build succeeds and records `fonts: {status: "absent"}` in `build.json`. The portal then serves 404 for the fonts and falls back to system faces, and nothing claims parity.
- No CDN and no network fetch. No host path is in the product source.
- **Licence notices:** the export supplies DM Sans OFL. The missing Instrument Serif notice is now retained at `assets/licenses/Instrument-Serif-OFL.txt` from [Google Fonts upstream](https://raw.githubusercontent.com/google/fonts/main/ofl/instrumentserif/OFL.txt), copyright 2022 Instrument Serif Project Authors, SIL OFL 1.1. `fc-scan` identifies the retained font as Instrument Serif. Its notice SHA-256 is `b6b2292aa580937fb63796878d65a027a27f8c3db2d97601d0c34d9031f4ca17`; staging verifies and includes it beside the fonts. No licence/font network fetch occurs at build time.
- The Instrument Serif italic and the Caveat, Newsreader, Fraunces and Manrope faces are not used by this screen and are not staged.
- Actual load is verified by `document.fonts` (`FontFace.status === "loaded"` and `document.fonts.check`), not by the CSS family name.

## Build identity

`build.json`'s `bundleSha256`, shown in the shell footer as "UI …", is computed over the portal modules plus the renderer, its styles, the asset allowlist, the shared `ui/theme.js`, `ui/styles.js` and `ui/dom.js` and the font hashes. A token, primitive or dial change therefore changes the displayed hash. `tests/pomodoro/focus-dial-assets.test.ts` and `tests/test_package_preview.py` recompute it.

## Hunks outside the listed ownership (for the coordinator to reconcile)

- `core/tracking/server.ts`: one token, `font-src 'self'`, in the `/portal` response CSP. Without it the browser blocks the portal's own fonts (`default-src 'none'`).
- `tests/account/portal-shell.test.ts`: two entries added to its explicit module-closure list (`focus-dial.js`, `ui/dom.js`).
- `tests/account/portal-pomodoro.test.ts`: the test double installs itself as the global `document`, because the shared primitives create elements on it.
- `tests/account/portal-pomodoro.e2e.ts` (two-client harness) is **not** updated. It fails the same way on base `73cf49b` (it never finds its `Account` field), so it needs its own repair. When repaired it must also allowlist `core/pomodoro/focus-dial.js` and `core/ui/dom.js`, and open the closed Timing disclosure before filling the duration fields.

## Checks

```sh
NODE_OPTIONS=--max-old-space-size=512 SPINDLE_FOCUS_DIAL_FONT_SOURCE=<export>/ui/prototype/dist npm run build
node --max-old-space-size=256 --test --test-concurrency=1 build/tests/pomodoro/focus-dial*.test.js build/tests/account/portal-pomodoro.test.js build/tests/account/portal-shell.test.js
python3 -m unittest tests.test_package_preview tests.test_portal_package
```

Optional provenance test: with `SPINDLE_FOCUS_DIAL_FONT_SOURCE` set, `focus-dial.test.ts` also checks the Lock-in files' hashes and that the constants and wording match them.

## Evidence limits

The browser proof is Linux Chromium 1228 against the actual temporary account server and actual API, with an invented account, no Google or model calls, and no mocked account or session. It shows served-web behaviour only. It is not a Mac, WKWebView, installed-extension, Windows or human visual acceptance, and publication of the images and recording is the coordinator's step.

## Integration and acceptance

The separate optional, view-only life-dial is described in [LIFE_DIAL_UI.md](LIFE_DIAL_UI.md); it does not invent or store profile age. Shared tokens/primitives and consumer guards cover the migrated surfaces listed in [SHARED_UI.md](SHARED_UI.md), not every tracking, blocking or application layout.

[#134](https://github.com/erniesg/spindle/issues/134) owns remaining approved-composition and cross-surface visual acceptance, including applicable desktop/Mac/extension states and human inspection. Source reuse, a served-web capture or an enforced import check is not that acceptance. Source-bound captures/reviews and platform limits belong in the implementing PRs, not a pending review-count checklist here.
