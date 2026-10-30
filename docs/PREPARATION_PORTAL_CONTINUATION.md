# Approved portal continuation (facade)

`continuePreparationPortal(options, approval)` in `core/preparation/portal-continuation.ts` takes an owner's approval of an **existing** prepared task and continues **that same task** to a verified receipt in the browser. It joins existing parts and adds none of its own: [`preparationBrowserReview`](../core/preparation/browser-review.ts) builds the review, [`createTaskBrowserTools`](BROWSER_FORM_TOOLS.md#task-bound-normal-runtime-integration) supplies the confined browser and approval state, the normal `AgentRuntime` runs the steps, and `AgentStore` holds the task and its history. There is no new task, store, planner, queue, prompt, bulk tool or budget. `reconcilePreparationPortal(options)` is the read-only path for checking a receipt when the submission outcome is unknown.

The coordinator owns the account endpoint, service/startup wiring, provider/model adapter, trusted browser-phase instructions, authentication and source checks, and cancel routing. This module neither edits nor replaces any of them.

## Authority and inputs

- **Trusted target** (`options.target`): host configuration only. It holds the portal destination, submission URL and receipt URL; the mapping from prepared fields and files to form controls; and `required.controls` / `required.files`, the controls and file fields the destination actually requires. Every required control must be mapped, or be a host constant, and must have a non-empty reviewed value. Every required file field must be mapped. Prepared fields the destination doesn't need, and raw source or session artifacts, are not required.
- **Owner request** (`approval`): `{expectedRevision, fingerprint, requestId}`. These come from the displayed `/preparation/browser-review` result. They choose which review to approve but grant no destination, control or file.
- **Authority**: `options.browser.authority` (`id`, `signal`, `isCurrent`) is the synchronous dispatch fence that the browser host already uses. `options.preflight(signal)` is the coordinator's async session/source check. It runs first, and the fence is checked again synchronously after it. Passing the async check never replaces the fence.
- **Caller** (`options.caller`): the trusted transport that carried the owner request, recorded on the owner action. The coordinator supplies it; the module does not assume it.
- **Limit** (`options.timeoutMs`, AgentRuntime's 30 s default when absent, at most 2^30 ms): the configured run limit. The module keeps it as the effective limit, see [Holds and recovery](#holds-and-recovery).

## Sequence

1. Refuse before any effect if any of these hold: the target is invalid or misses a required control/file; the approval, caller or limit is malformed; the `requestId` was already used on this task; the task is not `ready` (or this module's own clean interruption, below), has a pending call, or is not `clean`; the task or model decision budget is already used up (this is only a pre-check, and no cap is raised); the review fingerprint, revision or bytes differ; the authority is not current.
2. Run `preflight`. Then check authority, readiness and `assertCurrent()` again, and create the task browser host.
3. In one synchronous tail, with no `await`: authority/readiness → `assertCurrent()` → `host.approve(review, requestId)` → store the approval manifest (EvidenceStore JSON derived from the host's review artifact) and a `resume`/`portal_approved` preparation action whose `intentHash` is the manifest SHA-256 → `AgentStore.recover(taskId)`. Recovery increments generation and attempt. Budget, observations, decisions, `task.preparation` and history are kept. If storing the manifest, recording the action or recovering fails (for example `PREPARATION_ACTION_HISTORY_FULL` at the 4096-action namespace cap), the module revokes the approval it just granted and rethrows. An approval therefore never outlives a failed owner-action audit. If the revoke also fails, the module throws `PORTAL_CONTINUATION_APPROVAL_REVOKE_FAILED`. No audit action is invented.
4. Run `AgentRuntime` with the injected provider, the host tools, the host's `approveExternalWrite`, and a Ready gate made of the host's gate, a check that the provider has seen this intent's verified receipt observation, and the coordinator's own `assertReady`. The runtime already runs WRITE batches one call at a time, so the reviewed controls can be filled or uploaded in batches of up to 4 within the inherited budgets.
5. The run ends at Ready only after the host has saved a receipt verified on two visits **and** the provider has seen that result. Afterwards the module waits for in-flight provider calls to finish and closes the host.

## Holds and recovery

- **At most one submission per task.** Replaying the same `requestId` after a verified receipt returns the stored receipt and runs nothing. The replay must name the approved review: its `fingerprint` and `expectedRevision` must match the retained approval manifest, found through the action's `intentHash`. The receipt's approval, review artifact and revision must descend from that manifest. Otherwise the call fails with `REQUEST_ID_CONFLICT`, or `REPLAY_UNVERIFIABLE` if the manifest can't be found. Any other approval of a task that already has a submission fails with `SUBMISSION_EXISTS`. Replaying while the outcome is unknown fails with `RECONCILIATION_REQUIRED`. A `requestId` that is already used but has no submission fails with `REQUEST_ALREADY_USED`, because each id is one owner decision.
- **Lost response / unknown outcome:** the task is held and the POST is never retried. `reconcilePreparationPortal` re-checks the same authority and preflight, recovers the `blocked`/`clean` task, and registers **only** `browser.verify_submission`, so fill, upload and submit cannot be admitted.
- **Owner cancel** (`options.cancel`) calls `AgentRuntime.cancel`, and the task becomes `cancelled` (`Cancelled by user`). **Disconnect or revocation** (`authority.signal`) supersedes the run without counting as an owner cancel. The browser host's transport cutoff applies, and the task is held `blocked` with `PORTAL_CONTINUATION_INTERRUPTED` (outcome `interruption: 'authority'`). A pending non-read call becomes `reconciliation_required`.
- **Read in flight at a supersede:** a disconnect or the configured limit may land while this run's own `browser.inspect` or `browser.verify_submission` (for example a slow receipt page) is still reading. The hold retires that read pending, as `AgentStore.recover` does. The read has no write uncertainty: its tool context is already aborted, so the host refuses any late commit, and `host.close()` waits for it before the module returns. A read during the post-POST receipt check stays reconcilable, and a read before any write leaves the clean interruption below. Only a read that this run claimed is retired. A pending write, a foreign claim and the budgets are untouched.
- **Configured limit:** reaching `timeoutMs` supersedes the run the same way as a disconnect. The task is held `blocked` with `PORTAL_CONTINUATION_DEADLINE_EXCEEDED` (outcome `interruption: 'deadline'`); it is never recorded as an owner cancel. If the POST already went out, the task stays reconcilable: `reconcilePreparationPortal` verifies the receipt with one POST in total. The runtime's own timer would record `Cancelled by user`, so the module sets it to twice the configured limit as a backstop only. The effective limit is unchanged, and no model, tool or global budget is reset or lifted. A limit reached while a write call is in flight leaves that call pending, so the task becomes `reconciliation_required` and is not reconciled here.
- **Clean interruption before submit:** a fresh explicit approval may continue the same task only from this module's own interruption. That means status `blocked`, blocker `PORTAL_CONTINUATION_INTERRUPTED` or `_DEADLINE_EXCEEDED`, task and browser recovery `clean`, nothing pending, no submission and no external action, plus a prior approval on the task. It also needs a new `requestId`, the freshly displayed fingerprint (the generation is part of it), current authority, and remaining task and model budget. The host's `approve` supersedes and revokes the earlier approval. Any other blocked state, including `Agent turn bound reached`, still fails with `TASK_NOT_READY`.
- **Run identity:** the post-run hold applies only while the task still carries this run's claim, i.e. the generation and run id the provider saw, or the runtime's single claim if the provider never ran. A task claimed by another runner is left alone.
- A batch write with an unknown outcome (`recovery: reconciliation_required`), a cancelled task with an unknown submission, `Agent turn bound reached`, or the runtime's own tool-failure blocker (which keeps its pending call), is not reconciled here. Generic interrupted-run recovery stays with the coordinator.

## Coordinator integration needs (historical; the account endpoint and operator-gated fictional-portal wiring now exist, see PREPARATION_BROWSER_APPROVAL.md, which tracks what is still open)

- An account endpoint (for example `/preparation/approve`) that maps the signed-in session to `approval` and routes cancel to `options.cancel`. It must also publish the trusted `target` (selection plus required controls) from config, so the page never supplies it.
- `authority.isCurrent(task)` must stay true across this module's own `recover()` generation bump. Bind it to owner, session and revision, not to an exact generation.
- The provider adapter must settle `next()` once `ctx.signal` aborts. The module waits for in-flight provider calls to drain on purpose, rather than orphan their spend or invent a grace timer. An adapter that ignores the abort keeps the continuation pending after owner cancel, even though the browser has already been released. The adapter's abort settlement must be shown before endpoint wiring.
- The provider adapter must enforce per-task and global model budgets and spend-unknown holds. It must also supply browser-phase instructions that keep `task.preparation` without deleting it to get past DoNotSubmit.
- `getScope` must allow the prepared sources so that `browser.upload` lineage resolves.
- A site-specific `readReceipt` parser and a real browser/session lifecycle.

## Checks and proof limits

`tests/agent/preparation-portal-continuation.test.ts` runs eleven sequential tests on one existing Chromium (`SPINDLE_WEB_CHROMIUM`, default the cached chromium-1228). The portal is the invented loopback `examples/application-portal`, and the provider is scripted. The tests are:

1. Pre-effect refusals.
2. Approval → recover → batched fills/upload → one POST → observed verified receipt, with counters kept, an idempotent replay and a replay identity conflict.
3. Lost response → held → read-only reconcile, including an injected crash before the observation.
4. Owner cancel, disconnect before submit, and a foreign run claim. None makes a POST, and the browser is closed.
5. The configured limit after the POST → reconcilable hold → read-only reconcile with one POST in total.
6. A clean interruption → a fresh explicit approval continues the same task to one POST.
7. The configured limit while `browser.verify_submission` reads a slow receipt after the POST → no stranded read → read-only reconcile verifies with one POST in total.
8. A disconnect while `browser.verify_submission` reads after the POST → reconcile under a fresh authority verifies with one POST.
9. A disconnect while `browser.inspect` reads before any write → a fresh explicit current approval continues the same task to one POST.
10. Guard: the same disconnect while the submit write is in flight keeps it pending and `reconciliation_required`. A fresh approval and reconcile both refuse it.
11. Namespace action history saturated after `host.approve` → approval revoked, with no write and no POST even after a generic `recover`.

Run the suite serially with a short `TMPDIR` (Chromium's socket path limit; a project-local `.local` directory is already too long):

```sh
NODE_OPTIONS=--max-old-space-size=512 npm run build
TMPDIR=/short/run-owned/dir node --max-old-space-size=256 --test --test-concurrency=1 build/tests/agent/preparation-portal-continuation.test.js
```

This is **fixture/code proof only**. It is not product, actual-model, live-site, Google, Mac/native or installed acceptance. Native capture visuals do not apply because this module changes no capture or readback path.
