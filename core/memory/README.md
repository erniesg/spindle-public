# Durable context tools

The following describes the unchanged task/source memory API. The separate authenticated
[automatic shared user-memory application](../../docs/USER_MEMORY.md) owns conversation/activity
learning, user UUID namespaces, pending sync and tombstones; it does not adopt these records.

Create one `EvidenceStore` in an application-owned state directory and register
`contextTools(store, roots, selections)` with `AgentRuntime`. Roots map opaque
root IDs to user-selected directories; selections map opaque selection IDs to
trusted `{rootId, path, mimeType}` records. Do not construct these maps from model
arguments. `files.read` accepts only a selection ID, not a path or namespace.

The runtime task's account/workspace supplies the namespace. Pass trusted scope
grants matching exact capability names (`memory.search`, `memory.read`,
`memory.record`, `files.read`, `files.write`); file reads additionally require
`files.root:<rootId>`. Memory provenance and output derivation IDs must appear in
trusted scope sources and resolve in the same namespace. Refresh trusted scope
with inspected source refs between runs when appropriate; model output alone
must not grant authority. No external writes are exposed.

`files.write` creates a new evidence artifact, never replaces a source file.
Read results retain source identity, hash, immutable artifact and evidence in the
runtime observation. Model memory records always have `userCorrected:false`.
The trusted user correction UI may call `MemoryStore.record` directly with
`userCorrected:true`; later inferred facts cannot override those corrections.

`memory.search({query})` recalls effective records using literal lexical substrings,
not an entire-query phrase. It splits letters/numbers into at most 16 tokens
(up to 64 characters each, query up to 512 characters), matches any token and
ranks by distinct tokens matched, then binary key order. SQLite's built-in
`lower` provides ASCII case folding only; non-ASCII matching is literal (no
stemming, semantic recall or Unicode case-folding claim). Results are capped at
20, with user corrections selected before matching so superseded inferred values
do not resurface. Empty/punctuation-only queries return no results.

`MemoryStore.list(ns, afterKey?)` returns up to 50 effective records in binary
key order. `history(ns, key, beforeVersion?)` returns the latest 100 revisions
before the exclusive version cursor, oldest first; use the first version to
page backwards. `read` always selects the latest user correction, otherwise the
latest inferred version, independently of history pagination. The optional
[local preparation panel](../../docs/TASK_REVIEW.md#saved-user-context-alpha)
provides explicit user entry/correction. Saved context never grants tool scopes,
AI consent, preparation or submission authority.

Close stores before reopening or invoking orphan recovery with exclusive store
ownership. Artifact bytes are flushed before transactional metadata publication;
a failed metadata insert leaves an orphan, not a published half-pair. Recovery
is bounded and explicit. POSIX directory fsync errors propagate; Windows skips
unsupported directory fsync, so directory-entry power-loss durability is not
guaranteed there. Windows behavior has not been tested. Source/metadata limits
are bounded; this is not a full hostile-filesystem sandbox or encrypted store.

Focused checks: `npm run build && node --test build/tests/evidence/*.test.js`.
These checks use invented disk files and a scripted provider, not a live model,
Google account, or the full connected journey.
