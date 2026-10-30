# Shared UI theme and primitives

Status: library seam for [issue #134](https://github.com/erniesg/spindle/issues/134). The web portal Pomodoro and Life views, desktop preview controls and Chrome options/blocking pages consume the shared source. Other product screens retain explicit migration exceptions below; source reuse is not installed-app or human visual acceptance.

`core/ui/` is the one source for Spindle's visual tokens and a few native-DOM primitives for account, sync and onboarding controls. Each surface's build includes the same bytes. Changing a token or primitive here, then rebuilding, changes every migrated surface. It does not update installed apps.

## Design source

The values come from the owner-approved complete-site export, snapshot `ba2f72a002` (Sites version 85, received 28 October 2026), imported unchanged in commit [`8542abf`](https://github.com/erniesg/spindle/tree/8542abfed4aa2ca7b5917d853a736ae5c5459013/ui/prototype). That commit is on the draft paper-motion branch, not `main`. Its `PROVENANCE.json` records the hashes of the source files below.

| Tokens | Source in the export |
| --- | --- |
| Colours, including hover, pressed, tint, focus and accent | `dist/palette.js` `goldgraphite` ("Graphite / lemon gold"). This is the palette selected on 27 October 2026 and the one a fresh profile gets. Hover and other derived colours are the export's own `mix()` results. |
| Status colours: neutral, working (loading), success and error | `dist/palette.js` `statusColours`, which stay the same in every palette |
| Typography: DM Sans for interface text, Instrument Serif for display text | `dist/appearance-init.js` and `dist/design-tokens.css`. The serif/Caveat title treatment in `approved-typography.css` applies only to the landing hero and closing sections, so it is not included here. |
| Type sizes, spacing, radii, control height, line and focus widths, motion timing | `dist/design-tokens.css` |
| Disabled opacity (0.5) | `dist/app.css` `button:disabled` |

Not taken from the export: its sample data and browser-local state, the appearance and palette pickers, paper effects, the history archive, font and image binaries, and the export's hosting setup. Font files are not bundled, so each font falls back to an installed system face (Arial or Georgia) unless DM Sans or Instrument Serif is installed. Bundling the fonts locally, with no network fetch, is a separate decision.

## API

```ts
import {spindleUiCss} from '../ui/styles.js';      // theme tokens followed by the primitive rules
import {tokens} from '../ui/theme.js';             // the same values as a frozen record
import {button, textField, card, statusRegion, setStatus} from '../ui/dom.js';

const name = textField('Account name', {name: 'name', autocomplete: 'username', required: true});
const password = textField('Password', {name: 'password', type: 'password', autocomplete: 'current-password', minLength: 12, hint: 'At least 12 characters.'});
const submit = button('Sign in', {variant: 'primary', type: 'submit'});
const status = statusRegion();
form.append(name.root, password.root, submit);
root.append(card('Your account', form, status));
form.addEventListener('submit', async event => {
  event.preventDefault();
  submit.disabled = true;
  setStatus(status, 'loading', 'Signing in…');
  // the surface's own account adapter runs here, then:
  setStatus(status, 'error', providerMessage);     // always set as text, never parsed as HTML
});
```

- Buttons are `type="button"` unless `type: 'submit'` is passed. The variants are `primary`, `secondary` and `quiet`.
- Each `textField` has a visible `<label for>` and an optional hint linked with `aria-describedby`.
- A `card` that has a title is a labelled region.
- `statusRegion` is a `role="status"` live region. Errors are announced assertively; loading and success are announced politely.
- The layout classes are `sp-theme` (page base), `sp-actions` (button row), `sp-title` and `sp-muted`.
- Tokens are `--sp-*` custom properties and public classes are `.sp-*`, matching the export's names.

The primitives create elements, set text, classes and attributes, and do nothing else. They own no events, data fetching, timers, storage, routing, auth or business state. They never use inline styles, so they work under `style-src 'self'`.

## Platform adapters

Visual components stay platform-neutral. Each platform keeps its own behaviour in an adapter outside `core/ui`:

- Mac: permissions, Keychain, app lifecycle and file dialogs.
- Chrome: enrollment, native messaging and DNR.
- Web: navigation, session and API calls.

Each surface also keeps its own page layout, so a compact extension panel is not a full workspace page.

## Packaging

`core/ui/emit.ts` runs only in Node during development builds. `emitSharedUi(directory)` writes `spindle-ui.css` and the browser modules (`theme.js`, `styles.js`, `dom.js`) into a surface's asset root. Every import between these modules resolves inside that set, so an MV3 extension root or the desktop app's web content needs nothing outside it. A served page can instead import `spindleUiCss` and serve it from a route.

## Checks

Enforced now, in `tests/ui/*.test.ts`, which `make check` already runs:

- The token values match the approved export.
- Text, action and status colour pairs meet WCAG AA contrast, and the focus ring is at least 3:1 against paper.
- The primitive rules contain no colour or font literals and use only defined tokens. The guard ignores property names such as `white-space`, flags ordinary named colours, a standalone quoted `font-family` and any `--sp-*` declaration outside the theme block, and is tested against planted private palettes.
- The CSS has no `@import`, `url()`, `@font-face` or network origins.
- The browser modules import only each other (including bare `import 'x'` side-effect imports) and contain no HTML sinks (`innerHTML`, `DOMParser`, `createContextualFragment`, `setHTMLUnsafe`/`parseHTMLUnsafe`, `srcdoc` and similar), inline styles, storage, network, timers or `chrome`/`webkit` bridges.
- The emitted bundle is self-contained, and its modules load before any DOM exists.
- Labels, button types, disabled state, live regions and inert text behave as described above.

Consumer checks, in `tests/ui/consumers.test.ts`, run against the real build output and are enforced for the portal, the desktop preview controls and the Chrome options and blocking pages.

- The portal (web and desktop) serves `spindleUiCss`, and its own rules contain no palette literals.
- Desktop preview controls, Chrome extension options and the blocking page link the shared stylesheet and have no inline `<style>` palette.

These checks cover stylesheet reuse and palette literals, and the portal case also checks shared-primitives imports and the served `dom.js` module. They do not by themselves prove packaged-artifact import closure, installed visual parity or human acceptance; package/asset checks and the owning issue retain those separate claims.

Surfaces not listed above, which today keep their own styles and are not covered by any check:

- Pending product migration: `core/pomodoro/{index.html,style.css}` and `browser-extension/pomodoro/pomodoro.html` (web and Chrome product surface, #92); `core/account/{google-page,mail-page}.ts`; `core/assistant/*`.
- Development-only, exempt for now: `core/capture-check/*`, `browser-extension/connection-probe/extension/*`, `tools/review_page.ts`.

This list is a plain statement of what is not migrated. It is not enforced, and an exemption here is not approval to add new private palettes.

`node build/tests/ui/gallery.e2e.js`, run after `npm run build`, is an optional Chromium check and is not part of `make check`. It serves an invented-data gallery of the same primitives under a strict CSP and blocks every other request. It checks labels, roles, keyboard order and the focus ring, inert provider text, computed token colours, and the absence of horizontal overflow at 1280, 960 and 380 px. It writes screenshots to `.local/shared-ui134/gallery/`. This is design and component proof only. It is not proof of the authenticated product, an installed extension or the native Mac app, and it is not visual approval.
