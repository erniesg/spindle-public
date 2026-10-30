# From a scoped issue to a reviewed change

Use shared `reviewable-delivery` for scoping, delegation, writing, verification, evidence and closeout, and `outcome-supervision` for assumption checks and progress-based review/repair supervision. This document owns Spindle's exceptions/authority; skills are procedures, not product requirements or permission grants. They are optional dependencies: the local rules below remain authoritative without installation. Small changes should stay small.

## Context and product intent

Docs own durable product/architecture/testing contracts; issues own outcome, criteria, direct dependencies and decisions; PRs own actual implementation coverage, impact and observed evidence. Comments carry a new result/blocker/decision, not another tracker. Read current decisions and actual diff; never weaken criteria to fit code. Templates guide, rather than replace, judgment.

The product target includes ordinary native activity and editing. Fixture-only/read-only/layout restrictions in a candidate are implementation limits, not inherited requirements. Choose cheap reversible implementation details within scope, surface consequential assumptions in the PR and challenge a premise when it excludes intended use or stalls downstream development. Real consent/privacy requirements remain binding; local preparation does not authorise disclosure.

Keep one independently reviewable outcome and one owner per shared contract. Missing hardware blocks the target's native proof, not unrelated implementation, cross-builds or candidate preparation. A fixture proves machinery, not ordinary-app acceptance. Continue useful independent authorised work rather than repeatedly asking about a settled requirement or building speculative substitutes.

[PR #15](https://github.com/erniesg/spindle/pull/15) owns historical fixture Capture Check native results; its merge does not establish full Default/Rich installed acceptance. [PRODUCT.md](docs/PRODUCT.md), [ARCHITECTURE.md](docs/ARCHITECTURE.md) and [TESTING.md](docs/TESTING.md) own current contracts. No parallel status/acceptance files.

## Verification and evidence exceptions

- Name important invariants, user/data path and recovery before nontrivial work. Use focused observed red/green regressions, affected shared/integration checks and actual boundary proof. No test-count quota, duplicated platform policy suites or default multi-model fleet.
- Prose-only changes need link/consistency checks, not app/browser reruns. Changed executable instructions or safety claims need relevant checks. Shared/packaging changes rerun affected consumers/artifacts, not every old matrix.
- Native/installed claims require real affected OS/browser paths and exact-artifact evidence under [TESTING.md](docs/TESTING.md); cross-builds/replays are not acceptance. Shared-only work explains why native visuals do not apply.
- Capture/readback changes need sample-only screenshots and recording of the actual changed journey/control/failure state. Primary recording inline in the private PR where supported/approved; link supporting screenshots, packages and records in the private viewer/store. The [infrastructure handoff](INFRASTRUCTURE-HANDOFF.md) owns destination permissions.
- Inspect complete artifacts locally. No personal activity, unrelated windows, secrets or consent/credential entry in uploaded evidence. No automatic collector upload. Keep media/packages out of Git and GitHub release assets; preserve referenced evidence, byte-verify copies, refresh expiring links and separate captured app from viewer identity.
- A fresh reviewer opens required media; self-inspection/DOM checks do not constitute independent approval. Refresh affected evidence after source/behavior/artifact changes, not wording-only edits.

## Review and standing merge delegation

Owner decision, 25 October 2026: agents may investigate, implement, obtain **fresh independent agent review**, repair and merge scoped implementation/policy changes in private `erniesg/spindle` into `main`, without another per-PR human permission request, when current required checks, acceptance evidence and dependencies pass, blockers are resolved, and rollback is understood. This supersedes the earlier no-autonomous-merge rule; it does not claim the product itself has an auto-merge platform.

The exact current head/base must match the technical review and affected evidence. Implementers cannot self-approve. Governance changes receive independent review and relevant validation on the integrated policy revision before activation. Provider-enforced approvals/branch protection remain mandatory; never bypass a failing check. A child review does not prove an integrated parent. Required sensitive external effects still need their own authority.

Owner-requested correction, 26 October 2026: default review/reset counts are not permission boundaries. Continue useful authorised repairs and independent review; never approve merely to finish a round. After repeated non-advancing repairs, diagnose the cause and independently assess a concrete changed approach before repeating implementation. A failed strategy does not permanently exhaust permission to solve the blocker. Preserve findings, attempts and scoped histories through restart/agent/branch/PR changes. Explicit owner finite/bounded allowances, pauses and resource limits remain binding unless the owner changes them.

Re-review changed code and affected contracts, reusing evidence only where its exact source/dependency applicability is established. Unchanged bytes, prose-only updates or administrative status do not by themselves require another whole-patch technical review. Fresh merge/outcome checks remain required. A stale controller that cannot represent settled owner authority or an already-authorised stacked target is a tooling defect: hold only the dependent action, report it once and continue useful independent work. Do not bypass the controller or provider protection, rewrite live state or create another adapter fork.

Draft means still implementing, required acceptance/evidence missing, or a specific early design question. Ready has scoped self-checks/evidence and may await independent review. Merge requires all applicable gates and delegation; merged is not released. Foundational work may land after its own acceptance with downstream native gaps explicit; do not call it installed capture.

### Exclusions and operational bounds

No new spending/provisioning, expanded credential/publication access, destructive personal-data operations, Actions/runners activation, protection bypass, production deployment or destructive history rewrite is delegated here. Legacy data/secrets/automation/hosting remain excluded. Existing artifact approval is not general infrastructure authority. Release/deployment is separate from merge.

The workflow uses meaningful progress/review checkpoints and any explicit owner time/cost limit; no new numeric spending grant is implied. Preserve real budgets/pauses across continuation. A coordinator timeout requires effects reconciliation, not silent abandonment or replay. Keep work recoverable and report working / blocked / next action / retained resources at a scoped stop.

Coordinators retain delegated resource ownership through closeout, verify actual results, and never promise invisible monitoring after returning. At merge/abandonment reconcile same-task worktrees/helper branches, owned processes and temp artifacts; preserve dirty/dependent/unrelated work and referenced evidence. Retained resources need purpose, next owner and revisit trigger in the existing handoff. Shared/billable infrastructure cleanup still needs its authority.

## Human-facing format

Follow the repository PR template and shared writing procedure: issue `[Area] Observable outcome`; PR What was done, Review guide, Testing and real risks. Link criteria rather than copying a specification. Use `Refs` for partial scope; checked items are observed results. Keep one short current summary, with commands/hashes/traces collapsed. Never copy owner messages (including short quotations or conversation transcripts) into issue/PR comments. Incorporate resulting requirements into the owning body in plain language; use comments sparingly and preserve genuine owner-authored comments. Never hide blockers, approval requests or proof limits in details. Read back published Markdown and edit only owned/authorised content.
