# Reusable local email drafts and guarded send

`createOutgoingMailTools` in [outgoing-tools.ts](../core/connectors/google/outgoing-tools.ts)
returns `mail.draft.create`, `mail.draft.read`, `mail.draft.edit` and `mail.send`
for the existing tool registry. This is a source/fixture-tested capability, **not
live Gmail/model acceptance or an enabled send path in the ordinary application**.
AgentRuntime defaults to refusing external writes. The task-host adapter below supplies narrow trusted admission and durable intent state; a normal authenticated review surface and real Google send consent remain separate integration/acceptance requirements. No outgoing message is authorized by implementing this module.

## Local preparation

```ts
const tools = createOutgoingMailTools({store: evidence, namespace, sender: selectedGoogleIdentity});
// Register these ToolDefinitions alongside the ordinary authenticated agent tools.
```

Create takes `{content, provenanceIds}`. Edit takes the same fields plus `draft`;
read/send take `{draft}` only. A draft reference contains `artifactId`, `sha256`,
`draftId`, `revision`. Content has structured `to`, optional `cc`/`bcc` mailboxes
(`address`, optional `name`), `subject`, `text` and/or `html`, optional attachments
(`artifactId`, `sha256`, `name`) and optional reply metadata (`threadId`,
`inReplyTo`, `references`). Sender identity comes from the trusted selected Google connection via the host `sender` option, not model arguments or the Spindle tenant UUID. Namespace and Google identity remain distinct. The email-valued namespace default is only backward compatibility for standalone callers and old drafts.

Results have `state: local_draft`, the reference and full structured record for
review. Each revision has a separate immutable JSON artifact and exact RFC/MIME
artifact, stable Date/Message-ID, byte count/hash, explicit attachment metadata,
source/artifact provenance and parent revision. Read verifies the review record
against actual stored MIME/attachment bytes. Edit never mutates originals.
There is **no Gmail draft ID**: local creation performs no Google call and needs
no new OAuth scope. Gmail draft creation would be a different external write.

Attachments default to exact source snapshots in the trusted ToolContext scope.
The host can admit generated preparation outputs with `allowAttachment(ctx,id)`;
do not admit every same-account artifact. The store enforces namespace/hash/byte
integrity. Model-selected paths, URLs, inline secret blobs and MIME overrides are
not attachment inputs. Common binary signatures and UTF-8 text/JSON are checked;
other formats are transported truthfully as `application/octet-stream`, not
rejected by an application file-type allowlist. This is signature/type verification,
not malware scanning or complete document-format validation. Filenames use RFC 2231
continuations; Unicode display names/subjects use folded RFC 2047 encoded words;
text/HTML and attachments use MIME base64. There are no dependency additions.

Current bounded implementation: 500 total recipients, 50 attachments, 40 explicit
provenance refs, 1 MiB per text/HTML body, 24 MiB encoded MIME. Empty subjects/bodies,
HTML-only mail, Cc/Bcc, quoted ASCII local parts and IDNA domains are supported.
SMTPUTF8 non-ASCII local parts and obsolete reply-header syntax are not implemented;
validation failure is an implementation limitation, not a product policy. Controls,
invalid addresses, header injection and path-like attachment names are rejected.
Reply metadata cannot guarantee Gmail threading: matching subject, RFC reply headers
and supplied threadId are required; the provider's returned thread is authoritative.

## Trusted send integration

`send: MailSendHost` is host construction, never tool arguments. It supplies:

- Existing `GoogleOAuth.connectorAccess`, selected connection ID/epoch and an exact
  `mailSendGrants` value. Prefer `gmail.send` for messages.send; no broad fallback or
  OAuth scope registration occurs here. A readonly grant never authorizes sending.
- `approval(ctx,binding)` resolving an approval ID from authenticated durable host
  state. `binding` includes workspace/account/connection epoch, exact draft ref and
  exact MIME ref/hash/size/Message-ID. Model text cannot create approval. Review must
  display the exact recipient/body/attachment revision; edits require new approval.
- `assertCurrent(ctx,approval)` fencing authenticated owner/session/incarnation,
  approval cancellation/revocation and selected current draft revision, on every
  awaited boundary. The existing Google account/epoch/grant fence is also rechecked.
- `journal: MailSendJournal`, implemented by the existing task/external-action owner.
  There is intentionally no second account database or in-memory production journal.

The journal's **atomic durable reserve** must commit the complete `MailSendIntent`
and serialize the approval across workers/processes/restarts before POST. It returns
`new` exactly once for that immutable intent, otherwise `existing` (or rejects any
rebinding). Serialization must stay owned through settlement without timed takeover;
`assertReserved` checks ownership. `settle` durably appends facts, preserves prior
acknowledgements/uncertainty, and never deletes/rebinds an intent on cancellation.
The exact MIME already lives durably in EvidenceStore; retain those artifacts with
the intent. An interrupted reserve/settlement needs host recovery, not a new POST.
Use existing runtime pending/recovery alongside this record, not in place of it.
These are trusted adapter requirements, not claims that a TypeScript interface can
prove a caller's persistence or serialization implementation.

Do not weaken the global runtime gate or relabel send as local. The coordinator must
add narrowly scoped trusted external admission and preserve pending/reconciliation
on crash, then register these factories in the ordinary authenticated provider path.
A successful result feeds the next normal model turn as structured data, not a
scripted success string. Worker tests exercise the actual existing runtime for local
results and gate denial; send callbacks use mocked HTTP and a fixture durable adapter.
The task-host checks below now exercise actual send-through-runtime machinery with invented HTTP; actual model selection and live Gmail acceptance remain unrun.

## Existing-task host adapter

`createTaskMailTools` in [mail-host.ts](../core/agent/mail-host.ts) wraps the same tools and stores current draft refs, approvals and immutable send claims in the **existing atomic AgentStore task** (`Task.mail`), not a second outbox/database. Pass its `tools` to the ordinary registry and its `execution` (narrow `approveExternalWrite` plus unresolved-send `assertReady`) to the existing runtime/startup. Default external-write denial remains unchanged for every other tool.

Only trusted authenticated application code may call `approve(taskId,draft,requestId)` after displaying the exact sender/recipients/body/attachments, or `revoke(taskId,approvalId)`. Neither is a model tool or OAuth grant. Each owner request ID retains its original immutable binding/approval in the same task, even after later actions and full reopen. Replay returns those retained facts without making an older/revoked approval current; reuse for different draft/connection/application bindings is denied. Duplicate retries add no history. Supersession/edit/revoke preserve the revoked disposition. Legacy tasks lacking request history cannot reconstruct forgotten IDs: retained current facts remain readable/replayable, but fresh approval fails closed for reconciliation. This is an unactivated migration limitation, not a new Google-consent requirement. Editing invalidates old approval; reading an old snapshot does not make it current. Application-revision changes also invalidate it. A selected sender mismatch or another tenant is denied even when Google email is shared.

Before POST, the existing task transaction atomically reserves the complete intent and run/call/generation claim. Existing claims never dispatch again, including after full store reopen. Cancellation/revocation cannot erase observed acknowledgement or unknown effects. Unknown sends block Ready and fresh authorization for **all revisions of the same logical draft**; editing cannot launder an unknown POST. Repeated known acknowledgements still check current host authority and return retained facts without sending. The host-only `status` projection exposes nonsecret receipt/intent state for review. Provider-candidate reconciliation below does not itself resolve uncertainty or permit replay; authenticated recovery UI and verified disposition remain pending.

Tests use normal AgentRuntime/registered tools and actual SQLite/EvidenceStore reopen with scripted provider/HTTP, not direct injected success. They prove local draft → trusted owner approval → exact-MIME send result → later provider turn; no-approval, stale edit/read, host revocation, unknown prior revision and lost-ACK holds. These are machinery checks, not an enabled ordinary account UI or an actual email/model run.

## Private saved-draft readback (partial)

The trusted task host can supply `reviewMail: (taskId,after) => mail.review(taskId,after)`
to `startAgentApplication` with `review:true`. The existing private loopback task
preview then shows the actual retained sender, To/Cc/Bcc, subject, body and attachment
metadata, including working/blocked tasks. It uses the preview's existing bearer
capability and fixed namespace—not a new auth store or a Google grant. This is not
the shared-account `/connections` UI or full authenticated owner-action integration.

`GET /api/task-mail?taskId=...&after=...` is read-only, authenticated and owner-scoped.
It projects only `Task.mail` in SQLite, then validates the saved draft/MIME/attachment
bytes. One potentially large body is returned per page; every logical draft remains
accessible via First/Next. An unavailable draft retains its revision/failure and does
not hide valid siblings. Historical send facts keep their actual revision: an unknown
revision1 send is never relabelled as a revision2 result. HTML is displayed as inert
text; technical hashes/provenance stay collapsed. Refresh/selection do not run the
model, approve/send, reconcile or modify the task. The route is absent unless the
trusted hook is configured. Existing payload-free task projections are unchanged.

The normal UI is currently **read-only**: no correction, approve, send, continuation
or unknown-outcome disposition controls are shipped here. The browser demonstration
uses invented Task/MIME data and scripted provider/HTTP; its revision change uses the
existing local edit tool, not an owner-correction button. No actual LLM, Gmail send,
private Mac journey or native/installed acceptance follows. To run that affected
Linux browser check after building, select an existing Chromium with
`SPINDLE_REVIEW_CHROMIUM`, a new ignored `SPINDLE_TASK_MAIL_REVIEW_OUTPUT` directory,
and execute `node build/tests/assistant/task-mail-review.e2e.js`.

## Outcomes and recovery

- `sent`: provider acknowledged `messageId` and `threadId`, exact MIME hash/size,
  intent ID and `verification: provider_acknowledged`. **Not recipient delivery**.
- `denied`: validation, missing approval/scope/journal, namespace, stale/cancel or
  other pre-dispatch failure. Fixed codes only; no provider raw bodies or credentials.
- `no_send`: an observed provider 4xx rejection. Intent remains reserved; no automatic retry.
- `uncertain`: lost response, 5xx, malformed success, post-dispatch cancellation,
  stale connection or journal failure. Retain the exact intent. Observed provider IDs
  are preserved if acknowledgement was parsed before settlement failed.

Repeated intent reservations never POST again, even after rejection or success.
The host must explicitly reconcile; creating a fresh approval is not an automatic
retry strategy. No API here implements Gmail idempotency or exactly-once delivery.

Host-only `reconcileOutgoingMail(drafts,intent,ctx,{oauth,connectionId,assertCurrent,http?})`
uses the original account/epoch, existing readonly grant and saved Message-ID to
search `in:sent rfc822msgid:...`, then checks exact Message-ID and SENT metadata for
up to ten candidates. It returns the original draft/hash binding, candidate IDs,
page completeness and `automaticRetryAllowed: false`. `not_observed` is **not proof
of non-delivery**. A matching Message-ID is not a content attestation: inspect provider
candidates before declaring an outcome. No reconcile hook sends, mutates, clears an
intent or authorizes replay.

## Provider facts and remaining consent

Official references researched for this implementation:

- [messages.send](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send):
  RFC message in base64url `raw`; recipient headers determine delivery; accepts send,
  compose, modify or full-mail scope.
- [drafts.create](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/create)
  and [drafts.send](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/send):
  require compose, modify or full-mail scope, **not gmail.send alone**. Neither API is
  implemented/called by the local-draft tool.
- [Message/thread resource](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages),
  [sending/MIME guide](https://developers.google.com/workspace/gmail/api/guides/sending),
  [OAuth scopes](https://developers.google.com/workspace/gmail/api/auth/scopes),
  [search guide](https://developers.google.com/workspace/gmail/api/guides/filtering).

A real send still requires explicit incremental Google send consent (and applicable
OAuth application configuration/verification), a trusted exact-revision send
instruction and complete runtime/journal/approval wiring. Gmail draft creation
would additionally need deliberate compose-capable consent and implementation.
Existing readonly consent, preparation authority and application submission approval
are not arbitrary-email send authority. No consent, credentials, test users, live
Google/model calls or outgoing emails were used here. This shared backend-only
change has no affected native capture/readback/UI path requiring visual evidence.
