# Automatic shared user memory (development)

“Tell Spindle” accepts real typed turns, not model envelopes or canned assistant replies. With conversation learning **and** model processing enabled, a turn becomes an immutable EvidenceStore source and a durable learning job. The existing AgentRuntime calls the supplied AgentProvider with only `memory.learn {key,kind,value,quote}` registered. Each admitted `memory.learn` action commits its inferred fact/preference/goal and stable sync intent immediately, without a per-fact Save step or a later planner `ready`. Its successful feedback is `{saved:true,durability:'local',sync:'pending',value:actualStoredValue,outcome:'saved'}` for a new durable intent. A verified identical inferred value and complete provenance returns `outcome:'already_saved'` without a new intent (and `sync:'synced'` only for an already canonical identical record), never `staged:true` or an unobserved backend success. A later planner timeout/malformed response does not undo an acknowledged save. An absent provider leaves turns queued with `MODEL_NOT_CONFIGURED`; interrupted/failed planning is uncertain and never automatically paid-replayed. An uncertain turn may therefore have already-saved memories, visible separately in recall/status.

This is separate from PR87's manual **local task context**. Its MemoryStore APIs, IDs, versioning and Google/task source namespaces are unchanged. There is no adoption or migration. New tables in the same EvidenceStore SQLite connection are scoped by authenticated Spindle account UUID and workspace. Credentials/cookies stay in AccountClient memory. Signing in does not enroll a device or start capture. Local SQLite and source files remain private plaintext, not encrypted or forensic-erasure storage.

## Integration contract

```ts
import {createUserMemoryApplication} from '../core/memory/application.js';
import {AccountClient} from '../core/account/client.js';

const memory = createUserMemoryApplication({
  evidence,                       // existing EvidenceStore; exclusive lifecycle owner
  evidenceRoot: contextDirectory, // exact directory used to construct that EvidenceStore
  account: new AccountClient(trustedAccountOrigin), // trusted app configuration, never model/UI input
  workspaceId,
  provider,                       // optional EXISTING configured AgentProvider instance
});
memory.start();
const review = await startTaskReview(tasks, taskNamespace, evidence, memory);
// Shutdown in dependency order:
await review.close();
await memory.stop();
evidence.close();
```

`startTaskReview` preserves its two/three-argument behavior; the optional fourth argument exposes the authenticated shared-memory API and panel. Task namespace and authenticated user-memory namespace are deliberately different. The [combined preparation startup](AGENT_STARTUP.md) wires this lifecycle when trusted `AgentApplicationConfig.userMemory = {accountOrigin}` is supplied; `review: true` exposes the existing panel. It reuses the application's budgeted provider and session persistence, exact EvidenceStore/root and workspace. Omitting the option keeps manual-only task context. No runtime/model/Google/tracking-server implementation is replaced.

The service exposes `signin(name,password,register?)`, `signout()`, `session()`, `status(afterKey?)`, `configure({conversation,activity,processing,sync})`, `conversation(text)`, `forgetConversation(id)`, `correct(key,kind,value,expectedRevision)`, `forget(key)`, `resolve(key,currentServerRevision,correction?)`, `recall(query)`, `start()`, `drain()` and `stop()`. `drain()` is one finite pass (at most four learning jobs, six turns per job, 12 runtime reservations, 30-second runtime timeout; at most 16 source invalidations before at most 16 outgoing distinct keys, and four incoming 50-record pages per sync phase; active activity processing additionally reads up to four canonical pages before extraction). Start uses a one-second, single-flight poll. Stop aborts and drains owned work; callers close their own stores. Use the service signin/signout methods. If another trusted owner changes the shared AccountClient, it must call `session()` **before** the change to fence in-flight learning, including same-account reauthentication.

To use the existing assistant CLI without editing startup, set `SPINDLE_USER_MEMORY_MODULE` to an **absolute trusted operator-owned JavaScript module**, exporting:

```js
export function createUserMemory({evidence,evidenceRoot,workspaceId}) {
  return createUserMemoryApplication({evidence,evidenceRoot,workspaceId,
    account: new AccountClient('https://your-approved-shared-account-origin'),
    provider: configuredExistingProvider});
}
```

Import the compiled application/client and your existing provider configuration in that module. Then run the existing CLI with `DATABASE WORKSPACE TASK_ACCOUNT CONTEXT_DIRECTORY`. The module is not supplied by HTTP/model input, and the CLI introduces no provider implementation, credentials file, background service, deployment or startup registration. Omitting `provider` is useful to inspect the truthful blocked-configuration state, not acceptance of automatic inference. A production caller can supply NebiusAgentProvider with FileCallBudget and AgentSessionStore bound to this EvidenceStore. Extraction prompts do not copy existing memory values. Fact/source forget and expiry conservatively purge every extraction-job envelope owned by this application in the authenticated workspace/account (including old-format abstaining prompts), not unrelated task journals. In-flight extraction is cancelled before that purge; the production adapter checks cancellation before subsequent persistence. A provider persisting additional copies elsewhere retains its own deletion obligations; the service cannot purge arbitrary external journals or provider-held copies.

The registered tool publishes a strict output schema, with the same parser used by the runtime: success has exactly `saved`, `durability`, `sync`, bounded nonempty `value` and `outcome`; false results have exactly `saved:false` and `reason`. Reasons are `user_correction_preserved`, `forgotten_key_preserved` and `unsupported_learning_declaration`; none discloses a value or operation ID. Only a known unsupported declaration rejected directly by prewrite admission returns normal `status:'ok'` feedback with `saved:false`. This means evaluation completed **without saving**, not that a wrong-kind proposal was accepted or that the model abstained. Source/currentness checks and the outer transaction must still complete. Integrity, revocation, persistence and unknown errors remain hard failures. The actual proposal stays in the decision trace; the model alone chooses its next action or Ready. The public application factory uses this same registered-tool contract and unchanged authentication/privacy boundaries.

## Public learn, recall and correction contracts

These are existing production entrypoints, not a separate pilot SDK. Reuse `createUserMemoryApplication`, the configured provider/registry and authenticated AccountClient. Do not call a handler with a fabricated context or submit inferred rows directly. The caller supplies its own text, search and correction; no owner, file, account UUID or expected answer is hardcoded.

```ts
// `memory` is the factory instance above, signed in using the caller's credentials.
await memory.signin(name, password); // register=true only for explicit account creation
memory.configure({conversation: true, activity: false, processing: true, sync: true});
const turn = memory.conversation(userText); // {id, state}; acceptance is NOT a saved ACK
await memory.drain();
const matches = memory.recall(searchText); // up to20 current, nondeleted entries
const state = memory.status(); // pending/error and per-turn state are separate

// A separately constructed peer factory uses its own EvidenceStore/root/AccountClient,
// the same trusted workspace/origin, and authenticates normally. No provider is needed
// for recall/correction: configure that peer with processing/conversation/activity off.
await peer.signin(name, password);
peer.configure({conversation: false, activity: false, processing: false, sync: true});
await peer.drain();
const entry = peer.recall(searchText).find(e => e.key === selectedKey);
if (entry && !entry.pending) {
  peer.correct(entry.key, entry.kind!, replacementText, entry.revision);
  await peer.drain();
  await memory.drain(); // subsequent recall observes the user-authored correction
}
// On shutdown: await peer.stop(); await memory.stop(); then close owned stores.
```

`recall` is bounded lexical search over the authenticated local cache, not an embedding/model call or a promise of semantic retrieval. `correct` returns void and queues an explicit user-origin CAS mutation; neither its return nor `drain()` alone guarantees remote acceptance. Inspect pending/error/conflict and canonical revision. Another user's signin binds a different UUID/cache; account/workspace cannot be overridden by these method arguments. Recreate factories and authenticate again after restart; uncertain jobs do not automatically replay. Shared HTTPS/installed-device rollout remains separate from the tested loopback backend.

### Registered handler

Only **`memory.learn` version2** is registered inside the existing `learnSource` AgentRuntime. Recall/correction above are authenticated factory methods, **not** newly registered `memory.recall`/`memory.correct` tools. The runtime binds the immutable job/source/account/workspace and currentness; tool callers cannot provide those authorities.

| Contract | Value |
| --- | --- |
| Input | Exactly `{key, kind, value, quote}`; no extra fields. `kind` is `fact`, `preference` or `goal`; nonempty key/value up to8192 characters, quote up to512. Source/grounding checks additionally apply. |
| Effect | `write_local`, no capabilities granted; atomic local entry/outbox/provenance COMMIT. |
| Successful observation | `status:'ok'`, `data:{saved:true,durability:'local',sync:'pending'\| 'synced',value:actualStoredValue,outcome:'saved'\|'already_saved'}`. Pending never claims remote durability. |
| Protected no-op | `status:'ok'`, `data:{saved:false,reason:'user_correction_preserved'\| 'forgotten_key_preserved'}`; no value echo. |
| Unsupported declaration | Normal `status:'ok'` no-write result `{saved:false,reason:'unsupported_learning_declaration'}`; no value echo, no kind coercion or claimed model abstention. |
| Integrity/revocation/write failure | Hard runtime failure, no successful saved ACK or partial transaction. Earlier acknowledged saves remain committed. |
| Repeated same key/source/value | Verified identical record returns `outcome:'already_saved'` without a new intent; no cross-key semantic deduplication guarantee. Repetition does not prove planner completion. |

Preferences return the full qualified source-derived declaration, which can differ from the model's value. Facts/goals keep their admitted values. Exact source quote/hash, complete field, predicate/scope/time and commit-time account/expiry/revocation/correction fences are mandatory, not optional sample conventions.

### Existing authenticated HTTP surface

The normal review launcher exposes `GET/POST /api/user-memory` when this factory is configured. Both require the launcher's `Authorization: Bearer <review token>`; POST additionally requires the exact launcher Origin and `Content-Type: application/json`. That token protects the local review interface; the AccountClient's signed-in session separately selects the shared user. No account/workspace override is accepted in action bodies.

```js
// Within the existing trusted review client; userText/replacementText are caller input.
await request({action: 'conversation', text: userText});
await request({action: 'sync'});
// GET /api/user-memory returns paginated status.entries/turns/errors, not a new recall route.
await request({action: 'correct', key: selectedKey, kind: 'preference',
  value: replacementText, revision: canonicalRevision});
```

Here `request` denotes the existing review client's authenticated request helper, not a new library. POST returns current status, not a tool saved ACK. The factory's `recall(query)` is the programmatic search interface; HTTP clients page `status.entries` using `?after=...`. The shared authenticated backend continues to use `/user-memory/sync`, `/user-memory/changes` and `/user-memory/forget-source`, through AccountClient rather than a parallel transport.

Meaningful failure boundaries are observable: factory operations throw `SIGNIN_REQUIRED`, `CONVERSATION_LEARNING_DISABLED`, `INVALID_CHOICES` or `INVALID_REVISION` for those contract violations; absent provider leaves `MODEL_NOT_CONFIGURED` queued, and sync conflict remains `ACCOUNT_HTTP_409` with pending/current canonical state. HTTP rejects wrong token/origin with403, oversized bodies with413, and malformed/unsupported actions with sanitized400 `Request unavailable`; it does not expose internal exception text. Check status rather than treating HTTP200/conversation admission as inference success. Planner uncertainty is a per-turn error and can coexist with a successfully saved record.

## Data and failure boundaries

- Conversation learning, already-admitted activity learning, model processing and memory sync have distinct choices. All default off. Sync is with the existing account service; a shared HTTPS origin is required for physical devices (loopback is a local test exception).
- The local panel retains the latest 50 turns/status, pages shared entries in groups of 50, shows inferred/user origin and exact source quotes, and supports correction, forgetting a fact/source turn and explicit recreation of a **synced** tombstone. Polling leaves utterance/correction drafts mounted. Passwords are cleared immediately on submission and never rendered or stored by the panel.
- Only the authenticated session chooses the user UUID. The trusted workspace is fixed at construction. Account switching aborts work and hides the previous cache; a fresh AccountClient must sign in before any cached user memory is exposed. A server 401 invalidates the session and hides the cache again. There is no silent fallback to task/Google identity.
- Tool input is exact/bounded; quotes must be exact substrings of the hash-validated immutable source. The model cannot select owner, provenance, correction authority, paths or grants. Explicitly confirming an unchanged inferred value still establishes user-correction authority. Prompt instructions ask it to abstain for third parties, quotes, uncertainty, secrets and permission/instruction claims. Before writing, bounded deterministic admission additionally requires a complete unquoted speaker declaration and a grounded quote covering the **whole typed turn or whole activity text field** (falling back to the title only when there is no text). The authenticated history ingress records the title/body offset in internal job metadata; the model cannot choose it, and it is rechecked at commit. Line wraps are whitespace, not permission to omit qualifications; email/sender/forwarded attribution rejects a third-party envelope. Supported projections are: scoped `I prefer/like/dislike`, first-person facts/current activity, explicit goals and supported active-work goals. For preferences, the model may supply the complete parsed object or an existing full grounded rendering. Admission returns one source-derived persisted value: the complete matched first-person declaration with collapsed whitespace and one terminal period, retaining source case/wording, leading scope, prefer/like/dislike direction and all object/time qualifications. Thus `concise plain-language answers` paired with the whole `For fictional community grant applications, I prefer …` quote saves the full qualified declaration, not a global unqualified scalar. Full/verbatim/object renderings at the same key converge to the same value and stable intent. Fact/goal values stay unchanged. Successful tool feedback echoes the value from the verified committed entry; protected correction/forget no-ops return only `saved:false` and a reason, never the protected value. Arbitrary paraphrases, inner substrings, quoted/reported subjects, explicit sensitive/authority/uncertain markers and dropped qualifications fail without writing or acknowledging a save. The same families work for conversation and admitted activity; this is **incomplete implementation coverage, not a first-person-only/English-only product rule or an activity/goal prohibition**. Unknown forms, multi-statement fields and arbitrary selected snippets remain unsupported, not silently rewritten. Older queued activity jobs without trusted field metadata use the entire snapshot conservatively; uncertain jobs are never replayed to add metadata. Account ownership of a visit does not prove authorship of arbitrary visible text: unmarked third-party first-person prose, undisclosed secrets, sarcasm and general semantic entailment cannot be resolved by this recognizer. Broader activity attribution and live semantic quality remain unproven; the historical quotation mismatch is retained, not relabelled fixed model behavior. Memory never grants tool permissions.
- Every admitted tool action atomically commits its local value, stable operation ID and provenance binding. Source namespace/identity/hash, expiry, source-forget and run/account-currentness are rechecked at that commit. Identical repeated same-key actions reuse the intent; corrections/permanent tombstones are preserved and return `saved:false` rather than falsely claiming a new inference. Persistence failure earns no successful ACK; earlier separately committed actions remain intact. Pending values are explicitly not synced. Canonical revisions/sequences come only from validated ACKs/pages; an entire page and cursor commit atomically after validation. Server correction precedence may acknowledge an ignored inference with the existing user correction. Redacted retry receipts may acknowledge an old operation with a newer tombstone.
- A 409 remains visible with pending operations retained, rather than blind last-write-wins. Where a canonical row exists, the panel shows its revision and requires explicit review/reapplication of a correction or forget at that revision. A stale/deleted source may also reject a new offline inference with 409: the error stays visible, no source-derived content is resurrected, and forgetting the pending key discards it. Explicit privacy tombstones discard stale pending content for their key; automatic source invalidations do not discard independent fresh-source operations. Local forget purges source snapshots, turns/excerpts, application-owned model envelopes, unsent puts and cached canonical content, while retaining revision/hash/operation fences. Independent user corrections survive activity/source deletion. Logical deletion is not forensic WAL/SSD erasure.
- **Forget turn/source is not forget key.** Explicit source forget and real deletion/expiry durably queue a content-free `/user-memory/forget-source` operation even if all its keys are independently corrected or absent. Queue insertion, source/job logical erasure, cancellation and local fences commit in one SQLite transaction. A full source queue fails without erasing content or claiming success. Snapshot unlink follows commit; cancelled jobs retry interrupted unlink after restart. Superseded unsent inferred puts are removed without deleting independent user corrections. This may leave an offline correction needing explicit conflict resolution if its prerequisite inference never reached the server.
- Source operations contain only stable ID, workspace, kind, source ID and (for activity) activity key. Their IDs and local fences survive restart and lost replies. They sync independently of processing choices, before key puts; an exact one-ID ACK and current session/generation are required to remove intent. Invalid ACKs, conflicts and network failures retain pending intent; incoming canonical paging still runs. Both queues count as pending, and a pass with unflushed work does not advance the last-completed-sync time. Permanent content-free local fences suppress repeated invalidation from replayed tombstones and reject late inference on the same immutable source. The server scrubs source-derived current inference and old replay receipts while preserving independent user corrections, and rejects late/new-key inference from the forgotten source. Forget key additionally removes the selected value; it is not a substitute for source invalidation.
- Explicitly forgotten keys (including older tombstones without a reason) reject inference. Only explicit user recreation at the synced current permanent tombstone revision is accepted. Automatic backend invalidations carry `deletionReason: 'source_invalidated'` on content-free deleted entries only. A new inferred value at the **same key** requires the exact canonical tombstone revision and a genuinely current, unfenced source; the server remains final provenance authority. Clients cannot submit the marker as mutation authority. Expired inferred sources fence commits, hide dependent recall and queue a forget; user corrections remain authoritative. No paid replay occurs for a running job found after restart.
- Shared wire bounds are exported by `USER_MEMORY_LIMITS`: 8192-character keys/values, 256-character workspace/source IDs, 128-character event/operation IDs, eight sources per entry, 512-character source excerpts, 16 outgoing operations and 50 incoming entries per page. Client learning, mutations and status cursors accept the full key bound without truncation or row skipping. The local assistant HTTP route allows bounded 128KiB headers/JSON bodies for encoded maximum keys/values; Outgoing sync batches use at most 16 distinct keys and 512000 bytes for the entire UTF-8 encoded JSON body, including escaping, within AccountClient's existing 512000-byte request / 1.1MB response limits. Split queues retain full values and stable operation IDs, and each successful pass still reads incoming pages/tombstones. An individually oversized corrupt operation stays queued with `INVALID_MEMORY_OPERATION_BYTES` after incoming reads; current valid field bounds allow at least one operation to fit. Turns remain capped at 8192 characters, learning tool actions/recall at 20 results, admitted jobs at 1000, queued key mutations at 256 and queued source invalidations at 256. These are development bounds, not unlimited chat/history storage.

## Activity ingress and proof limits

When activity learning and processing are enabled, the service polls the existing account `/user-memory/activity?cursor=N&limit=16`. It validates page order/cursor, device/recording/visit identity, revisions, admitted scopes and expiry before snapshotting only title/text. No screenshot, OCR, URL, new capture, collector or clock is introduced. Stable hashed event IDs survive retries; source provider IDs and learning-job metadata retain the original device/recording/visit/revision/consent/policy provenance. Each activity source/quote binding also carries `activityKey` (the original `device/recording/visit`, without an `activity:` prefix) and numeric `activityRevision`, allowing shared source validation. A changed hash at the same admitted revision is rejected. Deletion/expiry purges dependent source content/jobs and queues forget, without deleting independent user corrections. Routine immutable revision replacement is **not Forget**: it cancels obsolete jobs, removes old snapshots/envelopes and superseded unsent inferences, but never queues permanent source/key forget or fabricates a canonical deletion. Durable cancellation precedes unlink, and cancelled jobs retry unlink after restart even without a forget fence. Automatic tombstone cleanup uses only the superseded canonical provenance, not historical key bindings that could include a newer source. When activity processing and sync are enabled, canonical invalidations are read before extraction. After offline learning, a stale unacknowledged inference is discarded/re-extracted with a new operation ID only against an automatic-invalidated canonical row and a still-current completed source, successful history poll, local fences and hash-verified immutable snapshot. Unknown/stale sources and permanent tombstones are never blindly rebased. Other conflicts remain visible. An activity request failure is shown separately and does not block independent conversation learning or memory sync.

The backend integration must include the additive authenticated read-only `/user-memory/activity` route before the collector-device gate. It projects only the validated identity/revision/time/scopes and visit `id/title/text/expiresAt` fields; no image, URL or Rich payload is transferred to a memory reader. The response remains below AccountClient's 1.1MB limit even for maximum supported Rich sources. Shared source deletion/expiry invalidation and stale-write fences run on the backend independently of opted-in extraction: a memory-sync-only peer receives a tombstone with the learner offline, including after restart. Independent user corrections survive that invalidation. Read access does not permit collector writes or enroll a new device. The backend was delivered by the independent main-target child; combined source assemblies reuse that existing implementation. This client does not fork it or silently enroll a device to bypass the collector boundary.

## Draft wire compatibility

This is **not a transparent upgrade**. Older strict clients reject the unknown `deletionReason` entry field and fail closed without committing that page or cursor; they may stop making sync progress. New clients accept old missing-reason tombstones conservatively as permanent. Coordinated client/backend upgrades are required before adopting this draft wire change. No deployed-client inventory, rollout or deployment authority is established here.

## Verification

```sh
npm run build
node --test build/tests/assistant/*memory*.test.js
# Optional real backend, selected explicitly (no repository dependency):
SPINDLE_MEMORY_SERVER_MODULE=/absolute/path/to/built/tracking/server.js \
  node --test --test-concurrency=1 build/tests/assistant/user-memory-server.test.js \
    build/tests/assistant/user-memory-activity-server.test.js
# Existing clean Chromium; invented samples only:
SPINDLE_REVIEW_CHROMIUM=/absolute/path/to/chrome \
SPINDLE_MEMORY_REVIEW_OUTPUT=/private/scratch/review \
  node build/tests/assistant/automatic-memory.e2e.js
```

Deterministic replay and scripted-provider regressions check durable saving independently of planner completion, stable duplicate intent, truthful sync feedback and recoverable no-write rejection. They are not live semantic-quality or connected-journey proof. Current source-bound results, budgets and preserved failure histories belong in [issue #41](https://github.com/erniesg/spindle/issues/41), not this reusable contract. No paid retry follows from running these checks.

The revision-server regressions use the real application and authenticated backend for same-identity tea → coffee updates, separately with different/same memory keys. They cover processing-off peer invalidation, offline learning/restart, exact-CAS fresh-source recreation, rejected old-source/wrong-CAS writes, stable lost-ACK retry, finite queue convergence, independent corrections and permanent source/key Forget. Focused checks cover replacement cancellation/unlink recovery and automatic ACK/page handling without discarding fresh queued inference.

The source-server regression additionally exercises typed learning → peer coffee correction → offline source forget → client restart → lost source ACK/retry → peer/server restart. It checks the retained coffee correction, decrypted encrypted-store receipt scrubbing, local durable source fencing and a rejected late original-source inference under a new key. Focused SQLite tests cover no materialized key, invalid ACK retention, revocation/account/stop fences, full-queue atomic failure and SQL/unlink crash ordering. This is logical deletion only: SQLite freelists/WAL, SSD remnants, backups and externally retained provider copies are not forensic-erasure guarantees.

The optional server tests exercise actual loopback account registration/session, two clients, another-user denial, client/server restart, automatic conversation inference, canonical sync, correction and forget. They also queue 16 maximum-length Unicode keys/values with sync off, drain byte-bounded batches after enabling sync, retry a lost ACK with identical operation IDs, read an incoming deletion while operations remain pending, and check malformed/valid user-origin provenance against the real backend. Writers and readers use the shared source-structure validator without skipping invalid pages or tombstones. The activity test uses a checksum-correct maximum 2MB invented Rich record and device-free memory readers, verifies text-only source-bound learning/shared recall, consumes 513/8192-character API-valid keys, stops the learner before source deletion, observes a memory-only peer's tombstone across server/client restart, and checks a visible 409 for a late offline source-derived put. Neither client enables activity processing for that deletion. The multi-job production-adapter regressions exercise fact/source forget and expiry after an unrelated abstaining turn, legacy copied prompts, unrelated-task preservation, and late HTTP responses. Neither test starts native capture. Semantic responses remain scripted. The production Nebius adapter test uses an actual HTTP stub plus durable budget/envelopes; it never calls a live provider or establishes semantic quality. The browser test uses real Chromium/HTTP/SQLite, with scripted account/model responses, and checks learning without Save, correction/forget, inert text, draft retention and phone layout. No live model/Google, deployed HTTPS, physical multi-device, native capture or installed acceptance is claimed. Independent review and required media review remain separate coordinator gates.
