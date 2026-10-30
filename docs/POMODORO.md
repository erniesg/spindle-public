# One synchronized Pomodoro

[#92](https://github.com/erniesg/spindle/issues/92) owns the desktop/web/extension outcome and acceptance. Controls are wired into the existing desktop frontend, account web app and companion extension. A Linux journey exercises all three through actual account HTTP authentication, desktop HTTP/IPC, the real extension worker and Native Messaging. The desktop path runs in explicit **timer-only mode**, not native capture or an installed Windows/Mac app. The timer is also served in the account portal workspace (see FOCUS_DIAL_UI.md). Installed-app acceptance is tracked in #92, and source merge is not deployment or physical-device acceptance.

## Run the web timer locally

Use Node 22+ and the repository's pinned tooling:

```sh
npm ci --ignore-scripts
npm run build
# First create private paths/key using the account-service setup linked below.
node build/core/tracking/run.js .local/tracking-demo/server .local/tracking-demo/server.key 43166
```

First follow the existing [account-service key and data-directory setup](TRACKING_API.md#run-and-operate-invented-data-only); never commit its key. Open the printed account-service origin with `/pomodoro/app/` appended. Sign in to a Spindle account, or explicitly create an invented development account. Account sign-in does not enroll a recording device, start capture, enable notifications or call a model. The local development service binds numeric loopback; remote hosting/deployment is separate and not included here.

The timer has configurable focus/break durations (25/5 minutes initially; 1 second–180 minutes for either). Start begins focus. Pause freezes remaining time; Resume establishes a new canonical deadline. End completes the current phase. A completed phase waits for an explicit **Start next phase**, alternating focus and break. Reset returns to idle focus without forgetting duration settings. Changing the fields affects the next Start, not the active timer. Untouched fields converge to shared durations; explicitly edited drafts stay visible as unapplied drafts until Start.

Offline/stale clients show that state and disable commands. Refresh reconciles current server state; it never automatically replays an action. An uncertain command response requires a refresh, because the command may already have committed. Reloading restores the cookie-authenticated account and actual timer; signout clears the local view without ending the timer.

## Desktop and extension

Ordinary Windows/Mac preview entrypoints mount the same timer component. Sign into the timer separately from collector enrollment. Use the same shared service/account as tracking for a common account history and timer. The ordinary native preview saves the timer service origin (not credentials) in its existing OS-key-protected settings after successful signin when settings are ready; launch restores it. Collector setup also prefills the service origin. Timer signin and extension regrant remain explicit after app restart; timer-only mode remains run-local. See [account/device setup](TRACKING_API.md#practical-same-account-setup). The companion's existing options page links to actual Pomodoro controls; its toolbar capture action, blocking policy and permissions are unchanged.

An explicit desktop **Allow this paired profile to control the timer** action enables extension access only for the current timer account/binding and enrolled profile. Pairing alone never grants account access. Disable, signout/account switch, profile revoke or host quit retires the grant. Binding, profile token, cookie and CSRF are never rendered into timer DOM; the pairing code is an explicit setup credential, not the profile token.

For Linux development, use the actual desktop frontend without a capture helper or native key:

```sh
node build/core/preview/app.js --timer-only --control-directory /absolute/new/run-owned-directory
```

This opens guarded desktop controls. `--no-open` is for a trusted test launcher using `runTimerOnly()`'s returned URL in memory; the CLI does not print/persist the bearer URL. Capture controls are hidden and capture APIs explicitly unavailable. This mode creates only a private lock, IPC socket and connection record; it does not adopt or overwrite an existing host. Timer-only enrollment/account login are run-local; reopening and authenticating reconciles the durable server timer. This is not installed setup/persistence acceptance.

The isolated Linux browser test installs its Native Messaging manifest only under its newly created Chromium user-data directory's `NativeMessagingHosts`. This lookup was verified on the actual Chromium build, not inferred from the default HOME config path. No global or existing profile registration is changed. Its launcher supplies `--control-directory` to the production bridge; extension messages cannot choose filesystem paths.

Timer requests use a separate worker port and host slot, not capture/revoke/purpose capacity. The host aborts actual downstream HTTP work at 1400 ms; the extension retires a request at 1500 ms, within the existing two-second bridge boundary. Disconnect/revoke aborts and retires late replies. A timeout can still follow a committed command: reconcile, never blindly replay or claim rollback. These are timer protocol bounds, not native capture performance acceptance.

## Canonical account transaction

`core/pomodoro/service.ts` is independent of capture/history. The authenticated transaction in `core/tracking/server.ts` supplies the account; no timer request accepts account/device/source identity. State and bounded receipts live inside that account's existing encrypted store. The service operator holding the encryption key can decrypt the data; this is not E2EE.

A timer has one account-wide monotonically increasing revision, session ID, focus/break phase, status, remaining milliseconds, deadline and update time. Clients render elapsed wall time from the server snapshot/deadline, not accumulated UI ticks. Suspension/reopen reads current state. Expiry completes one phase, once, with its canonical deadline as update time; it does not run unattended focus/break cycles. Polling never increments state per tick.

Commands carry a unique operation ID and expected revision. A successful mutation consumes that revision, including reset. Exact retries return current state plus the originally applied revision; changed payloads using a retained ID are rejected. Receipts retain the last 256 operations. Evicted retries still cannot reapply: their expected revision is permanently stale. Lost-response safety, CAS and persistence do not depend on a single browser tab being alive.

## HTTP/auth boundaries

| Route | Authentication and purpose |
| --- | --- |
| `GET /pomodoro/app/` and exact module/CSS paths | Public content-free assets; strict Host, no private state, restrictive CSP |
| `POST /pomodoro/session` with `{}` | Cookie + strict Origin/Host; read-only account/CSRF bootstrap |
| `GET /pomodoro` | Existing host-client Cookie/Origin checks; canonical snapshot |
| `POST /pomodoro/read` with `{}` | Browser cookie + Origin/Host + CSRF; canonical snapshot |
| `POST /pomodoro/command` | Same checks; typed CAS command |

Browsers cannot manually set Cookie/Origin and normally omit Origin on same-origin GETs. The new read-only POST bootstrap is the only new CSRF exemption; all existing API guards remain intact. Subsequent browser reads/commands require CSRF. No CORS exception or extension origin is added. Browser sessions remain HttpOnly/SameSite=Strict; the frontend stores CSRF only in memory. Authenticated timer responses carry server-selected account UUID so account switching cannot silently mix a new timer into an old identity view.

`core/pomodoro/desktop.ts` reuses device-free host `AccountClient`; it is not a second account backend. The extension's separate controls use a narrow own-page-checked runtime request, not direct cookie access, arbitrary URLs or recording commands. A host-issued per-signin binding is returned by session bootstrap and retained only in transport memory. Every desktop/extension read, command and signout must match that current binding **before** account dispatch; account-local CAS revisions alone cannot fence an account switch. Signin/signout rotate or retire binding, even when returning to the same account. The trusted host uses unbound `close()` only for teardown; it must never expose it as a client route. Shared bindings were implemented under the tracker's exclusive narrow delegation; final seam reconciliation remains tracker-owned. Profile pairing alone is not timer-account authorization.

## Checks and proof limits

```sh
npm test
node build/tests/pomodoro/web.e2e.js
# Linux, an existing Chromium binary and Xvfb (no global browser enrollment):
bash tests/pomodoro/run-surfaces.sh
```

The optional Chromium journey uses an existing local browser, selected with `SPINDLE_CHROMIUM` when necessary. It exercises actual account HTTP authentication, two independent browser contexts, control convergence, CSRF denial, offline/reset/reconnect, reload/server restart and same-profile account switching. Deterministic tests cover expiry/suspension, command races, lost responses, receipt eviction, account isolation and encrypted restart. The three-surface journey starts on web, pauses in the actual extension, resumes in desktop controls, finishes on web, starts a break in the extension and resets on desktop. It also stops/restarts the actual extension worker, restarts the account service while running (preserving the exact deadline), denies an old actual extension binding against a new account at the same revision, and verifies grant disable/profile revoke. A separate real-HTTP fault-proxy test observes cancellation, one timer slot and lost-response reconciliation; its profile callback is a unit seam, not enrollment proof. Runtime-payload ZIP/import closure is tested separately from unrun native package builds.

Adapter/dispatch unit tests alone are not extension proof; the real journey supplies that local boundary. Independently reviewed exact-build integrated media and installed Windows/Mac proof remain separate gates. Existing native capture/privacy/lifecycle findings are not waived by timer-only results.
