# Try Capture Check

**What to check:** when you switch between two windows, does each recorded visit show the right text?

The test opens windows **A** and **B** with sample text that changes over time. It reads those windows and shows the results on a local review page. It does not read your other apps yet. You do not need to give us remote access or a Spindle account.

| Action | Expected result |
| --- | --- |
| Start the 10-second test | A and B open and take turns in front. No unrelated app appears in the visit list. |
| Open an A or B visit | The title and captured text belong to that window. Returning to A creates another visit. |
| Inspect earlier/latest text | The update counter changes even while the same window stays active. |
| Pause | No new visits or captured text appear; existing results remain available to inspect. |
| Save feedback | You can preview the file before saving. It contains counts/error codes, not the captured text. |
| Clear | The visit list becomes empty and both sample windows close. |
| Quit | Recording stops and the local runner exits. You can close its browser tab. |

Save feedback before a new run or Clear: both replace the current results. Captured text stays in memory, not a history file. Clear/Quit removes it from the runner; close the tab too. Nothing starts automatically at login. These are development builds, so Mac/Windows execution and setup still need your review.

## Mac

1. From the private review page linked in the release, download the Mac ZIP matching your processor: **arm64** for Apple Silicon; **x64** for Intel. Verify its SHA-256 against the release's `SHA256SUMS.txt`, then unzip it.
2. Open **Start Capture Check.command**. If Finder refuses an unsigned downloaded script, inspect it and run `bash "Start Capture Check.command"` from Terminal in the extracted folder. Do not disable Gatekeeper or remove quarantine recursively.
3. The ZIP includes Node. This first Mac runner still needs **Apple Command Line Tools** to compile its small Swift reader locally. If missing, the inspector explains this; install them yourself with `xcode-select --install` if you want to proceed, then reopen the launcher. Full Xcode/Rust/Python/npm are not required.
4. In the local inspector, click **Allow Accessibility on Mac**. Enable the application/terminal macOS identifies in **System Settings → Privacy & Security → Accessibility**. Return to the inspector; it checks again. No Screen Recording permission is requested.
5. Follow the short test below. If a source update changes the local ad-hoc signature, macOS may require removing/re-enabling that Accessibility entry. Record this as a failure/limitation; production upgrade handling is not claimed.

## Windows

1. From the private review page linked in the release, download the Windows ZIP for **x64** (ordinary Intel/AMD PCs), or **arm64** for Windows on ARM. Target: Windows 10/11 desktop with .NET Framework 4.8 (4.8.1 on ARM). Verify the release checksum, then **Extract All**; do not run from inside the ZIP.
2. Open **Start Capture Check.cmd**. The browser inspector opens. The ZIP includes both Node and the compiled native .NET reader; wait for its ready state. It is an unsigned development executable, not a production release. If organizational policy blocks it, send feedback rather than weakening that policy.
3. No Python, Node installation, Visual Studio, Rust, SDK, admin rights or PowerShell execution-policy change is needed for the ZIP. The reader uses the Windows-provided .NET Framework runtime; no registry or startup entries are changed.
4. Follow the short test below. Screen Recording permission is not used: this first reader uses WinEvent focus events and UI Automation text.

## The two-minute test

1. Click **Run 10-second test**. This is the explicit recording action. Two native windows named **Spindle Test A** and **Spindle Test B** open. They contain only invented learning/leisure examples.
2. Let the test switch A → B → A → B. Avoid clicking elsewhere until it ends. Return to the inspector after about 11 seconds.
3. Select the visits. Check that returning to A created a **new visit**; A's text never appears under B. Initial fixture activation may add a setup visit—this smoke test does not assert an exact four-row installed acceptance result.
4. Open **Earlier/Latest** text snapshots. The `Content update` number should change while a window stays active. Text is obtained through native Accessibility/UI Automation, not from the fixture's activation messages.
5. Save a feedback file now if the normal test worked or failed; **starting another test replaces its results**. Then click **Try fast switches (250 ms)**. Some short visits may have unavailable text; report how it behaved. A missing result is not filled with another visit's text. This rate is a stress probe, **not a validated minimum dwell-time guarantee**.
6. Optionally use **Start manual test** and switch the two windows yourself. Click **Pause**; the visit/content-update counts should stop increasing. **Preview/save feedback before clearing**. Then **Clear & close test windows** should remove the visits and close both fixture windows.

If either native reader stops observing for over one second, it stops recording and reports `MAC_COVERAGE_GAP` or `WINDOWS_COVERAGE_GAP`. Windows also checks in-run event age. A detected gap is reported instead of silently counting the unobserved interval as continuous activity. Results before the reported cutoff stay available; visits/snapshots at or after it are removed, even if the run already paused. Switches/text may be missing: save feedback, then start a fresh test. Update/rejection counters remain cumulative diagnostic events, not counts of retained snapshots; the readable-visit count reflects the remaining readback. This is a conservative preview safety watchdog, not recovery of missed events or a validated minimum visit/timing guarantee. Windows notifications from before a fresh recording are ignored for its event-age check. Mac Accessibility notifications do not provide source timestamps; its watchdog detects stalled observation, not every delayed notification while polling continues.

The counts help us find missed visits and unreadable text; they do not tell us whether you were concentrating. In the fast test, a short visit may have no text yet. It must not show text borrowed from a different visit. Please report that as a failure if it happens.

## Send useful feedback

Click **Preview feedback file**, inspect it, then **Save feedback JSON**. Send:

- that JSON file;
- which step failed and what you expected;
- preferably a screenshot or 30–90 second recording of the **invented test windows and inspector**.

For a PR, put reviewed images/recordings in the approved private review viewer rather than GitHub release attachments. You can provide media privately to the reviewer; the capture check itself never uploads it.

The JSON contains build/source IDs, supported capability flags, compiler error locations/codes if available, stage codes, aggregate counts and durations. It excludes app/window IDs, names/titles/text, file paths, tokens, environment dumps and images. No automatic upload occurs. Do not send the local URL (it includes a session token), raw compiler/system logs, personal desktop recordings or a database. Inspect visuals locally for notifications, usernames and unrelated windows before sharing; recapture if necessary.

If no browser opens, keep the launcher open and paste its local URL into your own browser; do not send that URL. If OS policy blocks the runner before the inspector can start, send the build ID from `READ ME FIRST.txt`, your OS/processor and the blocked step instead of raw logs. Do not weaken OS/security policy.

If permissions or the native build fail after the runner starts, the inspector should still offer feedback. `MAC_TOOLS_REQUIRED`, `MAC_BUILD_FAILED`, `WINDOWS_HELPER_MISSING`, `FIXTURE_FAILED` and `HELPER_EXITED` identify different stages. After a fix, use the new build ID and rerun just the failing step first.

## Stop and remove

Click **Quit & clear everything**, close the inspector tab and launcher window, then delete the extracted folder. The runner asks both native processes to exit and has a bounded kill fallback. Closing/killing the runner closes its stdin pipes, so native readers/fixtures also exit. No capture data is written to disk; build outputs and a local compiler log may exist under `.local/capture-check/` inside the extracted folder. Remove any Accessibility grant you added in System Settings. Browser history/downloads and external recordings are outside the runner's deletion boundary.

## From a developer checkout

Clone with `git clone https://github.com/erniesg/spindle.git`, then `cd spindle`. The capture check is included in `main`. For a specific tested package and its native evidence, use the current [PR #15 handoff](https://github.com/erniesg/spindle/pull/15); ZIPs include their runtime and exact build identity.

A source checkout needs Node 22+; run `npm ci --ignore-scripts` and `npm run build` to typecheck and compile the shared runtime/browser assets. Generated JavaScript lives under ignored `build/`; Node's type stripping is not the build. On Mac it also needs Apple Command Line Tools; launch with `bash platforms/macos/start-capture-check.command`. Windows developers need a .NET SDK (8.0 was used for the preview): run `dotnet build platforms/windows/CaptureCheck.csproj -c Release --output .local/native-windows`, then `.\platforms\windows\start-capture-check.cmd`. The review ZIP already includes this reader; no PowerShell script or execution-policy bypass is used.

For source-run findings, include `git rev-parse HEAD` with the feedback file. Core tests after building: `node --test build/tests/capture-check/*.test.js`; all fast checks: `make check` (also requires Python 3.11+).

Full Default/Rich installed acceptance remains separate from this fixture-only probe. Native evidence is bound to the exact package and environment recorded in its PR; Linux automated/UI tests and Windows cross-compilation do not establish Mac or Windows runtime behavior.
