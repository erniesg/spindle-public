# Spindle

**A time tracker that saves you time.**

Spindle records where your attention goes (a native Mac/Windows capture app and a Chrome MV3 extension), helps you protect focus (Pomodoro, earned leisure and context-gated site blocking), and then offers to do the repetitive work it sees. The flagship flow: an email arrives in your connected Gmail asking for an ID photo and a completed bank form. Spindle picks it up, looks up the official photo requirements with Tavily web search, prepares a photo that meets the spec without changing who you are, reads your passbook, fills in the PDF form, saves both to Google Drive and drafts the reply with the attachments. Nothing is sent until you click **Send**. The model decides and deterministic code does the pixels: Nemotron returns coordinates, parameters and typed JSON, and Spindle's tools apply them, measure the result and record hashed evidence for every step.

## Try it

- **Hosted demo:** <https://spindle.berlayar.ai>
- **Judge sign-in:** use the demo account credentials in `demo.txt`, uploaded with the hackathon submission. Credentials are deliberately not in this repository.
- **Downloads:** <https://spindle.berlayar.ai/downloads> currently serves an Apple Silicon Mac test build and the Chrome extension, with a `SHA256SUMS.txt`.

Suggested path: sign in, connect Google once (one consent for Gmail and Drive, with Google Picker for `drive.file` folder access), email the connected inbox a request that needs a photo and a form, and watch the preparation run until it stops at a draft for your approval.

## How we use NVIDIA Nemotron

All model calls go to Nebius Token Factory's OpenAI-compatible endpoint (`https://api.tokenfactory.nebius.com/v1/chat/completions`). Models are chosen in trusted operator configuration, never by an HTTP request or by a model (see [`core/models/provider.ts`](core/models/provider.ts) and [`deploy/vm/account-config.example.mjs`](deploy/vm/account-config.example.mjs)).

| Tier | Model | Role in Spindle |
|---|---|---|
| Everyday, high-frequency | Nemotron Nano (`nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`) | Short, fixed-schema classification of the signed-in account's own activity records with thinking off ([`core/account/classification-host.ts`](core/account/classification-host.ts), [docs/ACCOUNT_CLASSIFICATION.md](docs/ACCOUNT_CLASSIFICATION.md)). |
| Agent workhorse | Nemotron 3 Super (`nvidia/nemotron-3-super-120b-a12b`) | The decision model for the preparation agent: planning, choosing tools, mapping form fields ([`core/models/agent-provider.ts`](core/models/agent-provider.ts)). |
| Vision | Nemotron 3.5 Super VL (`nvidia/Nemotron-3.5-Super-VL`) | `image.inspect` (describe the photo, locate face/mark/donor regions as pixel boxes checked against image bounds) and `ocr.document` reads. Inspection runs with thinking off and strict `json_schema` output. |
| Serious reasoning | Nemotron 3 Ultra | Planned: weekly pattern mining over labelled activity to propose automations. Not implemented in this repository yet. |

<!-- OWNER: confirm the Nano and Ultra rows match what you want to claim; see the snapshot report. -->

### OCR: two readers, nothing invented

[`core/tools/nebius-ocr.ts`](core/tools/nebius-ocr.ts) measures skew, straightens the crop and reads only the relevant region at full resolution. It supports an independent second reader called in parallel on the same crop. The intended configuration is two Nemotron 3.5 Super VL reads, one with thinking off and one with thinking on; a reasoning second reader is given its full declared output budget. Spans where the two reads disagree are marked **unresolved**, never auto-corrected. `preparation.record_fields` then only accepts values copied verbatim from cited OCR spans, and Singapore NRIC/FIN values must pass the check-letter algorithm in code ([`core/preparation/identifiers.ts`](core/preparation/identifiers.ts)) before they can be recorded.

<!-- OWNER: the live config on 30 Oct 2026 used openbmb/MiniCPM-V-4_5 as the second reader; see the snapshot report. -->

Thinking is controlled per model declaration (`thinking: false` sends `chat_template_kwargs: {enable_thinking: false}`); see [docs/MODEL_TOOLS.md](docs/MODEL_TOOLS.md) and [docs/OCR_TOOLS.md](docs/OCR_TOOLS.md).

## Where Nebius Token Factory accelerated the build

- **One OpenAI-compatible API and one key for every tier.** Moving a call between Nano, Super and Super VL is a change to a model declaration in operator configuration, not a new deployment. We never provisioned GPUs to serve a 120B MoE or a VL model.
- **Strict `json_schema` output and a thinking toggle** made typed agent decisions and typed vision results practical, so a multi-tool agent can run unattended up to the human approval step.
- **Per-token pricing made hard budgets possible.** Every call goes through a budgeted provider with a file-backed journal ([`core/models/file-budget.ts`](core/models/file-budget.ts), [`core/preparation/budget.ts`](core/preparation/budget.ts)). Each preparation run has a USD limit plus separate caps on decision and vision calls, and each request reserves its worst-case cost before it is sent.

## Other Nebius services used

<!-- OWNER: SUBMISSION.md lists Serverless Jobs and Serverless Endpoints. No reference to them exists in this repository (see the snapshot report). Keep this section to what is true for the deployed system. -->

- **Budgets and spend control** on Token Factory usage, enforced in Spindle's own budget journal as described above.

## Architecture in brief

- **Agent runtime:** TypeScript on Node 22, with context (the email, selected Drive files, screen history), memory, versioned skills (`application-photo`, `read-document`, `fill-form` in [`core/preparation/skills.ts`](core/preparation/skills.ts)) and typed tools.
- **Tools:** Tavily web search (`web.search`, `web.open_result`, [`core/tools/web.ts`](core/tools/web.ts)) with a guard that keeps personal data out of queries; image tools backed by a local Python worker ([`tools/image-worker/`](tools/image-worker/), ONNX Runtime on CPU, BiRefNet matting); PDF inspection and fill-by-label with pdf-lib; Gmail draft and Drive artifact tools.
- **Evidence:** every tool result is stored as immutable, hashed evidence with lineage.
- **Accounts and storage:** WorkOS sign-in, SQLite (`node:sqlite`), encrypted account store.
- **Hosting:** the public site is a Cloudflare Worker with downloads on R2, in front of the Node account host ([deploy/README.md](deploy/README.md)).
- **Capture:** Swift ([`platforms/macos/`](platforms/macos/)) and C#/.NET ([`platforms/windows/`](platforms/windows/)) native apps and a Chrome MV3 extension ([`browser-extension/`](browser-extension/)).

More detail: [Product](docs/PRODUCT.md), [Systems design](docs/ARCHITECTURE.md), [Testing](docs/TESTING.md), [Model tools](docs/MODEL_TOOLS.md), [Google setup](docs/GOOGLE_SETUP.md), [WorkOS sign-in](docs/WORKOS_SIGNIN.md).

## Run from source

### Requirements

- Node 22 (CI pins `22.23.4`; built and tested here with 22.22.3).
- Python 3.11+ for the repository's Python checks; Python 3.12 for the optional image worker.
- Mac native builds need Apple Command Line Tools; Windows native builds need a .NET SDK (8.0 was used).

### Install, build and test

```sh
git clone https://github.com/erniesg/spindle-public.git
cd spindle-public
npm ci --ignore-scripts      # or: pnpm import && pnpm install --frozen-lockfile --ignore-scripts
npm run build                # tsc, then stages portal/UI assets (fonts are hash-checked)
npm run typecheck
npm test                     # builds, then runs the Node test suite
python3 -m unittest discover -s tests -v
```

`make check` runs typecheck, build, the Python tests and the Node tests in one go. The lockfile is `package-lock.json`. Some end-to-end tests (`*.e2e.ts`) need a local Chromium via Playwright and are not part of `npm test`.

<!-- OWNER: see the snapshot report for the clean-checkout test result. -->

### Configuration and credentials

There is no `.env` file. Secrets are never read from the repository.

- **Production preparation account host:** `node build/core/preparation/startup.js --application-module /absolute/path/account-config.mjs`. The module exports `preparationAccountConfig()`, which supplies the decision/vision model declarations, a credential callback for the Nebius key, budget limits, the Google OAuth client and the WorkOS configuration. Start from the template [`deploy/vm/account-config.example.mjs`](deploy/vm/account-config.example.mjs) and keep the real file outside Git. Tavily search is enabled by passing a `webSearch` credential callback.
- **Capture classification:** set `SPINDLE_NEBIUS_CONFIG` to a private JSON file with exactly `model` and `budgetPath`, and `NEBIUS_API_KEY` in the launching process environment ([docs/CAPTURE_CLASSIFICATION.md](docs/CAPTURE_CLASSIFICATION.md)).
- **Purpose-gated blocking:** `SPINDLE_PURPOSE_CONFIG` selects a private provider config ([docs/SITE_BLOCKING.md](docs/SITE_BLOCKING.md)).
- **Google:** you need your own OAuth web client and Picker configuration ([docs/GOOGLE_SETUP.md](docs/GOOGLE_SETUP.md)).
- **WorkOS:** public client configuration lives in [`config/`](config/); see [docs/WORKOS_SIGNIN.md](docs/WORKOS_SIGNIN.md).
- **Image worker (optional):** `cd tools/image-worker && uv sync` (Python 3.12). Model weights are not in the repository and are never downloaded automatically; see [MODEL-NOTICES.md](tools/image-worker/MODEL-NOTICES.md).

### Capture Check (native window-capture smoke test)

The Capture Check opens two sample windows, A and B, reads their text, and lets you inspect the visits afterwards. It reads only those windows, not your other apps. After `npm run build`:

```sh
# Mac (Apple Command Line Tools, Accessibility permission)
bash platforms/macos/start-capture-check.command
```

```powershell
# Windows
dotnet build platforms/windows/CaptureCheck.csproj -c Release --output .local/native-windows
.\platforms\windows\start-capture-check.cmd
```

Click **Run 10-second test**, then open the visits: A should show A's text, B should show B's, and returning to A should create a separate visit. **Quit & clear everything** stops the check; delete the folder and remove any Accessibility grant you added to remove it. See [docs/TRY_CAPTURE.md](docs/TRY_CAPTURE.md) and [docs/CAPTURE_PREVIEW.md](docs/CAPTURE_PREVIEW.md).

## Source and live revision

This repository is a single-commit public snapshot of private source commit `c3686d5`. The hosted demo at spindle.berlayar.ai currently runs the earlier release `6b0d831`. Three changes in this snapshot are **not yet live** (they await the owner's preview approval): the second OCR reader as Nemotron 3.5 Super VL with thinking on (live still uses a MiniCPM-V second reader), the NRIC/FIN check-letter gate on recorded fields, and "Names on your documents" in Account settings.

## Known limitations

- `npm test` on this snapshot is not all green: in our run 1,492 tests passed, 27 were skipped and 6 failed. Five of the failures also fail on the live release and depend on local setup (Poppler and font paths, Google Picker referrer policy, production startup and memory-dispatch fixtures); one OCR geometry test fails on both revisions too. The sixth (a web-search privacy test) was fixed after that run.
- Some docs link to internal operations notes that are not part of this public snapshot.
- The only binary files are the three web fonts the portal build hash-checks (`core/account/portal/web/fonts/`).
- OCR of photographed documents can still misread a smudged character in a way both readers agree on; names and IDs are always shown to the owner for review, and nothing is sent without an explicit click.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Bundled fonts are under the SIL Open Font License 1.1 (licence texts beside the font files and in [`assets/licenses/`](assets/licenses/)).
