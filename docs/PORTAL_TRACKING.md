# Portal tracking view (lane, partial)

`core/account/portal/tracking.ts` exports `mountTracking`, a `PortalView` (see `core/account/portal/types.ts`). The shared shell creates, restores and signs out the account and owns navigation and CSS. This view only reads the existing authenticated account API through `context.client.request`. Cookies, CSRF, origin and account checks stay with `AccountClient` and the server.

## What it shows

| Area | Source | Truth rules |
| --- | --- | --- |
| Devices | `GET /devices` | Name and last accepted upload time, or "No accepted upload yet". The server reports `pending`/`uploadError` as `unknown`, so the view says waiting uploads and upload errors are not reported to the account. A registration is not proof of native hardware. |
| Shared history | `GET /history?cursor=N&limit=16` | Pages in ascending sequence order, up to 4 pages per sync and then "Load more". Later sync continues from the last cursor. Rows are merged by key, so a re-sequenced revision or tombstone replaces the earlier row. Malformed entries, entries past the cursor and regressing cursors are counted or rejected; nothing is repaired into plausible activity. Expired context shows "Details expired". Images are never rendered. |
| Time summary | `GET /sessions?from&to` | Last 24 hours or 7 days. Person time is the server's overlap-swept value, plus per-device time, visit count, unobserved gaps and clock anomalies. `413` shows "choose a shorter range". |
| Sync state | — | "Up to date as of …", or an error with retry. On failure the view keeps what it last loaded and retries after 2s, 4s and so on, up to 60s. It retries immediately on `online` or when the page becomes visible. It polls every 30s only while visible. A `401` or `SIGNIN_REQUIRED` stops and calls `context.onError` once, and `404` reports that the service has no device history. |

Reload or a fresh mount reads everything from the backend again. Nothing is stored in localStorage or cached across mounts. A reply that lands after abort, unmount or an account change is dropped before painting. Unmount aborts requests and clears the timer, all listeners, held entries and the root. The view creates no Blob URLs. Every backend value is set with `textContent`, and classes are prefixed `tracking-` alongside the shared `portal-*` vocabulary.

## Mac-first onboarding (guidance, not control)

The onboarding steps follow the existing route in [CAPTURE_PREVIEW.md](CAPTURE_PREVIEW.md) and [TRACKING_API.md](TRACKING_API.md). Each step carries an honest state:

1. **Account**: done (from the shell).
2. **Package**: *unavailable here*. No trusted package-metadata endpoint exists, so the view does not invent a URL. The next step tells the user to use the private Mac ZIP and checksum from the implementation PR, verify the checksum with `shasum -a 256` and extract into a private folder. It states Apple Silicon and macOS 15+ requirements. The packaged launch uses bundled Node and a precompiled native helper, with no recipient-side repository, Python, CLT or SDK. A real producer build and exact-ZIP installed proof remain separate required evidence; a VM structural check is not a Mac installation.
3. **Open the preview**: action on the Mac. It starts paused, and the user must never bypass Gatekeeper.
4. **Accessibility and Screen Recording**: listed separately as *not visible here*. The user grants each in System Settings.
5. **Recording, retention, pixels and sync**: separate choices made in the local app. Signing in never enables them.
6. **Connect this Mac**: derived from `/devices` (done when a device exists). It shows the exact service origin and account name to enter.
7. **Chrome companion**: Load unpacked, `Enroll Browser.command EXTENSION_ID`, pairing and per-site allow. Incognito and private windows are unsupported.
8. **Start/Pause**: only in the local app. This page cannot see or change the recording state.
9. **Second device**: pending until another device actually connects and syncs.

## Missing shared adapters (coordinator-owned)

- **Trusted package metadata** (for example an authenticated `GET` returning platform, version, source/build ID, size, SHA-256 and a non-signed-URL download route). Until it exists, the package step stays `unavailable`.
- **Native readiness bridge**: the local app's state (paired, Accessibility, Screen Recording, consents, recording/paused) for this account and device. Until it exists, those steps stay `unknown` and the view never emulates them.
- **Per-device pending/error reporting** from collectors: the server currently returns `unknown`.

## Checks and evidence labels

- `tests/account/portal-tracking.test.ts`: uses a labelled minimal fake DOM, with no browser and no visuals.
  - Fixture-API tests cover paging, tombstone merge, skip/reject, XSS-as-text, backoff/reconnect, sign-in loss and stale-account drop, and unmount cleanup.
  - A real-backend test uses `startTrackingServer`, a real `AccountClient` and invented `TrackingClient` uploads. It covers devices/history/summary, remount persistence, isolation between accounts and sign-out.
- `tests/account/portal-tracking.e2e.ts`: a standalone one-browser journey that records video and screenshots.
  - It uses a real server and real Chromium with browser cookies, and no routed or mocked requests. The sign-in form is a labelled harness standing in for the shell, and uploads come from a simulated device.
  - It is **not** native Mac, installed, permission, enrollment or multi-device acceptance. Run it only when the coordinator schedules it (command in the file header).
