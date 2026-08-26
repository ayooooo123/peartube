# Task 1 Report: Normalized HyperDB index schema

## Files

- `packages/backend/src/indexer/index-hyperdb-build.cjs` — Hyperschema and HyperDB ESM generator.
- `packages/backend/src/indexer/schema.js` — schema names, bounded validation, strict insert surface, validated transaction seam, and lifecycle.
- `packages/backend/test/indexer-schema.test.mjs` — schema conformance REDs.
- `.superpowers/sdd/2026-08-09-04-index-schema/task-1-report.md` — this report.

Generated `index-hyperdb-spec/hyperschema/` and `index-hyperdb-spec/hyperdb/` files were produced by the parent with `node packages/backend/src/indexer/index-hyperdb-build.cjs` and are included in the amended commit. The worker did not execute generation or hand-write generated output.

## Collections, primary keys, and indexes

All primary keys begin with canonical `publisherId`:

- `sourceRecords`: `(publisherId, catalogEpoch, recordId)`.
- `sourceCursors`: `(publisherId, catalogEpoch)`.
- `externalReferenceProjections`: `(publisherId, sourceRecordRef, namespace, normalizedIdentifier, entityKind, entityId)`.
- `publicationProjections`: `(publisherId, sourceRecordRef, publicationId)`.
- `renditionProjections`: `(publisherId, sourceRecordRef, renditionId)`.
- `availabilityProjections`: `(publisherId, sourceRecordRef, assetId, observerId, observedAt)`.
- `relationshipEdges`: `(publisherId, sourceRecordRef, relationType, fromId, toId)`.

Every source-derived projection and edge stores bounded `sourceRecordRef`. All fields are scalar; the schema contains no arrays or JSON blobs. Title tokens are normalized relationship rows with `relationType: title-token`, bounded `fromId`, and the target entity/work in `toId`.

Compound indexes include:

- exact external reference and exact entity/work lookup;
- exact publication, publication-by-work, and normalized-title lookup;
- exact rendition, exact asset, and availability-by-asset lookup;
- relationship type/from/to and token-prefix lookup;
- one publisher-prefix enumeration/repair index for every collection.

Every index begins with `publisherId`. Every projection/edge index carries `sourceRecordRef` in its complete key, preserving source attribution and deterministic duplicate disambiguation.

## Limits and validation

`INDEX_SCHEMA_LIMITS` is frozen. It reuses `RECORD_LIMITS.maxEnvelopeBytes` and `RECORD_LIMITS.maxRecordTypeBytes`; explicit frozen limits cover record/source refs, external namespaces and IDs, entity/publication/manifest/rendition/asset IDs, titles, provenance summaries, media descriptors, relationship types/endpoints, and descriptor refs.

Validation:

- requires canonical lowercase 64-hex for 32-byte protocol identities (`publisherId`, bootstrap key, observer ID);
- measures strings with UTF-8 byte length, including multibyte boundary cases;
- accepts canonical envelopes only as `Buffer`/`Uint8Array`, bounds them without stringify or validation-time copying, and passes the original value to HyperDB encoding;
- accepts only safe non-negative integer uint values, with a bounded release year;
- restricts projection, availability, and relationship states to explicit sets;
- rejects missing required fields and unknown schema fields;
- rejects unknown collections;
- serializes strict public inserts and rejects an already-present complete compound key before encoding/writing.

`validateIndexerRecord` is deterministic and returns the original validated record rather than cloning it.

## Lifecycle and internal seam

`openIndexerDatabase(store, options)` requires exactly one named or keyed core session, opens the generated ESM definition with `HyperDB.bee`, and exposes only insert, find, findOne, get, flush, validatedTransaction, and close.

Public and transaction `find`/`findOne` adapt direct compound selectors to HyperDB exact-prefix ranges (`gte` and `lte` with the same selector). Query controls (`limit`, `reverse`, and `checkout`) are preserved. Explicit `gt`/`gte`/`lt`/`lte` ranges pass through unchanged, while mixing direct fields with explicit bounds is rejected to prevent a silently widened scan.

Public `insert` is create-only. `validatedTransaction` is the narrow Task 2 seam: its callback receives validated `upsert`/`delete` plus reads on one exclusive HyperDB transaction, and flushes only after the callback succeeds. A thrown callback closes the unflushed transaction. This seam performs schema validation but deliberately does not implement Task 2 admission accounting or slice policy.

Closing the wrapper closes HyperDB and its core session, not the caller-owned Corestore. Close is idempotent and waits for queued writes.

## Tests authored

The RED suite covers:

- all seven collections and raw envelope round trip;
- publisher and source attribution on stored rows;
- exact external-reference, entity/work, publication, asset, relationship, normalized-title, and title-token-prefix queries, each with conflicting publisher rows;
- publisher-prefix enumeration and cross-publisher isolation for every collection;
- exact-prefix query adaptation, bounded explicit-range passthrough, mixed selector/range rejection, and identical transaction read behavior;
- duplicate complete-key rejection;
- missing, uppercase, and malformed publisher identity rejection;
- multibyte UTF-8 exact and over-limit boundaries;
- source-ref and envelope byte maxima;
- malformed envelope type, negative/fractional uints, and invalid states;
- validated atomic internal upsert behavior;
- caller Corestore ownership after database close.

## Design decisions

- Kept normalized title tokens in `relationshipEdges`, avoiding a second token collection or unbounded token list.
- Used source-attributed fields as trailing index components so exact/prefix lookups remain publisher-isolated while preserving provenance.
- Used an exclusive HyperDB transaction for the internal seam rather than introducing Autobee, a global in-memory index, or another persistence convention.
- Kept public insert create-only in the wrapper because HyperDB insert itself is upsert-oriented; internal upsert remains separately named and scoped.

## Generation and validation status

The worker did not run generation, tests, builds, lint, formatting, or other validation, as required. The parent generated the compiler output and reported the pre-fix conformance result (9/10 passing), which exposed unadapted direct selectors; the strengthened post-fix suite remains unexecuted by the worker.

## Concerns

- The strengthened query-adapter tests remain for the parent to execute.
- HyperDB's exclusive transaction behavior is used directly and should be confirmed by the parent conformance run against the installed runtime.

## Review Fix Round 1

- Added immutable `INDEX_KEY_FIELDS` metadata matching every collection and generated index key.
- Direct selectors now require a non-empty, defined, contiguous leading key prefix beginning with `publisherId`. Options-only, publisher-less, unknown, and gapped selectors reject before HyperDB; explicit range objects remain the intentional escape hatch.
- Public create now performs existence check, insert, and durable flush within one exclusive transaction. A Corestore-scoped, reference-counted named/keyed-core serializer coordinates independent surfaces and is removed when the final surface closes; it stores no index records.
- Close now stops admission synchronously, drains all previously accepted operations, shares one close promise across callers, then closes HyperDB and releases serializer state.
- Added a distinct `protocolId` validation kind for source record, publication, manifest, rendition, and asset IDs. These fields require canonical lowercase 64-hex while opaque entity/work/source/external and relationship endpoint values remain bounded UTF-8.
- Strengthened REDs across every index family, invalid direct selectors, two-surface duplicate/distinct-key races and reopen durability, queued transaction close behavior, and every protocol-ID field.
- No generator change was needed: generated field types and compound keys remain unchanged because protocol-ID and query constraints are enforced at the schema-facing boundary.
- The worker did not run generation or validation. Parent must run conformance after this amended source/test round.

## Review Fix Round 2

- Restored the asynchronous database contract for `insert`: validation and closed-state failures reject its returned Promise before any operation is enqueued.
- Applied the same Promise-rejection behavior to `findOne`, `get`, `flush`, and `validatedTransaction`; streaming `find` intentionally retains synchronous query-shape errors.
- Updated the close RED to expect late inserts to reject asynchronously.
- Parent reported the pre-fix run reached five passing subtests before four synchronous-validation failures. The worker did not rerun validation.

## Review Fix Round 3

- Serializer identity is now acquired only after the core is ready, keyed by `(store.root || store, lowercase resolved core.key hex)`.
- Root/session, name/key, Buffer/hex locator aliases therefore share one bounded reference-counted queue for the same writable core without retaining locator aliases.
- Keyed opens normalize hex string keys to bytes before Corestore lookup.
- Core-ready failures close the opened core without acquiring serializer state; HyperDB-ready failures release acquired state and close the DB/core once.
- Added REDs racing same-key and distinct-key creates through root/session and name/Buffer-key aliases, closing all references, then reopening by hex key to verify coherent persistence and cleanup.
- Parent reported 14/14 pre-alias tests passing. The worker did not rerun validation.

## Review Fix Round 4

- Keyed opens now pass `options.key` to Corestore unchanged, preserving Corestore/hypercore-id-encoding support for 32-byte Buffers, lowercase 64-character hex, 52-character z32, and `pear://<z32>` locators.
- Serializer identity remains derived only after `core.ready()` from the resolved `core.key` bytes, so all accepted locator spellings share the canonical `(store.root || store, core.key)` queue.
- Expanded the alias RED to open the same generated index core through Buffer, hex, z32, and Pear locators. Each spelling races a same-key create against a named root/session surface (exactly one success), writes two distinct keys, closes every surface, reopens, and verifies both writes persisted.
- Added malformed Hypercore locator rejection coverage and cleanup for every opened core, database surface, Corestore session, store, and temporary directory.
- Generated schema output is unchanged. The worker did not run tests, generation, builds, lint, or formatting, as required; parent validation remains pending.


## Parent validation and final review

- Regenerated `src/indexer/index-hyperdb-spec/hyperdb/` from the checked-in builder successfully.
- Ran `npx brittle test/indexer-schema.test.mjs`: 15/15 Node subtests passed.
- Final scoped review approved all selector, cross-surface atomicity, close-drain, canonical protocol-ID, asynchronous rejection, and standard key-locator fixes; no Critical or Important findings remain.
- Task quality: Approved. Spec Compliance: OK. Task 2 may build on the validated transaction seam.

## Review Fix Round 5

- Corrected the federated-query architecture by making all twelve search/discovery secondary indexes query-dimension-leading. Exact external references now key by `(namespace, normalizedIdentifier, publisherId, sourceRecordRef, entityKind, entityId)`; the entity, publication, work, title, asset, rendition, availability, relationship, and token indexes follow the same query fields first, then `publisherId`, then every remaining provenance/uniqueness field.
- Left all seven collection primary keys and all seven dedicated publisher-prefix index keys unchanged. Source slices therefore remain independently enumerable and deletable under a bounded `publisherId` prefix even though search spans admitted publishers.
- Generalized direct-selector adaptation to each selected index's actual key metadata. It accepts any non-empty contiguous leading prefix, rejects empty, unknown, gapped, extra, undefined, and range/direct-mixed selectors, validates unknown indexes even on the explicit-range escape hatch, and no longer emits a universal publisher-leading error.
- Added RED coverage proving publisher-free exact external-reference, entity, publication, work, asset, rendition, availability, and relationship selectors return both matching publishers and exclude a third nonmatch. Normalized-title and title-token selectors receive the same bounded cross-publisher coverage.
- Strengthened publisher-prefix coverage with two rows for one publisher and one for another in every collection, then deletes the enumerated candidates transactionally and proves the other publisher remains complete and isolated.
- Updated the checked-in expected generated `hyperdb/db.json` and `hyperdb/index.js` key encoders to match the builder. Hyperschema and message outputs are unchanged because record models did not change. The parent must run the generator and conformance suite; this worker did not execute tests, generation, builds, lint, or formatting as required.

## Parent validation after federated-query correction

- Regenerated the checked-in HyperDB output from `index-hyperdb-build.cjs` successfully.
- Ran `npx brittle test/indexer-schema.test.mjs`: 15/15 Node subtests passed, including cross-publisher search and isolated publisher deletion candidates.
- Final round-5 review found no Critical or Important issues. Spec Compliance: OK. Task quality: Approved. Task 2 may use the transaction seam and federated exact-reference index.