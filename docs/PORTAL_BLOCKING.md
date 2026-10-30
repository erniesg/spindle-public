# Portal blocking view (lane)

`core/account/portal/blocking.ts` exports `mountBlocking(context: PortalContext)`.
The central shell mounts it after signing in or restoring a real account. It shows:

- the current whole-site policy: host, scope, version, state, and whether the browser has applied it
- extension and native-host readiness, including an explicit **Unsupported** state
- adding or replacing a whole-site rule
- explicit pause (5, 15 or 30 minutes), resume, and **Remove block / recover access**
- recovery text, and a disclosure that Private/Incognito windows are unsupported

The optional allowed purpose does not gate a whole-site rule. The view never calls a
model or the purpose path.

## Authority and what this view does not do

The only authority over blocking policy is the enrolled extension's existing
`sitePolicy` journal ([SITE_BLOCKING.md](SITE_BLOCKING.md)). This view keeps no
policy store, timer, history or local/fake block. The pause countdown only refreshes
the display; when it ends, the view re-reads state instead of assuming that the pause
ended. Untrusted values are written as `textContent`. Unmounting, a shell abort or an
account change stops listeners and the countdown, and discards late replies.

## Account adapter contract (owned by the coordinator, not yet served)

Every call goes through `context.client.request(path, body, signal)`, so the
existing cookie, CSRF and origin checks still apply. All routes are `POST` with JSON.

| Path | Body | Reply |
|---|---|---|
| `/blocking/status` | `{}` | `BlockingSnapshot` |
| `/blocking/rule` | `{expectedRevision, host, subdomains, purpose}` (`purpose` may be `""`) | `BlockingSnapshot` |
| `/blocking/pause` | `{expectedRevision, minutes}` (5, 15 or 30) | `BlockingSnapshot` |
| `/blocking/resume` | `{expectedRevision}` | `BlockingSnapshot` |
| `/blocking/remove` | `{expectedRevision}` | `BlockingSnapshot` |

```ts
interface BlockingSnapshot {
  revision: number; // safe integer ≥ 0; a mismatched expectedRevision → HTTP 409
  readiness: {
    state: 'ready'|'enrollment_required'|'native_host_absent'|'site_access_required'|'unsupported'|'unknown';
    browser: 'chrome'|'unknown'; platform: 'mac'|'windows'|'other'|'unknown';
    observedAt: string|null; // when the extension last reported
  };
  policy: null | {
    host: string; subdomains: boolean; purpose: string; version: number; // version ≥ 1
    state: 'active'|'paused'|'pending'|'cleanup_incomplete';
    pausedUntil: string|null; // non-null exactly when state is 'paused'
    appliedAt: string|null;   // null until the extension confirms
  };
}
```

`parseBlockingSnapshot` validates replies strictly. A reply that does not match is
shown as unknown and reported through `onError`. HTTP status mapping:

- 404, 405 or 501: not connected yet. The view says nothing was changed and points to the extension controls.
- 401: sign in again.
- 403: request refused.
- 409: the policy changed elsewhere. The view re-reads state and shows the current policy.
- 429: another change is in progress.
- 5xx: service unavailable.

What the adapter must do:

1. **Relay to the extension's journal; do not copy it.** The policy must reach the
   extension's own `site-block` and `site-remove` controls, for example through the
   authenticated native-host session or an `externally_connectable` bridge. Status
   must report what the extension last confirmed (`appliedAt`, `observedAt`), not
   what was requested.
2. **Pause is a new extension operation.** The extension has no pause today. It needs
   a bounded, journaled pause that the extension itself ends, so blocking resumes even
   with no portal tab open.
3. **Site access is granted in the extension.** Chrome only grants host access from
   an extension page in a user gesture. If access is missing, report
   `readiness.state: 'site_access_required'`.
4. **No unsupported claim of readiness.** If no enrolled extension or native host is
   connected, report `native_host_absent`, `enrollment_required` or `unsupported`,
   never `ready`.

## Checks

- `tests/account/portal-blocking.test.ts` uses a source/test fixture (fake DOM and
  fake client). It covers:
  - the not-connected state
  - a whole-site rule without a purpose
  - hostname validation that keeps typed input
  - pause, countdown, resume and remove
  - re-reading state when a pause ends
  - 409 re-reads
  - the Unsupported state
  - inert purpose text
  - dropping late replies after unmount, shell abort or account change
  - rejecting malformed replies

  It is not browser, extension or native evidence.
- `tests/account/portal-blocking.e2e.ts` is a standalone journey, run only when the
  coordinator selects the effect. Its default `portal` effect uses the actual server
  and an invented account with no backend interception. The compiled lane module is
  injected into the real `/connections` origin, which is disclosed in its results.
  It exits 3 (`HELD_ADAPTER_UNWIRED`) until the adapter exists. The
  `SPINDLE_BLOCKING_EFFECTS=extension` effect loads the built extension into a fresh
  profile and checks four things on an invented host: navigation is blocked, a pause
  allows it, resume blocks it again, and removal allows it. It never enrolls, grants
  permissions or changes native state; if any of these is missing it exits 3 with
  `HELD_EXTENSION_NOT_READY`. A pass in a Linux VM is not Mac or Windows installed
  acceptance.
