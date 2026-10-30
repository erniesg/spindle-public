# A disposable browser-to-local connection

Click **Connect locally** and see a versioned reply from a real Native Messaging process. Try an incompatible version, disconnect and reconnect. This foundation probe collects no browsing activity and does not implement the production browser observer.

## Boundaries

- The extension has only `nativeMessaging` permission: no tabs, content scripts, URL/DOM reads, network service or incognito access.
- The host accepts only a fixed `hello` request with a bounded integer correlation ID and probe schema. Frames are at most 4096 bytes; malformed/truncated input and invalid callers fail with fixed codes. Replies never echo arbitrary content or errors.
- Chromium's `allowed_origins` restricts which extension can start the registered host. The host also checks the caller argument's shape. This is **not** authentication against another process running as the same OS user; that user can invoke the executable themselves. There is no privileged API or secret to unlock.
- The browser check generates its own extension key/ID, launcher, host manifest and disposable profile under `.local/`. Registration is inside that profile, never the user's normal Chromium configuration. Profile/registration/launcher are removed on completion; remaining receipts/media stay bounded for review.
- The disposable registration runner is Linux-only. A real Linux browser round trip is not proof of Mac/Windows registration, installed enrollment, browser capture, privacy filtering or production IPC. `spindle-browser-probe/v1` is an exploratory handshake, not the shared visit/context contract.

## Fast process/protocol checks

Node 22+; install the repository's pinned development dependencies and build first. The host/extension run generated JavaScript without runtime npm dependencies:

```sh
npm ci --ignore-scripts
npm run build
node --test build/browser-extension/connection-probe/tests/host.test.js
```

These spawn the actual host and exchange binary Native Messaging frames, including unsupported versions, malformed/oversized/truncated input, caller rejection and process exit at pipe closure. They do not launch a browser.

## Real-browser check and optional recording

Run `npm run build`, then use a development host with Chromium support. Pinned development-only `playwright-core` supplies the driver/types; no browser is downloaded by `npm ci`. The runner loads only the built extension and host. Install browser binaries into an ignored task directory, not global/browser-profile configuration:

```sh
PLAYWRIGHT_BROWSERS_PATH="$PWD/.local/probe-browsers" PLAYWRIGHT_SKIP_BROWSER_GC=1 node_modules/.bin/playwright-core install chromium ffmpeg
PLAYWRIGHT_BROWSERS_PATH="$PWD/.local/probe-browsers" node build/browser-extension/connection-probe/tests/browser.e2e.js
```

An already installed compatible Chromium may be selected with `SPINDLE_CHROMIUM_EXECUTABLE`. Tool/browser caches may be reused read-only; do not prune shared caches. Add `SPINDLE_PROBE_RECORD=1` for a readable recording. Every run creates a fresh `.local/browser-connection-*` directory and prints its location. The clean page contains no personal accounts, browser chrome, session tokens or activity.

The journey checks real handshake, incompatible-version response, disconnect, browser rejection of an unlisted extension before host launch, missing registration, reconnect, phone-width layout and native-process exit. No provider response is injected. The browser/profile run is initiated only by this explicit development command.

Keep build/source identity, current results, reviewed recording links and any missing environments in the PR, not this reusable guide. Inspect recordings locally before approved private publication; do not upload raw profiles or PID/debug files. After preserving needed review evidence, remove only the task's generated directories/tools; keep referenced artifacts until review closes.
