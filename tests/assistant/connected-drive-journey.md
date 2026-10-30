# Connected journey driver (local draft)

`runLocalDraftJourney` in [`connected-drive-journey-support.ts`](connected-drive-journey-support.ts)
is the reusable **trusted-host caller function**. It uses the existing authenticated
`AccountClient`, not a test-only product API. It calls configuration → ordinary
`prepareApplication` → persisted status/artifact readback → user correction →
status/readback again. The actual model chooses registered tools and subsequent
turns; the driver never selects/invokes tools, injects extraction answers, starts a
runtime, or touches a budget journal.

**Actual source/model journey is UNRUN.** Scripted HTTP proofs below test driver
machinery, not real OCR, editing, model adaptation, browser/native UI or acceptance.
New-parent Nebius egress approval remains pending. This source task makes no
provider/Google/private-byte/key/journal calls and grants no execution authority.

## Authorized caller contract

From an already authorized Node application/test host, import the compiled module:

```ts
import {runLocalDraftJourney} from './build/tests/assistant/connected-drive-journey-support.js';

// existingAccountClient is the host's ALREADY authenticated normal AccountClient.
// options is JourneyOptions, assembled explicitly by that authorized host.
const result = await runLocalDraftJourney(existingAccountClient, options);
```

There is deliberately no CLI credential discovery, cookie export, session-fetch
workaround, auto-signin/OAuth, generic request adapter, or fake `--live` fallback.
The normal UI remains `/connections`, `#preparation-request`, `#run-preparation`;
this caller tests its normal client protocol, **not browser interactions**. Do not
claim a browser/native recording from a function/HTTP-fixture run.

`JourneyOptions` requires:

- `ownerId`: matches the client's current account before every operation.
- `request`: the owner's ordinary request, selected `connectionId`/`rootId`, stable
  `requestId`, explicit `processingConsent:true`, **`saveOutputs:false`**. Text is
  submitted unchanged as JSON, including literal Bang/exclamation, quotes,
  backticks, `$()` and newlines. No tool sequence belongs in the request.
- `binding`: the **running service's** exact source revision (optional tree), build
  identity/digest, actual normal configuration model metadata (endpoint, global
  limit, whole-task reservation bound, decision/vision caps), full-declaration
  decision/vision config digests, and per-task limits. Obtain these from the
  authorized bootstrap/build attestation and actual configuration, not this
  harness's checkout or fixture constants. Configuration source/build/model/limit
  metadata must match; `configured`/lazy credentials are not live readiness.
- `maxPolls`/`pollIntervalMs`: finite operational polling, **not a whole-owner-job
  deadline**. Exhaustion returns BLOCKED with the latest checkpoint; it neither
  cancels nor resumes the product task.
- `checkpoint`: an awaited host callback to retain private, local checkpoints and
  actual artifact bytes. They include request/requestId, observed configuration,
  receipt, every observed status/session and verified readbacks. Never upload
  automatically. Retain the returned result too, including its original `error`
  object; ordinary JSON serialization does not preserve Error details.
- `verifyRevision`: the host's private oracle checks **actual returned bytes** for
  each revision: required PDF fields/overlay and rendered appearance, photo decode/
  dimensions/format/quality, source facts/citations/OCR page/region lineage and
  unresolved facts. Return explicit `Check[]`; empty/FAIL/BLOCKED/UNRUN checks cannot
  produce driver PASS. `assertPdf` reopens actual bytes for field values;
  `assertPhoto` independently decodes readback bytes with credential-free local
  Pillow and checks dimensions/format/byte limit and optional known RGB samples.
  Neither proves rendered PDF/photo visual quality. Never guess private expected
  values or call task tools from this callback.
- `correction`: after inspection, obtain the real user's changed `{fieldId,value}`.
  Only the normal `correctPreparation` action applies it, with `expectedRevision`.
  Returning undefined leaves the correction proof BLOCKED. Fixture corrections
  below are explicitly scripted, not actual human/model acceptance.
- Optional `signal`: an **explicit user cancellation**. It calls normal cancel
  once when a task is known and stops follow-on work. An uncertain cancellation
  acknowledgement remains a failure, never a retry instruction.

The driver requires clean Ready, resolved fields/checklist, persisted model/vision
call identities/config/usage within the existing task budget, readable source
snapshots, an immutable current-revision session export and hash/MIME/length-checked
artifacts. Correction requires a new persisted model turn and new prepared bytes
(not merely a new session JSON), then re-reads **all** earlier artifacts unchanged.
The exported session has a documented pre-export cutoff; it is not the later final
receipt. No hidden reasoning/raw provider logs are requested.

Blocked/reconciliation-required/cancelled status is retained rather than forced to
Ready. No automatic admission/correction/resume retries occur after lost replies,
stale revisions or operational bounds. Reconcile the retained task/requestId using
the normal client before deciding an explicit next action; do not restart this
function blindly. A checkpoint callback failure also halts dependent operations.

`driverStatus:PASS` means only the protocol and supplied oracle checks passed.
`acceptanceStatus` deliberately remains `UNRUN`: the coordinator separately binds
actual source/model evidence and independent inspection to the full journey.

## Local versus optional Drive save

This entrypoint enforces **local draft**: artifacts/session exports stay local,
readable and correctable; any Drive output intent is a failure. It requests no
Drive-write consent, OAuth, folder Picker or permission expansion for the current
Mac. Existing read-source authorization and separately approved model processing
remain necessary; “local outputs” does **not** mean no model egress.

Production's general `saveOutputs:true` capability is separate. It requires real
owner authority, minimum provider grant and the supported provider folder Picker/
parent authorization. This driver does not activate it. `assertDriveReadback` is
only a reusable byte/parent/version/MIME oracle for a separately authorized save
journey, never proof that one occurred. Full-write oracles remain UNRUN, not failed
local-draft requirements and not silently waived product outcomes.

## Offline deterministic proofs

Node 22+, existing locked Node dependencies, and an existing trusted Python/Pillow
interpreter (`SPINDLE_IMAGE_PYTHON`, default `python3`/`python.exe`). No automatic
installation, dependency scripts or backend fallback:

```sh
node --max-old-space-size=512 node_modules/typescript/bin/tsc --noEmit
npm run build
# New output directory; parent must exist. Nothing is overwritten.
node build/tests/assistant/connected-drive-journey.e2e.js --fixture --output /absolute/scratch/fixture-1
node build/tests/assistant/connected-drive-journey.e2e.js --live --output /absolute/scratch/live-preflight-1
```

`--fixture` uses the **same exported driver and real AccountClient** with strictly
scripted fetch responses. Only a fixture `/session` restoration supplies invented
authentication. It proves JSON transport/202 → working → local Ready, actual
invented PDF/photo bytes (including independent pixel decode) and corrected
revision/retained bytes, changed-input oracles,
tenant denial/owner change, corruption/MIME/length failures, false Ready and
source/build/model/budget/session mismatches, blocked/uncertain state, polling
bounds, lost acknowledgements, stale corrections, explicit cancellation and
checkpoint/oracle failures. Scripted model metadata is not real model evidence.
Production account/isolation/runtime regressions remain separate checks.

`--live` (and retained `--readiness` alias) exits 1 with an explicit supported-caller
instruction and **zero service/provider calls**. It cannot authenticate itself and
will never substitute fixtures for a live run. Use the trusted-host function once
all execution preconditions are authorized, not a misleading CLI switch.

Runs retain `run.json`, local harness `build-manifest.json` and, for fixtures,
`scripted-driver-proof.json`. These identify harness source/tree/dirt/build bytes
separately from the absent live service binding; every full-journey oracle is
UNRUN. No native visuals are manufactured for this test-only change. Coordinator
owns final integrated-candidate review, actual authorized execution, private visual
inspection/evidence and any source publication/activation boundary.
