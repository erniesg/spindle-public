# Draft observation and visit conformance

**Unstable proposal for the first slice of [#2](https://github.com/erniesg/spindle/issues/2), not a frozen production protocol.** This makes timing, association and rejection decisions inspectable without changing the native Capture Check. It does not select the product runtime or authorize any capture, retention or transport.

## Review one outcome

The [canonical invented examples](../../tests/fixtures/draft-capture-conformance.json) include `rapid-return-late-result`: A for 2 seconds, B for 3, return A for 1, then B for 4. A job admitted during the first A completes during the return A. It enriches **only the first A**, never extends time and never appears under the return visit.

Other sequences exercise same-window content/generation changes, pause/revoke/exclude/delete, a gap arriving after Pause, clock rollback, producer restart, replay/conflict/reordering, half-open cutoffs, job bounds and distinct field states. The runner prints exact synthetic results, not a native acceptance receipt. No screenshot/recording is applicable to this schema-only change; native/browser integrations still require their real-path evidence.

## Development checks

Use Python 3.11+ and a task-local environment; the existing `make check` does not need this optional Python environment; use its documented Python/Node/TypeScript prerequisites.

```sh
python3 -m venv .local/contract-check
.local/contract-check/bin/python -m pip install -r tools/contract-check-requirements.txt
make contract-check PYTHON=.local/contract-check/bin/python
.local/contract-check/bin/python tools/draft_capture_contract.py --case rapid-return-late-result --json
```

Without Make, run that Python's `-m unittest discover -s tests/contracts -v`, then `tools/draft_capture_contract.py`. Remove `.local/contract-check` after use; do not install these tools globally. On Windows use the environment's `Scripts/python.exe` and the same Python commands. Dependencies are development-only, pinned, MIT-licensed JSON Schema tooling; they are not packaged with the app. Their upstream notices stay with the installed distributions.

The two [JSON Schema 2020-12 documents](observation.schema.json) and [visit projection schema](visit.schema.json) use only local schema resources. The checker does not retrieve schemas from the network. Unknown versions return `UNSUPPORTED_SCHEMA`; invalid shape, irrelevant kind-specific properties and payloads on non-value states return `SCHEMA_INVALID`.

## Proposed semantics in this draft

| Boundary | Rule exercised here |
| --- | --- |
| Recording/provenance | Every event names recording, producer incarnation, clock domain, event ID, sequence and revisions. IDs are opaque, bounded and unique within this trace; they are not OS handles, paths, credentials or authentication. A source also names process/window incarnation and nullable profile/document identity. |
| Event time | `atMs` is a nonnegative safe-integer millisecond value in one named producer clock domain. It means source observation/admission time for `focus`/`content`/`admit`, and completion time for `result`. `wallTimeMs` is a separate UTC label; it never computes elapsed time. Arrival order is the fixture array; source ordering is checked separately. |
| Clock changes | One authoritative producer/domain is active at a time. `producerReset` requires fresh producer and clock IDs, closes the old visit at the last **source observation**, cancels work and marks an unknown restart gap. Result completion is not a source observation. No subtraction, continuity inference or clock mapping across domains is implemented. A reset never unpauses recording. |
| Visits | `focus` opens a fresh visit; a return requires a new visit ID. Intervals are half-open `[startMs, endMs)`. Closing/truncating an interval also removes previously committed samples at/after its endpoint. Document/navigation boundaries need new visit IDs; browser signals proving them are not implemented. |
| Same-window change | `content` updates content revision and/or stream/filter generation without opening a new visit. Neither can go backward and at least one must increase. A new admission must match the active visit's exact source identity, content revision and generation. |
| Prior admission | `admit` represents an already privacy/permission-checked capture by the authoritative producer **before extraction**. It binds one job ID to the exact active visit/source/revisions/time. It is not a producer permission request, nor proof that pre-read filtering actually happened on a device. |
| Late completion | `result` may name only an admitted job, not choose a new visit or timestamp. A closed visit may receive that historical sample while recording remains active, within job lifetime and unchanged fences. Capture must still fall inside the final visit interval. Its original revision/generation remains attached; it is never relabelled as the new content. |
| Lifecycle | A recording-scoped `fence` increments lifecycle revision and, for revoke/exclude/delete, the corresponding policy revision. It stops this trace and cancels jobs. Delete also removes all visit/sample/gap readback and clears replay digests. Later gap corrections return `HISTORY_DELETED`, including after a producer reset, rather than recreating deleted history. Synthetic rejection diagnostics remain separate from that readback. Old-revision results fail even if they arrive after Pause. Field-level availability is separate from these recording-scoped fences. |
| Coverage | An explicit same-recording/producer/domain `gap` can retroactively truncate visits/readback after Pause, including a correction emitted under older policy revisions. Future revisions are rejected. This exception only removes data: it removes samples at/after the cutoff, clears jobs and stops recording. A producer must supply the reliable cutoff; this runner does not detect native stalls or reconstruct missed boundaries. |
| Replay/order | An identical accepted event ID/body is idempotent; conflicting reuse is rejected. Event IDs are unique across the recording, including producer resets. Other events require strictly increasing sequence and nondecreasing `atMs` in their domain. This draft rejects reordered delivery; buffering/recovery and the required producer gap signal remain integration work. |
| Field result | Missing means no sample. `value` requires nonempty bounded text. `empty`, `unsupported`, `denied`, `stale` and `unavailable` are separate states that cannot carry a value. These are result states, not a completed per-field capability contract. |
| Bounds | Pending jobs, job lifetime and UTF-8 value bytes are explicit fixture limits. Expired/terminal jobs release capacity; job IDs cannot be reused. Corpus traces are capped at 256 events. The 64-byte/5-second/two-job examples and schema guardrails are **illustrative draft bounds**, not accepted product budgets. |
| Browser privacy | A well-shaped browser identity is not enrollment or privacy proof. The reference rejects **all** browser focus in this slice, including apparently ordinary profiles; native fixture examples remain usable. Do not use its native-kind tag as a security check in production. |

The visit schema is an **output projection for a complete synthetic trace**, with `sourceId`/`clockDomainId` resolved within that trace. It is not a standalone durable visit record, storage schema, full provenance export or content-free receipt. Full production identities/retention and native/browser coalescing remain #2/#3/#4 work.

## Canonical file format

The JSON file contains literal event sequences and handwritten expected outcomes. For compactness only, each event is expanded as a shallow merge of `wireDefaults`, optional case `wireDefaults`, then the event. A string `source` alias is replaced by the matching object in `sources`. Defaults **never** evolve with replay state; fence/reset overrides must be explicit. Validation applies to the expanded wire object, not the shorthand. Other languages can consume the same data with these two mechanical operations; do not copy scenario logic into platform suites.

`schemaCases` records expected validation codes; `cases` records exact expected replay projections. The schema tests and replay tests are distinct: JSON Schema cannot enforce temporal association or deletion by itself. The [reference checker](../../tools/draft_capture_contract.py) is a small, finite executable proposal under development tools; production code must not import it or treat it as a second ledger. It reads only the maintained invented corpus and has no capture/ingest server, storage, key access, upload or native API path.

## What remains open

- #1's final runtime/host/IPC choice, supported native environments, source clock correlation/uncertainty and measured bounds before production freeze.
- Authentication/enrollment and trustworthy browser focus/private-state proof; URL/path/content identity and pre-read privacy enforcement.
- Full observation/visit/capability/consent and content-free receipt contracts, idle/passive/lock/sleep semantics and restart/crash persistence.
- Frame acquisition timestamps independent of admission, pixel/processing/retention scopes, bounded frame buffers, encryption/expiry and Rich references.
- Production review of the proposed closed-visit enrichment rule, per-source/field revocation, clock/order recovery and actual adapter conformance. These are not silently approved by a green synthetic run.

No Capture Check code/package, production storage, Actions, deployment, startup hook or OS permission changes accompany this draft.
