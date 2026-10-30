# Google connection setup (partial connector slice)

For the account-shared Web/desktop connection API, cookie-bound `/connections` UI,
server-only encrypted credentials and confidential Web callback, use
[Shared Google accounts](SHARED_GOOGLE_ACCOUNT.md). That path supersedes the
host-local Desktop/keyring setup below for the shared-account product. Existing
standalone trigger-host instructions below remain a separate explicit integration;
they are not shared-account acceptance or instructions to create another OAuth client.

## Observed timing prerequisite (incomplete admission instrumentation)

The host captures request arrival before body buffering/authentication and persists it only after authenticated, epoch-fenced intake. The wake journal retains the most recent distinct delivery's receipt time and optional valid past Pub/Sub publish time. Duplicate ACKs and recovery wakes do not replace it; concurrent older receipts do not replace newer ones. Missing, malformed or future publish timestamps remain unknown. This is route-wake metadata, **not** a causal link from a notification to a particular Gmail message.

`status().latency.admissions` exposes durable per-task post-commit wall-clock observations, inserted/existing disposition, replay counts and optional receipt/publish intervals. The optional synchronous AgentStore observer reads SQLite INSERT changes without changing Task returns or schemas. Observer exceptions cannot undo admission or prevent cursor progress; actual admission SQL errors still propagate. Missing original journal writes (including crash between task and metric databases) replay as existing with unknown original admission time, never a fresh fast admission. First durable observation wins. An IMMEDIATE SQLite transaction captures the claim sequence and receipt together. A receipt qualifies only when its sequence is above completed and at or below the captured pending sequence: a recovery wake coalesced with a pending push preserves that push correlation. A polling-only claim cannot reuse a completed receipt. Multiple coalesced wakes correlate one receipt to the drain, not to any particular Gmail message. Local drains and completed older receipts do not create push latency; replay never overwrites a correct prior metric. Future/invalid/missing timestamps yield null intervals. These are observed timestamps after commit, not exact commit times, causal message attribution or provider guarantees. No admission/completion/automatic-execution permission is inferred. Finite invented-data tests prove this machinery only; live Google delivery/latency and exact-source independent review remain pending.

Status returns a bounded latest page under `latency.admissions`: `{items,total,limit,hasMore}` (default and maximum 100 items, ordered oldest-to-newest within the latest page). SQL limits rows before JSON parsing; total counts do not materialize historic observations. Replay counters saturate at `Number.MAX_SAFE_INTEGER`; saturation means the exact later replay count is unknown. Existing observation/delivery retention remains unbounded and needs an explicit deployment retention decision; this repair does not delete history.

## Source snapshot authority fence

All five registered mail/Drive source tools check the protected account, stable connection epoch and operation-specific grant before retrieval and again immediately before `EvidenceStore.put`. The final protected lookup races the tool signal; cancellation or failed lookup denies the invocation with no successful observations or snapshot references. Disconnect, same-account reconnect and grant loss during a delayed response are covered with invented data over actual local HTTP, not Google delivery. Attachment tests first discover the opaque part in a separate authorised read.

The current `EvidenceStore.put` implementation is synchronous (filesystem writes/fsync and SQLite transaction); there is no JavaScript await between the final protected lookup and metadata commit. This is **not** an atomic transaction across Secret Service and evidence storage: another process could change credentials after the lookup, and a failed local commit can leave unreferenced bytes. Existing runtime reconciliation and exclusive-owner orphan recovery remain required. An asynchronous replacement store would require a protected pre-metadata-commit seam; this fence does not approve such a replacement.

`connectedGoogle().gmail().poll` now forwards the captured connection epoch and awaited protected currentness fence. It accepts explicit optional cancellation and reconciliation eligibility options without auto-enrolling a mailbox or inventing a bootstrap policy. Legacy low-level callers still own their explicit bootstrap/admission policy. Connected Drive reads/listings also recheck protected authority after retrieval.

## Protected disconnect compatibility

Disconnect captures the protected connection identity before revocation and atomically deletes that same logical epoch under the Linux credential-store lock afterwards. Ordinary refresh, including legacy-record migration and token rotation, does not prevent deletion; a genuinely new reconnect epoch is preserved with an explicit conflict. The locked predicate uses the same validated identity parser as OAuth, including account normalization and deterministic legacy epoch derivation. Revocation still runs for the captured token; this local fence cannot guarantee provider-side validity of a concurrently issued token. Injected stores may omit `compareAndDelete` for read/refresh compatibility, but disconnect then fails closed before revocation (including `revoke=false`); there is no get-then-unconditional-delete fallback. Missing records with atomic support are a no-op. Fixture tests exercise two OAuth/store instances with real filesystem exclusion and simulated Secret Service/HTTP only.

## Explicit Google service host (opt-in; launch entry point and agent-host handoff are described below)

`GoogleService` in `core/connectors/google/service.ts` is an explicit opt-in running factory: construct with OAuth, GmailSync, journal, GmailWatch and trusted config, then call `start()`; route Requests to `handle(routeId, request)` in push mode and await `stop()` before closing those supplied stores. No listener or system registration is installed. Config supplies a verified account/epoch route, fixed `bootstrapSince`, relevance callback, mode, recovery interval and (for push) topic. Bootstrap is persisted and conflicting restart configuration fails closed. Actual timer tests exercise local reconciliation, restart, renewal, revoke during relevance and stop cancellation. Trigger waits race the operation signal, including noncooperative relevance/currentness callbacks and fetch/body readers; each HTTP request also races its 15-second request deadline. Stream disposal is best-effort with rejection observed, not a shutdown dependency. Post-await epoch/cancellation fences still precede task admission, watch recording and cursor commits. Hosts must await tracked jobs via `stop()` before closing stores. This cannot roll back a production Secret Service write already dispatched; cancellation prevents subsequent dispatch where possible, not reversal of an external effect. Finite controllable-promise regressions prove these local shutdown/fencing properties only, not live Google delivery.

The service periodically journals uniquely bucketed recovery wakes, captures a lease/sequence, invokes the same GmailSync/AgentStore admission path, and completes only on success. It renews watches daily or within one day of expiry. Status exposes backlog/retry, last successful sync, mode and watch/sync errors; provider latency remains unmeasured. Push intake caps concurrent handlers at eight and caches bounded JWKS for five minutes with a single in-flight fetch; failures are not cached. Current source-bound review/proof limits belong in #42/#51; finite injected-response tests are not live acceptance. This is not approval to expose a public receiver.

### Trigger lifecycle

`GmailSync.poll` accepts an optional lifecycle argument with `signal`, an awaited `assertCurrent` connection-epoch/grant fence, and a trusted `eligibleDuringReconciliation(message)` predicate for initial/expired-history scans. Checks run after network/body awaits, before relevance and admission, and before cursor commit. The caller must persist and reuse its explicit eligibility boundary across restart; do not infer it from read/unread or sender/self state. Existing low-level callers without this option retain their previous full-scan behavior and are **not safe application startup policy**. The profile cursor sampled before a full list is retained, so later history polling catches mail arriving during the list. Incomplete bounded scans do not commit a cursor.

The explicit host above supplies scheduled renewal and recovery/local mode; the explicit application launch and agent-host trigger handoff are described below. `GooglePushIntake` now supplies a pure Request/Response handler with RS256 verification against bounded keys fetched only from Google's fixed JWKS URL, exact audience/service-account/subscription/account routing, bounded body/token decoding and durable-before-ack journal insertion. Trusted route configuration is copied. `GmailWatch.start` performs the real watch REST operation with no label filters and records its returned history/expiry separately; calling it again renews. `stop` performs the stop REST operation. No operation runs automatically. The explicit service implements scheduling and the currentness/cancellation bridge, with finite regressions. Current source-bound review and live receiver/Google acceptance are tracked in #42/#51. The explicit launch is opt-in, not automatic startup; it does not authorise public webhook exposure. Notifications must remain hints, never cursor or execution authority. UI WebSocket/SSE does not ingest Gmail.

Live hosted push additionally requires owner-approved application OAuth configuration, Pub/Sub topic/subscription and service-account identity, audience, receiver runtime and test account. No provisioning/deployment is performed here. Report receipt-to-admission separately from provider-publish latency; neither has been measured with Google. Finite injected-response lifecycle tests prove cancellation/epoch fences and trusted bootstrap filtering including self-sent mail only; they do not establish Google delivery or connected acceptance.


Historical standalone host setup (not the shared-account product): its `GoogleOAuth.listen` path uses a Desktop client supplied explicitly and a host protected store. Do not repeat project/client creation for the shared backend: its existing Web client and separately authorised callback/test-account configuration are described in [Shared Google accounts](SHARED_GOOGLE_ACCOUNT.md). Do not use ChatGPT integrations or import legacy credentials.

Request `gmail.readonly` and `drive.readonly` only. The Drive Google grant covers more than the selected folders; Spindle's `DriveReader` enforces selected roots separately. Partial grants persist with verified account identity in the protected connection record. Display `status(connectionId)` after restart; obtain capability tokens through `accessToken(connectionId, requiredScope)`, which refuses absent grants before refresh and checks grants again afterward.

Call `listen(requestedScopes, connectionId, expectedAccountId?)` to bind `127.0.0.1` on an OS-assigned port. Open `flow.url` in the system browser and await `result`; always call `close()` afterward. The listener rejects untrusted Host and any Origin header, consumes state once before token exchange, and expires after five minutes. State/verifier remain in memory. Results report actual `grants` and `missingGrants`; absent scope responses do not imply permission. Exchange verifies the actual Gmail profile email using the granted Gmail scope before storing anything. First connect can bind an owner-selected expected email, or returns the verified email for display; reconnect always binds the stored account and refuses replacement by a different account. Drive-only authorization is explicitly refused because identity cannot be verified by this implementation; no additional identity scopes are requested. The account-shared /connections page is the connect UI (see Shared Google accounts). Do not log authorization URLs/codes.

`LinuxCredentialStore` uses `/usr/bin/secret-tool` with stdin and no shell; it requires an unlocked desktop Secret Service. Failure is blocking, never a plaintext fallback. Actual host storage acceptance is untested. macOS Keychain and Windows protected adapters remain pending. The protected value is JSON `{refreshToken, accountId, grants, connectionEpoch, generation}`, never AgentStore or model messages. `connectionEpoch` is created on each successful exchange and retained through refresh, including refresh-token rotation. Legacy JSON records without an epoch use a deterministic SHA-256 baseline derived from the protected refresh credential; the next refresh persists that baseline. Bare tokens still require reconnect. `connectionState` exposes only identity, grants and epoch. `connectorAccess` captures the epoch and exposes asynchronous `assertCurrent`; same-account reconnect or disconnect invalidates captured connectors, while ordinary refresh does not. GmailSync now awaits this check at its network/relevance/admission boundaries, and the service combines it with its owned cancellation signal. Legacy bare-token records require reconnect. Refresh persists rotated credentials and grants together in one store write; an omitted refresh scope retains previous grants. Do not log tokens, connection JSON or profile responses.

`GmailSync.poll` verifies account identity, paginates, reads full messages irrespective of read/sender state, and delegates relevance to an injected real decision function. Admission commits to AgentStore before cursor persistence: interrupted retries deduplicate. It does not send email. Expired history (404/410) durably resets to a full paginated reconciliation. SQLite stores the pre-list baseline, current/next page, bounded pending page IDs and item offset; each offset advances only after relevance and any durable AgentStore admission. Restart replays safely. Each poll handles at most 20 items and 10 fetched pages, yielding after roughly ten seconds between items; a single slow dependency may exceed that soft chunk duration. Optional `onProgress(complete)` distinguishes partial work while the numeric return remains the number processed this invocation. The service keeps partial wakes pending and schedules another drain; only a fully completed scan advances the cursor. Incremental history uses the same durable progress path. The conservative pre-scan baseline ensures arrivals during bootstrap are caught by subsequent history. Mocked restart/reconciliation tests are not live mailbox acceptance. Schedule polling only while the authorised local worker runs.

`DriveReader.list` discovers current direct folder children with pagination; `read` supports binary download and PDF export for supported Google native types, checking version after retrieval. Persist returned exact bytes through the shared evidence owner before exposing citations. Recursive discovery and shortcuts remain pending; registered source tools are described below.

No real Google calls or credential-store operation were performed for this slice. OAuth client configuration, consent, protected host storage and self-sent/read-mail + new-file acceptance remain pending. Google external Testing refresh tokens with these scopes commonly expire after seven days; reconnect and judge-access planning are required. Disconnect can revoke remotely before deleting the protected local credential; revocation failure remains visible.

### Durable wake journal and handler integration boundary

`GoogleWakeJournal` persists delivery deduplication and a wake sequence atomically in a Google-owned SQLite WAL database with FULL synchronous mode. Routes include receiver route, workspace, verified account and connection epoch. The caller must authenticate delivery and verify the epoch before enqueue; acknowledge HTTP only after enqueue returns successfully. Notification history IDs never directly advance GmailSync cursors. Claims capture a pending sequence with a bounded lease; completing that sequence leaves later arrivals pending. Failed drains can persist retry deadlines; expired claims can be reclaimed after restart. Watch history/expiry metadata is stored separately from the reconciliation cursor. This class neither authenticates push nor schedules work, renews watches or creates tasks. Deduplication rows currently remain until a future explicit retention policy; do not deploy an unbounded public receiver on this prerequisite.

Finite SQLite fixtures cover reopen/dedup/epoch isolation, arrival during drain, expired ownership, retry/watch persistence and atomic rollback on injected write failure. OAuth fixtures cover legacy migration/rotation and reconnect/revoke fencing; cancellation fixtures reopen both databases to assert zero tasks and zero cursor advancement. These are not real Google delivery evidence.

### Partial sync hardening boundary
Use `connectedGoogle(oauth, connectionId)` for application construction: it takes the verified protected account and enforces the required capability grant on every operation. Raw constructors remain low-level test/adapter seams, not identity verification. Gmail uses a SQLite workspace/account lease with a random ownership token and 60-second expiry; overlap rejects `busy`, different workspaces proceed independently, and finally releases only its own token. No transaction spans network awaits; expired owners cannot commit cursors. Still-live owned leases renew at fenced checkpoints and on a ten-second heartbeat while dependencies are awaited; expired or replaced tokens cannot be resurrected. The service renews its wake claim through the same lifecycle fence, and partial chunks release it without completing the pending sequence. Cursors are workspace/account scoped; old account-only cursors are ignored and reconciled. REST Gmail/Drive JSON streams are capped at 2 MiB; Drive downloads default to 32 MiB. Gmail additionally caps each invocation at 16 MiB and 1102 requests, and each stored provider page at 1000 unique IDs. These are per-chunk/page bounds, not a maximum mailbox or catchup size. A structured invalid-page-token response for a persisted page restarts full or incremental pagination from its original baseline, retaining durable admission deduplication and the pre-scan cursor until completion. Incremental recovery retains the original startHistoryId, not a watch hint or a newer profile historyId. Generic invalidArgument errors are not page expiry; expired-history 404/410 responses still require full reconciliation. Full-source independent review (including heartbeat lifecycle and recovery) remains required; review7 was incomplete/BLOCK, not approval. These are resource bounds, not live acceptance. Focused tests cover malformed required IDs/history cursors, failed admission with cursor reopen, cross-instance exclusion and actual local HTTP stream cancellation (no Google call). Full message schema validation, application scheduler/UI wiring and live Google acceptance remain pending.

### Selected source tool bindings (partial)

`googleSourceTools` binds an OAuth-verified account and workspace to admitted message IDs and copied selected Drive roots. `mail.read` retains the exact full-message JSON response; `mail.attachments` resolves only parts discovered by that read and preserves decoded attachment bytes. `mail.read` also exposes bounded decoded text and subject/from metadata. `drive.list` exposes observed file IDs, names and versions with optional pagination; `drive.read` uses the selected-root reader. Successful results contain namespace-scoped immutable artifact/source references; missing provider links are allowed and omitted, not invented. Denied, cancelled or stale operations return structured failures before persistence. Local commit exceptions instead propagate into runtime reconciliation.

Finite injected-HTTP tests drive the real AgentRuntime registry through mail read/attachment and Drive list/read. The scripted provider selects the discovered Drive ID, observes the exact byte hash, and reopened EvidenceStore verifies bytes and rejects another workspace/account. A SQLite source-insert abort proves artifact/source metadata rolls back together, no observation/receipt is published, the task retains `reconciliation_required`, and the unreferenced byte file is recoverable as an orphan. These checks prove focused machinery only, not real Google or model acceptance. `mail.search` and broader finite cancellation coverage are implemented below; `drive.search`, final current-source independent approval, live consent/account checks, application entrypoint/connection UI wiring and protected-store platform acceptance remain pending.

### Trusted mail search inventory (partial)
`googleSourceTools` accepts an optional trailing `ReadonlyMap<string,string>` of opaque query references to trusted Gmail queries. It copies the map; the model supplies only `queryReference` to `mail.search`, never a raw query/account/token. One bounded `messages.list` page (maximum 100 IDs) is snapshotted as exact provider JSON; returned IDs become eligible for `mail.read`. `nextPageToken` is reported honestly, but this tool does not fetch later pages or claim completeness. Namespace/current-operation checks precede persistence. This is not live Gmail acceptance. Finite injected-HTTP runtime tests prove search → discovered ID → actual request text, copied admission, unknown-reference/no-network and account/cancellation denial. Historical reviews/findings remain retained; prior source approvals do not approve the current dirty source. Final exact-source independent approval remains required. The owner lifted numeric iteration caps for issue 42 only, not review, acceptance or effect guards.


## Explicit application launch (partial connected journey)

After building, the Google-specific application host can be launched explicitly:

```sh
node build/core/connectors/google/main.js --application-module /absolute/trusted/google-application.mjs
```

The operator-selected module exports `googleApplicationConfig()` returning a
`GoogleApplicationConfig` (see `core/connectors/google/main.ts`). This is trusted
application code, not JSON, a model-selected tool argument, or a per-message prompt.
It supplies clientId, connectionId, an explicit dataDirectory, mode, bootstrapSince,
route, and an application-specific asynchronous `relevant(message, signal)` policy.
The callback returns a task goal or undefined. It must honor cancellation and must
not perform consequential external actions. Tokens and client secrets do not belong
in this module. Existing explicitly enrolled credentials are read from Linux Secret
Service; launching does not enroll, search for credentials, or set up OAuth.

Optional `listen: {port: 8080}` binds numeric loopback 127.0.0.1 only by default.
POST `/google/push/<encoded route.route>` forwards to authenticated push intake.
Explicit numeric `host` supports an authorised receiver behind an approved TLS
reverse proxy; specifying it is not deployment authority. Never expose this plain
HTTP listener directly as a public endpoint. Omit listen to embed the exported
`handle(Request)` in an existing approved receiver. Local mode rejects push with
503 and uses durable reconciliation timers. Push mode additionally requires
`topicName` and the configured audience, subscription, and service account.

The host constructs protected credentials, OAuth, durable task storage, Gmail sync,
wake journal, watch adapter and the running service. SIGINT/SIGTERM await service
shutdown before closing SQLite; programmatic hosts must await `stop()`. Data files
are tasks.sqlite, gmail.sqlite and wakes.sqlite under the selected directory.
No startup registration occurs. Task admission persists through AgentStore;
automatic model execution/UI notification remains a separate assembly seam.

Finite application tests use injected invented credentials and fake HTTP transport,
with a real loopback receiver, OAuth adapter, timers and SQLite task admission,
shutdown/socket closure and reopen/deduplication. They do not establish actual
Google push delivery, an installed application journey, or an approved live receiver.
Live OAuth/PubSub/account/receiver configuration remains pending. Finite host tests
now send RSA-signed invented notifications through the actual loopback HTTP host,
GmailSync and AgentStore before the 60-second recovery interval. They also launch
the actual Node entry point with an explicit trusted module, then signal shutdown.
These are local machinery checks, not measured Google delivery or independent review.

Configuration is validated before creating directories, stores or the listener,
including exact push/local mode, explicit route identity, callbacks and bounded
bootstrap/timer values. The listener rejects wrong paths, methods and malformed
bearer headers before buffering. Trusted fixed ingress limits are 8 active requests,
16 sockets, 64KiB bodies, 24KiB headers, 10-second header/request/active deadlines,
and 1-second keepalive. Rejected requests close their connection rather than draining
an unbounded body. These per-request resource limits are not an overall job timeout.
Disconnect, request deadline and application shutdown cancel intake even after the
body has finished; ordinary IncomingMessage close is not interpreted as disconnect.

### Connected event-to-agent handoff

The separate [agent host](AGENT_STARTUP.md#event-driven-connected-host) can select
`trigger:{config,authority,receiver}` to share its durable Task store and immediately
wake its existing queue after admission. This does not activate the signed-in
preparation account runtime or provision a receiver. Push delivery, live Gmail and
owner review/continuation acceptance remain separate from finite local tests.

`startGoogleTriggerRuntime().assertDispatchCurrent(taskId, signal)` rechecks the
standing backend owner capability and protected connection identity, epoch and Gmail
grant immediately before runtime handoff, after asynchronous task-tool binding.
The agent host blocks denied work durably without a model call or budget reservation;
restoring a connection or calling `wake()` does not resume blocked tasks. The check
is namespace-bound, cancellation/shutdown-aware and bounded to 15 seconds. It reads
existing protected state, not the Google API. `observeDispatch` remains observation
only and supplies no authority. Receiver loss alone does not revoke already-admitted
work; ongoing tool/source/external-write checks remain independently required.

An operator-selected module may export `googleApplicationDependencies` (the same
credential-store/HTTP injection accepted programmatically) for finite invented-data
launch checks. This is trusted executable application code, never model input or
an alternate credential search path. Omit it for production protected storage and
real network adapters. No receiver is made public or provisioned by this entry point.
