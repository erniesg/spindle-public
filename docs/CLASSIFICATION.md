# Local labels and personal vocabulary

The implemented TypeScript library in `core/classification/` labels **already-permitted evidence**, with an invented-fixture command-line demo. The preview now connects it to admitted capture content through `core/preview/classification.ts`, with local labels/corrections in the inspector. It is not a daily-review UI, disk history or an on-device neural model. It never reads a window/browser, calls a provider or calculates duration.

```sh
npm ci --ignore-scripts
npm run build
node build/tools/label-demo.js learning
# Or choose leisure: the same film can have different personal meanings.
make check
```

The JSON output shows cold-start abstention, a user-selected correction, rejected late suggestion, undo and source deletion. The separate code example is a deterministic lexical cue, **not model inference or evidence of attention**. It can suggest Coding but does not invent a category, project or study target. Models/network can remain absent.

## One vocabulary, not a universal catalogue

- **Activity:** behavior; shared seeds Reading, Watching, Listening, Coding, Writing, Meeting.
- **Category:** personal reporting group; stable seed IDs `work`, `learning`, `communication`, `admin`, `personal`, `leisure`, `uncategorized`.
- **Related things:** typed topics, projects, courses and entities.
- **Target:** optional user-desired allocation. Only its type is defined here; no target accounting or enforcement is implemented.

No Intent/Purpose/Focus entity. Unknown coverage is an evidence state, not a category. Leisure may be renamed Entertainment without changing its ID. A personal concept has a user scope, stable random ID, definition, aliases, revision and retirement. Optional category/activity maps pin `spindle-vocabulary/v1`; private topics are not promoted to a global catalogue.

This recovers distinctions from the pinned legacy [research](https://github.com/erniesg/spindle-legacy/blob/35b59534b6e6a9c7f33aa4796bf43afabfdd2e54/docs/design/2026-10-20-attention-taxonomy-research.md) and [concept proposal](https://github.com/erniesg/spindle-legacy/blob/35b59534b6e6a9c7f33aa4796bf43afabfdd2e54/docs/design/2026-10-20-activity-taxonomy-and-entities.md), not code, personal data, automation or claims of shipped legacy behavior. [PRODUCT.md](PRODUCT.md) remains authoritative.

## Correct, inspect and undo

`LocalLabels` starts with local text processing off. Explicitly enable it, then admit an already-filtered `PermittedEvidence`. This downstream seam preserves source/recording/visit/evidence identity and evidence/consent/policy/deletion revisions; it contains no interval or clock conversion. It is not a wire authentication or browser-privacy proof. Producers must enforce capture consent, source scope/exclusions and private-source rules **before** constructing this input; attaching a browser/native tag does not authorize collection. The downstream labeler does not impose a read-only-only capture policy. Explicitly authorized native window pixels/OCR may include edited content; structured field extraction and browser-private restrictions remain distinct.

Resolution order:

1. Exact user correction for this evidence revision.
2. Explicit user-saved rule. More specified predicates win; equally specific conflicting labels visibly abstain. A longer text substring is not implicitly higher priority. A matching narrow rule with a retired concept remains a visible `retired-rule-concept` abstention blocker: edit/remove that rule before a broader choice can apply. Retirement must not silently change a user's specific choice into a broader one.
3. Admitted suggestion, otherwise the small local code cue.
4. Visible Uncategorized/abstention.

A correction never creates a future domain rule. `undo` removes the latest exact correction. Replacing evidence requires the same source kind and evidence ID, strictly increasing evidence revision and nondecreasing policy revisions; it invalidates exact-evidence corrections, undo history and derived suggestions. Use an explicit rule when a choice should apply to future matching evidence. Rules and corrections can label unknown coverage but cannot turn it into observed time; automatic suggestions require observed coverage.

Rename/define/map/retire changes the catalogue revision. Retirement prevents new assignments/rule application, while existing exact corrections preserve their concept IDs. Inspection is a **current projection**, not an immutable as-recorded report. It includes concept and decision revisions, source, basis and uncalibrated confidence (`null`). Membership and confidence never change measured time; overlapping related concepts carry no extra minutes.

## Lifecycles and bounds

Suggestion tickets are in-process, one-shot and bound to exact owner/source evidence plus catalogue, rules, correction and processing lifecycle. Pause/revoke, changes, replacement and deletion invalidate them. No external model gets an authority token or creates vocabulary automatically. Field values on denied/missing states are not copied into the consumer.

Deletion works while processing is off, removes source/corrections/undo/suggestions, and prevents re-admission of that recording/visit identity. Unsaved correction-only concepts disappear when their last linked source is removed or replaced; undo also removes now-unused borrowed references. The original proposal remains linked to its originating evidence until that source is deleted/replaced. `saveConcept` is an explicit choice to retain minimal user configuration, not the originating text/title. Saved rules may reference only saved concepts. `exportConfiguration` constructs saved definitions/rules only; it excludes raw evidence, exact corrections and temporary vocabulary. An explicitly user-authored saved rule predicate such as `titleContains` may itself contain private, title-derived text; it is saved configuration, not a content-free diagnostic/export. Real configuration persistence/export still needs an explicit user choice and appropriate encrypted storage.

The engine is bounded to 300 source identities including deletion tombstones, 256 concepts, 64 rules, 16 related labels, 20 undo entries per evidence and 8 pending suggestions. It fails with fixed codes at capacity. A new recording ID distinguishes a new capture lifecycle; deleted IDs cannot be reused inside this engine. There is no persistent journal, background processing, telemetry or auto-export.

## Immediate tracker delivery

For the [accepted account-linked tracker](PRODUCT.md#accepted-account-linked-tracking-milestone), #23 owns durable encrypted vocabulary/rules/corrections and the existing capture consumer; #24 owns optional model setup/capability/quality proof. #67 adds labelled extended-session review with automatic processing under an explicit scope and a small persistent change-label action. #66 carries account-associated history and label/correction revisions between devices. Reuse this engine rather than add a classifier/clock/taxonomy platform. Custom-label management is optional if inexpensive; a future-rule editor, graphs and full split/merge system do not block the minimal review. These are delivery requirements, not current capabilities.

## Still separate

[Capture classification](CAPTURE_CLASSIFICATION.md) now consumes real preview-owner mutations, scrubs derived copies on Clear/revoke/expiry, preserves corrections over model suggestions and offers separately consented text/image requests. Its Chromium component proof uses invented native events and a local HTTP model mock; it is not native or live-provider acceptance. Durable encrypted label-configuration storage/reload/migration, episode corrections and a user-facing day review remain unimplemented. There is no neural/semantic model evaluation, population training, graph database, target-time projection, lock, credit or payment execution. This backend-only slice needs deterministic readback and lifecycle tests, not fabricated native media; its eventual capture/UI integration still needs the affected real journey and evidence.
