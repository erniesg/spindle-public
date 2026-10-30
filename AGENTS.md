# Working on Spindle

Read README.md, CONTRIBUTING.md and INFRASTRUCTURE-HANDOFF.md, then linked product/architecture/testing documents for the changed area and current issue decisions. Use shared `reviewable-delivery`, `outcome-supervision` and `karpathy-guidelines` skills when available; CONTRIBUTING.md owns repository exceptions and delegated merge authority without requiring their installation. Do not duplicate the shared procedure in project docs.

- The product target is ordinary Windows/Mac activity **including editing**, not a fixture-only/read-only product. Cheap reversible implementation assumptions may proceed and be surfaced in the PR; they cannot silently narrow explicit outcomes. Reconsider assumptions that block downstream work before patching around them.
- Keep one reviewable outcome; use critical red/green checks at the cheapest effective layer. Native/installed claims require actual affected paths and independent reviewed evidence. Missing hardware holds that acceptance, not independent source/build work. Label fixture, simulation, build-only and self-inspection honestly.
- Development evidence uses approved invented activity only. No implicit recording/enrollment, personal activity uploads or startup registration. Shared time/privacy/storage semantics must not fork by platform. Explicit native window-pixel consent and structured-text/browser restrictions remain distinct.
- Legacy is read-only reference. No adoption of personal data, secrets, automation or hosting. Existing reviewed sample-data artifact storage and private inline-primary permission are scoped in INFRASTRUCTURE-HANDOFF.md. Do not expand publication/access, enable Actions/runners, spend/provision/deploy, rewrite history or bypass protection without applicable authority.
- Keep binaries out of source and GitHub release assets. Preserve referenced evidence and never commit credentials/signed URLs. Clean only run-owned resources.

## Capture-specific safeguards

Read docs/PRODUCT.md, docs/ARCHITECTURE.md and docs/TESTING.md before capture work. Run `make check` or its documented equivalent; checks do not establish native capture/installed acceptance. Draft contract changes additionally use task-local `make contract-check` in contracts/draft/README.md; no development checker in runtime packages. Pin/review selected legacy imports and port approved behavior/tests only.

Capture/readback changes need inspected sample-only screenshots and a short recording of the actual affected native/browser path; primary recording inline where approved/supported, supporting records behind private links. Label replay separately. Shared-only changes explain why native visuals do not apply. Preserve source/build and viewer identities separately and follow docs/TESTING.md's exact-artifact gates.
