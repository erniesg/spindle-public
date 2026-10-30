# Spindle product brief

**Status:** rebuild product direction, informed by legacy review; not a claim of shipped functionality. The account-linked tracker and connected-agent milestones below are owner-approved scope; other proposals remain labelled as such. This is the single product reference for the fresh repository. Implementation issues own slice outcomes and acceptance, not competing product specifications.

## Purpose

**Help people close the gap between where their time goes and where they want it to go.**

Tracking is the instrument, classification makes the record meaningful, and recommendations and optional commitments help someone change something. Spindle is not an app-usage dashboard, productivity score, screenshot archive or blocker with tracking attached.

The core loop is **notice → understand → choose → act → review whether it helped**. Its proposed differentiation is a personal, correctable account across tools and devices, with little manual logging. More captured fields are valuable only when they improve that loop enough to justify their privacy and resource cost.

Initial audience hypothesis: people whose learning or knowledge work is fragmented across browsers, native tools and devices. Start by validating the owner's real use; the broader segment is not yet proven.

## Lessons from legacy

Reviewed legacy main `35b59534b6e6a9c7f33aa4796bf43afabfdd2e54`: product/status documents, selected source, and an archived synthetic UI screenshot. No runtime or current native behavior was verified. Open integration PR #190 was inventoried, not reviewed in full. The following links refer to the preserved repository.

| Finding | Rebuild decision |
| --- | --- |
| The [original plan](https://github.com/erniesg/spindle-legacy/blob/35b59534b6e6a9c7f33aa4796bf43afabfdd2e54/docs/archive/2026-09-02-original-spindle-plan.md) envisioned a time ledger **and workflow synthesizer**. | Reclaiming time includes eliminating repetitive work, not just restricting leisure. Do not revive its superseded private-store, retention or cloud assumptions. |
| [Actual UX feedback](https://github.com/erniesg/spindle-legacy/blob/35b59534b6e6a9c7f33aa4796bf43afabfdd2e54/docs/design/2026-10-16-activity-review-ux.md) rejected five-second app rows, device IDs, empty cards and correction bookkeeping. | Preserve grouped review, inline correction and progressive disclosure. A cleaner telemetry table is still not the whole product. |
| [Taxonomy research](https://github.com/erniesg/spindle-legacy/blob/35b59534b6e6a9c7f33aa4796bf43afabfdd2e54/docs/design/2026-10-20-attention-taxonomy-research.md) separates Activity, Category, Related things and Target. | Preserve these distinctions without forcing users to construct an ontology. No additional Intent/Purpose/Focus entity. |
| `spindle/goals.py` has flexible target declarations alongside an older daily-category goal store. | Reuse validation ideas selectively; declarations are not an integrated target-to-actual experience. Build one coherent goal system. |
| `spindle/local_semantic.py` has deterministic cues and optional embeddings; the [video design](https://github.com/erniesg/spindle-legacy/blob/35b59534b6e6a9c7f33aa4796bf43afabfdd2e54/docs/issues/023-video-staged-classification.md) distinguishes content, playback and person-time. | Evaluate meaningful-session classification and correction effort. A lecture title or playing video does not prove study. |
| `spindle/recommend.py` mostly compares daily category time with targets and turns deficits into generic rebalancing suggestions. | Treat it as a prototype: a missing study hour is not evidence of where an hour can be recovered. |
| Legacy has ledger/correction code and historical installed-Mac evidence, but incomplete platform acceptance. | Port small reviewed units with tests, not the architecture wholesale. Source and fixtures do not prove a current four-platform product. |

The legacy [product authority](https://github.com/erniesg/spindle-legacy/blob/35b59534b6e6a9c7f33aa4796bf43afabfdd2e54/PRODUCT.md) and [implementation status](https://github.com/erniesg/spindle-legacy/blob/35b59534b6e6a9c7f33aa4796bf43afabfdd2e54/docs/implementation-status.md) distinguish proposals from installed evidence. They remain historical references, not parallel authorities for the rebuild.

## Product model

The proposed primary review unit is an **activity episode**: a useful account of what someone was doing, backed by inspectable sessions. Working through a course exercise may span a tutorial, editor and documentation. Joining adjacent identical app samples alone cannot represent this.

Episode grouping is a design hypothesis, not an implemented legacy feature. Begin conservatively, preserve underlying intervals, and allow correction/split/merge. Never invent continuity across gaps or duplicate simultaneous device time.

Keep four questions separate:

1. **What did we observe?** Time, sources, context and missing coverage.
2. **What does it appear to mean?** Correctable activity/category and optional topic, course or project.
3. **Does it count toward something I chose?** Explicit target and qualifying policy.
4. **What help have I authorized?** Advice, a restriction, an allowance or a consequence.

A model must not answer all four with one verdict. Tentative classifications can support review; granting access or settling money requires stronger evidence and separate authorization. Rest and leisure are not inherently failures. Alignment is relative to the person's choices, not a universal productive/unproductive label.

## First usable experience

**Connect:** for the immediate account-linked tracker, sign into one account on Mac and Windows, explain actual coverage and explicitly enable recording. Present Rich as the default selection, requiring pixel and retention consent; Basic remains available without retained screenshots. Provision protected secrets automatically, not through manual Keychain editing or copied keys. No mandatory taxonomy, target or commitment setup. Fully local/account-free product delivery is deferred for this milestone, not a prerequisite for linked tracking.

**Today:** lead with the chosen priority and observed progress, then a compact account of episodes. Someone without a target still gets a useful account of their time. Surface ambiguities that materially affect their priority rather than demanding a label for every minute. Evidence and device diagnostics stay in drilldown.

**Correct:** edit an episode inline, choose “this episode” or an explicitly previewed future matching rule, and undo. App/domain identity is evidence, not the activity itself or the person's wishes.

**Review:** compare the week with chosen allocations, explain changes and uncertainty, and inspect supporting sessions. Overlapping target matches are not additive day totals.

**Make a change:** suggest one specific, evidenced experiment; show the pattern behind it and revisit the result. Recommendations may identify context switching or repetitive admin, not only excessive entertainment. No guaranteed savings or execution without the relevant authorization.

**Commit, optionally:** preview what counts, restrictions, exceptions, expiry and recovery. Locks, study-earned access and financial stakes support a chosen change; they are not default onboarding.

## Accepted account-linked tracking milestone

Owner decision, 25 October 2026: prioritise the smallest usable Mac/Windows time tracker. Record an extended working session in Rich by default after explicit consent, then inspect a durable, labelled account of what happened across both computers. Link devices to one account; fully local sync, elaborate device pairing/E2EE recovery, goals and graphs can wait. This is requested scope, not shipped functionality.

Basic means supported app/window/tab identity, title, useful sanitised URL/resource identity, permitted native/DOM text and local OCR where needed. Rich adds retained screenshots to the same visits. Capture refreshes while working in one window as well as on switches. Automatic screenshots and ordinary working-app/page coverage are the target; current manual-only/read-only browser restrictions are preview limits, not milestone completion. Verify the supported platform route and report real gaps; never guess document identity or silently fall back to whole-monitor/private-browser capture.

Deliver four reviewable implementation PRs:

| PR outcome | Existing/new issue ownership | Verifiable result |
| --- | --- | --- |
| One account and durable shared history | [#66](https://github.com/erniesg/spindle/issues/66), consuming #2/#3/#7/#23 | Two authenticated clients read the same device-associated history after restart/reconnect; duplicate delivery, deletion and another-account denial work. |
| Everyday Mac Rich capture | #4/#6/#9/#11/#13 under [#14](https://github.com/erniesg/spindle/issues/14) | Installed editor → browser → document session supplies correct timing/context and automatic matching screenshots, with persistent setup and Pause. |
| Everyday Windows Rich capture | #4/#5/#8/#10/#12 under #14 | The same installed session works on Windows and is readable through the same account. |
| Labelled extended-session review | [#67](https://github.com/erniesg/spindle/issues/67), consuming #23/#24 | A Mac→Windows session has readable labels/durations/evidence, visible gaps and no doubled overlap time; a simple label correction survives restart and appears on the other client. |

Reuse the existing classifier and correction machinery. Automatic labelling operates under an explicit processing scope; remote AI remains separately authorised and bounded, not a paid per-frame loop. Weak evidence stays uncertain/unclassified. Include inexpensive change-label/persistence, not a new taxonomy/rules/graph system. Native foreground use is not proof of attention; preserve original device observations and explain ambiguous attribution.

Account sign-in never starts recording or grants upload/model access by itself. Shared-history transport requires authenticated account isolation, TLS outside loopback, protected secrets, appropriate encryption/access controls at rest, explicit retention/deletion and offline/retry recovery. Say who can decrypt server-held content; do not claim end-to-end encryption. A simpler account-backed implementation is allowed; insecure storage and personal activity on development infrastructure are not. Actual hosting/deployment or personal-data transfer still needs its applicable authority. Local collectors remain usable offline, without models, and must not lose unsynchronised work.

Work can proceed alongside the connected-agent milestone using separate worktrees and nonoverlapping ownership. One owner controls shared history/types; the review UI can begin against that contract while native capture proceeds. Full two-host acceptance needs the actual Mac and Windows paths, not only a synthetic account/UI test. No changes to the ongoing connected-agent PR target or review histories are implied.

## Accepted connected-agent milestone

Reclaiming time also means reducing repetitive administration. The owner-approved connected-agent milestone applies the **choose → act → review** loop to preparing an application from an incoming request. It is an optional connected experience, not a replacement for the private activity record or a general workflow platform.

A real Gmail message can start or resume one durable task without a fresh task prompt. Using saved, correctable context and selected Drive sources, the agent maintains a visible checklist and repeatedly chooses reusable tools, observes their actual results and revises its plan. It reads the current destination requirements, extracts source-grounded values with model-backed OCR, prepares required documents and a compliant photo, and preserves originals and source versions. Changed requirements or inputs must change its work without a canned scenario pipeline.

The user reviews editable fields, attachments, missing items and field-adjacent citations that open the exact source snapshot/region. Corrections propagate into a coherent new application revision. One explicit **Submit** instruction authorizes the displayed destination, revision and attachments; the agent then fills/uploads/submits and verifies a persisted receipt, reconciling uncertain outcomes before retrying. A click or success toast is not completion.

- **Separate permissions:** capture consent does not authorize Google access or remote AI. The connected journey uses the selected Google account/roots and an inspectable standing preparation/AI scope; broader provider grants do not expand the selected source scope. Preparation does not authorize destination uploads or submission. No redundant generic approval is required for each upload/click within a valid submission instruction.
- **Durability and trust:** persist task/checklist, provenance, revisions, budgets and cancellation/recovery state. Duplicate mail or restart must not replay committed effects. Email, page/document content and model output cannot create grants, destinations or tool authority. A missing source, permission or tool blocks dependent work, not independent authorized preparation.
- **Proof and demonstration scope:** [the end-to-end issue #51](https://github.com/erniesg/spindle/issues/51) owns V3-01–V3-16 acceptance: actual Google calls, an actual NVIDIA/Nebius model/tool round trip, model OCR, adaptable preparation and browser submission to a real fictional portal. Mocks and component merges do not establish this journey. Demonstration data is invented/publishable; no outgoing email, signature, payment or real consequential third-party submission is authorized. [Release preparation #52](https://github.com/erniesg/spindle/issues/52) does not itself authorize public exposure or final submission.

This milestone can progress independently of unfinished desktop capture tracks. Capture privacy rules remain intact; neither the account-linked tracker nor this separately connected experience authorizes sending captured personal activity into the application-agent workflow. Live connected acceptance and native capture acceptance remain distinct and unproven until their respective evidence passes.

## Capture and AI

Four platform adapters, each with Default and Rich delivery tracks—not eight applications or eight top-level experiences. “Basic” means the Default profile, not a third mode. Shared semantics, privacy gates, ledger and conformance fixtures; platform-specific collectors and permission lifecycles. The client/UI stack remains undecided. The initial engineering milestone covers Windows/macOS; mobile follows separately. See [systems design](ARCHITECTURE.md) for module boundaries and [validation policy](TESTING.md) for evidence gates.

- **Default (Basic):** supported app/window/tab identity, sanitized URL, title and permitted native/DOM text, with local OCR fallback where available. Capture must follow rapid context/tab changes and refresh content while the same window remains active—not merely save a title or take an occasional snapshot. Retrieval has measured coverage/resolution limits; missing content cannot be substituted with stale results. OCR may require temporary pixels and OS screen-capture permission; it does not authorize retaining images.
- **Rich:** separately consented screenshots associated with the same visit. Must work without cloud processing. Capture, retention, inference and sync permissions are independent. For explicitly allowed, provenance-verified supported native windows, pixels/OCR/Rich include content being edited: read-only/edit-state/recognized accessibility layouts are not prerequisites ([owner correction](https://github.com/erniesg/spindle/pull/33#issuecomment-6385078156)). Window screenshots can include visible sensitive fields and chrome; they are not masked. Explicit scope/exclusions remain essential. Optional structured text extraction may skip editable/password values without blocking authorized window pixels. This does not change private/unknown browser exclusions or authorize native browser fallback.
- **Windows/macOS:** the native app records supported foreground activity without requiring an extension. The enrolled browser companion adds structured page/tab context and later precise browser controls; OS permissions alone do not reliably provide those capabilities. Prove privacy filtering, idle, sleep/wake and resource use on each actual platform.
- **iPhone:** establish supported entitlement/region/report and user-started capture paths first. Do not promise unrestricted background screenshots, live URL history or exported Screen Time events. Never scrape private stores.
- **Android:** Usage Access is package-level evidence, not URL visibility or blocking. Visual capture is a separately consented session; background/OEM limits must remain visible.

AI should reduce interpretation and review effort, match personal vocabulary and identify grounded patterns. It must abstain when evidence is weak. Prefer structured context to pixels; do not automatically escalate capture because confidence is low. Select models after representative evaluation, not as the product's organizing principle.

## Trust and consequence boundaries

- No telemetry or remote AI by default. The immediate tracker explicitly links devices/history to one account with separate recording, upload and processing scopes; fully local/account-free delivery is deferred. Visible recording state, pause/revoke, exclusions, inspect/delete, expiry and uninstall are pilot requirements.
- Filter before persistence, logs, inference and transport. Exclude private/incognito browser detail; unknown private state is not ordinary browsing. Native window capture must not bypass those exclusions. Strip URL credentials, queries and fragments; path retention needs a source policy.
- Keep personal activity, its screenshots/OCR/URLs, tokens and real exports off the development VM, GitHub, issues, CI and coding-model prompts. Use invented fixtures and content-free machine receipts. Native capture PRs also need reviewed screenshots/recordings of synthetic fixture flows, under the [visual evidence privacy rules](TESTING.md#evidence-privacy); this is not permission to upload real activity.
- Preserve stable visit identities, provenance and scoped corrections. Show gaps, stale sources and ambiguous overlaps. Combined person-time cannot sum simultaneous devices. Quiet reading and passive media are not automatically zero activity or proven attention.
- Screenshot retention stays off until encryption/key handling, bounded retention and deletion exist. Local SQLite is not automatically encrypted. Remote processing and paired encrypted sync require independent consent and implementation.
- Study eligibility is an explicit policy, not merely an AI label. Uncertain, passive or manual activity does not automatically earn measured credit. Durable, idempotent earn/spend accounting must prevent duplicate grants and multi-device double spending.
- Proposed content-aware commitment: always gate YouTube playback, allow an individually qualifying learning video, and apply the chosen leisure block/allowance otherwise. Jev may suggest a classification, but the user's policy defines eligibility; uncertainty stays gated with review/recovery. This is not a whole-domain unlock. Model inputs/quality, remote consent, pre-play enforcement and navigation/autoplay behavior require independent proof; see the [gate design](ARCHITECTURE.md#future-content-aware-gate-outside-the-capture-milestone). Controls remain voluntary and bypassable, with no claim to cover unenrolled browsers or native mobile apps.
- Financial stakes require lawful verified recipients, provider/legal review, explicit capped mandates, cancellation/reminder/grace/dispute handling and idempotent settlement/refund/reconciliation. Start preview-only. No model output, unknown coverage or unverified capture failure may trigger a charge. No payment is authorized by this brief.

## Delivery and validation

The [desktop capture tracker](https://github.com/erniesg/spindle/issues/14) owns the initial implementation sequence and status; it establishes capture evidence, not the complete experience below. Organize product milestones by user outcomes, with platform capture tracks underneath:

1. **Understand and correct one day:** prototype Today/episode correction with invented sessions, then prove a one-device installed journey. Choose the first desktop by available consented hardware.
2. **See whether a priority receives time:** integrate target matching and weekly review; validate that people understand progress and uncertainty.
3. **Stay coherent across devices:** deliver the accepted account-linked #66/#67 milestone across Mac and Windows with authenticated protected transport/storage and non-double-counting reports. Advanced pairing and fully local/E2EE sync are deferred, not prerequisites. Resolve mobile collection independently; a responsive review UI is not a mobile collector.
4. **Make and review a change:** one evidence-backed recommendation and follow-up, then an opt-in commitment. Financial commitments have a separate feasibility gate.

Preserve shared time/privacy contracts and native acceptance gates. The accepted connected-agent milestone need not wait for this capture-led sequence. Defer graph-first navigation, lifetime countdowns, learning artifacts, social analytics and broad automation generation beyond that milestone until the core loop is useful. These may become downstream features, not prerequisites.

Measure time to a useful first review, correction burden, reconciliation errors, target comprehension and whether accepted experiments are revisited. Test app rows versus episode summaries and observe actual correction behavior. These are proposed success measures, not established results. Native acceptance requires exact-revision install/uninstall, permission grant/deny/revoke, pause/resume, idle/gaps, privacy, deletion/expiry, sleep/restart and measured timing/resource behavior; mocks are not native proof.
