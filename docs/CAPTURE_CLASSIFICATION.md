# Capture → local labels → optional Nebius text/image suggestions

This preview joins the actual shared capture owner to the label/model libraries. It is **not native capture acceptance, a production history journal or an on-device neural model**. Live-provider tests, their input/accuracy limits and current build-specific results/downloads belong in the implementation PR; a mock-only journey never establishes live inference.

## User flow

1. Capture explicitly authorized content in Basic or Rich. Classification does not decide which source may be captured, and edited content is not inherently disqualified.
2. Click **Enable local labels**. The inspector shows Category/Activity, basis and uncertainty. Local rules/corrections and a small deterministic Coding cue work offline; weak evidence stays Uncategorized. This is not general semantic local inference.
3. **Correct labels** opens a stable dialog for that exact evidence revision. A changed/deleted revision rejects the edit; a correction does not create a future rule. User corrections/rules win over model suggestions without a provider call.
4. If an operator has configured a provider, explicitly allow remote app/domain/title/text and optionally the **matching Rich screenshot**, then apply consent. These grants last for the app run, not across restart. No per-image prompt, automatic dispatch, implicit enrollment or paid request follows from enabling capture.
5. **Classify text with Nebius** sends only permitted text fields. **Classify Rich image + text** sends one matching PNG plus the permitted text to the declared vision model. The UI image grant also selects text. The backend supports an explicit image-only grant; missing OCR does not require fabricated text. Missing image/capability/consent fails visibly, never silently falls back to text-only.
6. Revoke stops future remote work and aborts pending requests best-effort. Already disclosed data cannot be undisclosed. Clear removes capture and downstream evidence/corrections/suggestions; expiry and browser revocation scrub downstream copies even when processing is off. Quit disposes the consumer and pending work.

## Binding and limits

`CaptureClassification` subscribes to `PreviewSession` mutations; it does not run another collector or clock. Only admitted, available sampled context enters `LocalLabels`. Browser receipt-timed intervals remain partial in the capture owner: the classification seam's `observed` describes the sampled content, **not** full interval coverage or attention. No duration or confidence becomes allocated time.

Source visit IDs remain stable; a fresh downstream context incarnation after revoke/expiry cannot revive a deleted label identity. The capture owner advances image-revision/availability metadata on image replacement, removal, eviction and expiry. Local projection reads only that image metadata, not pixels; image changes invalidate image-visible assignments and exact corrections even when OCR/text stay identical. Evidence changes advance revisions. Replacing/correcting/deleting one entry invalidates only that entry's suggestions/tickets; genuinely global processing/catalogue/rule changes retain global fences, so unrelated capture updates do not erase a stable selected visit's paid result. Async requests bind owner generation, exact context incarnation/content and (for Rich) image digest, plus processing/egress/correction/catalogue state. Pause/Clear/revoke/exclusion/expiry and changed images cannot apply old results to new context. One remote classification is outstanding at a time. The existing 300-source-identity/tombstone label bound fails visibly rather than silently resetting history or budgets.

Capture and OCR outcomes are independent: a valid retained native screenshot remains classifiable when OCR is empty, failed or unavailable, and valid text remains usable when PNG retention fails. Failed target acquisition is not admitted through this metadata path. PNG egress keeps the 2,000,000-byte bound, with at most 8192 pixels per dimension and 33,554,432 pixels overall (matching the native 128 MiB four-byte pixel budget). Model-specific tokenization/context limits still require an explicit verified declaration; accepting these headers does not establish every model's image-size support.

Local text projection never copies the screenshot. Only an explicit image operation accesses the matching captured image for egress. The model receives no source IDs, raw URLs, personal catalogue/rules, keys or clock/accounting authority. Image and page text are untrusted data; output is restricted to validated label suggestions, never tools/locks/payments. Native/source filtering and remote egress remain independent.

Label state and corrections are currently in memory. Encrypted durable label configuration/restart/migration and a meaningful-day review remain separate work. The preview's encrypted capture snapshot is not a durable classification database, and old saved snapshots are not automatically re-admitted or remotely processed.

## Explicit trusted operator setup

Without configuration, capture/local labels work and remote controls report **model not configured**. No key search or provider discovery is performed by the application.

Before launching, the operator may set `SPINDLE_NEBIUS_CONFIG` to a private JSON file with exactly `model` and `budgetPath`. `model` is a [ModelDeclaration](../core/models/provider.ts) with actual account-supported ID, text/JSON capabilities, context/output bounds and verified pricing provenance. Set optional `jsonSchema: true` only for a model whose strict JSON Schema support has been tested. Classification then requests the allowed category/activity enums and abstention shape at decoding time; the same local validation still applies. Without that declaration, JSON-object mode remains unchanged. Unsupported schema requests fail visibly; there is no silent downgrade. For vision it additionally needs `images: {inputTokensUpperBound, accounting: "input-tokens"}`. Verify the maximum image tokenization and token-only pricing; unknown/per-image/extra units must not be guessed. Public model lists alone do not prove account availability or structured-output behavior.

`budgetPath` must select the **existing cumulative task journal**, not a fresh per-launch counter. Its limit is at most USD3 for this task, includes retries/delegates and uncertain reservations, and cannot be reset by restart. The VM task uses `/home/ubuntu/.local/state/spindle-overnight-20261023/nebius-budget.json`; don't copy this journal to another host and spend both copies. Missing/corrupt/locked journals fail closed. File fsync is required; the existing journal inode is updated under an exclusive lock, without relying on unsupported Windows directory-fsync/rename durability. A torn write or stale lock blocks further calls until explicit operator reconciliation. Windows/native filesystem behavior is unvalidated, not implied by Linux tests.

Set `NEBIUS_API_KEY` privately in the launching process environment; it is read lazily only after operation/field/current-source/budget admission. Do not paste it into GitHub/UI/logs or put it in the model declaration. A missing key never becomes a guessed credential. No NVIDIA paid request is authorized by the current task. No provider account, credits, deployment or infrastructure is created.

## Reproduce component checks

```sh
make check
SPINDLE_CHROMIUM_EXECUTABLE=/path/to/chromium node build/tests/capture-check/classification.e2e.js
```

The Chromium journey uses the production renderer/session/classifier/provider, invented native events and a real local HTTP **model mock**. It demonstrates local correction, Rich PNG+text versus Basic text-only, consent and Clear. Its readable input PNG is a synthetic Chromium image, not a native collector screenshot. Optional `SPINDLE_CLASSIFICATION_RECORD=1` records this explicitly labelled component journey; `SPINDLE_CLASSIFICATION_OUTPUT` selects an ignored task directory. Never present this as authenticated Nebius inference or Windows/Mac capture proof.

Target-host integration still needs the affected real capture → classification UI journey, including actual matching Rich images, lifecycle changes and setup/storage behavior. Live Nebius text/vision calls need an authorized key, verified model/accounting and cumulative reservations before dispatch. Keep implementation, mock/HTTP proof, live inference and native/installed acceptance separate.
