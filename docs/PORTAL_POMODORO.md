# Portal Pomodoro view

`core/account/portal/pomodoro.ts` exports `mountPomodoro(context: PortalContext) => () => void`, the portal's Pomodoro vertical. It mounts the existing account-wide timer described in [POMODORO.md](POMODORO.md) inside the authenticated portal shell. It adds no timer semantics.

## Boundaries

- **Identity:** the shell creates, restores and signs out the account. The view never signs in or out, never stores credentials and never reads cookies. On unmount it retires only its own local view. Server-side the timer keeps running.
- **Backend:** reads use `POST /pomodoro/read` and commands use `POST /pomodoro/command`, both through `context.client.request(path, body, context.signal)`. That keeps the shell's cookie, CSRF, Origin and account generation authoritative. Responses are checked against the signed-in account UUID, so the view never paints another account's timer.
- **Timer semantics:** the view reuses `PomodoroClient` from `core/pomodoro/client.ts` unchanged: CAS `expectedRevision`, unique operation IDs, one request at a time, freshness and wall/monotonic checks, and no queued or replayed commands. The countdown comes from the server deadline and `serverNow`. The view does not keep a local tick clock, a localStorage timer or a second store.
- **Privacy:** mounting only reads the timer. The view never starts one on its own. Starting a timer does not start recording, capture or notifications.
- **Rendering:** the DOM is built with `createElement`/`textContent` only, with no `innerHTML`. Lane classes use the `pomodoro-` prefix and data attributes use `data-pomodoro-*`. The view uses the shared vocabulary `.portal-card`, `.portal-actions`, `.portal-status`, `.portal-badge`, `.portal-muted` and `.portal-error`. The coordinator owns the CSS.

## States

`data-pomodoro-state` on `.pomodoro-view` is one of:

| State | Meaning | Controls |
| --- | --- | --- |
| `loading` | First read in progress | Hidden |
| `online` | Snapshot confirmed within the last few seconds | Enabled for valid transitions |
| `pending` | Command sent, waiting for the server | Disabled |
| `stale` | Last confirmation is too old; the next poll refreshes it | Disabled |
| `conflict` | Server refused with 409 (stale revision or transition) or 400. The command did not apply. The view immediately runs a read to reconcile and does not resend the command. | Disabled until the read finishes |
| `uncertain` | The command's response was lost, so it may have committed. The poll or Refresh reads the current state. The command is never resent. | Disabled |
| `offline` | Read failed | Disabled |
| `signed-out` | Account session ended (401/403/`SIGNIN_REQUIRED`/`ACCOUNT_CHANGED`). The timer is cleared and `context.onError` is reported once so the shell can restore or sign out. | Hidden |
| `unsupported` | Service has no timer route (404/405) | Hidden; Refresh disabled |

`data-pomodoro-status`, `data-pomodoro-revision` and `data-pomodoro-session` show the canonical server status, revision and session ID. They let the browser journey prove that two clients show the same server session and revision.

Lifecycle: the view redraws every 250 ms and polls every 2 s while the document is visible. It also refreshes when the page becomes visible again. Aborting `context.signal` or calling the returned function clears both intervals and the `visibilitychange` listener, bumps the client generation so late replies are dropped, and empties `root`. The view creates no Blob URLs.

## Checks

```sh
NODE_OPTIONS=--max-old-space-size=512 npm run build
node --max-old-space-size=256 --test --test-concurrency=1 build/tests/account/portal-pomodoro.test.js
```

The unit test uses the actual account HTTP service and `AccountClient` (real cookies, Origin and CSRF). The DOM is a minimal labelled test double, because Node has no DOM. It covers:

- two clients sharing one session and revision through start, pause, remount and reset;
- a 409 conflict that is shown and reconciled without resending;
- a lost response that is reported as uncertain and not resent;
- abort and teardown, including dropping late replies;
- a session ending, with one report to the shell;
- a labelled 404 fixture rendering as unsupported.

### Browser journey (coordinator-scheduled)

```sh
SPINDLE_RECORDING_DIR=/private/run-owned/dir node build/tests/account/portal-pomodoro.e2e.js
```

This runs actual Chromium against the actual account service, in two independent browser contexts on the same invented account. It records video and screenshots into `SPINDLE_RECORDING_DIR`. This journey predates the served /portal shell, so a **lane harness document stands in for the shell**. Playwright fulfils only the static `/portal-pomodoro-harness/*` document and an exact allowlist of compiled modules under the real origin. All `/signin`, `/session`, `/logout` and `/pomodoro/*` traffic goes to the real backend unintercepted. Signin happens through the real browser-cookie `AccountClient`; auth and localStorage are never seeded. The journey should now target the served shell instead.

Scenario: sign in on both clients → Start (2–3 min focus) → the second client shows the same session and revision through its ordinary poll → Pause on the second client → the first client shows paused → reload restores the paused time from the cookie and server → a raw command without CSRF gets 403 → Reset shows on both → the server restarts and the timer survives → sign out clears the view.

**Proof limits:** two browser contexts prove browser sync only. They are not native multi-device, installed Mac or Windows, or desktop timer acceptance. Those depend on the native onboarding path and an actual Mac.
