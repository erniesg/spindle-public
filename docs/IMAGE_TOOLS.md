# Image tools

Factory-created tools decode real PNG/JPEG/HEIF/HEIC pixels: inspect, masked clone retouch, crop/resize/RGB encoding, explicit-constraint verification, and opt-in local MODNet background removal. These are machinery, not photo-quality certification. [Issue #46](https://github.com/erniesg/spindle/issues/46) owns current delivery, remaining acceptance and continuation decisions.

Production configuration is caller-trusted: `createImageTools(store, {pythonExecutable, modelPath})`. Python defaults to python.exe on Windows or python3 elsewhere; the model is never downloaded automatically. The selected interpreter needs Pillow; matting also needs the pinned ONNX Runtime environment and model described in `tools/image-worker/MODEL-NOTICES.md` and `pyproject.toml`. Only PATH, SystemRoot, WINDIR, TEMP, TMP and LANG are inherited. Python -E ignores Python environment injection; trusted interpreter packages (including user site) remain available. Windows execution remains untested.

Inputs are immutable namespace-scoped snapshots or derived artifacts with bounded lineage to exact granted source or snapshot IDs. Bounded reads check actual open-file size before allocation and hash the selected input; ancestors are metadata-only. Each pixel operation publishes exactly one image artifact. ToolResult.data preserves input/output IDs and hashes, transform parameters and output metadata; AgentRuntime durably stores these with the observation, not a fallible independent sidecar. Active cancellation/currentness and image.processing grant are required.

Limits: 8 MiB encoded input/output, 16 MP decoded image, single-frame PNG/JPEG/HEIF/HEIC; crop output supports JPEG and PNG. Coordinates refer to EXIF-oriented pixels. Retouch clones at most ten percent of pixels to an explicit rectangular mask, preserving decoded pixels outside it in PNG. Verification requires nonempty explicit constraints and does not infer background or visual quality. EXIF metadata is not preserved. Worker timeout is 15 seconds; pixel bounds are not an OS memory sandbox.

## Literal text overlays

`image.text_overlay({inputId, parameters:{text,x,y,fontSize,colorRGB,opacity,strokeRGB,strokeWidth}})` draws a new canonical RGBA PNG through the same Pillow worker, preserving alpha for RGBA, LA, palette and RGB/tRNS inputs. `text` is 1–128 printable ASCII characters rendered with Pillow's bundled font; unsupported/control text is rejected, never executed. Coordinates are the outer text/stroke box's top-left in actual EXIF-oriented pixels. Font size is 4–256 pixels, opacity 1–255 and stroke width 0–16. Measured text that cannot fit is rejected without clipping or shrinking. Output records the literal text, measured box/style, original hash, derived hash and unchanged image dimensions; decoded pixels outside that box are preserved. A later text value matching a recorded field carries that field dependency through preparation revision checks.

For an owner-requested demonstration photo, the agent can choose this general operation to render **Sample** visibly. This does not make the photo anonymous or official-submission/compliance ready. Identifiable outputs remain in the owner-private app/authorized destination; evidence shared elsewhere must independently mask the face and sensitive source fields. The operation does not infer destination or disclosure permission. Tests cover actual pixels, changed text/layout, PNG/JPEG-EXIF/HEIF inputs, immutable originals, denied bounds/namespace/grant and cancellation.

## HEIF and immutable image provenance

HEIF is supported by the same `createImageTools` factory, not a separate engine.
Configure a trusted Python interpreter with the optional reviewed binary-only
`pillow-heif==1.8.1` decoder. The observed Linux aarch64 CPython3.12 wheel/hash,
local-only licensing and minimal uv installation are documented in
[HEIF-NOTICES.md](../tools/image-worker/HEIF-NOTICES.md). No package/model is
installed at runtime; absent/wrong decoder versions produce a meaningful
configuration error. Other platform wheels are not accepted by inference.

Local operations inspect header dimensions before pixel allocation, keep
libheif security limits enabled and use one decode thread without auxiliary,
depth or thumbnail decoding. Container rotation/crop is applied by libheif;
original EXIF orientation is retained as metadata, not applied twice. Coordinates
refer to the libheif display raster for HEIF and EXIF-oriented pixels for PNG/JPEG.
`image.crop_resize` derives PNG/JPEG through real decode, alpha composition and
encoding. The original remains immutable. Results include selected input/hash,
source pixel/decoder metadata, actual operation parameters and output/hash;
current scope/hash is revalidated before publication. SQLite/publication failures
escape normal operation-failure results for reconciliation.

`canonicalizeImage(bytes, signal, pythonExecutable?)` is exported from the same
module for separately admitted semantic/OCR consumers. It creates no store
artifact and receives no provider credentials. It is not an egress grant.

Set `SPINDLE_HEIF_PYTHON` to the trusted pinned-decoder interpreter to run
`build/tests/tools/images-heif*.test.js` and the derived-HEIF OCR test (also set
`SPINDLE_IMAGE_PYTHON` for general OCR/image tests). Actual invented HEIF pilots
cover alpha, two changed output sizes/formats, container rotation and malformed/
multiframe/configuration denial. These are local pixel/contract checks, not
photo-quality or private-source acceptance.

## Encoding a tight byte limit

JPEG encoding starts at the requested quality and decreases by five points, including quality 1 as the final supported floor even when that step would otherwise be missed. PNG is lossless and encodes once; reducing a JPEG quality setting cannot shrink PNG. The limit is strict (`bytes < maxBytes`); an unattainable limit fails without publishing an image. A byte-limit pass is not visual-quality acceptance: extreme compression can destroy useful detail and needs actual output inspection or another preparation round.

Manual crop parameters, synthetic edge cases and semantic mocks do not establish model-selected unseen-portrait preparation or passport quality. Agent-selected preparation must be evaluated against the actual destination requirements and inspected output. Historical pixel/portrait pilots are recorded in [PR #80](https://github.com/erniesg/spindle/pull/80).

## Optional semantic inspection

`createImageTools(store, {pythonExecutable, vision: {provider, admit}})` enriches `image.inspect` with optional semantic proposals, while preserving existing Pillow metadata and successful local inspection when enrichment is missing, denied or failed. `data.semantic.status` is `ok`, `needs_input` or `failed`; only an accepted semantic response sets `semanticVision: true`. No configuration is inferred, model selected automatically, budget journal created, or fallback attempted.

The trusted caller injects an already configured Nebius `TextProvider` with `FileCallBudget` (for example from `configuredNebius`), using operator-verified image capabilities, accounting and pricing. `admit` receives a frozen binding containing workspace/account, exact input/artifact/hash and every source-root/hash. It returns a source-specific revocable lease `{signal, isCurrent}` or denies with `undefined`. Revocation must both abort the signal and invalidate currentness. This is a separate #46 image-egress admission, not `RemoteConsent`, a copied `image.processing` grant, a capture permission or submission authority. Model arguments cannot choose admission, endpoints, credentials, executables, model paths or new grants.

Pillow performs bounded actual PNG/JPEG/HEIF decode and EXIF transpose, composites alpha to white for transport only, strips metadata and downsamples into an in-memory PNG fitting the actual existing provider limits: 2,000,000 PNG bytes, dimensions <=8192 and <=33,554,432 pixels (local decode remains <=16 MP). No canonical image is published to the artifact store. Provenance records encoded/oriented/canonical dimensions, orientation, original/canonical SHA256, canonical-to-oriented scaling and oriented-to-encoded affine mapping on continuous pixel edges. Semantic boxes are strictly finite, positive-area canonical bounds and map back to the exact source image; they are **proposed edits**, not OCR spans, biometric/identity verification, quality acceptance or authority. Retouch/crop execution remains a separate validated tool choice; the consumer must deliberately convert continuous-edge proposals into valid integer tool parameters.

The adapter checks current source scope/hash, context and the egress lease before/after canonicalization and through the provider's existing `current`/active signal options across credential lookup, request and result. Exactly one provider call is made; durable reservation occurs before credentials/network. Producer and usage are exposed. Reservation reporting uses only this invocation's observed facts: before invocation `not_reserved`; returned completion with usage `settled`; returned completion without usage `retained`; invoked provider without a returned completion `unknown`. A rejected semantic proposal after a returned completion preserves its known disposition. Cancellation or a budget-denial error after invocation does not prove reservation ownership or absence. The public `budget` snapshot is labelled `budgetScope: shared_aggregate` and never attributed to this call. Failed calls may leave charged reservations; no automatic retry. Revocation holds semantic enrichment without erasing valid local metadata; task cancellation/staleness still rejects the overall stale result.

Semantic adapter tests use synthetic model/pricing declarations and injected HTTP responses; they make no paid calls and do not establish actual provider capabilities, pricing, inference quality or unseen-portrait acceptance. Current review/continuation disposition belongs in [#46](https://github.com/erniesg/spindle/issues/46), with the historical implementation and review in [PR #73](https://github.com/erniesg/spindle/pull/73).

## Portable test configuration

Ordinary root fast checks do not require Pillow or a cached model. Schema and opaque-input namespace/hash/lineage/denial checks run offline in Node; backend tests explicitly skip when their configuration is absent. A skip is **not** pixel or matting acceptance. No test installs packages or downloads a model.

For configured acceptance, first provision a trusted environment using the reviewed pinned `tools/image-worker` dependencies and independently verify the model hash from MODEL-NOTICES.md. Then supply absolute host paths (PowerShell: use `$env:SPINDLE_IMAGE_PYTHON` and `$env:SPINDLE_MODNET_MODEL`):

```sh
export SPINDLE_IMAGE_PYTHON=/absolute/path/to/trusted/python
export SPINDLE_MODNET_MODEL=/absolute/path/to/verified/modnet.onnx
NODE_OPTIONS=--max-old-space-size=256 npm run typecheck
NODE_OPTIONS=--max-old-space-size=256 npm run build
NODE_OPTIONS=--max-old-space-size=256 node --test --test-concurrency=1 build/tests/*/*.test.js build/browser-extension/connection-probe/tests/host.test.js
python3 -m unittest discover -s tests -v
```

A configured PR run must pass every image test with zero image skips. An invalid configured path fails rather than skipping. Among the original pixel-operation checks, without either variable four backend tests intentionally skip; two Node-only image tests still execute, alongside the evidence suite's bounded-read guards. Semantic/canonicalization checks also explicitly skip without trusted Python. With Python but no model, only the MODNet test skips.

Historical source-bound portrait/provenance and portability results are retained in [PR #64](https://github.com/erniesg/spindle/pull/64) and [PR #80](https://github.com/erniesg/spindle/pull/80). Test results are not independent photo-quality approval; consult #46 for current acceptance rather than inferring it from those historical runs.
