# Source-bound OCR tools

## Explicit Nebius vision factory

`createNebiusOcrTool` from `core/tools/nebius-ocr.ts` registers `ocr.document`
with input `{inputId}` (a selected source or derived image artifact). Register it
**instead of**, not alongside, the same-named legacy NIM factory. The caller
supplies `{store, provider, admit, pythonExecutable?, maximumSpans?}`. The provider
is the existing explicitly configured Nebius `TextProvider` with verified image
capability/accounting/pricing and a durable `FileCallBudget`; no alternative
provider/decoder framework or automatic fallback is introduced.

`admit` uses the same source-specific frozen binding/revocable lease contract as
[semantic image inspection](IMAGE_TOOLS.md#optional-semantic-inspection): exact
workspace/account, selected artifact/hash and source roots/versions. A copied
`image.processing` grant is not remote-egress authority. Denial performs no
canonicalization, credential lookup, reservation or network request. Lease
revocation aborts pending canonicalization, credential and provider waits; source,
namespace, scope and task currentness are checked across those boundaries and
again before publication. Model input cannot select endpoints, executables,
models, paths or grants.

PNG/JPEG/HEIF/HEIC use the **same credential-free image worker** and
`canonicalizeImage` export as image tools. Limits are 8 MiB encoded and 16 MP
locally decoded, single frame, 15-second worker/provider timeouts; canonical PNG
fits the existing provider's 2,000,000-byte bound. There is no inherited 512,000-byte
Google probe limit. HEIF prerequisites/pin/license are in
[HEIF-NOTICES.md](../tools/image-worker/HEIF-NOTICES.md); an absent decoder is an
explicit trusted-interpreter configuration failure, not an unsupported product
use case. Originals remain unchanged; canonical PNG is memory-only.

Exactly one completion is requested, with a 512-token output bound and at most
`maximumSpans` (default 4; configurable 1–16). Coverage is explicitly **partial**;
this is not full-page verification. Exact returned strings, including leading
zeroes and masks, are retained. No missing digits, fields or confidence are
invented. Empty/masked/model-uncertain spans remain unresolved. Finite normalized
polygons must have nonzero area; malformed responses publish nothing and trigger
no fallback/retry. A completed provider response can still fail span validation.
Failure data records stage/invocation/reservation facts, not ownership inferred
from a shared budget total. Unknown/missing-usage reservations remain charged.
Genuine SQLite and publication errors escape ordinary provider-failure results
so the runtime can require write reconciliation.

Both factories share `ocrOutputSchema` and `spindle.ocr.v1`. Each validated
polygon gains a derived normalized `{x,y,width,height}` `bbox`; callers cannot
replace it with unrelated coordinates. `coordinateProvenance` is explicitly
`model-estimated` for Nebius and `backend-reported` for NIM. **Neither label is
ground truth or pixel-accuracy acceptance.** Confidence is retained only if an
actual backend/model span returned a finite value in 0–1; otherwise the property
is absent. Legible words such as “Alex” and “example” are not classified as masks
merely because they contain x. Explicit returned uncertainty, real mask marks and
numeric redaction sequences remain unresolved without altering literal text.

Nebius records include root source/version, exact original **or derived input artifact/hash**, canonical
hash, EXIF/original orientation and dimensions/affines, plus partial coverage.
HEIF coordinates explicitly use libheif display-raster edges after container
transforms. `resolveOcr` verifies lineage/hash/namespace, opens the exact input
image (not its root PDF), maps actual spans into source pixels and returns
`uncertainty` and available `confidence` additively. Consumers must preserve this
uncertainty and leave unresolved fields blank; OCR is not field verification.

Tests exercise public registered `ToolDefinition`/`AgentRuntime` contracts with
invented real PNG/JPEG/HEIF pixels and **scripted, injected HTTP responses only**.
They do not prove live Nebius OCR quality, actual private-input handling, native
capture or the integrated Drive workflow. Those remain coordinator/live-phase
acceptance; this module writer made zero paid/key/cloud calls.

## Actual page geometry and private region previews

Original image sources have **no invented page index**. For images descended from
a PDF, configure the trusted factory callback
`resolvePageGeometry(context, inputArtifactId)`. It returns exported
`OcrPageGeometry` from actual persisted `document.render`/PNG-export and subsequent
image-operation observations, not model arguments or guessed filenames. Missing
PDF page provenance fails before provider invocation with a configuration action;
independent image OCR remains available.

The contract contains exact `documentArtifactId/documentHash`, actual zero-based
`pageIndex`, exact `renderArtifactId/renderHash/renderPixelDimensions`, displayed
CropBox `pagePoints`, actual `cropBox:[x,y,width,height]`, `rotation`, `userUnit`,
`pdfToPage` and `inputToRender` six-coefficient affines. Coefficients use
`[a,b,tx,d,e,ty]`, mapping `(x,y)` to `(a*x+b*y+tx,d*x+e*y+ty)`.
`coordinateSystem` is `displayed-crop-top-left-points` (x right, y down, physical
PDF points). The PDF tool uses standard PDF `[a,b,c,d,e,f]` affines: convert its
`pdfToPage` to OCR row-major `[a,c,e,b,d,f]`. Normalize its `{width,height}` point
and pixel dimensions to arrays and crop object to `[x,y,width,height]`; resolve
its input source ID to the exact PDF artifact. Do not pass pixel-coordinate enum
labels or PDF affine coefficients through unchanged.

Direct render inputs use identity `inputToRender`; cropped/resized
inputs derive it only from their actual persisted transform parameters. The
adapter normalizes the PDF tool's render observation into this contract; OCR
does not query a private database schema or implement another PDF engine.

OCR verifies exact namespace/root/ancestor lineage, artifact hashes, actual PNG
pixel dimensions, invertible finite/in-bounds transforms, and crop/rotation/point
consistency. It composes EXIF-to-encoded, input-to-render and actual render scale.
`resolveOcr` additionally returns image/canonical hashes, `sourcePixelDimensions`,
source-pixel BBOX, and, only when present, actual `pageIndex/pageHash`, page-point
polygon/BBOX and full `pageGeometry`. Page hash identifies the actual rendered
page raster; document hash identifies its exact PDF input, which may itself be
a derived revision. These coordinate mappings do not turn OCR boxes into form
semantics or verified field placements.

`createOcrRegionTool({store, pythonExecutable?})` from `core/tools/ocr.ts` registers
**`ocr.render_regions({ocrArtifactId, spanIds})`**. It accepts 1–64 unique persisted
span IDs, never caller text/coordinates/paths. The local tool rechecks current
scope/hash/lineage, recanonicalizes the immutable exact input and verifies its
stored canonical hash/geometry before drawing through the existing Pillow
worker. It publishes one new PNG derived from the OCR artifact and exact image,
with unchanged evidence, exact provenance and a separate readable legend:
**MODEL-ESTIMATED / NOT PIXEL ACCURACY / NOT FORM SEMANTICS** for Nebius. Red lines
are persisted polygons, blue envelopes are computed BBOXes. Preview metadata
records the canonical image bounds within its legend-extended canvas. No provider
or egress admission is involved; local `image.processing` scope is still required.
Cancellation/staleness publishes nothing; genuine publication faults escape for
runtime reconciliation. A new preview does not rewrite the original or OCR.

Configured overlay tests additionally require `SPINDLE_PDFTOPPM` pointing to the
trusted Poppler renderer and `SPINDLE_HEIF_PYTHON` for the real HEIF matrix. They
render invented page 1 (not page 0), exercise changed layout, scale, nonzero page
origin, crop and rotations, read back actual glyph/border/preserved pixels, and
retain optional private sample PNGs under `SPINDLE_OCR_REGION_PROOF`. These are
scripted-coordinate mapping/display checks, not live model accuracy, native UI or
owner/Mac private-input quality inspection. The coordinator owns the final
integrated independent review and actual private citation acceptance.

## Legacy self-hosted NIM factory

`createOcrTool` implements the separate **self-hosted NVIDIA NIM `/v1/ocr` contract**. No service is started and no model weights are downloaded. A configured, authorised backend is required; there is no local/precomputed/hosted fallback.

The trusted application supplies an HTTPS endpoint (or explicitly selected numeric loopback), an `EvidenceStore`, and an `authorize(context, endpoint)` callback. The tool accepts only a permitted source ID in the current workspace/account. It requires `image.processing` scope, checks the exact original snapshot hash, and rechecks cancellation/current authority before retaining results. Endpoint selection and grants cannot come from model arguments or source text.

## Contract and evidence

Public API research, not live service verification:

- [Official OpenAPI reference](https://docs.nvidia.com/nim/ingestion/image-ocr/latest/api-reference.html)
- [Request/response example](https://docs.nvidia.com/nim/ingestion/image-ocr/latest/getting-started.html)
- OpenAPI YAML retrieved for this implementation: SHA-256 `e2a5dc45170c8fd305d86924cd949820a86e8aad2de0b7d0c6a5927320813b6f`.

The request supplies one original PNG or JPEG as an image data URI with its original MIME type and unchanged bytes and asks for word merge level. The response contains model identity and returned text detections with polygons. The adapter validates finite normalized coordinates and confidence, retains exact text (including leading zeroes), and binds stable span IDs to the original source/hash. The derived JSON artifact carries source lineage and the shared tool result retains actual evidence references. Confidence is not verification; no missing digits are inferred.

`resolveOcr` accepts persisted artifact/source/version/span IDs, verifies namespace and snapshot integrity, and returns source-pixel polygons derived from those actual spans. Callers cannot supply replacement coordinates.

## Current limits

- PNG and JPEG inputs are bounded to 8MiB, 16,384 pixels per dimension and 40 million pixels. PNG orientation metadata is refused rather than silently rotating geometry. Metadata inspection is not a full image decoder or proof of valid pixels.
- JPEG SOF dimensions are read without decoding or rewriting bytes. Supported frames are 8-bit baseline/extended sequential/progressive. No EXIF means conventional identity orientation; EXIF IFD0 orientation must be absent or exactly 1. Bounded endian-aware EXIF inspection rejects malformed lengths/offsets/types, nonidentity orientation, chained directories and unknown APP1 metadata. These unsupported inputs fail before any request; transform/backend proof is needed before supporting rotated sources. Exact original dimensions and returned normalized polygons are retained.
- JPEG live NIM acceptance, backend orientation behavior and actual inference quality remain unproven; the synthetic valid JPEG HTTP regression proves only adapter machinery.
- The public self-hosted schema is not assumed to match the hosted NVIDIA endpoint. Hosted support, model access/identity and actual inference quality need real-boundary verification.
- The loopback HTTP regression is a **mock backend**, not NVIDIA inference. It proves changed returned text/layout, leading-zero strings, source/version isolation, cancellation, authority checks and finite response bounds.
- Review citations now resolve to retained region previews in the preparation review (core/preparation/citations.ts). No user inspection of real-input overlays is claimed; PR69 for editable application issue #48 remains unmerged.
- Backend access must remain within the configured processing/budget authority. No automatic retry, paid fallback or deployment is installed here.

Run `NODE_OPTIONS=--max-old-space-size=256 npm run build`, then `node --max-old-space-size=256 --test --test-concurrency=1 build/tests/tools/ocr*.test.js build/tests/tools/nebius-ocr*.test.js build/tests/evidence/nebius-ocr.test.js`. The test uses invented content, a finite oversized response, and run-owned temporary disk/HTTP resources.
