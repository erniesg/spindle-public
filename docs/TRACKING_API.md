# Account/history and session API — partial #66/#67

The existing preview now includes explicit collector account/device setup and upload controls; signin never records. `PreviewSession` owns time. The separate shared-history presentation UI and full native cross-host acceptance remain pending.

## Practical same-account setup

1. Run **one existing account service**, with an approved HTTPS origin for different hosts. Each host must use that exact service and account; identical usernames on two local servers are unrelated accounts. No deployment or new access is supplied here.
2. In the normal preview's **Same-account devices and history** section, enter the service, account and a distinct device name. Connect explicitly (create an invented development account only on the first host). The existing automatic OS key helper may report `KEY_REQUESTED_RETRY_SIGNIN`; retry after settings/key readiness. The password field clears after submission and no password is saved.
3. Device enrollment uses the existing `/devices` secret/rebind contract. Protected settings save the service/account/device-name hints; the existing encrypted `account/tracking.enc` holds the cookie, CSRF, device secret, pending queue and cache under the OS-protected key. Launch reopens that same client **without registering another device**, remains paused, and retries only previously consented queued uploads. Expired credentials require renewal of the **same** account/service. Keep the OS key and data directory across ordinary restarts; deleting them is not a reconnect procedure.
4. Choose recording/pixels/Rich/retention separately, then explicitly select **Upload this recording** and bounded history retention before Start. Upload defaults off on every page load; it is not inferred from signin or saved capture preferences. No processor/model/startup grant is added. Sync/reconnect can drain pending work while paused. Pending/awaiting-history are not proof of received history; last sync and error are local observations. Refresh account devices shows names and last server receipt times, never claims remote pending/error/presence is known.
5. Enroll the browser companion separately on **each host/profile**, using that host's pairing code and selected origins. Existing encrypted pairing survives routine native restart. Optional automatic Rich still requires its existing separate Chrome screenshot permission plus app pixel/retention/Rich choices; structured text never reads form values. Do not reuse another host's pairing/profile secret.
6. For the timer, use the same service/account in the existing desktop controls and web `/pomodoro/app/`. The timer service origin is saved in protected settings after successful desktop signin when settings are ready, and restored on launch; collector setup also prefills it. Timer signin is independent of collector enrollment. Desktop timer credentials remain memory-only: signin and explicit extension timer regrant are still required after app restart. Pairing alone grants neither timer access nor recording.

The existing collector store supports one account/service. A different account or origin is **rejected**, preserving its queued data; no account-switch/discard/migration UI has been added. This is a current implementation limitation, not a requirement that the eventual product exclude account switching. Web timer account switching remains supported with the existing account/binding fences. Never copy the old queue to another account.

### Existing history UI seam

The preview visits and Saved snapshot are **local capture inspection**, not shared account history. A partial signed-in portal view (`core/account/portal/tracking.ts`, see PORTAL_TRACKING.md) reads devices, history and time summaries. It renders no images and has no two-host acceptance. The separate #67 owner still needs to supply its actual branch/head; current #67 decisions reserve that presentation ownership. There is therefore no honest history-navigation link to add yet. The existing authenticated `/session`, `/devices`, `/history`, `/sessions` and exact-key image/correction APIs below remain the integration seam; the existing `/pomodoro/app/` is a timer, not a dashboard. No competing dashboard or fake-ready dataset was created.

### Combined integration and limits

After build, with an existing Chromium:

```sh
node --test build/tests/tracking/setup.test.js build/tests/tracking/preview-setup.test.js build/tests/tracking/reauthentication.test.js
SPINDLE_CHROMIUM=/path/to/chrome node build/tests/tracking/combined-acceptance.e2e.js
SPINDLE_CHROMIUM=/path/to/chrome node build/tests/tracking/setup-ui.e2e.js
```

The combined test uses **one real existing server**, two distinct authenticated `TrackingClient`s/device registrations and encrypted queues, actual `PreviewSession` native/browser mutations → `CollectorHistory` → sync, and independent real Chromium web timer/history clients. It checks both devices' app/browser text and clock provenance, original durations and visible overlap, shared timer Start/Pause/Resume, offline queued capture, client reopen without reenrollment, same-key/data/port server restart, browser reload/account switch and strict other-account denial. Native source messages are invented simulations; no account IDs or fake-ready history are injected. History is inspected through actual browser API calls, **not a presentation dashboard**. This Linux multi-client result is not native cross-host, screenshot, permission, installed or deployment acceptance.

The setup test covers encrypted settings/client reopen, same-device reauthentication and account-change refusal. The actual preview HTTP/control test restores the service/device and timer origin across app close/reopen, remains paused, does not reenroll, rejects account/service changes and does not restore timer credentials/grants. A key refresh during first enrollment holds settings unavailable until the in-flight control drains; retired replies cannot save setup under a replacement key. Shutdown also waits for owned control/client work. It uses a **simulated Mac ready/key protocol peer on Linux** with an isolated fake HOME, not Keychain/DPAPI or native capture. A focused red/green regression also found and repaired a reconnect name mismatch: the local client now retains the server's canonical existing device name instead of claiming an unsaved rename. The renderer test uses real Chromium/production UI with **simulated desktop control responses**: password clearing, restored origin, explicit upload, pending/error diagnostics and persistent account-change error. Its sample screenshot is UI replay only. Logs and replay image stay under `.local/cross-device-sync/`, unuploaded and not independently reviewed. Relevant full checks are `make check`; native acceptance of the changed setup remains open.

## Preserved safe-launch/native handoff (#66/#67/#92)

The original safe-launch change is preserved. It is not a deployed service or proof of the new setup wiring.
The Windows launcher forwards arguments unchanged (`%*`), matching Mac's existing
forwarding; Root's normal `--no-open` support already exists from #112. No-argument
launch still opens the default browser. Use the normal packaged launcher with
`--no-open` for an authorized disposable profile, **not** `--timer-only` as a
substitute for Windows/Mac acceptance. See [launch instructions](CAPTURE_PREVIEW.md#launch-the-candidate).
The historical C218 ZIP lacks this forwarding fix. The later c0e723f packages contain it; the setup changes described above need another exact-source build/review before native use.

Preserve [Windows #92 result comment6464094034](https://github.com/erniesg/spindle/issues/92#issuecomment-6464094034): actual C218 native desktop/web/extension timer sequence, account isolation and graceful same-key/data/first-port restart **PASS**, using an external opener harness. Desktop reopen required service-origin entry/signin/timer regrant; pairing persisted. Those are targeted, harness-qualified native results, not “no native test.” They do not validate this changed setup revision or full cross-host capture. Supplemental force termination left `server.lock` (`EEXIST`); verified run-owned stale-lock removal was required. No crash-lock code fix is included here; graceful restart and abrupt-stop recovery must remain distinct.

### Decisions retained for final human acceptance

- **Shared runtime/deployment:** choose an approved host, HTTPS origin and operator
  for the existing Node account service, with durable private storage, separate
  encryption-key custody, backup/retention/deletion policy and stop/update/rollback
  ownership. Use one service for both native clients, the dashboard and timer;
  identical usernames on two local servers are different accounts. The operator
  can decrypt server data; no E2EE claim. No new backend is needed.
- **TLS/access:** approve the actual proxy/certificate and client reachability,
  minimum-scoped operator access and consenting native operators/test profiles.
  The same-origin proxy must preserve Host/Origin unchanged and keep the backend
  loopback listener private. Production TLS trust, authentication abuse protection
  and storage/access controls still need validation; the self-signed local test
  does not supply them. Do not widen the bind, disable certificate checks or reuse
  the legacy Worker/domain/credentials by inference; see the
  [infrastructure handoff](../INFRASTRUCTURE-HANDOFF.md).
- **Dashboard UI:** obtain the separate #67 owner's actual branch/head and API
  handoff before integration. Available local/remote-tracking refs at base
  `c7834b1` identify tracker/backend, timer and connected-application lanes, but
  no distinct dashboard UI lane; #67's current record also supplies none. This is
  inventory of available refs, not proof that no external UI work exists. Do not
  duplicate it or treat the application review UI/empty API test page as it.

### Remaining native cross-host acceptance sequence

1. Build/checksum a clean exact-source package after review; record source,
   fingerprint and helper hashes. Run the Windows-only launcher argv regression
   below, including the quoted `control & spaces` path. Preserve prior native
   findings/review histories; no deferred privacy/performance recertification is
   implied by this launcher change.
2. In Command Prompt run `"Start Spindle Preview.cmd" --no-open` (Mac:
   `bash "Start Spindle Preview.command" --no-open`). Verify paused startup with
   no default-browser launch; open the privately printed bearer URL only in the
   authorized disposable profile. Never put that URL or credential entry in
   evidence. Leave recording OFF for the initial #92 timer journey.
3. Against the approved **same** account service, exercise desktop Start → web
   Pause → extension Resume → desktop End → web next phase → extension Reset.
   Explicitly enroll the test extension and separately allow timer access. Check
   shared durations/revisions/countdown, outage mutation denial, reconnect,
   same-key/data/first-port service restart, desktop reopen and grant withdrawal.
   Local single-host timer checks may precede approved cross-host deployment.
4. After separate recording/pixel/retention/upload consent, use only invented
   editor → browser → document activity on actual supported Mac/Windows paths.
   Verify matching Rich evidence, same-window refresh, Pause/paused relaunch and
   native keys/enrollment. Then hand off Mac → Windows with overlap, offline
   pending/reconnect/restart, correction on the other client, browser reload,
   authenticated deletion/replay and second-account denial. Use the existing
   [minimal tracker acceptance](TESTING.md#minimal-account-linked-tracker-acceptance),
   shared union-time API and exact-key images, not summed device durations.
5. Inspect sample-only screenshots/recording of actual affected native paths;
   obtain independent exact-artifact review and human acceptance. This worktree
   authorizes no upload/publication, deployment or personal activity. Unregister
   only test-owned enrollment, quit owned processes and preserve referenced evidence.

### Historical c0e723f local evidence and reproduction

On Linux, Node 22.22.3, against base `c7834b1` plus this launcher/tests/docs delta:
`npm ci --ignore-scripts` and `make check` passed (369 Node tests; 28 Python tests,
including one Windows-only skip). The focused Windows source guard failed before
forwarding was added and passed afterward. The payload ZIP round-trip preserves
launcher bytes and the compiled import closure; no native ZIP was built here.
Root CLI tests cover normal defaults/`--no-open` and reject unknown/duplicate flags.

After building, run the existing real integrations (an installed Chromium and
OpenSSL are required; the three-surface test also needs Xvfb):

```sh
python3 -m unittest discover -s tests -p test_package_preview.py -k windows_launcher -v
python3 -m unittest discover -s tests -p test_pomodoro_package.py -v
SPINDLE_CHROMIUM_EXECUTABLE=/path/to/chrome node build/tests/tracking/web-viewer.e2e.js
SPINDLE_CHROMIUM_EXECUTABLE=/path/to/chrome node build/tests/tracking/https-viewer.e2e.js
SPINDLE_CHROMIUM_EXECUTABLE=/path/to/chrome node build/tests/capture-check/browser-rich.e2e.js
SPINDLE_CHROMIUM=/path/to/chrome node build/tests/pomodoro/web.e2e.js
SPINDLE_CHROMIUM=/path/to/chrome bash tests/pomodoro/run-surfaces.sh
```

All five journeys passed locally: authenticated browser/history overlap,
correction/restart/deletion/isolation; actual loopback HTTPS proxy/cookie/Origin
checks; real manual/automatic Chrome PNG → Native Messaging → encrypted pending
reopen/account readback; web timer recovery; and actual desktop-control/web/
extension timer convergence, cold worker, service restart and account/grant fences.
Tracking/HTTPS/browser Rich used Chromium 149.0.7827.0; timer journeys used Chromium
145.0.7632.0. Browser Rich substitutes a synthetic native foreground/key peer and
installed screenshot permission; timer desktop uses capture-free Linux timer-only
mode. These are local instances with invented data, **not native cross-host,
production TLS, presentation UI, installed acceptance or independent approval**.
Logs, content-free receipts and invented browser PNGs are retained under
`.local/cross-device-sync/` for the next reviewer/operator; existing test harnesses
create transient `.local/` directories and remove them on success. No service or
browser is intentionally retained. Windows cmd.exe quoting remains unrun here.
No native capture/readback code changed, so no new native visuals are claimed.

## Run and operate (invented data only)

Node 22+:
```sh
npm ci --ignore-scripts
npm run build
mkdir -p .local/tracking-demo
chmod 700 .local/tracking-demo
node --input-type=module -e "import {randomBytes} from 'node:crypto'; import {writeFileSync} from 'node:fs'; writeFileSync('.local/tracking-demo/server.key',randomBytes(32),{mode:0o600,flag:'wx'})"
node build/core/tracking/run.js .local/tracking-demo/server .local/tracking-demo/server.key 43166
```

Stop: Ctrl-C/SIGTERM. Update: stop, back up ciphertext/separate key, rebuild, restart same paths/port. One owner/directory; server.lock rejects duplicates: verify PID stopped before clearing crash lock. No migrations; schema/key/corruption fails closed. Lost key loses data. No autostart; discard only run-owned demo.

The listener is **always loopback-only**; no public exposure/deployment or personal-data transfer is authorised here. Network use needs an approved trusted TLS proxy/target. The client rejects plaintext non-loopback/redirects. Optional canonical HTTPS-origin configuration prepares that integration without starting a proxy or widening the binding:

```sh
# Preparation only; this still listens at http://127.0.0.1:43166.
node build/core/tracking/run.js .local/tracking-demo/server .local/tracking-demo/server.key 43166 https://tracker.example
```

Omit the final argument for loopback development. With an explicit HTTPS origin, a separately approved TLS proxy must serve the UI and forward API requests to that private listener, preserving the original **Host and Origin unchanged**. Session cookies become `Secure; HttpOnly; SameSite=Strict`; exact Host/Origin and write-CSRF checks remain. No `Forwarded`/`X-Forwarded-*` header is trusted, no CORS wildcard/foreign-origin access is granted, and origins with credentials/path/query/wildcard/non-HTTPS are rejected before store/lock startup. The program does not supply a production proxy/certificate, approve a public target or establish internet abuse protection. Never disable certificate validation for real clients; the new TLS browser fixture's disposable self-signed exception is test-only. The operator owns server encryption/TLS keys and proxy configuration; native client keys remain automatically OS-protected, and viewers need no native key. Programmatic equivalent: `startTrackingServer(directory,key,port,publicHttpsOrigin?)` returns the configured `origin` and private `listenOrigin` separately.

AES-256-GCM, atomic rename/fsync, POSIX 0600/0700, CLI key checks. Operator key decrypts accounts: **not E2EE**. Keychain/DPAPI, Windows ACL/fsync unproven. Don't log secrets/context. Expiry on access; deletion clears current/pending, not encrypted staging/backups (operator cleanup) or SSD remnants.

Storage flushes encrypted files before rename on every platform, and flushes the
parent directory on POSIX. Windows omits unsupported Node directory `fsync`;
rename/deletion durability across abrupt power loss is not guaranteed there.
File-flush, rename and deletion errors still reject the operation.

## Observation versus evidence revisions (#66/#67)

`revision` orders delivered observations. The server assigns optional `evidenceRevision` to the revision at which source identity/content, retained image, availability or consent/policy last changed; absent values in older records default to `revision`. Session reports and correction CAS use **evidenceRevision**, not the latest transport revision. Heartbeat, interval end and timing-only updates preserve corrections across restart and other clients; changed evidence invalidates them. Existing account/session reviews do not cover this collector-dependent change.

A preview-only 6 MB image eviction leaves an empty `image` with `imageAvailable:true` and unchanged `imageRevision`. Pending coalescing and server ingest preserve only the previously retained exact same visit/source/sample/frame/image revision while both contexts and pixel scopes remain valid. This is not a request for another visit's latest frame. Explicit empty-image removal sets `imageAvailable:false`; revoke/delete/expiry still erase or deny content. Without matching stored bytes the marker supplies no image. The preview discloses `image-evicted`/zero dimensions locally; durable readback retains original image metadata.

An identical browser DOM poll preserves its retained image's sample timestamp, expiry and Rich availability; it is not another screenshot acquisition and cannot renew old pixels. Title/text/resource/document changes clear the image (including eviction markers) and advance the existing challenge lifecycle, so an in-flight frame admitted for the previous context cannot attach to the new one. Failed/denied acquisition leaves the changed context without an image. Identical context/image polling therefore preserves exact corrections even with HTTP sync between phases; genuinely changed text or image invalidates them. Native samples are atomic acquisitions: missing image clears previous pixels, and image-only refreshes do not inherit older text or capture metadata. During Mac/Windows Rich capture, text is OCR'd from the same admitted frame/bitmap even when structured text would be complete. Mac AX-only updates cannot overwrite its active Rich stream; Windows skips the earlier UIA read on successful Rich capture. This uses the existing local OS OCR, not a new model/runtime. Basic retains structured-text preference. If pixels are unavailable, a fresh scoped structured-text-only acquisition can remain usable; it is never borrowed alongside a successful different frame. OCR failure does not discard retained pixels, and image encoding failure does not discard same-bitmap OCR. Source wiring/shared-seam tests and Windows cross-build are not native execution/quality/performance acceptance. These are production-seam/browser-component checks, not Mac/Windows native acceptance.

Repair proof: `tests/tracking/collector-repairs.test.ts` uses invented native messages, actual HTTP signin, encrypted pending/server restart and cross-client readback, including three 1.8 MB byte fixtures beyond the preview ring. These are synthetic PNG-header fixtures, not native screenshots. Shared lifecycle/storage changes do not establish OS acceptance; supported Mac/Windows runs remain pending. Browser component proof is separately actual Chrome with a synthetic OS peer.

## HTTP

Exact Host; same-origin browser GETs may omit `Origin` (foreign origins/fetch sites are denied). POST requires the exact configured HTTPS origin (or `Origin: http://127.0.0.1:43166` in default loopback mode); no CORS. POST: `Content-Type: application/json`. Auth: `Cookie: spindle_session=<opaque>`; writes: `X-CSRF-Token: <csrf>`. Hashed 12h sessions, salted scrypt; 20 auth/min/runtime, not internet defence. Names `[a-z0-9._-]{3,64}`, passwords 12–256 chars.

```text
POST /register {"name":"sample-account","password":"invented-password-123"}
POST /signin   {"name":"sample-account","password":"invented-password-123"}
 -> Set-Cookie: spindle_session=<opaque>; HttpOnly; SameSite=Strict; Path=/
    (also Secure when an explicit HTTPS public origin is configured)
    {"csrf":"<random>"}
GET /session -> {"account":{"id":"<immutable Spindle account UUID>","name":"sample-account"},"csrf":"<random>","deviceId":null}
POST /devices {"name":"Mac invented"}
 -> {"deviceId":"<server UUID>","secret":"<random>","name":"Mac invented"}
POST /devices {"name":"Mac invented","deviceId":"<saved>","secret":"<saved>"}
 -> rebind existing account device to fresh session
GET /devices -> {"devices":[{"id":"...","name":"Mac invented","lastUploadAt":1792886400000,"pending":"unknown","uploadError":"unknown"}]}
POST /logout {} -> {"ok":true}
POST /sync {"operations":[<operation>]}
 -> {"acknowledged":["unique-operation-id"]}
GET /history?cursor=0&limit=16
 -> {"entries":[{"key":"device/recording/visit","deviceId":"...","recordingId":"...","visitId":"...","seq":1,"deleted":false,"record":{...}}],"cursor":1,"hasMore":false}
```

Full operation (replace timestamps with source anchors/future expiry ≤30 days):
```json
{"id":"unique-operation-id","deviceId":"server-device-id","recordingId":"stable-recording-id","visitId":"source-visit-id","record":{"schema":"spindle-tracking/v1","deviceId":"server-device-id","recordingId":"stable-recording-id","visitId":"source-visit-id","revision":1,"consentRevision":1,"policyRevision":1,"wallAnchor":1792886400000,"monotonicAnchor":0,"observedAt":125.5,"expiresAt":1792886460000,"scopes":{"recording":true,"retention":true,"upload":true,"pixels":false},"labelRevision":0,"correctionRevision":0,"activity":{"awake":true,"unlocked":true,"inputAgeBucket":"over-5m","heartbeatAt":125.5,"coverage":"observed"},"visit":{"id":"source-visit-id","key":"process-incarnation/window","app":"sample-editor","title":"Invented editing session","start":0,"end":1000,"clock":"native-clock-incarnation","revision":1,"browser":false,"text":"Invented permitted text","textSource":"native","url":"","image":"","availability":"native-text","sampledAt":125.5,"framePTS":null,"expiresAt":1792886460000}}}
```

Delete: replace `record` with `"delete":true`; reads: `deleted:true`, no record. Tombstones dominate all puts, including delete-before-put/expiry. Equal revision replay is safe, conflict 409; older revisions cannot roll back. Peers may delete; puts require session-bound device, never client account-ID authority.

A signed-in account can read history/sessions/devices and explicitly process/correct/delete its own persisted records **without** `/devices`, a collector secret, native installation, recording permission, or a free collector slot. `GET /session` restores account/CSRF state from the HttpOnly cookie after page reload; `deviceId:null` is a normal viewer session. Only producer puts require a session-bound device; account-scoped deletes through `/sync` do not create a recorder. Viewing does not start capture. The browser viewer uses these same authenticated APIs, not a desktop-local cache or source-device connection. The listener remains loopback-only. Explicit HTTPS-origin configuration above supports a same-origin dashboard behind a trusted TLS proxy without header rewriting; actual proxy/certificate/remote deployment is not supplied or authorised here. Cross-origin deployment needs its own reviewed origin/cookie policy, not a CORS wildcard.

Omit `deviceId` for all devices; add `?deviceId=<id>` to `/history` or `&deviceId=<id>` to `/sessions?from=...&to=...` for one device. Unknown/foreign IDs both return 404. Apply the filter **before** interval union and pagination. Keep history cursors/caches separate per account and selected filter; changing filters starts a fresh cursor. A device-filtered response is not evidence that another device's records were deleted. Source key/device/clock, coverage/anomaly and time rules are identical in both views. `lastUploadAt` is the server UTC time of that device's latest successful nonempty producer batch, including replay; null means no known upload (including legacy devices). It is not a source heartbeat, live presence, complete coverage or a claim that the device has no pending/error state. Those states are explicitly `unknown` on the server; only that device's local client can disclose its pending queue/error. Persisted history remains readable while the source is offline.

Resume cursor/apply key+seq; missing rows aren't deletes. Preserve clocks/IDs/sample-frame/consent/privacy fences; assertions aren't OS/private-browser proof. Activity isn't attention/absence. URLs reject credentials/query/fragment. Pixel scope: canonical PNG ≤2,000,000 bytes with a shared ≤32 Mi-pixel header guard (128 MiB RGBA8 equivalent, matching the existing Windows source allocation budget). Compressible 4K/8K native windows need no manual resize. This is not full PNG/decoder validation or a promise about decoder scratch memory; browser producers may retain their smaller acquisition bounds.

## Client, bounds and proof

[Types](../core/tracking/types.ts) define validation; [client](../core/tracking/client.ts):
```js
const client = new TrackingClient(origin, privateDirectory, localKey32);
await client.signin('sample-account', password, 'Mac invented', true); // false: signin
await client.enqueue(operation);
await client.sync();
await client.inspect();
```
Import built `core/tracking/client.js`. Separate OS-protected keys/directories per device/account/origin. Encrypted pending/session/device secret/cursor/cache survive restart; no password. Single-flight sync: one batch/page; caller retries/drains. ACK/page/cache fail closed; pending isn't remote success. Removing an acknowledged raw put atomically retains encrypted metadata-only identity/browser provenance/revision (at most 10,000) until matching history/tombstone reconciliation. Locally expired own records retain the same metadata until server deletion is confirmed: local clock expiry alone is not server deletion proof. Erase includes those identities, so an ACK→history failure or concurrent late page cannot recover erased content; no fabricated cache row/sequence is used. Inspection distinguishes `awaitingHistory` from unsent `pending`, and failed refresh remains `SYNC_FAILED`. Timing-only bounds updates have at most 64 metadata-only intents in that same encrypted state. They reuse only an exact authenticated same-key/base-revision/permission match from pending/cache; otherwise normal bounded paging resolves the base after reconnect instead of replacing valid retained context with a blank template. Pending counts include unresolved intents (`reconciling` is separately exposed); no fake received row or sequence is created. Coalescing never extends an earlier cutoff, expiry/deletion dominates and drops work, and a stale-base conflict holds sync—not signin or explicit erasure. `tests/tracking/bounds.test.ts` covers restart/coalescing/capacity/expiry/stale-base/permission/privacy recovery with real API/storage. No new server partial-write operation, recorder, clock or store is introduced.

64 pending puts; individual delete coalesces same-visit work, reserves 128 queued operations without unrelated loss. `eraseDeviceHistory(browserOnly)` first encrypts the complete known deletion intent and removes matching local/pending content; metadata-only remaining targets stage through that same queue, 16 operations per upload, across offline periods/restarts/lost replies. Up to 10,064 intent targets covers the bounded 10,000-entry cache plus 64 unsynced puts; inspection/sync pending counts include unstaged targets. A local erase acknowledgement means durable intent, **not** completed remote deletion. Keep syncing until pending is zero; remote history can remain readable until its tombstone arrives. Errors: `PENDING_BOUND` / `PENDING_BOUND_DELETE_REQUIRES_SYNC` (drain/retry). Expired puts become fences. Server: 3 MB request/page, 16 operations/page, 8 queued/in-flight, 16 sockets/devices per account, 100 accounts, 500 sessions, 10,000 entries/account including tombstones, 32 MB snapshot, 10s timeout. Saturation fails closed.

[HTTP/disk proof](../tests/tracking/history.test.ts): auth/isolation/reconnect/replay/delete/max PNG. [Malformed-response mocks](../tests/tracking/repair.test.ts) aren't auth proof. After build:
```sh
node --max-old-space-size=256 --test --test-concurrency=1 build/tests/tracking/*.test.js
```
Linux API/store proof only; no native/installed or full #67 experience acceptance.

## Shared user memory (device-free)

`AccountClient` (`core/account/client.ts`) signs in/registers, then reads `/session`. Account identity, session cookie and CSRF live only in memory. Signin, memory requests and logout never enroll a device or start recording. Only producer record puts require device association; account viewers may read history/sessions, explicitly process/correct/delete their own records and use memory routes without enrollment. Memory routes do not grant producer privileges. The backend does not itself learn from activity; the separately integrated learner must restrict what it submits and cannot use its learning tool to assert `origin:user`.

```text
POST /user-memory/sync {"operations":[{"id":"invented-operation","workspaceId":"invented-workspace","key":"answer-style","expectedRevision":0,"action":"put","kind":"preference","value":"Concise answers","origin":"user"}]}
 -> {"acknowledged":["invented-operation"],"entries":[<canonical entry>]}
POST /user-memory/forget-source {"id":"invented-source-forget","workspaceId":"invented-workspace","kind":"conversation","sourceId":"invented-conversation"}
 -> {"acknowledged":["invented-source-forget"]}
GET /user-memory/changes?workspaceId=invented-workspace&cursor=0&limit=50
 -> {"entries":[<canonical entry>],"cursor":1,"hasMore":false}
GET /user-memory/activity?cursor=0&limit=16
 -> {"entries":[<text-only history entry or tombstone>],"cursor":1,"hasMore":false}
```

[Wire types](../core/memory/user-protocol.ts) define entries/mutations/sources. Account scope comes exclusively from the authenticated session; workspace is an explicit partition, not a separate account grant. Exact field validation rejects unknown fields and invalid types. Puts require kind, nonempty value and user/inferred origin; inferred puts require 1–8 sources. User puts may omit sources. Sources bind the session account/workspace, bounded IDs, lowercase SHA256, excerpt ≤512 characters and canonical UTC ISO timestamps (optional expiry after observation). Conversation sources remain authenticated client assertions. All origins use the shared `isUserMemorySource` structural validator. Activity sources must supply `activityKey` (exactly three slash-separated `[A-Za-z0-9_-]{1,128}` identifiers: original `deviceId/recordingId/visitId`) and a nonnegative safe-integer `activityRevision`; conversation sources forbid both activity fields. Independent user corrections may retain structurally valid provenance without requiring live history; explicit source fences and source expiry strip the affected provenance, not the correction value/authority. Before accepting inference, the server checks that exact account history row/revision, recording/retention/upload scopes, both envelope/context expiry, SHA256 of `[title,text].filter(Boolean).join('\n')`, and exact excerpt inclusion. Memory workspace remains independent of the history account UUID. Missing legacy activity identities are unverifiable and are invalidated, never skipped on sync. Credentials/provisioning secrets must not be inferred or submitted as memory.

Server-assigned per-key revision and account-global sequence/time replace device clocks. `expectedRevision:0` creates; stale CAS is 409. Explicit corrections dominate subsequent inferred puts, which ACK the existing user entry without altering it, even with an old expected revision. Forget accepts only id/workspace/key/expectedRevision/action, increments revision/sequence, strips content/sources and supports deletion-before-put. Inference cannot recreate a permanent tombstone; explicit user recreate must match its current revision. The sole exception is a server-derived automatic tombstone carrying `deletionReason:'source_invalidated'`: inferred recreation requires the exact current tombstone CAS plus fresh, currently valid, unfenced provenance. Stale CAS, the old activity revision, deleted/expired history and explicit identity fences still reject. Missing reason on legacy tombstones means permanent; no historical reason is guessed. Callers cannot submit deletionReason in mutations. The reason is allowed only on content-free deleted entries, never live values. No revision-history endpoint is implemented.

Stable operation IDs are account-wide. A recursively key-sorted payload SHA256 permits exact replay and rejects ID/payload drift with 409. Replay receipts keep canonical ACK snapshots; forget replaces all receipts for that key with its content-free tombstone, so earlier put replay cannot reveal forgotten content. A repeated forget retains that tombstone ACK even after explicit recreation. Forget also retains hashed, content-free source fences so the same conversation/activity source cannot recreate inference under a different key or operation ID. Whole batches commit atomically inside the existing encrypted transaction; any malformed item/conflict/capacity/store failure rolls back all items. No receipt eviction or silent history loss.

Source forget is independent of key authority: `POST /user-memory/forget-source` accepts one direct `UserMemorySourceForget`, **not** an operations wrapper. Only `id`, `workspaceId`, `kind`, `sourceId` and (required only for activity) `activityKey` are allowed; no account ID, source quote, value or body. Query fields are forbidden. The existing Host/Origin/session/CSRF guards and 512000-byte body limit apply; device enrollment is not required. Activity identity uses the same three-part history key as provenance. The fence is the existing SHA256 of JSON `[workspaceId,kind,activityKey-or-sourceId]`; local activity source IDs do not define a second namespace. The operation works with no current key, or with all formerly inferred keys now user-corrected.

In the existing encrypted account transaction, source forget sets the durable fence, immediately reconciles current entries and old key replay snapshots, and stores a separate content-free `{id,digest}` source-operation receipt before ACK. Source-operation IDs have their own account-wide receipt namespace; same ID/canonical payload returns exactly `{"acknowledged":[id]}`, including after lost responses/restart; payload drift is 409. There is no key revision precondition. Dependent current inference becomes a genuine canonical tombstone with incremented revision/sequence. A user correction retains its value/authority; if it carries forgotten provenance, only those sources/excerpts are stripped and a new canonical revision/sequence is published. Superseded inferred or forgotten-provenance receipts resolve to the reconciled current entry; old tombstone ACKs remain tombstones even after recreation. Repeated invalidation never gratuitously advances memory sequence/revisions. Explicit source forget also converts associated current automatic tombstones to permanent tombstones, using new canonical revisions/sequences (not a same-revision metadata edit). Explicit key forget on an already automatically deleted key likewise publishes a permanent tombstone and fences its former source identities. The account retains only bounded content-free bindings for current automatic tombstones: at most 1000 key bindings, at most 8 existing identity hashes each; recreation or permanent deletion removes the binding. Neither source text nor quotes survive there. The fence rejects late inference under new keys/operation IDs before ACK, even when no inferred key remains.

Every authenticated account transaction reconciles inferred memory and retained replay snapshots against history, regardless of processing choices or learner availability; history sync reconciles again after mutations. Deleted, expired, changed or unverifiable activity sources produce canonical content-free memory tombstones with new sequence/revision. Expired conversations are likewise tombstoned and durably source-fenced. Well-formed inferred entries invalidated by an actual history revision replacement or observed source/context expiry, with no pre-existing source fence, receive the automatic deletion reason. Explicit forget/fenced sources, malformed provenance and ambiguous missing/deleted history do not receive revival authority. Expiry may permit key reuse with a genuinely new valid source, never renewal of the expired source. Superseded put ACKs stay content-free tombstones after recreation; explicit forget scrubs automatic ACK reasons to the new permanent tombstone while old permanent forget ACKs remain tombstones. Inferred replay receipts are scrubbed too, including superseded snapshots whose current entry is an independent user correction (the correction survives). Late stale-source inference is rejected before publication even for a new memory key. Legacy user corrections with structurally invalid provenance retain their value/authority and valid sources; incompatible, explicitly fenced or expired sources are removed, with a new canonical revision/sequence/time so existing cursors receive the repair. Retained malformed replay snapshots resolve to the repaired current entry (or content-free tombstone), never restoring forgotten content. An exact old payload digest may replay its repaired ACK despite its obsolete source shape; changed/new malformed payloads are rejected. Tombstone receipts remain tombstones after recreation. This is logical application-store cleanup, not forensic erasure of backups/SSD remnants.

`/user-memory/activity` is a text-only allowlist projection of the same authenticated history/cursor, including tombstones; it does not enroll a device, collect anything, or create another clock. Records contain only schema, device/recording/visit IDs, revision, consent/policy revision, original wall/monotonic/observed anchors, expiry, recording/retention/upload scopes and `visit:{id,title,text,expiresAt}`. No image, URL, pixel scope or capture metadata is transferred. Maximum 16 entries and <1MB/page; cursor advances by returned sequence, including deletion/expiry. Unknown/duplicate query fields and invalid cursor/limit are rejected. Full `/history` and `/sync` contracts are unchanged.

Bounds: 1–16 operations, raw request ≤512000 bytes; 1000 keys including tombstones, 10000 key-operation receipts, 10000 source-operation receipts and 10000 source fences/account (507 on capacity, no eviction/resurrection; failure rolls back the entire transaction); IDs ≤128, workspace/source IDs ≤256, key/value ≤8192 characters; existing 32MB encrypted snapshot cap also applies. Changes requires workspace, validates cursor/limit/unknown or duplicate query keys, max50 entries and <1MB response. Entries are latest effective states, not an event log. Global sequence with workspace filtering advances to the last returned entry while more selected entries remain, otherwise the current account sequence, so unselected workspaces cannot strand or skip selected entries. Resume using the returned cursor and apply by key/revision; absent rows are not deletes.

**Predeployment draft compatibility:** this field addition requires a coordinated backend/client upgrade before use; no deployed compatibility or rollout is claimed. Older strict clients reject the unknown `deletionReason` field and must fail closed without advancing their cursor, not silently skip the deletion. Updated clients must accept missing-reason old tombstones as permanent. Client acceptance and end-to-end replacement evidence are separate from these backend checks.

`tests/tracking/memory-revision.test.ts` and the extended provenance/expiry tests cover actual authenticated loopback revision replacement, memory-only peer deletion, same-key fresh-source/current-CAS recreation, stale CAS/source rejection, explicit key/source forget after automatic invalidation, preserved corrections, permanent legacy tombstones, receipt redaction, discarded ACK/replay and encrypted restart. `tests/tracking/memory-source-forget.test.ts` covers source forget after user correction (with/without provenance), canonical tombstones/repairs, discarded-ACK replay, encrypted restart, late new-key fences, empty-key invalidation, activity identity, account/workspace isolation, request guards, atomic capacity failures and memory-only expiry/read cleanup. `tests/tracking/user-memory.test.ts`, `memory-lifecycle.test.ts` and `memory-provenance.test.ts` cover actual loopback two-client identity, encrypted restart, offline-learner deletion, expiry/replay/source fences, provenance checks, 513/8192-character key interoperability, CAS/replay/correction/forget/recreate, isolation and auth/bounds with invented data; `history.test.ts` covers the text-only projection progressing past a maximum 2MB PNG and subsequent deletion/text; `tests/account/client.test.ts` uses response mocks for client rejection/generation tests. Run both after build with `node --test --test-concurrency=1 build/tests/tracking/*.test.js build/tests/account/*.test.js`. Storage/API-only: no changed capture/readback UI, so native visuals do not apply; this does not prove automatic-learning integration, native or installed acceptance.

## Session/label integration (no UI)

Same signed-in account session and CSRF rules as above; a viewer need not enroll/bind a collector device. Processing defaults off; explicitly select account-wide deterministic **local text processing on this loopback server** (app/domain/title/permitted text, never pixels). This is the existing `LocalLabels` library, not a neural model, hosted provider or permission to upload personal activity. Disable hides assignments and stops inference; saved exact corrections remain encrypted until source replacement/deletion/expiry.

```text
POST /processing {"local":true}
 -> {"local":true}
GET /sessions?from=1792886400000&to=1792890000000
 -> {"from":1792886400000,"to":1792890000000,"personTime":90000,
     "perDevice":{"<mac>":60000,"<windows>":60000},
     "visits":[...],"blocks":[...],"anomalies":[],"processing":"local","attribution":"..."}
POST /corrections {"key":"<device>/<recording>/<visit>","evidenceRevision":1,"expectedRevision":0,"labels":{"categoryId":"learning","activityId":"reading","relatedIds":[]}}
 -> {"key":"...","label":{"labels":{"categoryId":"learning","activityId":"reading","relatedIds":[]},"source":"override","correctionRevision":1,...}}
POST /corrections {"key":"<device>/<recording>/<visit>","evidenceRevision":1,"expectedRevision":1,"undo":true}
 -> {"key":"...","label":{...,"correctionRevision":2}}
```

The session example illustrates a 60s Mac interval overlapping a 60s Windows interval by 30s; it is not a canned response. Use actual source UTC anchors. UTC epoch-ms `[from,to)`, maximum 31 days; malformed/empty/reversed range: 400. Dense queries return 413 `RANGE_BOUND`, never truncated totals (512 matching visits, 32,768 block references, 3MB response); narrow the range. Empty time is explicit unknown-coverage gap blocks, not zero attention. No day/timezone bucketing: render UTC instants in the chosen timezone without changing elapsed totals.

Visits retain key/device/recording/visit, original source clock/start/end/anchors/heartbeat, clipped duration, evidence revision and matching sampledAt/framePTS/context. `context.imageAvailable/imageState` refers to the **same key's** `/history` record image; require matching `evidenceRevision`/record revision and `imageRevision` before displaying it (re-query on change), never substitute another image. Expired optional context is empty/marked expired and cannot erase measured time. On authenticated access, optional `visit.expiresAt` independently clears title/URL/text/image and saved corrections even while envelope `record.expiresAt` is future. Labels become null; corrections return 410 `CONTEXT_EXPIRED`. Cleanup advances the history cursor without changing evidence revision; expired duplicate puts are normalized before conflict checks. Client cache/pending access applies the same clearing. This privacy repair also affects the previously reviewed #66 history/sync/cache paths; it is not a new authentication review or reset. Labels include vocabulary/concept/basis and exact-evidence references; weak cues stay Uncategorized. Only the existing uncalibrated code cue currently infers Coding; there is no invented general classifier. Category/activity seed IDs are in `core/classification/types.ts`; related concepts/custom configuration and future-rule management are not exposed here.

`blocks` split at every observed boundary and reference underlying visit keys; no semantic join or continuity across gaps. `personTime` is the union of observed awake/unlocked intervals; `perDevice` unions each device independently, while each visit retains its own original clipped duration. Simultaneous device attribution is `ambiguous:true`; recent-input keys are a disclosed provisional hint only. Quiet reading counts normally, lock/sleep excludes availability, missing/unknown activity never proves absence. Open/closed visits are capped at observed source heartbeat/end, never request wall time. Inconsistent anchor mappings within one device/recording/clock incarnation produce unknown coverage and an anomaly, not manufactured time; invalid monotonic intervals are listed in `anomalies`. A restart must use its own recording/clock incarnation.

Corrections use compare-and-swap `expectedRevision` and exact source `evidenceRevision`: stale writes 409, unknown/foreign/deleted source 404, processing off 403. Revision increases even on undo; at most 20 stacked corrections. They do not create rules or alter time. Automatic query-time labels cannot overwrite them; there is no remote suggestion-write API. Source revision replacement invalidates exact corrections; duplicate/reordered old deliveries do not. Corrections live separately from producer `HistoryRecord.labelRevision/correctionRevision` hints: **read the authoritative revision from session assignments**, not those producer fields. Peers read sessions directly, so corrections need no capture replay/history-cursor change. Deletion/expiry removes derived correction history in the same encrypted transaction.

Client equivalents: `await client.processing(true)`, `await client.sessions(from,to)`, `await client.correct(key,evidenceRevision,expectedRevision,labels)`, `await client.undo(key,evidenceRevision,expectedRevision)`. These are online account reads/writes; failed correction requests are not offline-queued. Re-read after an uncertain HTTP result before retrying with its current revision.

`tests/tracking/session.test.ts` exercises actual HTTP signin/device association, persisted editor→browser→document visits through `PreviewSession`, overlapping second-device history, two clients/restart, correction/undo/CAS, foreign-account denial, deletion cleanup/no resurrection, heartbeat caps/gaps/clock rollback and expired optional content. Provider events are **invented simulation, not Mac/Windows native capture**. The separate presentation agent and actual supported-host acceptance remain pending; this API does not claim that journey.


Browser image admission requires an explicit receipt timestamp from the owner's existing native-clock mapping. A focus-event timestamp is not a browser acquisition time: receipts older than the active visit or its admitted context are rejected, never clamped forward. The image's independent sample time changes only for newly retained pixels; identical retained bytes keep their original time and expiry. Component peers must supply the same receipt mapping; simulated foreground/key evidence does not establish native acceptance.

## Browser/API boundary proof and UI-owner handoff

`tests/tracking/web-viewer.e2e.ts` exercises actual Chromium cookie signin and Origin-free fetch against the real HTTP/encrypted store, at the full 16-collector-device limit: two invented Mac/Windows-named observations, all/device-filtered union time, source-offline viewing/reload, persisted correction/server restart, a second browser session, deletion/replay, signout/account isolation, CSRF and foreign-origin denial. Only an empty test document is fulfilled; no API/auth response is mocked. No presentation UI is implemented, and named fixture sources are not actual Mac/Windows capture. Shared API changes have no native UI visuals to inspect. Run after build with an installed Chromium:

```sh
SPINDLE_CHROMIUM_EXECUTABLE=/path/to/chrome node --max-old-space-size=256 build/tests/tracking/web-viewer.e2e.js
```

UI owner: fetch `/session` after reload (401 means signin); use cookie credentials, returned CSRF for mutations, `/devices` for names/last-upload/unknown upload status, and the same `/sessions` + exact-key `/history` contract for both web and desktop views. Do not call `/devices` POST just to view, infer recording permission from signin, sum per-device durations as person-time, or claim complete/live coverage from upload time. Corrections/deletions remain account-wide even when initiated from a selected-device view. No second store/clock/recorder is needed. Actual presentation/native/installed acceptance and independent integrated technical review remain separate gates.

`tests/tracking/gap-invalidation.test.ts` red/green proves native- and browser-shaped retroactive gaps through real HTTP/encrypted storage/restart/cross-client correction cleanup, retaining 50ms of a prior 200ms range and tombstoning the removed visit. The 110-visit cached and ACK-only cases prove ordinary eviction preserves history and explicit gap-at-55 removes 104 later identities while preserving the evicted visit's valid sample-at-51, exact correction and final 5ms. Five active-visit cases cover image-at-100/cutoff-50 with/without a newer heartbeat, Pause/document closures and the positive image-at-25 case through encrypted restart/peer readback. No late image/marker survives, valid image/correction remains, and valid time is conserved. The same suite covers receipt-time documents at 0/100/200 followed by delayed native focus at 50, with and without a new native visit: real-store/restart/peer queries retain only the correct 50ms (or 80ms including the new visit), preserve valid pre-boundary correction and reject late text/image. These are invented source events, not native gaps/focus executed on either OS. `preview-readback.e2e.ts` additionally uses the real production renderer and a synthetic owner to reject rendered/in-flight Saved copies after reconciliation; its HTTP state responses are fixtures, not native capture.

`tests/tracking/native-boundaries.test.ts` passes a valid invented compressible 4K PNG through the actual shared session/collector/pending/HTTP store and rejects excessive pixel allocation. It does not execute the Windows producer. Mac atomic-frame shape plus source-wiring checks preserve same-frame text/image and reject stale partial merges; actual Mac compilation/run remains pending. `tests/tracking/reauthentication.test.ts` exercises the production paused-signin helper with a genuinely expired server session and durable pending data, and holds a real in-flight HTTP response to verify single-owner ordering. `tests/capture-check/vault-durable.test.ts` checks actual fsync barriers with filesystem fault injection.

The browser component also runs the existing local classifier/correction consumer on a real automatic Chrome PNG; the automatic availability status uses the same existing privacy/evidence gates as manual Rich. The capture-preview contract is reconciled in `contracts/preview/README.md`; source/control-primitive checks do not replace native control-path execution.

`tests/tracking/public-origin.test.ts` checks configured HTTPS-origin/Host/CSRF/Secure-cookie policy and rejects invalid configuration before filesystem/listener side effects. Its raw `node:http` client preserves Host like a proxy; Node fetch rewrites that supplied header. `tests/tracking/https-viewer.e2e.ts` exercises actual Chromium through a real local HTTPS proxy with unchanged Host/Origin: Secure/HttpOnly/Strict cookies, signin/read/reload/server restart, no viewer enrollment, CSRF and a credentialled same-site foreign-port request actually denied by the backend, then signout. Both documents are empty fixtures, not presentation UI. The self-signed certificate is ignored only in that test browser, so it is **not trusted production TLS/deployment acceptance**. Run after build with Chromium and OpenSSL available:

```sh
SPINDLE_CHROMIUM_EXECUTABLE=/path/to/chrome node --max-old-space-size=256 build/tests/tracking/https-viewer.e2e.js
```

`tests/tracking/deletion-recovery.test.ts` additionally holds the real post-ACK history response, and separately fails it/restarts, then verifies erasure produces a server tombstone with no local recovery. It also covers 129 synced browser visits erased offline, durable restart, a committed-but-lost delete reply, bounded resumed sync, native-history preservation and replay suppression; settings-store tests cover pending revocation failure/restart/retry and protection of later enrollment. These are API/store and production settings-seam proofs, not OS-native execution.

## Optional existing collector sink (foundation, not everyday-capture acceptance)

The existing native preview owner now accepts these **authenticated local control**
requests (its printed loopback URL, same Origin and bearer token as `/start`). The setup controls above invoke the same routes. Do not send account credentials in screenshots:

```text
POST /tracking/signin {"origin":"http://127.0.0.1:43166","name":"sample-account","password":"invented-password-123","deviceName":"Mac invented","register":true}
POST /start {"apps":["com.apple.Preview"],"pixels":true,"rich":true,"retain":true,"upload":true,"retentionMs":3600000}
GET /tracking
GET /tracking/status
GET /tracking/devices
POST /tracking/sync {}
POST /pause {}
POST /clear {}
```

`/tracking/signin` requests the existing automatic Keychain/DPAPI key helper if
needed, returning `KEY_REQUESTED_RETRY_SIGNIN`; retry after `KEY_READY`. No key is
created/copied manually. Registration/signin, key setup and launch never start
recording. Upload and envelope retention are explicit `/start` choices; processing
remains a separate account API choice. Native scopes remain the existing admitted
app families (`photos` on Windows), not arbitrary editor admission. No implicit
remote AI, startup registration or permission escalation. Pause/relaunch stays idle;
native preferences/profile enrollment persist encrypted across relaunch; recording still requires an explicit Start. Local context
still expires after 15 minutes independently of the chosen history envelope expiry.

`CollectorHistory` subscribes to actual `PreviewSession` mutations, copies source
visits/images immediately, and serializes encrypted durable writes. Repeated
unsent updates replace only that visit's older put; IDs of in-flight batches are
not reused. Pause → `/tracking/signin` is supported for expired credentials: it drains/detaches the paused sink, waits for the existing client's in-flight sync/store, and reuses the same client/device/pending history rather than introducing a concurrent encrypted-store owner. Start and signin share one exclusive control owner across awaits; overlapping Start/signin or Starts reject `CONTROL_BUSY`. A Start publishes its sink only after durable settings and every lifecycle/key fence pass, with no await between publication and native Start. Cancellation drains/detaches operation-owned history. Manual sync is held during either exclusive operation. No recording resumes implicitly.

The setup UI polls metadata-only `/tracking/status` (no history entries or credentials) at most once every two seconds; the original authenticated `/tracking` inspection API is retained. `/tracking/devices` refreshes server receipt metadata explicitly.

One automatic sync attempt runs every two seconds after account signin while the OS key is available, including while capture is paused/detached so queued deletion can drain;
explicit `/tracking/sync` supports reconnect. Native event receipt has no durable
ACK protocol: a crash before the pending transaction fsync can lose the bounded
in-flight updates. Browser acknowledgements and successful control replies wait
for pending writes. This is not a lossless capture journal or native acceptance.

Four queued mutation snapshots pause acquisition with `HISTORY_BACKPRESSURE`.
63 distinct unsent visits pause with `HISTORY_PENDING_SYNC_AND_RESTART`, before the
100-visit preview ring rolls over; sync and explicitly Start again, never silently
resume. Byte/store failure also pauses and exposes an error, not silent eviction.
Connected sessions can exceed 100 visits without losing already durable history. Ordinary preview ring eviction is not deletion. An explicit `PreviewSession.gap(at)` mutation/notification is atomic—there is no intermediate Pause capture that can hide the pre-gap interval. It propagates through the same sink: remove identities beginning at/after the reliable boundary and revise overlapping intervals to that boundary, preserving valid earlier context/corrections and clearing only late or unavailable evidence. The sink retains up to 10,000 redacted source identity/interval/acquisition-time templates for the current recording (no titles/text/URLs/pixels), so invalidation also reaches evicted visits; it introduces no independent clock or store. Valid pre-gap time/evidence is preserved, later time becomes missing coverage, and exact corrections invalidate only when supporting evidence actually changes. Authoritative native focus also explicitly reconciles prior-known identities before the sink admits the newly created native UUID: later browser receipt-time visits are tombstoned, not left in shared history, and the new authoritative visit is not caught by a blanket cutoff. Visible pre-boundary context/corrections survive timing-only truncation; text or independently timestamped pixels acquired at/after the authoritative boundary clear instead. Retroactive invalidation advances the owner generation to fence old Saved copies/in-flight restore responses. Ordinary ring eviction still has no deletion meaning. Gap reconciliation includes independent image acquisition time even when the earlier DOM sample is unchanged or no newer heartbeat arrived; the reliable cutoff is the closing observation, without changing awake/unlocked/coverage assertions. It never extends an already closed interval. Pause/document closures also clear context acquired after their end. Shared validation rejects retained images/eviction markers timestamped after a closed interval, and published gap envelopes contain no acquisition metadata. Browser `coverage-gap` envelopes carry time only: empty title/text/URL/image, unavailable text source, no frame/capture/image marker. Invalidation writes use the same durable pending/bounded deletion-intent path; sync must still drain, and native messages retain the documented pre-fsync crash window.
`/clear` durably replaces known local device records/pending puts with deletion
fences/remaining-target intent before clearing the preview; sync transmits bounded batches even beyond 128 known targets. This is not account-wide deletion of unknown/unfetched history. Profile revoke pauses acquisition and durably disables the enrollment with a hashed pending-revocation receipt before cleanup. It acknowledges only after known local browser content is removed and deletion intent is durable; remote deletion still requires sync. Failures remain pending/retryable with the old token, including after restart; completed old-token retries cannot revoke a later enrollment. A pending restart with an unopened account requires `/tracking/signin` to reopen it and finish cleanup, not another recording Start. `/state` exposes `pair:"revocation-pending"` and a content-free pending code; pairing/start stay held until cleanup completes. Revoke never enables native browser fallback. Settings/snapshot writes now fsync the encrypted file, rename, then fsync its directory; clear/expiry unlink has a directory barrier. A failed barrier rejects completion and keeps revocation pending. Fault-injected actual FileHandle tests verify those barriers/order and rejected completion, not a physical power-cut or supported-host filesystem guarantee. Windows ACL/directory-fsync behavior remains part of native acceptance; unsupported barriers fail closed, never silently acknowledge durability.

Source monotonic clock IDs, revisions, sample times, frame PTS and exact PNG bytes
are preserved. A fresh recording UUID is assigned per explicit Start. First native
receipt provides an **estimated** wall/monotonic anchor; it is not a native UTC
anchor. Existing native helpers emit coarse age buckets once/second independently
of OCR: Windows `GetLastInputInfo`, Mac minimum age across keyboard/mouse-button/
movement/scroll event classes. No key values, coordinates or input streams.
Session lock/sleep stops acquisition; resume requires Start. Awake/unlocked is
provisional while the started native session is live, not independently certified
attention or complete lock-state proof. Unknown activity remains partial.

Proof: `tests/tracking/collector*.test.ts` uses **invented native messages**, actual
signin/device association, production mutations, encrypted pending restart, real
HTTP sessions/correction/deletion and a connected 110-visit run past the preview
ring. Native/browser screenshots were not acquired on this Linux host. Windows
.NET Framework cross-build passed; actual Windows run and Mac compilation remain
required. On each consenting host, build the exact source using the existing
[preview launch/package instructions](CAPTURE_PREVIEW.md#developer-checks--proof-limits),
record only the invented A/B documents, exercise the API sequence above, verify
same-key images/history, quiet input age, lock/sleep, explicit restart and Pause.
Return only build/source hash, stage/error codes and counts; no credentials,
URLs/titles/text/images/raw logs. Inspect sample-only visuals locally before any
approved evidence handoff. No SSH is required.

Collector follow-up now persists encrypted profile enrollment/native choices,
retains enrolled-origin sanitized URL paths, adds exact-path Apple-signed TextEdit,
and supports optional automatic Chrome Rich on editing pages. Chrome requires a
separate optional `<all_urls>` screenshot grant: enrolled origins still strictly
limit DOM/pixel collection. See extension options and CAPTURE_PREVIEW for revoke,
manual fallback, visible edited-field pixel disclosure and paused restart semantics.
The real Chromium component test includes authenticated loopback account sync and
encrypted pending reopen; native foreground/key and installed capability grant
remain synthetic/substituted. Actual optional-grant UI and Mac/Windows source-bound
restart/capture/enrollment proof remain pending. Windows now uses persistent window-only Windows.Graphics.Capture (#85); native execution of the follow-up below is still unrun. This foundation must not be presented as finishing #4/#12/#13.

Target-host follow-up (not run here): build the exact revision with the existing
Mac launcher / Windows Preview.csproj commands. Using only invented content,
explicitly `/start` Mac `apps:["com.apple.TextEdit"]` or Windows
`apps:["notepad","mspaint"]` with chosen pixel/Rich/retention scopes; verify native
matching image/history. Quit/relaunch: `/state` must be paused, `settingsReady:true`,
with the same `preferences` and enrolled profile, and no new account records before
explicit Start. In ordinary Chrome setup, approve one invented origin and the
separate automatic screenshot permission; verify edited fields/shadow pixels,
structured form exclusion, another origin denied, and late Pause/revoke denial.
Revoke, relaunch again, and confirm the old profile token cannot obtain a challenge.
Return source/helper hash and content-free stage results; actual OS-key storage,
optional permission UI, native signatures and foreground associations need those
supported-host runs, not this Linux component test.
