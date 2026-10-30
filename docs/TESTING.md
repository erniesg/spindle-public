# Desktop capture validation

This is the shared test policy for Windows/macOS Default/Rich. Issues add platform-specific scenarios, not copies of this checklist. All four full tracks remain **not fully delivered / not installed-accepted**; the limited preview has targeted native results in [#30/#33](https://github.com/erniesg/spindle/pull/30), which do not establish those full tracks. The [Capture Check](TRY_CAPTURE.md) is an implemented fixture-only native-text probe, not full Default/Rich acceptance. Its PR owns exact-package native results and current proof limits.

## Present the work so a person can review it

Follow [CONTRIBUTING.md](../CONTRIBUTING.md) and the shared delivery procedure: lead with user benefit, observed result and one important limitation. Put the primary recording inline in the private PR where supported and approved; link the directly playable private viewer, screenshots, packages and closed technical records as supporting evidence. The [infrastructure handoff](../INFRASTRUCTURE-HANDOFF.md) owns destination permissions. Distinguish synthetic/replay, native and installed proof; a remaining native check states its steps and success criterion. Captured app and viewer identities stay separate.

## Evidence levels

1. **Repository checks:** links, layout, syntax/package boundaries and hygiene.
2. **Synthetic conformance:** deterministic fake clocks/events, fault injection and invented context through production seams. `make check` currently includes the Capture Check visit/readback/privacy, HTTP-boundary and package-integrity tests as well as repository checks. It does not compile or run native providers.
3. **Native integration:** compiled target APIs and fixture applications on the actual OS. A native API unit test is not whole-package acceptance.
4. **Installed acceptance:** the exact built package, ordinary user permissions, real extension enrollment and local inspection on a consented device.

A track closes only at level 4 with reviewed evidence. Passing Linux tests or producing a build cannot substitute. Native hosts and permissions are not available merely because issues exist.

## Current bundled-delivery disposition (#74 / #85)

Owner direction, 27 October 2026: move the demonstrated Windows capture slice and integrated Mac/Windows packages forward under scoped source review. Known privacy, resource/timing and broader native edge-case followups are deferred as blockers for this delivery, not declared fixed or passed. Central broken functionality, account/authentication failures and package/runtime breakage still require repair. Keep existing consent, source restrictions and personal-data boundaries; use invented activity only.

The 32 MiB/ten-minute private-growth requirement originated in the agent-authored `0cea9ed` measurement policy, not an owner-selected budget. The agent-posted #1 freeze comment is not evidence that the owner chose it. The owner explicitly rejects that threshold as a current milestone blocker. Preserve the measured Default **39.23 MiB** / Rich **43.93 MiB** growth, the unsuccessful timing calibrations (**18.03915 / 12.21630 ms** half-width), and unresolved privacy/native findings as deferred followups. Do not optimize to these thresholds or rerun broad certification merely to admit the bundles; do not relabel the historical results as passes.

Source/package delivery is not full installed/native certification, deployment or permission to capture personal activity. Publish exact source/package identities and request affected Mac/Windows tests through the existing operators. Missing or stale native proof limits those claims, rather than blocking independently reviewed delivery of the test candidates. This scoped owner disposition takes precedence over the general full-acceptance gates below for #74/#85 delivery only.

## Test strategy: protect behavior, not implementation

Use critical, risk-based TDD. For a new behavior or bug, write the smallest test that exposes the wrong user-visible outcome, run it red, implement the fix, then run it green. Exercise production seams; assert observable results rather than private methods, callback counts or a mirrored implementation. Record the red/green test command and regression protected in the PR. A toolchain/API feasibility spike can be exploratory; add the regression before integrating its chosen behavior into production.

Choose the cheapest layer that can catch the failure:

| Layer | Spend tests on | Avoid |
| --- | --- | --- |
| Shared deterministic tests | Visit boundaries/rapid returns, duration conservation, URL/content identity policy, stale-result rejection, pause/revoke/delete fences, replay/expiry | A unit test for every getter/helper, OS mocks presented as native proof |
| Focused integration tests | Real persistence/readback, key/store failures, native-message validation, actual browser SPA/tab/privacy behavior, adapter-to-core association | Repeating the same policy permutations in Windows, macOS and extension suites |
| Small user-journey suite | Record → switch → inspect; pause/revoke → no new content; delete/expire → no readback; Rich consent → correct-visit visual | Exhaustive UI click combinations, brittle DOM/CSS snapshots, broad pixel baselines |
| Native visual review | Actual recording/readback and permission/lifecycle changes on the affected OS | Videos of mock APIs, rendered fixture-only UI passed off as working capture |

One canonical fixture set should drive shared semantics and thin provider conformance on both OSes. Test distinct failure mechanisms, not every combinatorial ordering; use table-driven vectors where outcomes differ. Introduce a regression for a real bug before fixing it. No test-count or coverage-percentage quota, new property/fuzz framework, custom test DSL or general-purpose harness without a demonstrated failure class that warrants it.

On each PR, run fast shared checks plus affected integration/journey tests; select extra cases from the risk matrix below and explain omissions. Run full relevant regressions at integration and the complete platform checklist at installed acceptance. Long soaks, battery tests and broad OS/browser matrices are acceptance/periodic gates, not a tax on every documentation or small logic edit. Failure of a required privacy/timing/lifecycle invariant blocks acceptance regardless of test-layer cost.

## Visual evidence required on capture PRs

PRs that introduce or change native/browser recording, context association or readback must include **screenshots and a short recording of the affected real flow**. Use the actual compiled host/extension and production capture/readback path on the affected OS, with invented fixture apps/pages. A minimal inspection surface is enough; do not build a polished dashboard just to prove capture.

- Show start/recording state, controlled app/tab changes (including a return visit), and retained context readback for the matching visits. Include the changed failure/control behavior, such as pause, denied permission or deletion.
- For Rich, show separate consent and the actual retained screenshot opened from its matching visit, then a relevant revoke/delete/expiry outcome. A desktop screenshot alone does not prove that Spindle captured or stored it correctly.
- Include a readable result screenshot and a concise screen recording (normally about 30–90 seconds; longer only if the behavior needs it). Keep expected/actual behaviour and limitations in the main PR; put source SHA, artifact digest, OS/build, fixture version, mode and reproduced steps in the linked technical record or a closed details block.
- A reviewer must be able to compare old and new behavior. For regressions, link the baseline or describe the old failure; UI changes should show before/after where useful. Do not regenerate image snapshots merely to make tests green.
- Visual evidence complements deterministic assertions and timing traces; it cannot prove duration accuracy, absence of disk leaks or complete deletion by itself. Keep those mechanical checks.
- Shared-contract or storage-only PRs with no native user-flow change can use a failing/passing production-seam test and inspectable synthetic readback/trace; explain why native visuals are not applicable. Their integration capture PR still needs native visuals. Never manufacture an integration demo for unfinished plumbing.

### Evidence privacy

Use a clean disposable OS user/browser profile, invented fixture content, no personal accounts, notifications or unrelated windows. Preview the full clip and screenshots locally before uploading. Only reviewed sample-data visual evidence may be published to the approved private viewer; real activity and unreviewed recordings stay on the device. Strip identifying paths/account/device details; recapture if safe framing is not possible. Do not enable automatic recording uploads or use personal sessions to make a demo look realistic.

Keep review images, recordings and packages out of Git and GitHub release assets. Inspected sample-only primary media may be attached inline to a private PR under the owner-approved scope; supporting media/packages/records use the existing private store/viewer. Release pages contain stable pointers. The existing private R2 review store is approved for this handoff (see `INFRASTRUCTURE-HANDOFF.md`). Verify copied bytes before removing an old copy, retain referenced evidence, show signed-link expiry and refresh the same PR/release pointer when needed. Never commit signed URLs/credentials or add an uploader to the capture runtime. Machine receipts remain content-free. Default's prohibition on retained screenshots concerns the **collector**, not a separately consented external recording of a synthetic acceptance run; prove the collector still retains no frames.

Without the target host, a PR may be draft/awaiting native evidence; it is not capture-accepted. Foundational units can land after their own reviewed checks, but absence of downstream native proof must remain explicit. The first native proof must occur during implementation, not be postponed until the final validation issue. Reuse an unchanged exact-artifact demo where appropriate; when behavior/artifact changes, refresh the affected evidence rather than recording the entire release matrix again.

## Test cases shared by all four tracks

| Area | Required oracle |
| --- | --- |
| Timing | Script an invented A 2s → B 3s → A 1s → B 4s sequence; four distinct visits, 10s total, no merging rapid returns. Synthetic time is exact. Native fixture records an independent activation trace, not the collector's own output as its oracle. Compare per-boundary and total error against the agreed budgets. Repeat short/long visits and delayed extraction. |
| Identity | Tab/window/app switching, SPA navigation, reload, duplicate title/URL, same-window new process, multiple profiles and out-of-order results. No cross-visit association. |
| Rapid/content-changing capture | Repeat increasing-speed native app/tab switches and return visits with distinct visible fixture markers; record an independent action trace and frame timestamps. Measure per-visit retrieval success, boundary/readback latency and missing/dropped coverage at the agreed minimum dwell time—not just the number of callbacks. Delay OCR beyond a visit and complete jobs out of order: old content must never appear on the new visit. Also change visible text/scroll/playback content without switching tabs/windows and verify fresh context. Test stream filter change, backlog and stale-frame reuse; report unavailable content honestly. |
| Idle/coverage | Idle, quiet reading, possible passive media, lock/unlock, sleep/wake, event loss and extension disconnect. Distinguish observed, possible passive, unknown and unavailable; no fabricated continuous coverage. |
| Privacy | Private and unknown-private browser state, excluded source, denied permissions and URL credentials/query/fragment. Structured AX/UIA/DOM extraction must avoid password/form-entry/editable/hidden value reads, including eager enumeration caches. Explicitly allowed supported native window pixels/OCR/Rich must work with edited content or incomplete text metadata; visible sensitive/edited fields and chrome are included, not masked. Read-only/edit-state/layout must not become pixel gates. Native browser pixels/detail remain denied. Check producer reads, ledger/WAL, context files, caches, logs and diagnostics—not just UI. Use invented secret sentinels and keep structured-read exclusion proof separate from consented window-pixel behavior. |
| Lifecycle | Start/pause/resume, permission grant/deny/revoke, logout/reboot/crash, startup on/off. Queued jobs cannot commit after pause, revoke, exclusion or delete. Deliberate pause survives restart. |
| Persistence | Duplicate replay, crash during commit, out-of-order enrichment, schema migration, expiry, delete, orphan cleanup and restart. Read back actual retained context; a category or success counter is not readback. |
| Offline | Capture and readback work with network and all models disabled. No unexpected outbound request. |
| Install | Clean ordinary-user install, supported browser/profile enrollment, upgrade preserving only intended data/settings, uninstall and reinstall. No leftover recording process or startup hook; explain data removal choices. |
| Performance | Repeatable Default/Rich workloads, queue saturation, CPU/memory/disk, battery and sleep/resume on laptops. Optional OCR/screenshots cannot stall visit timing. |

Default proves no retained screenshots anywhere, including temp files and diagnostics. In an explicitly enabled bounded-retention test, inspect permitted app/window/tab, sanitized URL, native/DOM text and OCR context for the correct visit; unsupported fields have named reasons. Browser pages/native fixture apps are invented content.

Rich repeats Default regressions and proves retained screenshot readback tied to exact visits, separate opt-in, encryption/key-unavailable behavior, expiry/deletion, no accidental monitor capture and cleanup after interrupted writes. Include occlusion, multi-monitor, DPI/scaling, unavailable/black/protected surfaces and rapid focus change. Do not label every black frame as DRM or attempt to bypass protected content. Missing frames must not erase valid baseline observations.

## Measurement budgets are a prerequisite, not an afterthought

The foundation issue must record supported OS/build/architecture, fixture schedule, sampling/visual cadence, minimum visit resolution, per-boundary/total timing tolerance, readback latency, CPU/memory/disk/battery budgets, and active/soak durations **before** accepting collectors. Measure a native baseline, propose numerical thresholds, review them, then freeze them with the fixture version. Unset budgets block validation; do not silently choose tolerances after seeing results. A fixed sampling cadence that misses the agreed rapid-switch oracle cannot pass by increasing tolerance. Freeze minimum dwell time, permitted frame-buffer size/lifetime, acquisition versus extraction cadence and per-visit retrieval/coverage budgets; report the measured limit rather than claim every arbitrarily fast transition is recoverable. Review native event timestamps against frame capture timestamps, not OCR completion time.

Test at least one supported Windows and one macOS host; include Windows laptop battery/sleep checks and MacBook power/sleep checks before claiming laptop support. If hardware is unavailable, leave that claim blocked. Supported architectures not exercised remain unsupported/unvalidated, not inferred.

### Windows desktop measurement profile r1

**Historical agent-defined measurement profile, not the current #74/#85 delivery gate.** The `0cea9ed` policy and agent-posted #1 freeze recorded these limits; neither establishes that the owner selected the 32 MiB growth budget. The owner disposition above defers these resource/timing requirements for current bundled delivery. Preserve original measurements and failures; this is neither a passing result nor an erased profile. This profile is Windows 11 Pro build 26200 x64, .NET Framework 4.8, English OCR, one 2560×1440 display at 150%. It evaluates local native capture and encrypted retention. Browser/account transport, GPU/driver total memory, other OS/builds, laptop battery/sleep, multiple monitors, OS crash and sudden power loss require separate evidence. It does not close the unresolved legacy UIA finding or establish full acceptance.

Baseline source/artifact is `1a70332881f45653ad0a75382ac5ff1bef3d2fb0`, Windows ZIP SHA256 `9f2f80a2690eb0f04cb353382ea59ebba5a923c51a9a7d90fdb6fa3102433d6b`. Three-process aggregates (Node control, native worker, mutex guardian) measured 20.92% of one core / 187.85 MiB peak private bytes for the normal 1 Hz invented canvas, 27.19% / 287.36 MiB for the maximized canvas, and 0.107% / 149.97 MiB paused. These roughly 30/30/15-second baselines are measurements, not accepted soaks. The agent-proposed ceilings were intended to provide scheduling/GC headroom. Historical runs remain assessed against their original ceilings; the owner's later delivery disposition does not change their measured outcome.

| Measurement | Required limit |
| --- | --- |
| Baseline visit resolution | At least 1 second; all rapid-return visits remain distinct |
| Matching optional context | At least 95% of visits with actual dwell ≥2 seconds |
| Absolute boundary error | At most 50 ms, including stated oracle and clock-mapping uncertainty |
| Total interval error | At most 100 ms per nominal A2s → B3s → A1s → B4s schedule, compared with actual independent activations |
| Matching retained readback latency | Nearest-rank P95 at most 1,500 ms |
| Wrong-visit context | Zero |
| Native acquisition bounds | Two frame-pool buffers, one queued newest frame, queued-frame age ≤750 ms; one extraction worker, 500 ms polling |
| Stream-disposal grace | At most 3 seconds; this grants no post-Pause commit grace |
| Active native workload | At least 600 seconds between first and last resource samples; maximized invented canvas updating at 1 Hz |
| Aggregate CPU | Active mean ≤50% of one core; paused mean ≤2% of one core |
| Aggregate private bytes | Active sampled peak ≤512 MiB; paused sampled peak ≤384 MiB |
| Aggregate handles / threads | Sampled peaks ≤2,048 / ≤96 |
| Resource growth (historical; deferred for current delivery) | Agent-proposed private bytes ≤32 MiB and handles ≤128 between first/last defined median windows; not an owner-selected milestone requirement |
| Capture disk | Committed snapshot ≤8,000,100 bytes; all capture-data/staging files together ≤32 MiB |

Timing/coverage uses 20 repetitions of A2/B3/A1/B4, followed by a closing control-window activation. The fixed invented fixture holds each nominal duration plus a declared 20 ms scheduling guard; compare actual independent WinEvent activations, not requested sleeps. All 80 A/B visits enter timing checks; the 60 actual ≥2-second visits enter coverage/readback checks. Unexpected external focus invalidates this controlled run instead of disappearing from its denominator. A controlled scheduling fixture is a separately hashed test input; changed fixture bytes must not be represented as an unchanged installed package.

The independent witness uses raw QPC. Before the schedule, bracket a fresh control-window visit through the real Start/state endpoint: raw QPC immediately before POST Start and immediately after receiving that new visit bound the offset from its native start coordinate. Use the interval midpoint, retain its width, and reject clock calibration if half-width exceeds 10 ms. For each independent WinEvent, bracket the current tick read with QPC before/after. Subtract the event tick age from that QPC midpoint and retain 16.001 ms plus the measured bracket half-width as that witness's uncertainty. Absolute error adds the actual calibration half-width, each witness's measured uncertainty and timestamp rounding. Interval bounds add both endpoint uncertainties; raw frame-window checks use their respective witness bounds. Retained-readback latency adds the activation witness uncertainty. A first-aligned trace alone proves intervals only and cannot pass the absolute-boundary gate.

The frozen fixture/run record additionally identifies its source/executable hashes, QPC frequency and millisecond units, a fresh calibration visit and owner generation, stable native clock identity, and the exact polling procedure. Each visit has a distinct invented ordinal and RGB marker `(37+2×index,81,207)` for zero-based indices 0–79, painted synchronously before activation; retained PNG decoding identifies that marker independently of OCR spelling. OCR must still be present and bound to the same image/PTS. State polling waits 100 ms after each processing cycle and candidate context is verified through POST Restore; calibration polling uses 5 ms waits. Include any visit whose independent dwell upper bound (measured dwell plus both measured endpoint uncertainties) reaches two seconds, including an unexpectedly stretched nominal one-second visit. Thus 60 is the planned minimum denominator, not a cap. Missing processes preserve a failed/interrupted record and cannot be silently replaced by another run.

Matching local Rich readback means a real decrypted `/restore` result with the correct visit identity, source marker and PNG, and raw acquisition PTS after activation and before the next boundary within stated uncertainty. Latency ends at receipt of that matching decrypted result. Missing/unavailable readbacks count as failures in the 60-visit denominator and as infinity when computing nearest-rank P95; never omit them from latency statistics. Native-only transport probes and already-visible state images do not substitute for this retained endpoint.

Resource sampling targets 500 ms intervals. Missing owned processes or sample gaps above 1.5 seconds invalidate a run. CPU is aggregate CPU-time delta divided by measured elapsed time without dividing by logical processors; memory, handles and threads are sampled aggregate peaks. Apply absolute limits throughout. For growth, compare medians in `[60,120)` and `[540,600]` seconds. Then Pause, retain context, allow the three-second disposal deadline, and observe paused resources for at least another 60 seconds without Clear or forced GC. Disk includes the task's complete capture-data tree/staging files plus the known native DPAPI key at its existing OS user-local path (that key is not isolated by a Node LOCALAPPDATA override and is not deleted); account transport is disabled in this profile. GPU/driver allocations are outside private-byte accounting.

## Sanitized acceptance receipt

Machine receipts in GitHub remain content-free and link from the validation issue. Separately reviewed synthetic visuals follow the policy above; raw/personal evidence stays on the device. The contract issue will implement a versioned schema with:

- Track (`windows-default`, `windows-rich`, `macos-default`, `macos-rich`), source SHA and clean/dirty state.
- Artifact digest, compiler/toolchain/dependency versions, OS/build/architecture and fixture version/digest.
- Installation/invocation path type, permission/enrollment states, test-case IDs and pass/fail/blocked reasons.
- Budget revision, expected/measured timing/resource aggregates, queue/drop counts and active/soak duration.
- Local readback/retention/deletion checks, uninstall outcome and independent reviewer sign-off bound to that artifact.

Never include local usernames, device identifiers, paths with personal names, URLs, page titles, text, images, secrets or real exports. Synthetic fixture payloads may live in `tests/fixtures/`; receipts still need no payload. A validated receipt format is not an attestation that the run happened. Review the native run and preserve a local evidence reference outside Git.

## Testing on the user's separate machines

Remote access is not the default prerequisite. Each platform delivery must include a small **Capture Check** launcher and exact instructions; “install this repo's entire development stack and debug it” is not an acceptable test handoff. These launchers are requirements, not existing tools at bootstrap.

- Give Mac and Windows separate versioned artifacts, SHA-256 checksums, source revision, minimum OS/architecture and short launch/stop/remove steps. Prefer runnable native packages with dependencies included; if the first development build needs a compiler, label it clearly and provide one build command with prerequisite detection. Never present a source ZIP as a tested executable.
- Start idle. Explain permission prompts before requesting them. One explicit Start test action opens only invented fixture windows/pages; no startup registration, personal-session recording or automatic upload. Stop/close must terminate capture/workers and remove transient fixture resources. No permanent security-setting/Gatekeeper/execution-policy bypass.
- The local result view shows what was captured and what failed: prerequisite, permission, fixture launch, foreground/tab observation, frame delivery, text/OCR, association, readback and cleanup are separate stages. Display an error code and one next action, not a generic failure or a raw exception with private paths.
- Offer a previewable **content-free feedback file** with build/artifact/fixture IDs, OS/architecture, stage pass/fail/blocked, sanitized error codes, event/frame/drop counts and measured timing. Exclude usernames, device IDs, local paths, URLs/titles/text/images, environment dumps and raw crash reports. Export is manual to a user-chosen location; no collector upload endpoint. Include launcher failures in the same feedback path where feasible.
- Ask the tester for: feedback file, which step failed/what they expected, and optional locally reviewed synthetic screenshot/clip. The build ID must be visible so screenshots can be matched. Native personal evidence stays local; do not ask for their database, entire logs or remote credentials.
- Reproduce using the reported build and fixture version, turn a confirmed behavioral bug into a focused failing regression, fix it, and return a new artifact ID with the specific step to rerun. Retain old feedback links in the issue so an update cannot erase the prior failure. Rerun the affected scenario first, not the full manual matrix on every troubleshooting iteration.

## Draft contract conformance

For `contracts/draft/`, its canonical fixtures or development reference checker, also run `make contract-check` with the task-local Python described in the [draft contract guide](../contracts/draft/README.md). JSON Schema validates shape; fake-clock replay separately compares exact expected visits, gaps and rejections. `--case rapid-return-late-result --json` provides inspectable invented readback. This optional development tooling does not change the Capture Check runtime, select a product runtime or establish native/installed acceptance. No native media is manufactured for schema-only work.

## Capture Check developer verification

Install pinned development dependencies with `npm ci --ignore-scripts`, then run `make check` (Python 3.11+, Node 22+). It performs strict typechecking, a clean TypeScript/browser build, Python package checks and Node suites against compiled runtime/host entry points. No compiler dependencies are shipped to test machines. The Windows helper can be cross-compiled against .NET Framework 4.8 using a build-time .NET SDK; compilation is useful evidence, not Windows execution. Build packages from a clean commit with `python3 tools/package_capture_check.py --dotnet /path/to/dotnet`; the official Node runtime archives are checksum-pinned in `contracts/node-runtime.lock.json` and their licence is included.

The Windows continuity regression links the production `ObservationContinuity.cs` into a dependency-free .NET 8 console check. It runs on Linux or Windows with deterministic clock inputs covering observer stalls, delayed callbacks, retry, clock rollover and the watchdog boundary. It does **not execute Windows UI Automation**. Keep generated outputs in an ignored directory:

```sh
dotnet build tests/capture-check/windows-continuity/ContinuityTests.csproj --artifacts-path "$PWD/.local/windows-continuity/artifacts" --output .local/windows-continuity/tests
dotnet .local/windows-continuity/tests/ContinuityTests.dll
```

One optional Playwright inspector journey covers start/readback/return visits, inert captured text, pause, feedback download, clear, coverage-gap explanation/retry and quit at desktop/390px widths. It injects explicitly invented provider events into the same local controller on every OS; its screenshots/video must be labelled **UI replay, not native capture**. Set `SPINDLE_CAPTURE_REVIEW_OUTPUT` to a new `.local/` run directory to preserve earlier evidence. Run `npm run build` first. It is not part of the fast checks. To reproduce without touching shared browser caches:

```sh
PLAYWRIGHT_BROWSERS_PATH="$PWD/.local/browsers" PLAYWRIGHT_SKIP_BROWSER_GC=1 node_modules/.bin/playwright-core install chromium
PLAYWRIGHT_BROWSERS_PATH="$PWD/.local/browsers" node build/tests/capture-check/inspector.e2e.js
```

For the saved-media review viewer, `tools/review_page.ts` (run as `node build/tools/review_page.js` after building) renders approved recording/screenshot/download links into one page. Keep its input, signed links and output under `.local/`, never in Git. The operator check `tests/capture-check/review-page.e2e.ts` (run as `node build/tests/capture-check/review-page.e2e.js`) opens an explicitly provided private viewer and verifies real inline playback, screenshot selection, phone layout and closed technical details; it does not run or connect to the capture app. Use `SPINDLE_REVIEW_SHARE` for a private JSON file containing the viewer URL. The default driver is pinned development-only `playwright-core`; `SPINDLE_PLAYWRIGHT_PATH` may explicitly select a compatible operator-owned Playwright module. It must not run with privileged upload credentials on untrusted PR code.

Output stays under `.local/capture-check-review/` until locally inspected; never confuse it with target-host evidence or commit media to Git. Keep the capture PR draft/awaiting native evidence until the user returns real Mac/Windows results and reviewed native visuals. Do not close platform acceptance issues based on these packages or replay tests.

## Minimal account-linked tracker acceptance

[PRODUCT.md](PRODUCT.md#accepted-account-linked-tracking-milestone) owns scope; #14/#66/#67 own delivery. Verify four independently reviewable results: account/shared history, installed Mac capture, installed Windows capture and labelled session review. No extra platform, full-local/E2EE system, graph or connected-agent demo is required for this acceptance.

Use invented data to record an extended editor → browser → document session with Rich selected after explicit recording/pixel/retention consent. Verify automatic screenshots and fresh native/DOM/OCR/title/URL context against their source visits, not a manual screenshot-button replay. Inspect disclosed gaps/unsupported surfaces, Pause and actual installed restart/permission/key/enrollment behaviour; no routine copied keys or re-pairing. Basic must still work without retaining screenshots. Reuse the applicable #12/#13 exact-artifact/native privacy/resource checks rather than duplicate them in another checklist.

Then use both actual supported hosts with the same account: a device handoff, an overlapping interval, offline/reconnect/restart, one label correction and authenticated deletion. Both clients must show the same retained history/correction, overlap must not double elapsed person-time, and reconnect must not revive deletion. Test a different account's denied access and record actual transport/storage protections and sync state. A cloud sign-in or successful HTTP mock alone cannot establish this two-host result. Do not upload personal sessions to the development VM or use unapproved hosting for acceptance.

Assess meaningful labels and uncertainty separately from measured time. Exercise different meanings on one domain, quiet reading, changed content and late model results after a correction. Use the existing #23/#24 machinery; automatic processing requires the selected local/remote scope and bounded scheduling, not manual per-card model clicks or paid per-frame inference. A valid schema or three live invented-input classifications is not general interpretation accuracy.

## Release decision

Each validation issue records one row per mode with evidence level, exact revision/artifact, reviewer, native screenshot/recording links, unresolved failures and supported scope. PR visual evidence is required during capture implementation; the validation issue adds the full installed acceptance run rather than acting as the first demo. No separate status spreadsheet or dated acceptance MD. Rebuild after a capture/packaging change and rerun affected native cases; if the artifact changes, old acceptance is historical. Do not call the desktop milestone complete until Windows Default, Windows Rich, macOS Default and macOS Rich all have accepted installed receipts.
