# Connected Gmail draft and send tools

The ordinary account host now exposes `/mail`, linked from `/connections`, using
its existing account session, CSRF checks, encrypted Google connection and agent
stores. `startPreparationAccount` constructs this additive service by default;
`mailEnabled:false` disables it. Starting/reloading/status does not load a model
credential, expand a Google grant, create a Gmail draft or send mail. This source
change does not activate or replace a running host.

## Owner flow

1. Sign in through the existing account page and choose the connected Google
   sender. A Drive folder is **not** required.
2. Describe the email and optionally select/download current files from an existing
   preparation task, including valid partial outputs. Only those exact selected
   artifact IDs/hashes are admitted; file metadata, not binary contents, enters the
   model request. Explicitly allow AI processing of this email request. The
   configured model selects the registered local draft tools. Inspect the actual
   sender, To/Cc/Bcc, subject, plain/HTML bodies, reply/thread metadata and
   attachment metadata. New messages explicitly show that no reply metadata exists.
3. Save corrections locally; this creates a new immutable revision and clears the
   review choice. Reloading a saved revision is explicit and warns before losing
   unsaved editor changes. HTML is inert text, never rendered.
4. If necessary, explicitly choose **Enable Gmail draft/send permission**, follow
   the genuine Google consent step, then refresh. This requests `gmail.compose`
   plus the existing identity/read scopes and all previously recorded grants,
   retaining the current compose upgrade's required-grant and lease fences. It does
   not newly request all-mail or all-Drive access. Scope availability is not email approval.
5. Review the exact saved revision. **Save reviewed draft to Gmail** creates and
   reads back a real Gmail draft without sending. **Send reviewed email** requires
   the separate exact owner instruction and final confirmation. Neither action
   invokes another model merely to perform the approved operation.

Registered model-callable tools are `mail.draft.create`, `mail.draft.read`,
`mail.draft.edit`, `mail.draft.publish` and `mail.send`. Publish/send remain
external-write operations denied until trusted exact-revision owner admission.
The sender is backend-selected, never a model-issued From header. Models cannot
mint approval, grants, filesystem paths or arbitrary attachment URLs.
Both single calls and runtime-admitted batches are supported. The fence matches
an active invocation's registered tool name/run and either the singleton pending
ID or a member of the current admitted batch, not the batch-wide pending ID.
Unrelated IDs and a sibling's ID for a different tool remain denied; batching
never grants publication or send authority.

## Provider boundaries

Local drafts and MIME snapshots are durable EvidenceStore artifacts. Gmail draft
publication persists its intent in the existing atomic `Task.mail` before
`POST /gmail/v1/users/me/drafts`, then verifies `GET drafts/{id}?format=raw` against
the exact MIME. A local edit is a new revision; publishing it creates a new Gmail
draft rather than silently overwriting a user's older remote revision.

Sending a published revision verifies its remote draft, then uses
`POST /gmail/v1/users/me/drafts/send` with both the exact draft ID and immutable
`message.raw`. Gmail documents [updates in the send request](https://developers.google.com/workspace/gmail/api/guides/drafts#send_drafts):
this prevents a concurrent remote edit from substituting other send bytes. Without
a published Gmail draft, the existing exact-MIME `messages.send` tool is used.
Successful draft sending consumes that remote draft. A provider acknowledgement
is not a recipient delivery receipt or an exactly-once guarantee.

Duplicate action identities retain their original dispositions. Lost responses
remain uncertain across restart. This implementation conservatively also retains
uncertain intents when the final backend guard rejects before HTTP: it does not
issue a typed no-dispatch receipt, clear an unknown or permit blind retry. A later
verification GET failure cannot erase a known publication ID or prove a preceding
POST had no effect. No blind POST retry, consent reset or reconnect
can erase an unknown hold. The read-only reconcile action may recover a unique exact
published draft or return send-search candidates; it does not promote candidates
to delivered messages or automatically retry sending. Interrupted local/runtime
work is held for reconciliation rather than automatically taken over.

The mail surface can admit explicitly selected current artifacts from the same
owner's preparation tasks, without another Drive importer or write scope. Source
snapshots and generated outputs have distinct neutral filenames and can be
explicitly downloaded for review. The source task revision and exact file metadata
are frozen into the mail task and checked around model work and before writes;
source changes preserve the local draft but block stale publish/send. The required
backend guarded transport rechecks the actual invocation, selected source and claim
synchronously after the final encrypted-auth wait, immediately before raw Gmail
HTTP. The model transport also repeats its local dispatch guard after its last
async bound check; neither guard is exposed to the model or UI. Select the
current files and save corrections to create a new local draft revision without
another AI call, or explicitly remove attachments. Both model Ready and manual
completion validate the persisted draft against the
effective selected files. A partial local edit is retained but blocked if selected
attachments are missing; an explicit empty selection removes them without AI.
Missing selected attachments block Ready and external writes until corrected. No draft means no Ready claim.
Read-only reconciliation can still observe an old immutable intent after its
source changes or cancellation; cancellation never retracts Gmail effects. There is no arbitrary same-account
artifact, filesystem path or URL attachment access, and internal mail/MIME records
do not automatically become attachments. New filesystem uploads and new Drive
imports remain separate from selecting already-retained preparation artifacts.
Gmail draft readback permits only provider-added Received and replacement Date/Message-ID headers. Every other header and the complete MIME body, including attachment encoding and bytes, must match the immutable snapshot. Other canonicalization or edits fail closed. Reconciliation of a known provider draft ID remains read-only; no replacement draft or AI request is needed.

## Verification and activation limits

Tests use invented OAuth state and injected Google/model HTTP through the real
production account host, registry, runtime, MIME and approval paths. They cover
create/edit/read, actual API request shapes, immutable raw readback, sending the
published draft once, no-grant/no-approval/stale/owner denial, duplicate and unknown
holds, consent upgrade, and real sandboxed Chromium owner controls. **These are
not a live Gmail send or actual-model acceptance claim.**

Live acceptance still requires the existing host integrator to select the reviewed
revision, a genuine Gmail write grant, and a human-approved recipient/content and
attachments. No real email or Gmail draft is created merely to test wiring; no
Google consent is clicked by the coding agent. Preparation's separate no-submit/
no-send policy and its held tasks/budgets remain intact. Mail processing uses the
same configured lazy decision model and cumulative journal; it never creates or
resets a spending allowance. The UI exposes cancellation and preserves existing
facts/unknown outcomes rather than implying remote rollback. Captured owner/session/Google binding is checked
before and after lazy credential access, model transport and decision acceptance,
including Ready. Revoked requests cannot dispatch after a credential wait or accept
late decisions. Actual pending operations still drain on shutdown. Processing
pauses remain effective.
