# Task 2 Report: Durable admission and transactional publisher slices

## Files

- `packages/backend/src/indexer/admission.js` — finite hard-limit and policy validation, stable admission errors, bounded publisher/trust/shard/time validation, and actionable ceiling checks.
- `packages/backend/src/indexer/store.js` — durable publisher-slice replacement/deltas, atomic counters/cursors/control rows, exact-reference query, local eviction/tombstones, snapshots, and lifecycle.
- `packages/backend/src/indexer/index.js` — public Task 2 exports.
- `packages/backend/src/indexer/schema.js` — additive local-control schema validation and deterministic encoded data-row measurement.
- `packages/backend/src/indexer/index-hyperdb-build.cjs` plus generated `index-hyperdb-spec/` output — additive usage-counter/tombstone models and local usage-by-scope index.
- `packages/backend/package.json` — `./indexer` package export.
- `packages/backend/test/indexer-admission.test.mjs` — admission/options/measurement REDs.
- `packages/backend/test/indexer-store.test.mjs` — transactional/durability/eviction/query/lifecycle REDs.
- `packages/backend/test/indexer-schema.test.mjs` — local-control generation, exact charge, and callback rollback REDs.

## Design decisions

- Kept the seven approved raw/cursor/projection collections and every approved search and publisher-repair key order unchanged. Added only `usageCounters`, `admissionTombstones`, and local `usage-by-scope` metadata.
- Reserved the canonical all-zero publisher ID for control rows. Global, shard, trust-class, and tombstone-count counters use it; each real publisher counter remains publisher-keyed and persists its current shard/trust membership.
- Counted one admitted data row as its generated primary key, generated collection value, and every generated secondary-index key plus primary-key pointer. Control rows are deliberately excluded from recursive quota charge.
- Used the Task 1 canonical-core serializer and one exclusive `validatedTransaction` for data/cursor/counter/tombstone mutations. There is no sidecar, second Hyperbee, Autobase, or authoritative in-memory usage state.
- Replacement validates and measures the complete incoming slice before entering the transaction, then checks persisted old rows/counter coherence before atomically replacing the publisher prefix. Incremental apply premeasures every put and the cursor, then measures actual stored rows inside the transaction for exact idempotent deltas.
- Reclassification debits the publisher's recorded old shard/trust buckets and credits the newly resolved buckets in the same transaction. Unknown newly resolved trust classes reject; removed historical trust-class buckets can still be debited safely.
- Local eviction enumerates and deletes only the publisher's raw/cursor/projection rows, removes all four charged counter dimensions, and writes a bounded local tombstone. It exposes no network or publisher-retraction surface. Explicit clear is the only reinsertion gate.
- Bounded historical tombstones with an atomic uncharged count record and a fixed 65,536-record ceiling so deterministic `snapshotUsage()` never creates an unbounded result.
- `snapshotUsage()` performs one serialized read transaction and returns global usage plus lexically sorted shard, publisher, trust-class, and tombstone arrays. Empty zero-value bucket rows are deleted rather than retained.
- Used a fixed named core, `peartube-index-v1`, so independent root/session surfaces and restarts address the same generated database while preserving caller Corestore ownership.

## Authored behavior coverage

- Generated encoder byte measurement includes primary key/value and every secondary key/pointer.
- Exact retained-byte equality admits; one byte below rejects with stable scope/resource/limit/current/requested details.
- Exact row boundaries and global, shard, publisher, and untrusted hard ceilings.
- Missing/non-finite/fractional/unknown options, required untrusted pool, synchronous policy, bounded IDs, and unknown trust-class rejection.
- Publisher mismatch, disallowed cursor operations, malformed operation types, duplicate compound keys, and validation no-op behavior.
- Full publisher-prefix replacement/repair across raw record, cursor, and projections while another publisher remains unchanged.
- Accepted row/cursor values are snapshotted before queued work so caller mutation cannot invalidate preflight accounting.
- Exact put/update/delete/cursor deltas and replay-idempotent put/delete operations.
- Oversized apply and replacement rollback across data, cursor, counters, and tombstones.
- Persisted usage/cursor/source/projection recovery after closing and reopening a real Corestore directory.
- Two independently opened root/session stores racing the same final global capacity.
- Atomic shard/trust policy reclassification.
- Cross-publisher exact external-reference federation without a publisher selector.
- Local eviction, counter debit, query suppression, durable tombstone rejection, explicit clear, and reinsertion.
- Forced transaction callback and underlying append/flush failure rollback.
- Drain-safe idempotent close, late-work rejection, accepted-work persistence, and caller Corestore ownership.

## Generation and validation status

The parent ran `node packages/backend/src/indexer/index-hyperdb-build.cjs` successfully after the builder changes and updated the checked-in Hyperschema and HyperDB output. The first focused Task 2 run reached 35/36 because the Task 1 exact selector-metadata fixture did not seed/select the three additive control entries. After that fixture amendment, the parent reran generation and the focused suite successfully: 36/36 tests passed with 50/50 Brittle assertions.

The review-fix tests and implementation below were authored after that green run. This worker did not rerun validation, builds, lint, or formatters, as required. Parent rerun command:

```bash
cd packages/backend && npx brittle test/indexer-schema.test.mjs test/indexer-store.test.mjs test/indexer-admission.test.mjs test/storage-pressure.test.mjs
```

The parent should also exercise the package export from a package consumer and inspect the focused test output for warnings.

## Concerns

- The append-rejection RED injects at Hypercore `append`, the transaction flush boundary, and proves no durable append when that call rejects. It does not simulate a partial or post-commit device failure; no existing focused helper provided that stronger boundary without substantial storage scaffolding.
- Exact quota charge intentionally follows the parent contract's generated row/index bytes; it does not claim to include Hyperbee tree/framing overhead.
- The fixed tombstone ceiling is local control-state protection, not charged publisher storage. Reaching it fails closed with the standard limit error until operators explicitly clear tombstones.

## Review Fix Round 1

- Hard ceilings now reject only genuine growth above both current usage and the configured limit. Equal/decreasing replacement, reclassification, and eviction can monotonically repair persisted over-limit global, shard, publisher, and trust-class usage after a stricter restart; growth still fails closed.
- Publisher-row enumeration scans every publisher-prefix collection even after reaching the persisted expected count, with at most one excess row read. Apply performs the same bounded zero-row orphan check before creating a fresh counter/cursor. Apply, replacement, and eviction therefore reject orphan or later-collection excess without mutation.
- Deterministic snapshots now safely sum every bounded publisher counter, group exact shard/trust aggregates, and require exact global/shard/trust set and value equality before returning operator-visible usage.
- Replacement validation uses the effective minimum global/publisher row ceiling before touching the row array. Apply caps operations at twice that effective limit without unsafe multiplication, also before touching operation entries. Actionable limit errors retain the limiting global/publisher scope.
- Added REDs for over-limit monotonic repair and eventual zero, decreasing replacement still above retained-byte ceilings, orphan rows in the final publisher collection, corrupted global/shard/trust control aggregates, and poisoned arrays proving fail-before-map bounds.
- The parent’s 36/36 focused result predates these review fixes; this worker did not run validation.

## Parent validation and final review

- Regenerated the Hyperschema/HyperDB output after the review fixes.
- Ran the focused Plan 04 command: 40/40 tests passed, with the existing storage-pressure file reporting 50/50 Brittle assertions.
- Scoped re-review marked all four findings addressed: monotonic over-limit repair, orphan/excess-row detection, exact snapshot aggregate coherence, and fail-before-map publisher batch bounds.
- No new Critical or Important findings. Spec Compliance: OK. Task quality: Approved.
- Package smoke import `@peartube/backend/indexer` exposed `createIndexerStore`, `openIndexerDatabase`, `IndexerAdmissionError`, and `measureEncodedIndexerRow`.
- Final complete-plan review found no Critical or Important issues. Plan Compliance: PASS. Final verdict: Approved.
