# Invented browser acceptance harness

This is a development demo, **not an authenticated owner product UI**. It launches
only its own fictional loopback portal, then uses the production browser registry,
AgentRuntime, AgentStore and EvidenceStore. A real-mode NebiusAgentProvider chooses
all tools/arguments from actual observations. There is no real-mode scripted plan.
The only prepared mapping is the explicit reviewed invented task input, which the
model sees; observed DOM refs must drive its tool calls.

## Run with coordinator-supplied provider authority

Compile without clobbering another worker's build:

```sh
node_modules/.bin/tsc --outDir .local/browser-build
node .local/browser-build/tools/demo-browser-loop.js \
  --provider-module /absolute/trusted-browser-provider.mjs \
  --output .local/browser-demo-NEW-RUN \
  --chromium /absolute/path/to/chrome \
  --approve-fictional-submit
```

The trusted executable module exports `browserDemoProviderOptions()` returning
`Omit<AgentProviderOptions,'persist'>`: an explicit model/pricing declaration,
**existing authorised cumulative budget**, lazy credential callback, and normally
`timeoutMs:60000`. The harness supplies its actual AgentSessionStore persistence.
It does not discover credentials, create/reset a budget, or grant API spending.
Never select this module from model, email, page or other untrusted content.
Real API invocation requires the coordinator's separately applicable authority.
An injected `transport` is supported for offline machinery tests and is labelled
`injected-nebius-transport`, not live model proof.

The explicit CLI flag is checked **before importing the provider module**. It
supplies one exact trusted instruction outside model authority for this run's
reviewed fields, attachment hash, revision, destination and submission identity.
No third-party endpoint can be selected. Omit the flag and nothing runs. Output
must be a new directory: old evidence and uncertain submissions are never replayed
or overwritten automatically. Only invented data is generated or supported.

## Callable ingress integration

`runBrowserLoop(options)` exports the same runner. Supply
`provider:{kind:'nebius',options:...}`, `outputDir`, `executablePath` and
`approveFictionalSubmit:true`. An optional
`binding:{tasks,store,namespace,taskId}` reuses a **freshly admitted invented task**
and the email lane's actual stores, without closing caller-owned stores. It keeps
the task ID/source event, replaces requestedOutcome with explicit invented task
input, and requires no prior revision, decisions, observations or pending effects.
It is not a general continuation/recovery API or proof of Gmail delivery.
`variant:1` changes field names/order to exercise observed-ref adaptation.
Default bounds: 16 provider turns, 128 runtime units and 300 seconds per run;
existing provider budget and timeout remain independently authoritative. The harness
opts into the runtime's `blockOnTurnLimit` policy: exhausted runs persist Blocked,
not a misleading Working state. Existing stepping callers retain yielding behavior.

When browser tools are registered, the provider sees a bounded inert projection of
retained review/revision, write/submission and reconciliation state. This is not a
live grant: tool-host authorization still decides every effect. Browser-specific
instructions explain consuming observations and read-only reconciliation, without
choosing model actions; preparation's no-submit policy is unchanged.

`provider:{kind:'scripted-test',provider:...}` is only a machinery route, explicitly
labelled in evidence. The normal tests never contact a real model.

## Incoming-email alternate demo

Use the same provider module, Chromium and explicit fictional Submit instruction:

```sh
node .local/browser-build/tools/demo-email-browser-loop.js \
  --provider-module /absolute/trusted-browser-provider.mjs \
  --output .local/email-browser-NEW-RUN \
  --chromium /absolute/path/to/chrome \
  --approve-fictional-submit
```

`runEmailBrowserLoop` delivers invented already-read Gmail-format MIME through
numeric-loopback HTTP, production GoogleTriggerRuntime/GmailSync and real durable
admission. It binds the SAME admitted task/store to the browser runner, adding
production scoped `mail.read` source tools. The model—not a scripted tool chain—
chooses mail/browser calls. Acceptance additionally requires successful mail
readback, a later model decision observing it, and mail read before browser writes.
`email-result.json` records admission and the loopback-only endpoint trace.

**This substitutes local HTTP for Gmail.** It proves no live Gmail/OAuth/watch,
notification or authenticated owner-review journey. The application is already
reviewed: it does not demonstrate general email triage, application creation from
arbitrary mail, or unrelated-mail classification. That broader #51 acceptance
remains pending. No outgoing mail is exposed. The standalone
`demo-email-ingress.js --data-directory /absolute/directory` and its tests prove
connector duplicate/restart persistence; the default creates generic inspection
tasks, not a hard-coded-subject eligibility rule. Its injected relevance-callback
test is not model classification.

Callable assemblies may supply `additionalTools`, `context` and an
`observeProvider` wrapper to the browser runner. These are trusted development
configuration, never model/page/email-selectable capabilities or authority.

## Local evidence and acceptance limits

- `owner-instruction.json`: exact instruction/review bound once by the trusted host.
- `tasks.sqlite`, `evidence/`: actual durable task/evidence/model envelopes when
  standalone; caller-owned locations when a binding is supplied.
- `portal/`: independent server records and exact uploaded bytes.
- `visible-session.json`: allowlisted visible input, decisions, tool results,
  returned model usage and response-persistence facts, plus source SHA/dirty state
  and executing harness digest. No raw provider requests, hidden reasoning,
  credential configuration or browser profiles are exported. Browser ref arguments
  are retained for single and batch decisions/model envelopes, alongside observed
  snapshot/field/action refs. Other detailed inspect metadata remains allowlisted. Local databases are not claimed encrypted or publishable.
- Numbered screenshots and `video/`: **actual tool browser**, not replay/animation.
  The trusted harness wraps Browser.newContext solely to add recordVideo while
  preserving all production context safeguards. `recordVideo:false` disables it;
  missing recording prerequisites fail the run, not silently fabricate evidence.
- `result.json`: mechanical acceptance requires Ready, retained verified receipt,
  a subsequent successful provider decision with that verification in its input,
  exactly one independently read server record, matching field values and exact
  stored file bytes. Production `browser.verify_submission` navigates and revisits
  the receipt. Media gaps are separate. No automatic submit retries occur.

`accepted:true` is **mechanical harness success**, not independent/human acceptance
or proof of real inference by itself. Read `proof` (`scripted-provider`,
`injected-nebius-transport`, `nebius-default-transport`) and review persisted model
calls. Actual model/human acceptance and independent technical/media review remain
coordinator-owned. Inspect complete media before any authorised publication. All
media, databases and credentials stay out of Git; no uploader is included. Normal
shutdown closes only this run's host/browser/server, retains evidence, and leaves
incomplete effects for reconciliation rather than rerunning them.

Focused checks:

```sh
node_modules/.bin/tsc --outDir .local/browser-build
node --test .local/browser-build/tests/demo/browser-loop.test.js
```
