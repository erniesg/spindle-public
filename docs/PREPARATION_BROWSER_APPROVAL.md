# Owner-approved browser submission (account API)

The account API runs the reviewed [portal continuation](PREPARATION_PORTAL_CONTINUATION.md) on the **same** prepared task, runtime and stores. It is wired only to the one owned **developer-fictional** loopback form, and only when the operator turns it on. Nothing here adds a store, queue, planner, timer, ledger or provider.

## Enabling it (operator only, default off)

`startPreparationAccount` takes `developerFictionalPortal: {enabled: true, directory, chromiumExecutable, …}`. If it is absent, or `enabled` is not `true`, there is no approve/reconcile execution and `/preparation/config` reports `browserApproval.available: false`. When enabled, startup:

- starts the owned fictional portal (`core/preparation/fictional-portal.ts`, reusing `examples/application-portal`) on `127.0.0.1` and closes it on shutdown;
- builds `fictionalPortalContinuation` (`core/preparation/portal-production.ts`) from the **same** decision model, credential, model transport and budget journal as preparation;
- refuses to start if a read-only `browserPortal` is also configured.

The destination, the field mapping (prepared field ID → `applicant_name` / `contact_email` / `programme`) and the required controls come from this configuration. Neither the page, the model nor a request URL supplies them. The two file controls take the task's current prepared PDF and PNG. A file qualifies only if it is not a source snapshot, a session or draft export, or a rendered page. When several qualify, the newest current-revision file wins. The owner sees the exact file and its hash before approving. A Chromium executable is never discovered or downloaded.

`processingPaused` still holds everything: approve and reconcile return `423 PREPARATION_PROCESSING_PAUSED`.

## Routes

All three are authenticated `POST` routes with CSRF. Their bodies are bounded to 64 KiB; a measured approval is 182 bytes.

| Route | Body | Effect |
|---|---|---|
| `/preparation/browser-review` | `{taskId, expectedRevision}` | Read only. Returns the exact values, citations and correction flags; the files with their SHA-256; the destination, submit URL, receipt URL, fingerprint and required controls. When continuation is configured, a page-supplied `fields`/`files` mapping is refused with `PREPARATION_BROWSER_MAPPING_SERVER_OWNED`. No browser, model or approval is involved. |
| `/preparation/browser-approve` | `{taskId, expectedRevision, fingerprint, requestId}` | Explicit owner approval of the displayed review. A stale fingerprint is refused (`409 PREPARATION_PORTAL_REVIEW_CHANGED`) before any effect. Otherwise `202` admits one service-owned run. |
| `/preparation/browser-reconcile` | `{taskId}` | Read-only receipt check of a retained submission. Only `browser.verify_submission` is registered. |

After a `202`, `/preparation/status` reports `execution.state: running`, then `portal` (the last outcome: `verified`, `held` with a code and `interruption`, `cancelled`, or `refused` with a code), plus `browser` (the retained approval and submission facts, including the receipt) and `canReconcile`. Module codes cross the API as `PREPARATION_PORTAL_*`. Replaying the same `requestId` returns the retained verified fact. `/preparation/cancel` routes owner cancel into the run.

The model never approves anything. The approval comes from the owner's request, and the browser host enforces every fill, upload and submit against it.

## Why the run is a job, and what its authority is

The account client bounds every request to 10 s, so a held-open request would disconnect itself partway through a run. Admission is therefore synchronous, and the run is owned by the service, which `close()` awaits before closing its browser. A client that disconnects during admission (a response closed before it finished) starts nothing; a request that completes normally is not a disconnect.

The run authority is the signed-in session plus the task's bound connection, root, grant and epoch. It is **not** the task's generation, so it survives the module's own `recover()`. It retires on:

- signout or session change, root/grant/epoch change: a synchronous observer of committed auth-store writes (`EncryptedStore.observe`, `preparationBinding().observe`) runs the same check as `guardedDispatch`;
- owner cancel;
- service close.

Each browser packet and each model HTTP request starts only inside `guardedDispatch`'s final auth transaction.

The browser-phase provider is the existing `NebiusAgentProvider`, with the same per-task and global budget, session persistence and journal. Its opt-in `browserContinuation` option replaces the preparation "do not submit" policy with a trusted phase instruction, and passes the approved control/file plan as data. Without the option, its output is byte-identical to before.

## Checks and proof limits

`tests/account/preparation-browser-journey.test.ts` is a fixture pilot. It runs a real account server and API, the real adapter against a **scripted loopback model** (not an LLM, no external call), and real Chromium posting to the owned fictional portal. The completed preparation is **simulated** in the task store. Run it serially with a short `TMPDIR`:

```sh
NODE_OPTIONS=--max-old-space-size=512 npm run build
TMPDIR=/short/run-owned/dir node --max-old-space-size=256 --test --test-concurrency=1 build/tests/account/preparation-browser-journey.test.js
```

It covers four cases:

1. Happy path: one POST and a verified receipt, then an idempotent replay and a read-only reconcile.
2. A foreign owner, and a changed or stale review: no effect.
3. Owner cancel while the adapter awaits the model: it settles in about 125 ms and the HTTP request is aborted (LOW-1).
4. Signout during a run: held as `PORTAL_CONTINUATION_INTERRUPTED`, with no POST.

Removing the observer turns case 4 red.

This is not real-model, live-site, Google, Mac/native, installed or whole-journey acceptance. Native capture visuals do not apply: no capture or readback path changed.

Model request size, measured in the pilot: about 18 KiB on the first turn, growing to 34 KiB by the sixth, against the adapter's 64 KiB limit. The pilot's simulated task carries almost no preparation history. A real preparation's observations are carried into every browser turn, so a real task may exceed the limit (`REQUEST_TOO_LARGE`) and fail closed. This is an open activation condition, not a closed finding.

## Open before activation

- **Operator gate and holds.** The gate stays off by default. `processingPaused` and every existing hold are unchanged.
- **Request size (F2).** No real preparation history has been measured against the 64 KiB adapter limit (see above).
- **Real model.** Only a scripted model has run a browser phase. No real model has been shown to follow the phase instruction.
- **Unknown and partial states.** An unknown write, a cancel with an unknown submission, a batch write, the turn bound and the runtime's tool-failure hold all fail closed and stay unsupported for automatic recovery.
- **Restart.** A service restart in the middle of a run leaves the task `working`. It is shown as interrupted and is never resumed automatically.
- **Session expiry.** A session that only times out produces no commit, so no observer event fires. The final dispatch check still refuses the next browser or model packet.
- **Review.** Independent review of this wiring is still required.
