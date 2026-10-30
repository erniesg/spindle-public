# Voluntary browser site blocking (#78)

Build with `npm ci --ignore-scripts && npm run build`, load
`build/browser-extension/preview` unpacked into an ordinary disposable Chromium
profile, and open extension options → **Site blocking and recovery**. Enter a
hostname, optionally include subdomains, then approve
only that site's HTTP/HTTPS host access (including its DNS-equivalent trailing-dot spelling). One policy is supported; replacing it
invalidates existing exceptions. An allowed purpose is optional for a whole-site
block; leave it blank for whole-site-only protection. Configure a purpose before
reviewing a narrow resource exception. The active status displays the purpose or
explicitly says that no resource exceptions are configured. Capture enrollment, recorder, store and clocks
are unchanged. Tracker owns integration; the parent remains a merge dependency.

Main-frame navigation is blocked by a persistent dynamic network rule. Existing
matching tabs reload under that rule. A rejected reload keeps protection pending
unless a fresh tab query proves the target closed or left the blocked host (with
no matching pending navigation). Unknown identity/query failure stays pending.
Retry or restart reattempts existing-tab re-gating before publishing Active; the
query result is transient and no additional browsing identity is stored. **Remove block / recover access** removes
the rule and exceptions, but retains host permissions shared with capture.
Inspect/revoke those separately in extension settings. Disabling/uninstalling
bypasses voluntary blocking. Stored policy is not a continuously verified health
indicator. Policy mutations now write a durable pending intent inside the existing
`sitePolicy` key **before** touching guards or network rules. Until all affected
steps and final metadata commit succeed, controls say **Policy change incomplete**,
not Active, and guards deny resource overrides. Restart resumes that intent
idempotently; failed forward recovery stays pending without an automatic retry
loop. Retry the chosen policy or Remove to supersede a failed replacement (including
lost host permission). Removal also keeps its pending marker until local deletion
succeeds. There is no rollback that can falsely restore an Active snapshot after
browser APIs have partly succeeded. Continuous API/storage failure can leave
partial protection; the pending status is not a fail-closed network guarantee.
Committed metadata is not continuous detection of out-of-band browser-rule changes.
Capture's existing revoke action clears shared extension storage; blocking now
reconciles that deletion by removing its network rule, exceptions and guard.
Absence of policy is durable cleanup intent: startup and controls retry removal
of owned enforcement even if the original storage event failed or the worker was
interrupted. Cleanup gets one automatic recovery-alarm retry per failed burst;
persistent failure requires controls or a new worker, not a tight retry loop.
Controls report unknown/incomplete until absence reconciliation succeeds. Every
destructive cleanup boundary rechecks current policy, and the existing mutation
queue prevents a stale cleanup from overtaking a new user enable. No new storage
key or capture consent reset is introduced.
It does not change capture's clearing or native acknowledgement semantics.
Blocking lifecycle events (policy storage changes, alarms, tab removal/navigation)
share the control mutation queue and wait for session-grant restoration. Deletion
cleanup reads current policy, rechecks it after guard shutdown, and cannot overtake
a later enable/review operation. Stale early alarms retain the current unexpired
grant and re-arm its expiry. A different URL observed by the tab listener
immediately expires only the grant present at event receipt, before queued
current-tab reads can erase that departure on a same-resource return. A later
review's replacement is not expired by an older queued event. Status-only updates
also reconcile current identity: Chromium omits URLs on ungranted origins, so
missing current identity fails closed without requesting broader browsing access.
This preserves delivered events; it does not make browser event delivery or
network-rule removal atomic. Events received before cold restoration finishes
are retained against restored grant objects only, never against a subsequent
review's replacement. This provenance is an in-memory weak set, not additional
browsing persistence.

## Jev purpose processing (integration candidate)

The new **Ask Jev** route uses a separate purpose-only Native Messaging port and the existing signed-in Spindle account/profile. It requires an explicit, per-review processing grant for the exact resource, purpose, policy/model/consent revision and static evidence. It does not require recording or timer access. Root retires grants on account/profile changes, lock and Quit; processing Revoke aborts pending work rather than waiting behind credentials. Busy/denied work cannot read keys or reserve money. Host timeout is 1400 ms, extension retirement 1500 ms, with no retry. All three predeclared Choice/Score/Noul thresholds must agree; unknown/error stays blocked, never a path-word or manual fallback.

Production processing defaults **UNCONFIGURED**. The operator may explicitly select an absolute private JSON file with `SPINDLE_PURPOSE_CONFIG`:

```json
{"provider":"typesafe","keyFile":"/absolute/operator-selected/typesafe.env","keyFormat":"dotenv","budgetFile":"/absolute/operator-selected/current-task-budget.json","maximumCalls":3}
```

`keyFormat` is explicitly `dotenv` (Node's `parseEnv`, selecting only `TYPESAFE_API_KEY`) or `raw` (one key value, not an env assignment). Keys are read lazily only after admission and cumulative-budget checks. No secret copy, env discovery, journal creation/reset or old-ledger conversion is performed. The selected journal must already be a valid `typesafe` USD cumulative journal; the existing default `nebius` journals remain separate. Reservations atomically enforce the selected cumulative call ceiling under the existing journal lock. An optional journal `maximumCalls` (integer 1–100) is a persistent stricter ceiling that cannot be widened by another Root config; omitted preserves the existing 100-call journal bound. The current named three-call pilot requires `maximumCalls:3` in both its config and its one new journal, never a reused/reset ledger. This example is **not spending authority**: a named owner grant and exact source/input/pricing/offline preflight are required before live calls. Preserve uncertain reservations and cumulative call counts through restart.

The capture-free Root's trusted Node test API optionally accepts `{purposeClassifier}` as the third `runTimerOnly(directory, noOpen, options)` argument. This is fixture injection, not an HTTP/extension backdoor or another backend. Browser bundles contain only pure blocking contracts/policy—not host classifier, control, file-budget or credential modules. Production/vendor quality, real browser enforcement/recovery and installed platforms require their own current evidence; module tests alone do not establish them.

## Manual resource override (existing, separate)

There is no generally verified semantic classifier. The path-word baseline is unverified
and never automatically unlocks a browser resource. Choose a target tab, enter
an exact supported resource URL, and explicitly override uncertainty. This is
a user decision, not classification success. Admission uses the shared core
validation, policy revision/purpose, unchanged target navigation and expiry,
then installs a higher-priority case-sensitive exact-URL, tab-scoped session rule. Other tabs,
paths and hosts remain blocked. No remote processing or page metadata is used.
The controls identify targets by browser tab ID, not captured browsing history.
Override success is explicitly **Last action** feedback, not a continuously verified
live-grant indicator: navigation or expiry may already have re-gated the tab.

Overrides are time-bounded (1–300 seconds), scoped to the exact case-sensitive
URL, target tab, chosen purpose and policy version. Expiry, policy changes and
capture revocation re-gate access. Departure cancellation and SPA re-gating are
asynchronous, not atomic or single-use: a rapid HTTP redirect, JavaScript or SPA
return to the same resource before cancellation can reach the server without
renewed review. The resource-change invalidation requirement remains limited;
rapid-return probes are negative coverage, not a fixed race or acceptance pass.
Other-resource network isolation is distinct from this same-resource return gap.
Ordinary MV3 extensions cannot use synchronous `webRequestBlocking` (policy-installed
extensions only), and `webNavigation` provides no request-event ordering guarantee.
No privileged installation or additional permissions are proposed.
Incidental worker termination preserves unexpired grants
in extension session storage; browser restarts retain the block, not exceptions.
Exception installation persists resource/version/expiry and schedules its alarm before
installing network authority, with rollback covering every installation await.
Revocation removes network authority before best-effort metadata persistence; a
failed metadata write/remove cannot prevent re-gating or resurrect a network rule.
Unreadable startup metadata causes demonstrably blocking-owned orphan session rules to be revoked. Ownership is the existing exception wire signature: ID = 100000 + a nonnegative tab ID, priority 2, plain `allow` action, exactly one matching tab and main-frame resource type, case-sensitive anchored escaped canonical HTTP(S) URL, and no other condition fields. The numeric range alone is not reserved. Source inspection found no other session-rule writer in the capture extension; future seam owners must not emit this exact protocol signature. Metadata alone never proves rule ownership. Restore validates its resource/version against the owned rule; mismatches and stale metadata cannot retain a guard grant. Every revoke inspects the current rule before removal, and installation rejects a foreign ID collision rather than replacing it. Unrelated session and dynamic sentinels are preserved; there is no universal registry/range takeover.
Initialization failures (including session-rule enumeration) no longer latch a
rejected promise: controls and lifecycle events retry restoration, with one
additional attempt per recovery alarm rather than an immediate API loop. Failed
initialization retries revocation of known grants; if inspection fails it closes only their known target tabs rather than deleting uninspected/tab-derived IDs. Orphans without readable metadata cannot be identified until enumeration recovers; controls remain unavailable in that state, not successfully restored. Blocking-owned rules are tab-scoped, so closing a known target bounds its authority without removing unrelated rules;
no resource review is admitted until initialization succeeds. Successful cold
restoration still preserves unexpired grants. A retry
alarm is scheduled before network removal; failed control calls retain an expired
grant with an expired deadline persisted for immediate retry after worker restart.
If both network removal and persistence of cancellation fail, the affected tab is
closed rather than leaving a restart able to restore its former deadline.
Failure of both alarm scheduling and rule removal
attempts to close the affected tab. Chromium alarms are not a hard real-time clock:
continuous browser control API failure (including tab closure), disabled extensions
or browser shutdown cannot be made tamper-proof. Errors are logged, not success
claims. Whole-site blocking remains independent of these session metadata writes.

A registered document-start content script checks resource/policy state and pauses
media/hides/reloads a gated document. It observes URL changes locally every 250ms
and contacts the worker only on initial load, URL changes or grant expiry,
complemented by tab URL events. A response is applied only to the resource that
requested it; navigation during an awaited check triggers a new current-resource
check rather than consuming that URL change or applying stale permission. Removal
unregisters the script and sends a stop
message to existing guards; replacing the policy stops old guards too. This is best-effort re-gating, **not strict zero pre-playback**.
Already loaded media, subresources, arbitrary players, autoplay, Shorts, embeds
and universal website support are not established. Query-selected identities are
rejected unless the core's narrow typed identity preserves the exact resource
(e.g. an allowlisted YouTube watch ID); that does not establish YouTube playback
coverage. Uncertainty, stale policy and unsupported identities remain gated.

## Shared purpose-processing contract and installed binding

`core/blocking/purpose.ts` provides the shared request projection and reply fence
used by the production worker and authenticated native dispatcher. The pure
contract itself performs no provider call and grants no network permission;
the integrated host classifier and browser policy/enforcement own those effects.
Actual offline browser evidence covers that installed path with a fixture vendor,
not live semantic quality or installed Windows/Mac capture.

The authenticated host derives the approved model, processing-consent revision
and explicitly allowed fields. Browser-supplied model/consent values are only
expectations. The projection admits a canonical resource and nonempty purpose,
plus separately allowed title (200 characters), summary (1,000 characters), and
current-page text (4,096 UTF-8 bytes). Page text needs its own field consent and an
admitted resource-bound source/evidence identity; changing that identity invalidates
the result even at the same URL. Metadata-only requests are explicitly distinct.
The constructed provider state is capped at 6,144 UTF-8 bytes. Oversize data is
rejected, not silently materialized or clipped by this boundary.
Denied optional fields are not read or copied. Captured visits, images and unknown
fields are rejected; recording is not required. Local request/policy/consent IDs
are excluded from the constructed provider state. Schema validation does not
verify that metadata came from the resource: the binding must first admit its
permitted source/provenance.

Replies echo request, resource, purpose, policy, model, consent and evidence identity and
carry `authority: none`. Changes, cancellation, malformed replies and results at
or beyond the local 1,500 ms operation deadline yield unknown. This deadline uses
the caller's monotonic operation time, not a second capture clock. A matching
suggestion still requires the extension's current tab/navigation and user-policy
checks before enforcement. Uncertainty never becomes an implicit override.

The tracker owns the existing authenticated Native Messaging/preview IPC binding.
The installed binding supplies the separate purpose slot, busy rejection before
credential/budget access, provider transport, abort propagation and cumulative
usage accounting described above; these effects do not live in the pure contract.
The product text path uses an explicitly permitted resource-bound source, not an arbitrary server URL
fetcher, private profile, cookie jar or unbounded DOM dump. These helpers read no
DOM and never fetch a supplied URL. No second server, recorder or history store
is proposed. Real semantic quality and supported-host acceptance
remain independent requirements; contract fixtures cannot establish either.

### Prepared Jev output comparison (no new live calls)

`core/blocking/jev.ts` constructs one native System One request with categorical
Choice, an atomic semantic-alignment Score, and a Noul statement-truth question
against the same permitted state. It fixes model/question revision, caps the full
JSON request at 8,192 UTF-8 bytes, and parses the native distributions. It has no
transport, credentials, URL fetcher or permission effect. Expected/manual labels
and provenance/control identifiers are not model state.

Choice returns a selected label, its option probabilities and distribution
confidence. The original pilot's **0.83 described its selected UNCERTAIN answer**,
not an 83% probability of allow or correctness (allow probability was 0.11).
Score is the probability-weighted position on predeclared ordinal levels, not an
allow probability; probabilities, confidence and legend must be retained. Noul
returns the probability of a statement being true with **no separate confidence**.
The installed Pi SDK maps Noul to `bool/probability` and drops Score's distribution
and legend, so this comparison parser consumes the native API body instead.
See the official [Score](https://docs.typesafe.ai/primitives/score.md),
[Noul](https://docs.typesafe.ai/primitives/noul.md) and
[confidence](https://docs.typesafe.ai/confidence.md) schemas.

`tests/fixtures/purpose-grounded.json` contains small actual public-page excerpts
with URL, retrieval time, text/prefix hashes, explicit prefix truncation and manual
expectations. Metadata-only and text-supplied inputs remain separate. These are
public non-personal source examples, not private activity, complete pages,
transcripts, model answers or browser-enforcement evidence. Reading their URLs is
an operator-only bounded preparation step; it is not an application SSRF surface.
The original three-authored-example pilot and its failed positive result remain
unchanged. No comparison call is made by tests, and another live batch requires
its own applicable budget authority; unused money is not call permission.

## Permissions and isolated hooks

The manifest adds `alarms` for persistent expiry wakeups and
`declarativeNetRequestWithHostAccess` as an installed capability. The latter was
previously optional: fresh Chromium 145 profiles hung on the first dynamic-rule
update after runtime capability grant; making the capability available at install
resolved the observed failure. It grants no hosts by itself: HTTP/HTTPS hosts
remain explicitly requested at enable time. No new broad host grants or remote
endpoints are introduced. This permission change still requires independent
review. Existing `scripting` registers only the chosen host's local guard.

Hooks are an additive worker import, options link, manifest capabilities and
build asset copying/import relocation. Installed core admission/policy modules
remain inside the extension root; registered classic scripts have the compiler's
module marker removed. The tracker-approved capture storage listener ignores session
notifications (capture reads no session data) and blocking-only local writes to
`sitePolicy`/`sitePolicyRevision`. Any other local key, mixed capture/blocking change,
or unknown storage area still invalidates pending capture. Token/origin/Rich changes,
removals, explicit revoke and permission-removal fences are preserved. No second
recorder/store/clock is introduced.

## Reproduce and proof limits

Use a run-owned Xvfb display, Chromium binary and **fresh** profile:

```sh
DISPLAY=:178 SPINDLE_CHROMIUM_PATH=/path/to/chrome \
  SPINDLE_BLOCKING_PROFILE=/path/to/new-disposable-profile \
  node tests/blocking/browser.e2e.mjs
```

The policy transaction journey uses `node tests/blocking/policy-transaction.e2e.mjs`
with the same environment and an explicit unique media path. It grants only
`a.test` and `b.test` in its owned Xvfb profile (the driver clicks those two native
permission dialogs), then injects final replacement-write and removal rejection.
It checks actual server requests, pending controls, real worker stop/browser restart,
forward recovery and explicit removal. These rejections are runtime injection,
not physical disk/quota failures. The production-worker matrix additionally covers
initial enable, replacement and removal at journal, guard, DNR and final storage
boundaries, worker interruption and repeated forward failure with explicit recovery.

The absent-policy journey uses `node tests/blocking/cleanup.e2e.mjs` with a
unique media path and a disposable profile. `SPINDLE_ALLOW_PROMPT=1` clicks the
reviewed `reload.test` permission dialog in a 1280×900 Xvfb display. It calls the
actual inherited capture runtime revoke handler (native acknowledgement unavailable),
injects cleanup rejection, verifies same-worker recovery and real worker stop /
browser restart with absent policy. Unrelated dynamic rule 78002 and session rule 42 survive active/absent-policy cold worker startup, capture revoke, cleanup retry and explicit recovery. Browser restart clears all Chromium session rules by design; the test explicitly re-seeds the sentinel after restart rather than claiming session-rule persistence.
This does not simulate actual disk failure. Use a fresh profile after executable
changes: retained Chromium service-worker import caches can run older modules;
a new controls message returning undefined exposed that during this repair.

The navigation/revoke restart regression uses `node tests/blocking/navigation.e2e.mjs`.
`node tests/blocking/rapid-return.e2e.mjs` additionally delays a production control's
storage read to hold the mutation queue while real Chromium tab events observe a
SPA departure and return. It checks that the delivered departure survives a later
current-tab read of the original resource, and that a subsequent main-frame request
does not reach the invented server. Set `SPINDLE_ALLOW_PROMPT=1` only in its owned
1280×900 Xvfb profile to click the exact `example.test` permission dialog. The recorder starts only after site-permission entry completes; the logged
`RECORDING_OFFSET_SECONDS` maps journey elapsed time to recording PTS. Permission
entry is not retained in the current recording. This is runtime latency injection
and observed-event retention, not atomic cancellation,
HTTP/JavaScript race elimination, native enrollment or playback acceptance.
Add `SPINDLE_COLD_RESTORE=1` to stop the actual worker with an unexpired exception
and delay session restoration while the same departure/return events arrive.
This mode prepends a disclosed test-only wrapper to generated worker bytes and
restores them on exit; production and instrumented hashes are logged separately.
The warm mode uses unmodified installed production modules. No claim is made
that the latency wrapper is a physical browser/storage failure.
The startup recovery journey uses `node tests/blocking/startup.e2e.mjs` with the
same environment and media path. It prepends a disclosed test-only API wrapper
to the generated worker before launch, rejects initial enumeration in the actual
worker with existing session authority, and restores generated bytes on exit.
Production and instrumented worker hashes are logged separately. Use
`SPINDLE_STARTUP_FAULT=always` for paced repeated failure and same-worker recovery;
the default rejects enumeration once. This is
runtime fault injection, not actual browser API/disk failure or native acceptance.
The focused persistence journey uses `node tests/blocking/persistence.e2e.mjs`
with the same environment plus `SPINDLE_BLOCKING_MEDIA=/new/output.webm`.
It runs the installed unpacked extension with runtime-injected storage method
rejections; these are **not actual Chrome quota/disk failures**. DNR enforcement,
server-observed request isolation, alarms, worker stop/cold wake and browser restart
are real Chromium paths. Deterministic production-worker tests additionally cover
unreadable restoration and network/alarm control failures.

Approve the invented-site permission prompts (exact host, subdomains, then
`invented.youtube.com`, explicitly DNS-mapped to the loopback fixture, never the
real service). Server request logs assert that path/query case variants never
arrive while approved exact resources do; post-load guard state is not the oracle.
The test uses local invented sites and an external ffmpeg screen recorder;
its explicit quit/exit assertion avoids the observed Playwright video-pipe hang.
Raw recordings use unique `.local/issue78/media/blocking-<timestamp>.webm`
names (or an explicit `SPINDLE_BLOCKING_MEDIA` path). Logs/screenshots remain
under `.local/issue78/`. No media is published or independently reviewed yet. Repair evidence includes
decoded frames/contact sheets with exact timestamps and hashes for a fresh reviewer;
these are not independent visual approval.
Linux/Xvfb Chromium 145.0.7632.0 was exercised originally; the lifecycle repair
also ran on Chromium 149.0.7827.0, not Mac/Windows installed
capture acceptance. Node/Python regressions protect the existing capture seam;
a live enrolled native-host capture regression and independent technical/media
reviews remain pending. Core tests, not fixture labels or this browser override,
cover delayed inference/policy races; semantic classifier quality is unmeasured.
