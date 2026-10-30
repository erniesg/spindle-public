# Chrome companion for the installed Spindle app (Mac test candidate)

Status: **source module only.** `core/preview/chrome-install.ts` is implemented and tested against a synthetic package in a temporary home. The app button and routes now call this module (`core/preview/app.ts`, `ui.ts`). Installed Chrome connection/enrollment and revision-specific native proof belong in [#135](https://github.com/erniesg/spindle/pull/135) and [#143](https://github.com/erniesg/spindle/pull/143); source wiring alone does not establish them. Windows keeps its current [Enroll Browser](CAPTURE_PREVIEW.md#explicit-chrome-enrollment-each-ordinary-profile) path unchanged.

## Recipient steps (no Terminal, repository, CLT or Python)

1. Open **Spindle.app**. Click the app's Chrome companion button. The app copies the compiled extension from its own verified bundle to the stable folder `~/Library/Application Support/SpindlePreview/chrome-extension` and opens it in Finder. The folder stays the same across app updates, so Chrome keeps the same extension ID.
2. In Chrome, open `chrome://extensions`, turn on **Developer mode**, then click **Load unpacked** and pick that folder. This is an explicit test-candidate step. The extension is not from the Chrome Web Store.
3. Copy the extension's public 32-letter ID (letters `a`–`p`) into the app and confirm. The app registers the existing `ai.berlayar.spindle.preview` native host for that ID only.
4. Pair the profile in the extension options with the app's pairing code, as in [Capture Preview](CAPTURE_PREVIEW.md). Pairing, the profile token store, per-site permission, pause, blocking and recovery all stay as they are. Nothing is seeded.
5. Readiness: the app shows the companion as ready only after it sees a real pairing or host connection over its IPC. A registration file alone shows **registered, unverified**. Incognito/private windows are unsupported.

## What the module writes (Mac only)

| File | Contents |
| --- | --- |
| `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/ai.berlayar.spindle.preview.json` | Host manifest for one `chrome-extension://ID/` origin, pointing to the launcher below |
| `~/Library/Application Support/SpindlePreview/chrome-bridge/Spindle Chrome Host` | `/bin/bash` launcher: `exec '<app>/runtime/node' '<app>/build/core/preview/browser-host.js' "$@"` |
| `~/Library/Application Support/SpindlePreview/chrome-bridge/chrome-bridge-receipt.json` | SHA-256 of every file this module wrote, plus the source and package fingerprint |
| `~/Library/Application Support/SpindlePreview/chrome-extension/` | Byte copy of the bundle's `build/browser-extension/preview/*` files |

The signed bundle is only read, never modified. Before writing anything, the module checks the bundle against its own `preview-build.json` (schema, clean source, macOS target, fingerprint). That covers `runtime/node`, `package.json`, every `build/core` file and every extension file. A missing or changed file fails as `CHROME_BUNDLE_STALE`. Nothing is downloaded. The module adds no permissions, `key`, `externally_connectable` or host permissions. It reads or copies no API key, cookie, profile token or Keychain item.

## Safety rules

- Only a public `[a-p]{32}` extension ID is accepted. An app path containing quotes, `$`, backslashes or control characters is refused, because it is embedded in the launcher.
- Symlinks in any path segment are refused. A host manifest, launcher or extension folder that does not byte-match the receipt is a conflict. This includes a registration from the older `Enroll Browser.command`. The conflict is preserved and never overwritten. Remove that registration first with its original package.
- Reinstalling for a new ID or a new app version replaces only files that still match the receipt.
- Removal checks every owned file first and then deletes only those files. It never touches encrypted history, `connection.json`, the Keychain item, OS permissions, unrelated native hosts or Chrome's own extension state. Remove the unpacked extension in Chrome yourself.

## Interface for the app coordinator

```ts
inspectChromeNativeHost(extensionId, resourceRoot, {home, platform?}) // -> ChromeStatus
stageChromeExtension(resourceRoot, {home, platform?})                 // -> {directory, source, fingerprint}
installChromeNativeHost(extensionId, resourceRoot, {home, platform?}) // -> ChromeStatus
removeChromeNativeHost({home, platform?})
```

`ChromeStatus.connection` is always `'unverified'`. Call these only behind the app's existing local CSRF check and an explicit user gesture. `tools/enroll-browser.ts` is a developer CLI over the same functions. Recipients do not need it.
