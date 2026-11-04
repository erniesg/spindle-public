# Shared-account Google connections — partial #42 / #51

One Spindle account can connect several verified Google identities. Web and desktop
use the existing `AccountClient` and account backend; neither receives refresh or
access tokens. This slice does not close Gmail push, the connected-agent milestone,
installed desktop acceptance or live Google acceptance.

## Use and configuration

`/connections` is a separate, cookie-bound web page. It does not replace `/` or
legacy download paths, and does not expose the capability-only assistant UI.
The normal page restores the existing account session and shows **one active
connection/root**, bound to the retained task when selected. Draft/request intent,
root, task ID and requested saving mode survive refresh and permission navigation
in owner-scoped browser storage. No passwords, cookies, tokens or callback URLs
are stored there. Extra verified connections and expired/failed/pending attempts
stay under collapsed **Advanced**, alongside explicit retained-task selection.
They are preserved, not merged or deleted; an old attempt does not override a
working verified credential. Selecting a retained task only reads its state.

**Enable saving** prepares a tab synchronously on the user's click, then opens the
normal Google flow. Popup blocking produces a visible focused Continue link beside
the action, not below the page. After the owner's choice, **Refresh access** checks
grants and the exact parent. **Choose saved folder** appears only when Google needs
that step; its result must be exactly the task's root and then pass actual parent
verification before **Ready to save**. No permission step Runs or Resumes processing.
Denial preserves readonly access and the request/mode. Configuration, authentication,
permission, folder selection and verified-ready are distinct states.

Saving folder IDs only configures scope, not contents or output authority. The
metadata-only folder-check API remains available; task diagnostics instead reuse
the registered runtime source factory and are labelled manual probes, not LLM
acceptance. Folder validity/ancestry is checked on use; selected-root permission
never authorizes traversal through an out-of-root shortcut.
Connecting never starts recording, mailbox polling, AI, enrollment or startup hooks.

The backend remains numeric-loopback bound. A trusted reverse proxy would need to
preserve the configured Host and terminate TLS. Forwarded headers and request/model
arguments cannot choose the origin or OAuth redirect. With trusted
`publicOrigin = 'https://spindle.berlayar.ai'`, the implemented callback is exactly:

```text
https://spindle.berlayar.ai/oauth/callback
```

Local fixture servers use `http://127.0.0.1:<port>/oauth/callback`. No public DNS or
hosting is needed for the offline cross-client proof. Public routing, preservation
of existing downloads/services, registration, deployment and live verification
remain coordinator-owned actions with their applicable authority. No deployment
was performed for this source slice.

Programmatic host (trusted configuration only):

```ts
startTrackingServer(directory, key32, port, publicOrigin, {
  clientId, clientSecret, // server-only confidential Web client
  // http: mocked Google transport for fixtures only
});
```

The existing runner accepts explicit paths, without credential discovery:

```text
node <compiled>/core/tracking/run.js DATA_DIRECTORY KEY_FILE PORT PUBLIC_ORIGIN_OR_LOOPBACK_DASH PRIVATE_GOOGLE_WEB_JSON
```

The fifth argument is the existing private downloaded Web JSON (`web.client_id`,
`web.client_secret`, `web.redirect_uris`), not a new application vault. On POSIX the
file/parent must belong to the runtime user and have no group/other access; the
file cannot be a symlink. The exact configured callback must already appear in
`redirect_uris`; empty registrations fail closed. Loopback CLI requires an explicit
nonzero port when Google is enabled. No config/key is created or overwritten.
The already-created Web client/private configuration must not be recreated. Current private coordination records own actual registration/runtime readiness; historical setup gaps are not instructions to repeat completed configuration. Source checks do not establish owner consent or live connection.

Without Web configuration Google APIs return unavailable, not a host-keyring or
plaintext fallback. The existing injected 32-byte backend key/store must be usable
before listening. The runtime holding that key can decrypt data: **not E2EE**.

## Local shared-backend Web callback (no deployment)

The current owner instruction is **NO DEPLOY**. Local connection testing can use the same authenticated backend and Web client, not a Desktop/keyring/token-export workaround. The concrete local callback is:

```text
http://127.0.0.1:43166/oauth/callback
```

After this exact URI is registered on the existing Web client and represented in its private downloaded JSON, a trusted VM operator can run:

```text
node build/core/tracking/run.js PRIVATE_DATA_DIRECTORY PRIVATE_32_BYTE_KEY 43166 - PRIVATE_WEB_JSON
```

The existing backend key remains private and separate from its data. No command here creates credentials or config. On the Mac control interface, forward the same port before opening the UI:

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:43166:127.0.0.1:43166 <YOUR_SSH_HOST>
```

Open `http://127.0.0.1:43166/connections`, sign in to Spindle, then explicitly connect Google. The Web client needs only the exact redirect URI, not a JavaScript SDK origin. Reuse the existing project/client; do not create a service account, make the folder public or export tokens. The intended authorizing Google account is already saved as a Testing user for the current local setup; do not re-add it. Other configurations require their own applicable approval. It needs Viewer access to the requested folder; if already owner/viewer, no sharing change is needed. Consent is the owner's browser action. Select only the requested folder, then use the metadata-only check. Actual source access and model processing follow the latest explicit owner-selected scope and separate normal processing consent. A completed metadata-only/readonly verification phase is not a permanent prohibition on later explicitly authorized selected-source model work. Readonly never supplies a write grant, and neither connection nor this document grants unrelated-root access or unredacted evidence disclosure. Route/source verification and actual Google testing are separate claims; these instructions do not claim either live success or deployment.

## Account API and shared clients

All Google APIs are POST JSON with exact Origin, signed-in HttpOnly cookie and
`X-CSRF-Token`. Read operations are POST RPCs because browser fetch GET does not
reliably supply Origin. `POST /session {}` is the narrowly Origin-guarded read-only
CSRF bootstrap; existing GET clients remain supported. No general CSRF/Origin
exception was added. Public GETs are only the data-free connections shell/assets
and the strictly mounted callback. No CORS is enabled.

```text
POST /google/begin       {} or {connectionId} -> connectionId, authorizationUrl, expiresAt
POST /google/list        {} -> connections[]
POST /google/roots       {connectionId,roots:[folderId,...]} -> status
POST /google/disconnect  {connectionId} -> disconnected, revocation: confirmed|uncertain
POST /google/drive/check {connectionId,rootId} -> selected folder metadata only, provenance
POST /google/drive/list  {connectionId,rootId,folder,page?} -> files, provenance, nextPageToken?
POST /google/drive/read  {connectionId,rootId,fileId} -> bytesBase64, provider metadata/hash, provenance
```

IDs are generated by the server. Every operation authorizes the immutable Spindle
UUID from the current session, not an ID/email/namespace supplied by a caller.
This backend presently has **account-private authority only**. Workspace membership
is an unimplemented seam, not a product prohibition: workspace arguments cannot
create authority and are rejected here. Future workspace use needs actual membership
checks before construction of a scoped reader/tool.

Node/desktop consumers use `googleConnections`, `connectGoogle`,
`selectGoogleRoots`, `disconnectGoogle`, `checkGoogleDriveRoot`, `listGoogleDrive` and `readGoogleDrive` on
the existing `AccountClient`. The browser loads that same compiled class with
browser-cookie mode and `restore()`, scoped to its own cookie jar. There is no
server-global signed-in client. Signin explicitly revokes a prior Node session;
browser signin also atomically replaces/revokes its previous cookie on the server.
Signin, restoration and server logout share one private auth queue. Public logout
immediately invalidates local requests, then waits for cancelled signin's issued
session to be revoked before resolving. Cancellation is preserved across the old
session's logout await. Failed revocation retains private retry authority; a lost or
invalid auth reply with unidentifiable server authority reports
`ACCOUNT_LOGOUT_UNCONFIRMED`, not successful logout or permission to switch accounts.
Logout affects this session, not another device's session.

## Failed authorization and recovery

OAuth failures use fixed codes/stages/statuses: denied consent (400), missing Gmail
identity grant/profile denial (403), missing offline credential or rejected token
(400), client configuration/provider network or malformed response (502). A partial
Drive-only grant cannot establish an unverified identity. A verified Gmail-only
connection remains connected with Drive visibly missing; universal grants are not
required. Session/incarnation/CAS conflicts remain separate from provider failure;
actual encrypted-store failures remain `STORE_OR_REQUEST_UNAVAILABLE` (503).

`lastAttempt` is a safe per-row projection (outcome, correlation, timestamp, fixed
code/stage/status and optional fixed parser `reason`), independent of any previous working credential. Failed reconnect
retains that credential and selected roots. Failure commits require the same current
lease/incarnation/session as credential commits. Refresh/reload does not clear the
failure. Disconnect without a verified identity is disconnected, not pending forever.
Expired/orphaned leases project recoverable failure after expiry or server restart.

Browser callbacks requesting HTML receive a data-free completion/recovery page with
a local **Return to connections** link, no echoed callback query, no-referrer and
no-store. JSON clients retain failure status/code, plus `stage` where known and
`action: RETURN_TO_CONNECTIONS`. A used callback cannot be replayed. The browser
serializes actions, disables controls in flight, binds actions to stable rows and
fences stale refresh/owner results. Continue links survive unrelated refresh until
the relevant attempt completes, expires, disconnects or the owner signs out.

Repeated begin calls resume one unfinished row and the same live authorization in
its initiating session. Concurrent sessions or an already-processing callback get
`GOOGLE_ATTEMPT_IN_PROGRESS` (409), not a replaced lease. After completion another
Google identity can be added normally; this is not a one-account restriction.

The existing CLI logs allowlisted `google_oauth` events only: stage, fixed code,
HTTP status, random per-attempt correlation and optional fixed parser `reason`. No URL/query, authorization state or
code, account identity, provider body/description, token or secret is logged. These
new diagnostics cannot reconstruct the earlier owner's exact provider response.
No live runtime instrumentation or activation is implied by a source build.

### Google authorization-response compatibility

Google's [public discovery](https://accounts.google.com/.well-known/openid-configuration)
advertises issuer `https://accounts.google.com` and
`authorization_response_iss_parameter_supported: true`. The earlier parser omitted
`iss` and rejected an otherwise valid issuer-bearing response before token dispatch.
This is a reproduced contract defect, **not proof of the lost Mac callback's query**;
that actual request was not retained and its exact parser branch remains unknown.

Following [RFC9207 §2.4](https://www.rfc-editor.org/rfc/rfc9207.html#section-2.4),
present `iss` is form-decoded by URLSearchParams and compared exactly to the fixed
Google issuer before any credential lookup/provider request. Empty/wrong issuer,
including a trailing slash, fails closed. Legacy absence of `iss` remains supported
as this single-provider client's compatibility policy, not authority from query input.
[Google's Web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server)
and [RFC6749 §4.1.2](https://www.rfc-editor.org/rfc/rfc6749.html#section-4.1.2)
define an extensible authorization response (the RFC says clients MUST ignore
unrecognized response parameters). Here the existing restrictive policy is retained:
only the named `hd` metadata extension is additionally recognized, bounded to 253
nonempty, non-control/whitespace characters and discarded. Arbitrary unknown fields
and duplicates still fail closed; no blanket extension bypass is introduced.
This bounded handling is justified by response extensibility, **not** by mistaking
[Google OIDC's verified token `hd` claim](https://developers.google.com/identity/openid-connect/openid-connect)
for callback authority. Neither callback `hd` nor `iss` supplies verified identity,
account ownership, selected roots or grants. The existing Gmail profile, grant,
expected-identity and credential-CAS checks still establish the connection.

Parser failure reasons are fixed identifiers: malformed URL, origin/path mismatch,
state length/mismatch, duplicate/unsupported parameter, fragment, missing/invalid code,
issuer mismatch, invalid extension or unrecognized provider error. No raw parameter
names/values (even unknown names), query/URL, hosted-domain value or provider body is
persisted, projected, logged or rendered. Provider denial remains distinct from
missing code; storage faults remain unknown503, not parser denial.

## Incremental Gmail compose consent

On `/connections`, select the existing connected account/folder and explicitly click
**Enable Gmail drafting and sending**. The disclosure covers managing drafts and
sending mail; the button only starts consent, never drafts/sends email, calls a model,
or Runs/Resumes preparation. It is disabled while the selected task is running/queued.
After Google's choice, return and use **Refresh access**. **Gmail permission recorded**
means the saved grant includes `https://www.googleapis.com/auth/gmail.compose`; it is
not proof of Gmail API availability, a created draft, a sent message or delivery.

`AccountClient.authorizeGoogleMail(connectionId)` calls the ordinary authenticated,
Origin/CSRF-protected `POST /google/mail/begin {connectionId}`. It requires an existing
verified connection and reuses its confidential Web client, callback, PKCE/state,
verified Gmail identity and protected credential CAS. The request contains base
readonly scopes, all previously recorded grants and `gmail.compose`, with
`include_granted_scopes=true`. No caller-selected scope, redirect, identity or token
is accepted or returned. No new project/client or token export is required.

A compose callback must verify the same identity and return all requested and still
recorded prior grants before replacing the credential. Missing compose/prior grants
returns `GOOGLE_MAIL_GRANT_REQUIRED`; denial/partial consent retains the previous
credential, identity and selected roots. Session, connection incarnation, root
revision, epoch and final CAS fences prevent stale completion. Same-session repeated
clicks resume the same unused, same-purpose lease; a different permission purpose,
other session or in-progress callback returns `GOOGLE_ATTEMPT_IN_PROGRESS`. Expiry or
restart never restores an OAuth lease or fabricates grants. A new explicit click can
start a fresh flow on the same retained connection. Actual Google consent and saved-
grant checking remain owner/browser acceptance after reviewed runtime activation.

Focused checks: `google-compose-upgrade.test.ts` exercises the real HTTP/encrypted
backend with invented Google; `google-compose-upgrade.e2e.ts` uses actual Chromium,
normal sign-in/restore and the connection UI, but still invented Google. Neither is
actual Google consent or mail/model acceptance.

## Incremental new-output consent and folder authorization

Normal preparation does not reinterpret readonly grants as write permission.
The normal request UI defaults to **local draft** (`saveOutputs:false`): readonly
selected-root discovery/read, explicitly consented processing and protected local
form/photo/preview/session review and corrections do not require drive.file,
Google Picker, a save checkbox or a Drive POST. No OAuth/write expansion happens
automatically on Run, status, reload or correction. Actual source processing still
requires its separate explicit choice. Optional `saveOutputs:true` retains the
broader same-folder-new-output capability; local draft is not proof of that write
journey. See [production startup and request API](AGENT_STARTUP.md#signed-in-request-preparation).
`POST /google/output/begin {connectionId}` reuses the same confidential Web client,
PKCE/state/session lease, pinned verified identity and encrypted credential CAS.
It adds only `https://www.googleapis.com/auth/drive.file`, with incremental
`include_granted_scopes=true`; there is no full-Drive fallback. Denied consent or an output exchange missing drive.file/readonly grants
preserves the existing readonly credential and selected sources. Previously recorded
grants (including compose, if present) are included and required on this incremental
output flow as well. The owner's
separate same-root creation choice cannot invent a Google grant.

Google's [scope guide](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
defines drive.file for created/opened/shared app files, **not all arbitrary existing
folders**. The [folder guide](https://developers.google.com/workspace/drive/api/guides/folder)
and [files.create](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/create)
require an explicit parent to avoid My Drive root. The existing uploader checks
that exact selected root's `isAppAuthorized` and `capabilities.canAddChildren` before
creation; a locally saved ID or readonly metadata check is not per-file authority.
[Multipart/pre-generated IDs](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
permit stable-ID reconciliation, not assumed success from an HTTP200/409.
Official public pages were inspected for this source change; no live authorization
or upload is claimed.

Where opening the existing parent is necessary, the UI has an explicit **Authorize
saved folder in Google Picker** action. Its optional trusted `SharedGoogleConfig.picker`
contains the **existing project number** (`appId`) and a browser-restricted Picker
`developerKey`; the Picker API must actually be enabled for that project and the
key's HTTP-referrer/API restrictions must permit the approved origin and Picker.
These are configuration dependencies, not invented defaults. The worker neither
creates keys/clients, enables APIs nor changes project settings. Without that
configuration the route reports `GOOGLE_PICKER_CONFIGURATION_REQUIRED`; independent
local preparation remains available, while output creation stays unproven/blocked.

Authenticated `/google/list` (and the root-save status reply) includes per-connection
`outputReadiness: {pickerConfigured, grantPresent, blocker?}`. Configuration is
locally syntax-checked; `grantPresent` means the protected credential explicitly
contains `drive.file`, never inferred from readonly grants or saved folder IDs.
`blocker` is `GOOGLE_PICKER_CONFIGURATION_REQUIRED` before
`GOOGLE_OUTPUT_GRANT_REQUIRED`. Status does not request an access token, mutate
authorization, poll Google, or expose Picker keys/client secrets/credentials.
These are advisory local prerequisites, **not** proof the Picker API/key restrictions
work or that Google authorizes children in this parent.

The UI hides Picker while permission is missing. Missing configuration asks the
operator to configure the existing project/key, not the user to reconnect/reset
Google or repeat consent. **Enable saving** requests incremental permission on the
same verified connection when needed; **Refresh access** reconciles it afterward.
The one primary action is unavailable without configuration and changes to the
necessary parent check/folder choice when the grant is present. Local preparation and local snapshots remain
available without any output readiness requirement. The explicit Picker RPC repeats
authentication/root checks, then configuration-before-grant checks, returning typed
503 `GOOGLE_PICKER_CONFIGURATION_REQUIRED` or 403 `GOOGLE_OUTPUT_GRANT_REQUIRED`
before token access; stale UI metadata never supplies authority. Connector creation,
current checks and refresh each normalize concurrent grant reductions from one
protected context-and-grant read after a failure, without repeating the connector's
racy predicate. Session/connection/root/epoch fences precede grant recovery; typed
provider failures are preserved, and errors with no confirmed grant reduction are
re-thrown rather than labelled permission failures. The parent-check RPC needs the
actual output grant, but does not require Picker configuration.

The official Picker SDK is loaded only on that deliberate action, never for a
local-draft request. The narrow
`POST /google/output/picker {connectionId,rootId}` returns an ephemeral browser
access token plus public Picker configuration, after cookie/CSRF/current-root and
actual drive.file checks. It is no-store and never part of ordinary connection
status, telemetry, model tools, task/session artifacts or persisted browser state.
This is the explicit minimal exception required by Google's browser Picker, not a
generic credential export endpoint. The dialog result must select exactly the
saved root and cannot expand backend scope. `POST /google/output/parent` independently
queries Google's actual app-authorization/canAddChildren metadata; callback data
never grants authority. No personal source contents are included in these responses.
Live SDK/CSP behavior, actual project configuration and Google folder authorization
remain coordinator-owned verification; source/fixtures cannot establish them.

## Explicit background trigger capability

Backend-only `SharedGoogle.triggerAuthority({ownerId,connectionId,isCurrent})` reuses the **same encrypted credential adapter, Web client and refresh CAS**. The trusted host must derive `isCurrent` from explicit revocable standing owner configuration, never from model/email/HTTP input or mere possession of OAuth grants. This method is not an HTTP RPC and does not enroll/start a watch, receiver, model or mailbox scan.

The capability pins owner/connection incarnation, root revision, verified Google identity and epoch. It rechecks standing permission before/after provider I/O and at credential CAS, and drains tracked HTTP on backend close. Browser-session expiry is neither its lifetime nor a restart credential: the host restores and rechecks real standing permission on restart. Missing permission/grant, owner/connection/root changes or close fail closed; no desktop keyring, token export or second vault is introduced.

Google's provider account remains the Google identity. A deterministic backend-owned workspace `account-private:<owner UUID>` isolates tasks/evidence for different Spindle owners even when they connect the same Google identity. This is constructed authority, not a caller-supplied workspace label or a claim of general workspace membership. The normal trigger startup checks that its namespace matches the supplied capability, calls the actual existing bridge with the same AgentStore, and wakes the existing queue asynchronously. Push still needs an approved mounted receiver, actual watch/subscription configuration and explicit relevance/bootstrap scope; none is activated by creating this capability. Local mode is not hosted push acceptance.

Invented encrypted-store/Web-refresh tests cover initially expired browser sessions and host reopen, separate owners sharing a Google email, explicit standing revocation during refresh (no late credential commit), connection/root changes and old-capability closure. These are source/fixture checks, not live Google trigger or private-inbox permission.

## Credential and race boundaries

The private account Google collection lives inside the **same** `EncryptedStore`
snapshot and serialized transactions as accounts: AES-256-GCM, encrypted staging,
atomic rename, file/directory fsync and one runtime directory lock. Its public
interface and crypto format are unchanged. Credential payloads are absent from
session/history/preferences/user-memory projections and are never put in AgentStore,
EvidenceStore or model envelopes by this service.

The adapter permits only conditional updates, checks owner/session/incarnation
inside the transaction, and pins reconnect to the previously verified identity.
Ordinary refresh preserves the Google epoch; reconnect gets a new epoch. A random
incarnation also fences stale creation when the expected credential was absent.
Disconnect durably removes the credential and rotates incarnation **before** remote
revocation, then reuses the existing OAuth revocation protocol on a private captured
snapshot. Uncertain revocation cannot restore local access or delete a later
reconnect. Identity/selected-root configuration and content-free incarnation metadata
remain for explicit reconnect; disconnect is not forensic erasure of old encrypted
snapshots/backups or provider-side guarantees.

Pending state binds owner, initiating hashed session, intended new-connect/reconnect
record/incarnation and expected verified Google identity. It expires after the existing
five-minute OAuth TTL, is bounded to 128 runtime leases and one per connection, and
fails closed after restart. Valid state is consumed once, including denied/malformed
callbacks. Duplicate/unknown query fields, wrong Host/method/path/origin, replay and
expiry are denied before provider I/O. Logout/switch invalidation is checked before
every callback HTTP dispatch and after its response, including between token exchange
and profile verification, and atomically before credential CAS; no callback cookie
is required. These checks never hold an encrypted transaction across network I/O.
Already-dispatched requests cannot be undone; the fence stops subsequent dispatch
when the initiating owner/session/incarnation/flow is no longer current.
PKCE, grant parsing, Gmail profile verification and refresh are the existing engine.
The confidential client secret is sent only by server token exchange/refresh.
`exchange()`'s internal access token is deliberately discarded, never serialized.

Drive is explicit on-demand, through the existing `DriveReader`: selected-root and
current session/incarnation/root-revision/Google-epoch checks precede refresh/read,
repeat around provider requests and precede the final result. An unselected root
is rejected before Google I/O. The existing reader retains ancestry/trashed/shortcut,
provider-version and exact-byte SHA256 protections. Download results are limited to
512KB here; they are authenticated source results, not credential export or automatic
evidence persistence. Provider JSON/errors are not returned wholesale.

Other bounds: 64 connection records/account (including disconnected/pending records),
32 selected roots/connection, existing backend request/concurrency/store limits, and
existing OAuth/reader operation timeouts. Capacity fails closed without eviction.
An acknowledged connection requires the encrypted write to complete; an interrupted
reply is unknown until list/status reconciliation. Closing the host awaits tracked
Google operations before releasing its store lock.

## Verification and limits

`tests/account/google-*.test.ts` exercise real encrypted storage and independent
actual Node `AccountClient`s with mocked Google HTTP, restart/two identities,
wrong-owner/namespace denial, callback guards/replay/expiry/denial, partial grants,
identity replacement, deferred token/profile/credential-CAS logout/switch, stale
refresh/reconnect/disconnect/absent-value ABA, root changes before/after I/O,
failed snapshot serialization, discarded reply and secret-free public projections.
The source read fixture verifies actual returned bytes, version, hash and provenance. Metadata-only check regressions assert one minimal folder GET and no child-list/media requests, wrong-owner/root denial before provider I/O, invalid/trash rejection and root removal during retrieval.
Deferred token logout/switch checks additionally assert zero subsequent profile
requests; the final atomic persistence fence remains separately exercised.
`tests/account/auth-lifecycle.test.ts` checks both cancelled-signin windows, actual
server denial, other-device isolation, failed/uncertain cleanup and retry.
Test-only transaction instrumentation is labelled; it is not disk-crash acceptance.

Current stateful normal-UI proof is `tests/account/preparation-stateful.e2e.ts`,
using sandboxed existing Chromium and invented Google/Picker/provider replies. It
covers stable draft/task/mode/root, one visible connection, direct user-gesture
consent navigation and focused popup fallback, denial retention, exact-folder
Picker/parent verification and no automatic processing. Backend
`preparation-stateful.test.ts` protects cross-tab/ID deduplication, working/queued
Resume rejection/CAS, truthful interruption, action provenance and paused startup.
These are source/fixture checks, not actual source/OCR/form or installed acceptance.
The older browser journeys below retain their historical evidence and pre-stateful
account-management controls; they were not re-run as current-page acceptance.

`tests/account/google-connections.e2e.ts` historically ran actual Chromium on the real server,
using the same `AccountClient` in browser and Node in both directions. Google HTTP
is mocked, external browser navigation is blocked, and credentials/consent entry
are not recorded. It exercises denied/unchecked and Drive-only consent, profile403,
token400/network failure, missing refresh credential, expiry/used recovery,
refresh/reload failure preservation, repeated begin/link preservation, pending
disconnect and failed reconnect retaining authority, then multiple identities,
verified partial grants, roots, disconnect uncertainty, cookie isolation and narrow layout. This is actual
web UI/API proof; **Node is an API seam, not an installed desktop app**. Native
capture is unchanged and native visuals do not apply. Local media requires full
inspection and independent review before any authorised publication.

`tests/account/auth-logout.e2e.ts` separately delays the old-session logout and the
new-session response in the actual browser class, then checks successful logout,
API denial and unauthenticated reload with HttpOnly cookies. Select an existing
Chromium with `SPINDLE_REVIEW_CHROMIUM` and an unused `SPINDLE_AUTH_REVIEW_OUTPUT`;
authentication uses invented API data before recording, without credential entry.

`tests/connectors/google-callback-contract.test.ts` protects exact issuer/form decoding,
legacy issuer absence, ignored bounded `hd`, every fixed parser rejection before any
credential/provider access, denial and one-use behavior. The focused
`tests/account/google-callback-contract.test.ts` checks actual HTTP/encrypted persistence,
safe HTML/JSON/telemetry reasons, malformed client response and verified identity/grants/roots
after reopen. `tests/account/google-callback-contract.e2e.ts` shows collapsed invented
history, explicit row reuse, pending continuation after reload and issuer-bearing mock
success in real Chromium. These are fake-Google checks, not live connection acceptance.

`tests/account/google-output-readiness.test.ts` covers missing/invalid configuration,
missing/genuine output grants, configuration-first typed failures, zero-provider-call
and byte-unchanged status reads, secret-free/account-isolated projections, and
incremental-consent denial retaining readonly roots. The associated
`google-output-readiness.e2e.ts` covers disabled actions, precise recovery, advisory
readiness and explicit Picker/parent verification through the real authenticated UI
in **sandboxed Chromium**, with entirely invented Google/Picker responses and all
other browser traffic blocked. It is not live Google/Picker acceptance. Use a short
run-owned `TMPDIR` under the approved scratch root (Chromium's Unix socket path is
bounded), an existing `SPINDLE_REVIEW_CHROMIUM`, and a new
`SPINDLE_GOOGLE_REVIEW_OUTPUT`; no browser install/download is needed.

The callback repair uses a separate build without mutating the running artifact:
`node --max-old-space-size=512 node_modules/typescript/bin/tsc --outDir .local/actual-flow/build`.
Focused causal regressions: `node --max-old-space-size=256 --test --test-concurrency=1 .local/actual-flow/build/tests/account/google-failures.test.js`.
Affected account tests: `node --max-old-space-size=256 --test --test-concurrency=1 .local/actual-flow/build/tests/account/*.test.js`.
The browser journey additionally needs an explicitly selected existing Chromium and
`SPINDLE_GOOGLE_REVIEW_OUTPUT` in an unused local evidence directory. No install,
Google/model call, public hosting, Pub/Sub, service account or personal data is needed.
