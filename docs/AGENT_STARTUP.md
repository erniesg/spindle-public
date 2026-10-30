# Explicit preparation worker (partial)

## Signed-in request preparation

`startTrackingServer(..., googleConfig, preparationConfig)` accepts an optional
sixth argument from trusted host code. `productionPreparation(options)` in
`core/preparation/production.ts` constructs that configuration using the existing
AgentStore, EvidenceStore, AgentSessionStore, AgentRuntime, NebiusAgentProvider,
TextProvider and image/document/OCR factories. It does not create a second planner,
credentials, provider endpoint, money journal or Google client. The host supplies
its existing stores, existing FileCallBudget, verified decision/vision model
and pricing declarations, lazy credential callback, build identity and trusted
local helper configuration. No request/browser/model selects these values.

For the actual signed-in production host, build normally and run:

```sh
node build/core/preparation/startup.js --application-module /absolute/trusted-account-configuration.mjs
```

The trusted executable configuration exports async `preparationAccountConfig()`
returning `PreparationAccountConfig`: the **existing** absolute account directory,
backend key and confidential Google Web configuration; existing absolute budget
journal; explicit decision/vision model declarations; generic lazy credential
callback; exact `sourceIdentity` (revision/tree) and separate `buildIdentity`; optional
trusted image/Poppler/font configuration and finite task bounds. No provider key path
or model is inferred. `startPreparationAccount(config)` opens the same existing
account backend (not a replacement auth database), its preparation stores and the
real production factory assembly, then serves the normal `/connections` entry.
The trusted configuration module is host startup code, never request/tool input.
No credential lookup, source read or model request happens at startup, status,
restore or reload. A user's explicit Run/correction/resume is required.

`preparationConfiguration()` → POST `/preparation/config {}` exposes only configured
model IDs, fixed Nebius endpoint, declared input/image/output bounds, whole-task
call/USD limits and cumulative global ceiling, source/build identities and truthful
unprobed readiness. It contains no keys, credential paths or raw configuration.
The actual operator declaration is authoritative; these source bounds are **not**
live spending/processing approval. For example, a verified declaration of 65536/1024
decision context/output plus 32000/512 image-inclusive vision, at the independently
verified prices .06/.24 and .658/1.11 USD per million, reserves at most .26343936 USD
for 16+3 calls using the conservative whole-context/output 2× bounds. No price/model is selected
or authenticated by this example; the actual journal and image billing must be
reconciled before any real use.

The idle UI/configuration/status surfaces can be served before processing approval
without submitting a request. Unchecked Run shows a consent-needed notice; false or
missing request consent is rejected before admission or any provider/source work.
No durable pending-request or separate host-disabled mode is required. Saving an
existing failed/blocked/cancelled task does not resume its model. Existing protected
key/config reuse is sufficient when processing is eventually authorized; no new-key
or OAuth-project setup requirement is introduced.

### Partial draft and session saving

`draft.export {}` and `session.export {}` are registered local capabilities. They
persist immutable actual-revision/status/cutoff/source-hash evidence first, including
visible errors, pending/unknown operations and partial extractions. Draft manifests
reference only current, actually generated PDF/image/preview bytes. Historical or
unknown-binding outputs are omitted rather than relabelled corrected; absence of a
current generated PDF is explicit, never a fabricated form. Both exports use the
same session allowlist; a trace may include in-progress call intents but cannot
include its own future result/upload/final status.

Normal signed-in **Save Draft / Save Session** buttons work even if the model failed
before selecting a save tool. `AccountClient.savePreparation({taskId,expectedRevision,
kind:'draft'|'session',requestId,saveOutputs})` uses POST `/preparation/save`. It invokes
the same validated export/new-artifact capabilities, without running a model,
forcing Ready, clearing recovery or charging/resetting model budgets. Immutable
snapshots/artifact references and bounded save facts survive restart. Repeated request
IDs retain the same snapshot. Public receipts expose no file paths or credentials.

Each save retains its last 16 inactive capability facts, ordered by last fact update,
plus actual in-flight calls (the normal HTTP server admits at most eight requests).
Completion/error updates keep the same call ID and move its fact to the window tail.
`history` reports observed user attempts separately from capability events, dropped
counts by outcome (including unresolved), and active call IDs. `complete` coverage
starts with a new save; `legacy_lower_bound` counts only known retained events and
subsequently observed attempts, never inferred pre-tracking totals. Status and later
session exports expose this accounting; earlier immutable exports keep their cutoff.
Pruning never changes authoritative upload intents/states, snapshot IDs/bytes or
retry/reconciliation permissions.

Save always happens locally first. Optional `saveOutputs:true` is a narrow owner
intent for exactly that snapshot, not a mutation of the task's model/write/processing
authority. Actual drive.file plus exact selected-parent authorization still precede
new durable Google intents/creates/readback. Local/user and model uploads share the
same serialized existing uploader capability; unknown ACKs reconcile the saved ID,
never automatically POST again. Receipts distinguish `local_saved`, `upload_blocked`,
`uncertain` and `verified`; task status and unknown batch fences remain unchanged.
An existing cancelled or blocked task can retain evidence without restarting AI.

The standalone legacy worker documented below is unchanged and still denies
external writes by default.

The normal entry point is `/connections`: choose an already-selected Drive root,
enter a plain request, explicitly consent to request-relevant Nebius processing,
then Run. Without consent the UI does not submit a request and the API rejects it. **Saving is optional and unchecked by default**. `saveOutputs:false`
prepares a local draft from readonly sources, with protected local artifacts,
current visible-session export and corrections; it requires no Google write grant,
Picker action or Drive POST and cannot claim uploaded outputs. `saveOutputs:true`
is a separate explicit same-root **new** artifact-write intent, still gated by
actual Google write/parent authorization. Neither mode implies processing approval
for any actual data outside the user's explicit choice. Connecting/signing in alone never
starts processing, recording or enrollment. Requests are persisted verbatim as
user data before provider execution; punctuation, bangs and command substitution
are never passed to a shell. The facade accepts only factory tools in the Drive,
image, document, OCR, field-grounding and session-export registry, not arbitrary
filesystem, shell, credentials or network tools.

`AccountClient` methods use POST JSON with the existing HttpOnly session, exact
Origin, CSRF and immutable owner namespace:

- `prepareApplication({connectionId,rootId,request,requestId,processingConsent:true,saveOutputs:boolean})`
  → `/preparation/request`, 202 `{taskId,revision,state}`. Request-ID replays return
  the same task; rebinding that ID to different input or save mode fails. An exact
  same-owner/root/request is also deduplicated across different IDs/tabs/duplicate
  Google cards, including blocked work: replay returns retained state, never Resume
  or a fresh budget. An explicit **New request** action uses `newIntent:true` to
  distinguish a deliberately new attempt; it still cannot duplicate matching active
  work. Different requests are not subject to a generic one-task product ban.
- `preparationTask(taskId)` → `/preparation/status`, persisted checklist, fields,
  source versions/hashes, visible sanitized session, artifacts and verified Drive
  URLs only when actually saved and verified. Local mode reports `local_draft` and
  no uploaded outputs. A Ready decision requires this revision's real session
  export and is refused while unresolved checklist/fields or required Drive output
  verification remains; Ready is reviewable preparation, never live acceptance.
- `correctPreparation({taskId,expectedRevision,fieldId,value})` →
  `/preparation/correct`, new revision of the same task, retaining prior artifacts
  and explicit user precedence. Source-grounded values come from persisted OCR
  spans/text or literal user-provided request facts; masks/unresolved values stay blank. PDF editing uses grounded fields,
  not unchecked model-invented values. Preview/citation artifacts remain protected.
- `resumePreparation(taskId, expectedGeneration?, requestId?)` and `cancelPreparation(taskId)` →
  `/preparation/resume` and `/preparation/cancel`. Explicit resume can bind a renewed
  authenticated connection to the same verified Google identity/root; it cannot
  erase uncertain writes or replay their POST. A lost ACK can be resolved through
  read-only same-ID metadata/exact-byte reconciliation; 404 keeps uncertainty and
  cannot authorize a repost. Mixed/local-write uncertainty remains a manual hold. Processing cancellation revokes
  source-image egress and invalidates late results. Resume requires a blocked task,
  an action ID and the expected generation; the shared client reads generation when
  omitted by an older caller. Working, queued, in-flight and stale/concurrent Resume
  are rejected before enqueue or budget/envelope growth. It does not erase holds.
- `preparationList()` → `/preparation/list`, bounded owner-only retained task choices.
  Selection reads state only; no pending task is automatically picked for execution.
- `preparationSource(taskId, 'list'|'read', fileId?)` → `/preparation/source`, an
  explicit **manual probe**, not model acceptance. It uses the same composed source
  tool factory, task binding, consent/currentness and Task/EvidenceStore as runtime;
  list's exact root is supplied by the host, not caller/model input. It creates no
  task, model call, Resume, generation change or queue entry. Active work, invalid
  owner/root/fields and unresolved write holds are rejected. Listing/read results
  and private typed failures are actual observations, not fixed success fixtures.
- `preparationArtifact(taskId,artifactId)` → `/preparation/artifact`, typed
  `{bytes,mimeType}`, with ordinary cookie+CSRF and task/owner binding; no paths or
  tokens. Source snapshots and derived previews/downloads use immutable bytes.

Only the actual configured provider chooses tool names/arguments and subsequent
steps from actual results. `drive.list/read` use the existing selected-root reader
(32 MiB server intake, not the inspector's 512000-byte download cap) and immutable
EvidenceStore snapshots. Trusted connector admission, not model SourceRefs, grows
this task's scope in the Spindle owner UUID namespace. The verified Google identity
is retained separately. Session/root/epoch and source-version checks fence awaits;
local per-type image/PDF limits remain those of their tool factories.

`drive.create_artifact({artifactId,name})` is the only admitted external write.
The host approval binds task/revision/root and generated immutable artifact/hash;
source originals, unrelated artifacts and raw extraction/log artifacts are denied.
The existing uploader requires genuine drive.file consent and provider-authorized
parent capability, persists the pre-generated Google ID **before** POST, then checks
metadata plus independent exact-byte readback. Repeated calls reconcile that ID;
lost ACK/crash/partial writes retain uncertainty and require reconciliation, never
an automatic repost/delete or duplicate-ID allocation. Batches with any write
serialize. Unknown external writes remain denied by AgentRuntime.

`session.export {}` creates an immutable allowlisted JSON artifact from actual
visible request/corrections, validated decisions/calls, results/errors, sources,
field citations, decision and vision model/config digests, actual returned usage,
separate source/build identities, run/revision and known status. Vision attempts,
including failed/unknown usage, persist in the same AgentSessionStore.
It excludes hidden system/developer/reasoning messages, raw configuration, paths,
keys, tokens, cookies, callback URLs and base64 images. In save-enabled mode only, the model uploads this same
artifact using `drive.create_artifact`; its stated cutoff excludes its own future
upload/final status. The authenticated task status is the subsequent receipt.

A trusted operator can start this same preparation assembly with
`processingPaused:true` and a static `processingPauseReason` (also accepted by
`ProductionPreparationOptions`). This holds new request admission, Resume,
correction/model dispatch and Drive-saving actions with
`PREPARATION_PROCESSING_PAUSED`; it does not change budgets, grants or old task
records. Existing account/session/status, Google permission refresh, explicit
current-task manual source probes under retained consent/currentness, downloads and
local `Save Session` remain available. The normal page prominently reports the
pause and disables execution controls. Requested saving stays selected/blocked;
local saving requires the user's explicit unchecked saving choice. Removing the
operator flag never drains old queued/interrupted rows. No constructor, page load,
status read or permission callback starts/resumes work. Actual activation and
operator callback remain coordinator-owned actions, not effects of this option.

Defaults are finite: 16 decision calls, 3 vision calls, USD0.30 conservative task
cap, 128 cumulative runtime/tool units and a 300-second per-run bound, composed
with the **existing** cumulative FileCallBudget. Entire-context/image-inclusive
reservations precede lazy credentials. Counts and retained uncertain charges live
in the task across corrections/resume/restart; no global journal is created/reset.
Actual model context/pricing and image accounting still require operator verification.
A durable exclusive preparation-owner row and the account host lock prevent a
second dispatcher; a crash leaves a hold for effects reconciliation, not auto-steal.
Shutdown drains actual invocations before releasing ownership. It aborts host
leases as supersession rather than calling owner Cancel. Still-working tasks retain
an observed `service_shutdown` interruption marker; queued work does not replay on
reopen. Status reports actual in-process running/queued versus durable interrupted,
blocked, ready or cancelled state without mutating a task just because it was read.
Legacy records without cause metadata remain unattributed, not retroactive owner
cancellation. Per-step statuses come from actual registered tool invocations/results
(discovery/read/OCR/photo/PDF fill/render/draft/session/Drive readback), not an assumed
pipeline or percentage. A genuine new start clears stale blocker/phase display.

Future authenticated request/resume/correct/cancel/save/source actions are recorded
in a small table in the existing Task DB before enqueue/effects, plus the observed
run ID/generation before a provider is requested. Each record contains an action ID,
observed timestamp, disposition, task/run/generation, honest `account_api` caller
label and purpose-separated noncredential session fingerprint. It is **not proof of
human intent, provider receipt or billing**, and supplies no attribution for old
unlogged tasks. No raw request/source/provider body, cookie, token, raw session
handle or hidden reasoning enters this audit. Status returns the last 64 events
with a retained count; the DB keeps facts up to a 4096-record owner cap and refuses
new audited actions at saturation rather than pruning unknown facts. FileCallBudget's
scoped cap view retains the **same** real cumulative journal and durability contract;
it is not a new/reset ledger or an in-memory replacement rejected by OCR tools.

Correction-dependent artifact bindings record exact immutable hashes, creation
revision and consumed-field fingerprints through trusted factory declarations and
artifact lineage. The model cannot declare its own independence. Unknown bindings
cannot be carried across a correction; explicitly source-only OCR/photo/evidence
can remain current when unaffected. Ready requires replacements for stale dependent
PDF/preview families; uploads independently enforce current content before intent
or provider effects. Historical downloads retain their original revision and are
labelled historical, never relabelled corrected.

Thrown/invalid/partial write-batch results retain the durable batch pending fence.
An empty artifact array does not prove no effect: only an explicit validated
no-effect result from a trusted wrapper permits clean recovery. Resume cannot
clear missing/unknown batch reconciliation by assertion. Correction CAS supersedes
only the old run, separately from explicit owner cancellation; old actual credential/
transport invocations drain before a successor runs. Real cancellation remains
non-resumable and uncertain writes still hold correction.

The OCR callback normalizes actual persisted PDF render metadata, including the
PDF-standard affine convention into OCR row-major order, actual pageIndex/crop/
rotation/UserUnit and hash-bound raster dimensions. Crop/resize and same-size image
operation lineage map back to that exact render. Unknown provenance cannot invent
page0 or matrices. Registered `ocr.render_regions` and protected UI citation overlays
show real retained regions, explicitly labelled potentially model-estimated—not
pixel-accuracy verification, confidence or form semantics.

Focused tests use invented Google/model HTTP and explicitly labelled fixture
transformations through the normal API/runtime. They cover literal request data,
registered upload/readback, leading zeroes, correction/new revision, owner denial,
secret-free exports, missing write grant and lost ACK. These are offline machinery
proof, **not live Google/Nebius, real PDF/photo quality or #51 acceptance**. The
actual production startup test registers the composed real upload/OCR/PDF factories
and exercises the normal API using invented HTTP choices (not live model quality),
including an actual 11-second first response. Production explicitly passes its
trusted preparation `timeoutMs` (default 300000ms) to the decision adapter; the
runtime's whole-run deadline/cancellation can still win sooner. The generic adapter
keeps its 10000ms default; explicit deadlines are bounded at 3600000ms. New attempt
envelopes retain start time and configured deadline, not proof of provider receipt
or billing. A local adapter deadline reports `AGENT_PROVIDER_TIMEOUT:<phase>`
(request persistence, credential, transport headers, response body or response
persistence); externally signalled cancellation remains `TIMEOUT_OR_CANCELLED`.
Failures never trigger an automatic retry or release an unknown reservation.
Historical `TIMEOUT_OR_CANCELLED` records without this metadata do not establish
which abort/deadline fired.
The coordinator must independently review the exact integrated candidate and verify
actual outputs before acceptance.


Build normally, then run:

```sh
node build/core/agent/startup.js --application-module /absolute/trusted-application.mjs
```

The operator-selected executable module exports async `agentApplicationConfig()`
returning `AgentApplicationConfig` from `core/agent/startup.ts`. It selects the
Google connection/route/bootstrap/relevance policy, namespace, existing absolute
cumulative budget journal, verified Nebius model/pricing declaration, lazy
credential callback, registered tools, source/grant scope, turn/time/poll bounds
and optional `review: true`. No default model, credentials, grants, enrolment,
receiver configuration, capture or login startup is generated. Never use a model
argument or email attachment as the module. Configuration is trusted code; it is
not a sandbox. Protected Google credentials retain the Google host's custody.

The tools factory receives the application EvidenceStore and an optional second
host context `{tasks,namespace,signal}`. Normal startup always supplies its SAME
AgentStore and detached namespace, so task-bound tools do not open another task
store. Factories may return tools synchronously or asynchronously; startup awaits
them before ingress/dispatch. Existing one-argument synchronous factories remain
compatible. Optional trusted `stopTools()` closes owned tool contexts after actual
invocations drain and before evidence/tasks close, including startup failure;
cleanup failure is reported without skipping store/lock release. Compose existing
`contextTools`, Google sources, document/image tools and the [task-mail adapter](EMAIL_TOOLS.md#existing-task-host-adapter)
under explicit standing scope; roots/opaque selections remain trusted application
choices, not model paths. Tools enforce currentness/cancellation before committing.
Optional trusted `execution` forwards only `approveExternalWrite`, `getScope` and
`assertReady` into the existing runtime before fixed host signal/scope/timeout.
Default denial remains; a narrow exact-revision policy does not supply Google,
submission or mail-send authority. Neither model/email text nor registry presence
can create approval; signatures and real consequential actions remain excluded.

The base factory runs once before ingress. Optional trusted `taskTools(task,host)`
constructs task-bound tools only after durable admission, with that detached Task
and the SAME `{tasks,evidence,namespace,signal}`. Return the existing binding shape
`{tools,execution?,close}`; no second queue/store or model-selected configuration.
Its narrow external-write predicate and the base predicate admit their respective
families; both readiness gates run. Global scope/currentness/signal/timeout remain
host/runtime-owned. Duplicate tool names fail closed. After actual provider/tool
drain, the task binding closes before the next task or store shutdown; `close`
must be idempotent. Construction that throws before returning owns its partial
cleanup. Close failure stops dispatch and retains the binding for shutdown cleanup.

This seam permits a browser adapter to receive its actual task ID, not full browser
startup/owner-UI acceptance. The task-review preview server (distinct from the signed-in account host's /mail and /preparation/browser-approve routes) still has no authenticated
mail/browser approve/resume/recovery controls. Already attempted tasks remain held
for explicit reconciliation; `wake()` is not an owner continuation API. These are
unfinished paths, not extra consent requirements or product restrictions.

Optional `reviewMail:(taskId,after)=>mail.review(taskId,after)` enables only the
[private saved-email readback](EMAIL_TOOLS.md#private-saved-draft-readback-partial)
inside the existing task preview. It is namespace/capability-authenticated, one
saved body per page, and never executes a model or grants sending. The normal
startup passes that exact trusted read hook after stores/factories exist. This
read-only preview is not shared-account owner correction/Submit/resume/recovery
integration and does not alter the live preparation account application.

### Event-driven connected host

Trusted configuration selects exactly ONE ingestion construction: existing `google`
or `trigger:{config,authority,receiver?}`. The latter invokes the actual
`startGoogleTriggerRuntime`, not a parallel service. Its namespace must match the
backend-supplied authority; use [the protected standing capability](SHARED_GOOGLE_ACCOUNT.md#explicit-background-trigger-capability),
not expired browser credentials or a new vault. Push requires an already approved
mounted receiver/watch configuration. Explicit local mode is a fallback, not hosted
push acceptance. No configuration default enrolls or starts a real mailbox.

`wake()` coalesces asynchronous immediate selection from the SAME durable queue.
Post-commit admission, startup, recovery and retained runnable work signal it; it
never executes the model inline in SQLite admission callbacks. A wake while busy
remains pending until actual provider/tool settlement. Local status separates
admission/scheduler/runtime handoff from actual model dispatch or provider latency;
`observeDispatch` records only the trusted handoff immediately before runtime.run.
The trigger's lastSync/watch/receiver/stop status remains truthful on restart.

One exclusively owned application consumes the **durable Task database**, not
admission telemetry. At most 20 working rows are selected in SQL per selection and
one task executes at a time; immediate wakes supplement bounded recovery polls.
Polls are 10–60000ms, turn bounds 1–100 and runtime task
timeout 1–3600000ms; these resource choices are trusted application configuration,
not an overall worker lifetime. Each invocation gets the runtime generation,
active cancellation signal and currentness fences. Exhausting the turn chunk
blocks with an explicit continuation action instead of repeatedly spending from
an automatic retry loop. Queue failure halts dispatch and appears in `status()`.

Google ingestion and runtime share `tasks.sqlite`; preparation readback uses that
same store and namespace through the existing review server. With `review: true`,
that server also receives the application's EvidenceStore: its memory list/history
and user corrections use the same durable, namespaced memory as runtime context
tools. Corrections retain user precedence and survive restart; this is not a
second UI-only memory store.

Optional `userMemory: {accountOrigin: 'https://approved-account-origin'}` in that
same trusted configuration also constructs the [shared user-memory service](USER_MEMORY.md).
With `review: true`, it supplies the fourth `startTaskReview` argument and exposes
the existing Tell Spindle panel/API. Omit `userMemory` to retain the previous
manual-only behavior. Startup validates the account origin (HTTPS, or numeric
loopback HTTP for local testing); neither browser/model input nor a Google/task
account selects it. Authentication supplies the Spindle user UUID, while the
trusted workspace is reused and existing task/source namespaces stay unchanged.
There is no automatic sign-in or device enrollment. Conversation learning,
activity learning, processing and sync default off; explicit account-scoped choices
persist across restart, but a new authenticated session is required to expose data.
The service shares the exact application EvidenceStore/root and existing budgeted
provider/session persistence; no second budget, model configuration or store is
created. Enabling processing can consume that same cumulative budget. Preparation
and memory may reserve calls against it; this does not promise cross-journal atomicity.

`ready` still means
preparation needs review, not a validated or submitted application. Evidence and
model envelopes use `evidence/context.sqlite` with immutable artifact bytes.
FileCallBudget uses the **existing** selected journal, never creates or resets it.
Task, envelope, Google and budget commits are separate journals, not one atomic
transaction.

Restart retains completed/cancelled/blocked work and duplicate event identity.
Any working task already attempted (even with no pending tool) is conservatively
blocked for reconciliation: a model dispatch could have occurred between journal
commits. Inspect retained envelopes, reservations and local effects before an
explicit recovery decision; this worker does not automatically replay uncertain
model or local-write effects. It deliberately does not add a recovery/approval UI.

An exclusive `agent-startup.lock` prevents a second worker in the same directory.
A crash leaves it in place. Verify the prior process is absent, reconcile its
journals/effects and obtain applicable recovery approval before removing a stale
lock; absence of a process is not proof a dispatched effect did not happen.
Directory and journal identities must be retained across restart, not changed to
bypass this hold.

Trusted callers can use namespace-checked `cancelTask(id)` to persist cancellation
and abort the active runtime signal; unknown/foreign IDs and calls after stop are
refused. Timeout/cancellation ends the runtime observation wait, not the actual
invocation. Queue admission stays fenced until all tracked model/tool invocations
settle; late results are not accepted. Noncooperative code can hold the queue even
after its task is cancelled. This does not add a separate UI or submission authority.

Await `stop()` (SIGINT/SIGTERM do so in the CLI). It stops selection, aborts active
runtime work, drains Google ingress and the worker, closes/drains review HTTP
handlers, stops/drains optional memory work, then drains actual tracked tool/model
invocations and async memory sign-in/sign-out before closing evidence/tasks and
releasing ownership. Account ingress is tracked even if its client disconnects
before the account response; stopping refuses newly admitted account calls. Trusted
tools must settle after cancellation or enforce their own finite operation bounds;
noncooperative code can hold shutdown, rather than close SQLite under a late
callback. Closing the browser does not stop the worker. An ingress shutdown error
still drains the worker and memory before resource closure. Startup failure also
stops an already-started memory service before closing its shared stores. Private review capability URLs
must not be copied into logs/evidence.

Focused tests use invented Google responses, the real Google service/timers and
admission, real Nebius request/response parsing with injected transport, registered
file reads/versioned writes, retained source bytes, session envelopes, cumulative
budget and authenticated preparation HTTP readback. With an explicit
`SPINDLE_MEMORY_SERVER_MODULE=/absolute/built/tracking/server.js`, startup tests
also use the actual authenticated account backend with two combined-startup
clients: inferred memory/sync, namespace isolation, root-correct source deletion,
shared journals/reopen, in-flight sign-in drain and cancelled late model responses.
Only Google/model decisions are scripted; no native visuals apply to this shared
assembly change, which does not change panel pixels or capture/readback code.
These are local machinery
checks, **not live Google delivery, model quality, native acceptance or completed
v6 application/submission**. Live account/receiver/provider configuration, actual
application assembly/field citations/correction, submit authority and affected-host
proof remain separate acceptance obligations.


Public preview paid-task admission uses the existing encrypted account store when
the trusted `publicProxy` configuration is present. Each account may start two
distinct preparation/mail tasks in a rolling 24 hours, shared across both routes.
A preparation task may make its normal multiple model/tool calls, and a separate
email draft uses the second slot. Existing task status, approval, reconciliation,
request replay, and preparation intent aliases consume no additional slot.
A new admission beyond the limit returns HTTP 429 `PAID_TASK_QUOTA`; the account
client preserves that code for display. Existing per-task and global model
budgets still apply. Private servers without `publicProxy` retain their prior policy.

Admission first durably reserves the exact workspace/account/kind/request identity,
then initializes the existing SQLite Task, attaches its actual ID, and only then
enqueues execution. These stores do not share a transaction. A crash or failed
initialization/ID attachment leaves an unknown reservation charged indefinitely;
there is no automatic refund or eviction of that unknown. Known admissions age
out at 24 hours, even if the task was cancelled; cancellation does not refund
within the window. Same-identity retry relies on SQLite's exact event key to retain
one actual Task. Clock rollback refuses new identities. This policy does not
resume interrupted work or authorize providers, Google writes, or final Send.

Retained request replays and explicit task continuations reconcile an existing
unbound reservation before returning or continuing. Preparation aliases use the
retained Task's original event identity, never the alias's request ID. This binds
only a matching existing reservation to its actual Task ID; absent or expired
reservations and pre-feature tasks incur no new charge. A conflicting Task ID
refuses the operation. Binding does not restart the task or clear provider/effect
uncertainty; existing continuation and reconciliation authority still applies.
Read-only status/artifact/draft review and owner cancellation remain available.
