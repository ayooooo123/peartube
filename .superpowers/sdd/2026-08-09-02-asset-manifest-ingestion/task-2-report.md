# Plan 02 Task 2 Report — Static upload/publication cutover

## Status

Complete. Upload publication, publication batches, API source locators, and the named fixtures now use the Plan 01 static descriptor through the Plan 02 v2 rendition boundary.

Commit: `15cac3003982a72d4e58b8f021841f8fccc60404` — `feat(assets): publish static asset manifests`

## Producer and fixture map

Mapped before editing:

- `packages/backend/src/upload.js`
  - `uploadFromPath()` and `uploadFromBuffer()` write the channel-local playback blob.
  - Both flow through `maybeAttachImmutablePublication()`, the active signed manifest/catalog producer.
- `packages/backend/src/assets/rendition-writer.js`
  - `createImmutableRenditionWriter().writeRendition()` is the single static asset materialization boundary over `writeStaticAsset()`.
- `packages/backend/src/assets/publication-batch.js`
  - `addPublication()` is the batch publication boundary. Production publication callers are not present yet; the focused batch fixtures are its current publication producers.
- `packages/backend/src/api.js`
  - `exactSourceLocators()` translates accepted manifests into local whole-core inspection/offload ranges.
- Active upload callers remain the orchestrator-provided manager used by desktop, mobile, CLI archive import, and add/executor paths; they all share the two upload methods above.
- Named focused fixtures:
  - Matroska buffer upload and catalog rollback in `upload-playback-support.test.mjs`.
  - File/buffer structured metadata fixtures in `upload-structured-metadata.test.mjs`.
  - Publication/claim batch fixtures in `publication-batch.test.mjs`.
  - Legacy owner-channel and malformed-source fixtures in `publication-v1-migration.test.mjs`.

## Implemented behavior

- A publishing upload now streams the exact source bytes through `createImmutableRenditionWriter()` before manifest signing.
- The writer preflight descriptor itself is a canonical `static-prologue-v1` descriptor, so validation no longer attempts the rejected legacy random-core shape.
- The verified readonly core session is closed before any catalog operation is created.
- The signed v2 manifest stores the exact writer-produced rendition descriptor. Upload results expose `{ publicationId, manifestId, renditionId, assetId, coreKey, manifest }` from that same stored manifest.
- Upload provenance retains publisher/video/rendition/asset identity without carrying the old shared Hyperblobs `start`/`end` writable range. Existing structured channel metadata, including the local playback `blobId` and `blobsCoreKey`, remains unchanged.
- Identical bytes written in independent Corestores converge on the same `assetId` and `coreKey`; publisher-scoped manifests/publication IDs remain distinct.
- Cancellation is checked before static materialization and again before signing/catalog operation creation. Static writer cleanup closes and deletes staging state; the upload rollback path removes the newly written channel blob and emits no catalog operation.
- Publication batches reconstruct every child rendition through `createRenditionDescriptor()` and require the supplied rendition ID to match, rejecting legacy random/writeable-range shapes.
- API source inspection/offload derives an exact whole-static-core locator from normalized `AssetCoreRefV2` (`0..core.length`) instead of trusting upload provenance carrying a shared writable blob range.
- The legacy owner-channel fixture has only a random Hyperblobs range and no source bytes, so it is explicitly `reingest-required`, retains structured metadata, and has no active v2 playback identity. Malformed storage remains quarantined.

## RED / GREEN

### RED

After adding the required assertions, the exact focused command exited 1:

```text
npx brittle test/upload-playback-support.test.mjs test/upload-structured-metadata.test.mjs test/publication-batch.test.mjs test/publication-v1-migration.test.mjs
```

Observed failures:

- Two independent publisher stores returned upload failure instead of a stored static descriptor identity.
- Cancellation reached the old rejected core-reference path instead of the cancellation/cleanup contract.
- `createPublicationBatch()` accepted a legacy writable-range rendition instead of throwing.
- The existing catalog-failure test stopped at `static asset core reference required` before exercising catalog rollback.

The first implementation run exposed one additional valid RED: rendition-writer metadata preflight still used the legacy placeholder core. Replacing that placeholder with a reconstructed canonical zero-length static descriptor completed the boundary cutover.

### GREEN

Final exact command under Node 22.19.0:

```text
PATH=/Users/jd/.nvm/versions/node/v22.19.0/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  npx brittle test/upload-playback-support.test.mjs test/upload-structured-metadata.test.mjs test/publication-batch.test.mjs test/publication-v1-migration.test.mjs
```

Observed result:

```text
1..14
# tests = 14/14 pass
# asserts = 139/139 pass
# ok

1..4
# tests 4
# pass 4
# fail 0
```

## Self-review

- Confirmed catalog operation construction occurs only after `writeStaticAsset()` has returned its locally verified descriptor and the readonly session has closed.
- Confirmed cancellation test opens real staging state, observes it closed, observes zero catalog operation creation/appends, and leaves no video metadata.
- Confirmed catalog failure still clears the new playback blob and persists no channel video metadata.
- Confirmed returned IDs are compared against the manifest decoded from the actual appended publication operation, not against a shared test object.
- Confirmed the two-store test uses distinct publisher keypairs and independent Corestores while asserting asset/core convergence and publication/publisher separation.
- Confirmed active v2 upload provenance contains no shared writable `start`/`end` range; API ranges are derived locally from the readonly static descriptor.
- Confirmed all pre-existing structured metadata assertions remain green.
- Skipped formatter, lint, build, project-wide suites, and unrelated tests as required.

## Concerns

No blocking concern. Source-byte-less legacy random-core records intentionally remain unavailable for active v2 playback until an external re-ingest supplies the original bytes; no compatibility descriptor is synthesized.

## Round-1 review fixes

Commit: `311f9dd14c23c663e186df419bbc47a6c5d827d0` — `fix(assets): retain published static renditions`

### Ownership and one-source materialization

- Publishing uploads now materialize the source into the verified static core first, then stream the local Hyperblobs playback copy from that readonly core. Path publication opens the mutable source file exactly once; MIME detection, byte length, playback blob, rendition, and manifest all derive from the resulting static core.
- The temporary writer session closes before signing. After catalog acceptance and projection rebuild, `scopedNetwork.retainAuthorizedRendition()` opens and owns the served asset range before the publisher catalog is announced. A later announcement failure releases that retained rendition; successful retention remains owned by the scoped runtime lifecycle.
- Static-to-playback stream failure/cancellation destroys the unreturned blob stream, drains its completion, closes the readonly static session in the upload catch path, and never reaches catalog append.

### Cancellation, reuse, and migration

- Cancellation is rechecked after every awaited `catalog.createLocalOperation()` and immediately before batch append. Mid-signing abort creates no accepted batch and persists no video record.
- Deterministic path reuse now expands the stored `immutablePublication` through the same top-level result builder as a fresh publication, then adds `reused: true`.
- Real publication-v1 startup migration now classifies normalized legacy ranges before catalog resolution. Byte-less ranges checkpoint `reingest-required`, preserve source metadata, emit no catalog operation, and allow startup migration to finish. Malformed legacy storage keeps the existing quarantine/fail-closed behavior.

### Fixture cutover

- Both media-catalog publishing harnesses now own isolated Corestores with teardown and streaming blob fixtures.
- Media-catalog manifests use canonical v2 static descriptors and range authorization against the full static core rather than provenance-carried writable ranges.
- Source-offload fixtures now use reconstructable v2 descriptors and assert `assetId`, `blobId: null`, and whole-core `0..length` locators. Default deletion assertions clear that same whole static range; legacy random-core and multiple-original fixtures fail closed.

### Round-1 RED / GREEN

The corrected canonical fixture first produced the expected behavioral RED:

- publication-v1 startup returned `pending`, resolved a catalog once, and checkpointed no re-ingest disposition;
- path publication read the source three times instead of once;
- mid-signing cancellation reached append/rejection instead of returning the cancellation error;
- reused uploads omitted all top-level publication/asset fields;
- the publishing runtime had no retain-before-announce ownership transition.

Final authorized six-suite command:

```text
PATH=/Users/jd/.nvm/versions/node/v22.19.0/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  npx brittle test/upload-playback-support.test.mjs test/upload-structured-metadata.test.mjs test/publication-batch.test.mjs test/publication-v1-migration.test.mjs test/media-catalog-runtime.test.mjs test/source-offload-api.test.mjs
```

Observed result:

```text
1..29
# tests = 29/29 pass
# asserts = 228/228 pass
# ok

1..7
# tests 7
# pass 7
# fail 0
```

No formatter, lint, build, project-wide suite, or test outside the six authorized files was run.

## Round-1 re-review retention ownership fix

Commit: `fce4091bf5bb4f8202987141b7e7ca3e3e5a7636` — `fix(assets): preserve borrowed rendition retention`

A focused regression test pre-retained the rendition, injected publisher announcement failure, and initially observed one erroneous release instead of zero. Upload publication now records ownership only when `retainAuthorizedRendition()` returns `status: 'retained'`; `status: 'already-retained'` is borrowed state and is never released by the failed attempt.

The exact same six-suite command then passed:

```text
1..29
# tests = 29/29 pass
# asserts = 228/228 pass
# ok

1..8
# tests 8
# pass 8
# fail 0
```

## Final Plan 02 integration fixes

Commit: `059bc66c9327081464b1ab1391d6a231403ec8be` — `fix(assets): complete static publication ownership`

### Canonical static opens and discovery identity

- `retainAuthorizedRendition()` now normalizes the signed v2 `AssetCoreRefV2`, reconstructs its zero-signer Hypercore manifest, and opens the readonly core with `{ key, manifest, writable: false }`. A fresh-reader Corestore test replicates and reads the asset without warming that store through the publisher writer.
- Both default source-offload core opens use the same reconstructed static manifest instead of key-only opens.
- Retained discovery derives from `deriveStaticAssetTopic(assetId)`. Results return both rendition authorization identity and canonical `assetId`; different purpose/format renditions over identical bytes join one asset topic.

### Owner-aware retention and source offload

- Retention is now owner-aware. One asset scope may hold multiple rendition/owner authorization leases, including the same rendition descriptor in distinct publications. Revalidation and release remove only the affected owner and leave the shared asset scope active while any authorized owner remains.
- Default source deletion releases the publication owner's lease under the source-mutation lock immediately before `clear()`. Successful deletion leaves that ownership unadvertised; a clear or GC failure reacquires the exact manifest/rendition/owner lease. Other owners remain retained throughout.

### Atomic local metadata boundary

- Publishing uploads stage `replicationPending` local metadata before catalog append. A local `addVideo` failure therefore creates no catalog batch and acquires no network retention.
- Rejected catalog append deletes the staged local record. Accepted append promotes the record to `published` before retention. Post-commit failures release only retention ownership acquired by that publication attempt.

### Integration RED / GREEN

The focused RED observed:

- retention and source offload passed no Hypercore manifest and no readonly flag;
- retained results had no asset identity and the static asset topic was unauthorized;
- identical bytes joined no canonical asset topic and release discarded shared authorization;
- source offload cleared without release and did not reacquire after failure;
- local metadata failure occurred after one catalog append (`actual: 1`, `expected: 0`).

Final authorized command:

```text
PATH=/Users/jd/.nvm/versions/node/v22.19.0/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  npx brittle test/upload-playback-support.test.mjs test/media-catalog-runtime.test.mjs test/source-offload-api.test.mjs test/scoped-network-runtime.test.mjs test/scoped-network-runtime-portable.test.mjs test/scoped-runtime-source-contract.test.mjs
```

Observed:

```text
1..37
# tests = 37/37 pass
# asserts = 232/232 pass
# ok

1..9
# tests 9
# pass 9
# fail 0
```

Task 1 asset-manifest/static-core tests were not required because shared static-core opening code was not changed. Formatter, lint, build, project-wide suites, and tests outside the authorized files were not run.

## Final re-review: shared offload and staged rollback

Commit: `2cf8e9c417fa50c29f8431657bfafa433b977717` — `fix(assets): reconcile shared offload ownership`

### Shared asset offload

- Owner release now reports `remainingOwners` and `scopeQuiescent`.
- Releasing one publication from an asset still retained by another publication leaves the shared scope, download, discovery, and bytes intact. Confirmation succeeds truthfully with `freedBytes: 0`, `sharedRetention: true`, and audit outcome `retention-released`.
- The last owner release is quiescent and may clear the canonical range. Clear/GC failure still reacquires that exact owner.

### Rejected staged metadata reconciliation

- If catalog append is rejected and staged metadata deletion fails, the upload returns `rollbackPending: true` and does not clear the playback blob.
- A deterministic retry never treats `replicationPending` metadata as a successful reused upload. It deletes the pending record, clears the rejected blob exactly once, then performs one replacement upload.
- If clearing the rejected blob fails after metadata deletion, the pending record is restored before returning rollback-pending, preserving a durable retry anchor.

### RED / GREEN

RED observed a shared-owner offload incorrectly clear one block and report 4096 freed bytes instead of zero/shared retention. The staged-delete failure returned no rollback-pending state, cleared its referenced bytes, and the retry reused the pending record.

The same authorized command passed after both fixes:

```text
1..38
# tests = 38/38 pass
# asserts = 240/240 pass
# ok

1..10
# tests 10
# pass 10
# fail 0
```

## Mobile deterministic reconciliation

Commit: `cf769fc5157b5aa0f81d487a7aab715c3539bb71` — `fix(assets): reconcile mobile upload retries`

`uploadFromBuffer()` now applies the same validated caller-supplied `videoId` preflight as path uploads: completed records reuse safely, while `replicationPending` records delete their staged metadata and clear the rejected blob exactly once before republishing with the same ID.

The mobile-specific RED showed the pending record stored under a random generated ID instead of the supplied deterministic ID, making reconciliation unreachable. The authorized suites then passed:

```text
1..38
# tests = 38/38 pass
# asserts = 240/240 pass
# ok

1..11
# tests 11
# pass 11
# fail 0
```

## Revalidated shared scope and durable retry anchor

Commit: `32af9efb5991b49b63d0bd298994996ecde5751c` — `fix(assets): preserve rollback anchors and shared scopes`

- `releaseAuthorizedRendition()` accepts normalized `assetId` and, when its rendition lease was already removed by revalidation, locates the shared asset scope by `deriveStaticAssetTopic(assetId)`. Quiescence and remaining-owner counts therefore describe the whole asset scope, not merely the requested rendition map entry. Source offload carries the locator asset identity into release.
- Rollback now clears the staged blob before deleting its `replicationPending` row. Clear failure leaves the row untouched; delete failure after a successful clear also leaves the pending row as the durable retry anchor. Retry may idempotently repeat clear, then deletes the anchor and performs exactly one replacement publication.
- This ordering supersedes the earlier “clear exactly once” wording: replacement publication is exactly once; idempotent clear may repeat until the pending row can be deleted.

Focused RED observed the revalidated rendition return `remainingOwners: 0`/quiescent while another rendition owner remained, and both path/mobile rollback tests observed no pre-delete clear. Mobile then covered clear failure followed by delete failure across retries before convergence.

Final authorized result:

```text
1..38
# tests = 38/38 pass
# asserts = 247/247 pass
# ok

1..11
# tests 11
# pass 11
# fail 0
```

## Uncertain catalog reconciliation and private round-trip

Commit: `eb6441b460eb73f3e409331e74a3df4b5e01b185` — `fix(assets): reconcile uncertain publication commits`

- A mixed/maybe-accepted `appendBatchAndConfirm()` failure no longer invokes staged rollback. The private row remains `commitUncertain`, the staged playback blob remains referenced, and the failure returns `commitUncertain`, `reconciliationRequired`, and the exact immutable IDs plus three catalog operation IDs.
- Deterministic retry reads receipts for those exact persisted operation IDs. All accepted receipts resume projection, retention, and publisher announcement while the row remains private; only after all three side effects succeed is the row finalized as `published`. Side-effect failure remains retryable without clearing or republishing. All explicitly rejected receipts transition to the existing durable clear-then-delete rollback before one replacement publication. Missing, mixed, or failed receipt reads remain uncertain.
- Private `contentDetails` schema version 3 now persists bounded publication, rendition, static asset/core, publisher, sequence, claim, operation, and canonical encoded-manifest fields. `MultiWriterChannel` reconstructs the full `immutablePublication` shape on read. Public schema/projection allowlists were not expanded with these reconciliation fields.
- Both path and buffer completed-record preflights return the same full publication contract without source access or a new write.

RED evidence:

- uncertain catalog response cleared staged state instead of returning a reconciliation marker;
- accepted-receipt finalization marked the row published before retention failure;
- private schema rejected `commitUncertain` and dropped every explicit publication field.

Final GREEN:

```text
Exact four brief suites:
1..14
# tests = 14/14 pass
# asserts = 141/141 pass
# ok

upload node:test subtests:
1..13
# pass 13
# fail 0

private channel HyperDB:
1..10
# pass 10
# fail 0

structured content codecs:
1..14
# tests = 14/14 pass
# asserts = 357/357 pass
# ok
```

The focused channel schema compiler was run to update generated version-3 codecs. No formatter, lint, project-wide build/suite, or test outside the authorized focused files was run.

## Reviewed uncertain-publication reconciliation closure

Commit message: `fix(assets): close uncertain publication reconciliation` (this report is included in that focused commit; the exact hash is returned in the handoff).

- Persisted hexadecimal publisher identities are decoded to exact 32-byte values before production registry resolution and compared byte-for-byte with the resolved binding.
- Receipt handling is fail-closed. Accepted means `accepted: true`; rejected means `accepted: false` with a non-empty `rejectionCode`. Bare-false, missing, malformed, and mixed results remain commit-uncertain.
- Accepted retries project the published candidate with propagated public-sync errors before the private `commitUncertain` row is changed to `published`. A failed public sync therefore leaves the durable retry anchor intact.
- Restart projection deletes both private publication states, and owner catalog API results exclude both. Public projection allowlists remain unchanged.

### RED

The focused pre-implementation runs observed:

```text
upload reconciliation:
1..13
# pass 11
# fail 2
```

Both reconciliation tests reached the production-like registry assertion with an undecoded persisted publisher ID. The accepted path made zero public-sync attempts. The receipt test also retained its bare-false uncertainty and explicit-rejection replacement assertions.

```text
private finalization:
1..11
# pass 10
# fail 1
```

`MultiWriterChannel.updateVideo()` did not receive the pre-commit projection contract; the expected strict public-sync options were absent.

```text
public projection and owner catalog:
1..24
# tests = 22/24 pass
# asserts = 125/127 pass
```

Restart sync failed to suppress the stale `commitUncertain` row, and the owner catalog counted the uncertain draft in its extras group.

### GREEN

The unchanged authorized six-suite asset command passed:

```text
1..38
# tests = 38/38 pass
# asserts = 247/247 pass
# ok

upload node:test subtests:
1..13
# pass 13
# fail 0
```

Only the implicated private/public projection and catalog tests were added:

```text
private channel HyperDB:
1..11
# pass 11
# fail 0

public projection and owner catalog:
1..24
# tests = 24/24 pass
# asserts = 127/127 pass
# ok
```

No formatter, lint, build, project-wide suite, schema compiler, or unrelated test was run. No concern remains within the four reviewed defects.

## Re-review: fail-closed loser suppression ordering

Commit message: `fix(assets): keep uncertain projection fail-closed` (the exact hash is returned in the handoff).

The accepted candidate is now the final public mutation in a full channel sync. Claim-winner stabilization and all potentially failing loser-suppression writes complete before `syncVideos()` publishes the candidate. If loser suppression fails, the private row remains `commitUncertain` and the candidate remains absent from the public bee; a later retry converges to both private and public `published` state.

Focused RED:

```text
private channel HyperDB:
1..11
# pass 10
# fail 1
```

The injected post-suppression failure left the private row uncertain but exposed the synthetic candidate publicly with `publicationState: published`.

Focused GREEN:

```text
upload reconciliation:
1..13
# pass 13
# fail 0

private channel HyperDB:
1..11
# pass 11
# fail 0

public sync and claim projection:
1..36
# tests = 36/36 pass
# asserts = 249/249 pass
# ok
```

Only the requested upload, private finalization, public sync, and public claim-projection suites were run. No formatter, lint, build, broad suite, schema compiler, or unrelated test was run.

## Final whole-plan reviewer closure: crash-safe publication and shared offload

Commit message: `fix(assets): close final upload crash windows` (the exact hash is returned in the handoff).

### Implemented behavior

- Before staging `commitUncertain`, uploads now encode the exact three signed publisher operations into a bounded, versioned, count-bearing, length-prefixed canonical frame batch. The private-only `publicationOperationFrames` HyperDB sidecar durably stores that batch; the public schema and projection allowlists contain no corresponding field.
- An all-bare-missing receipt set decodes and replays those exact frames. Replay verifies version, exact count, every frame length, canonical re-encoding, expected publication/claim record order, and operation-ID equality before append. Malformed or mixed state remains uncertain, and repeated exact append is idempotent at the publisher catalog.
- Normal append and accepted-receipt reconciliation now use one finalizer. The durable row remains private `commitUncertain` while projection rebuild, owner-aware static retention, publisher announcement, and strict public sync run in order; only successful public sync commits `published`.
- Custom and default source deletion now share the same owner release/quiescence boundary. A remaining sibling owner prevents either deletion implementation from touching bytes; custom-hook failure or an unsuccessful hook result reacquires the released publication lease.
- Explicit custom segment indexes are shape-checked before materialization without comparing them to the zero-length preflight core. Their final bounds are validated against the realized static asset byte length; valid multi-segment writes succeed and out-of-bounds writes still close/fail.

### RED

- Upload suite: `13/15` passed. The accepted normal path returned no retry marker after announcement failure, and the staged pre-append crash persisted no replay frames.
- Source offload suite: `12/13` passed (`74/79` assertions). The custom hook deleted shared bytes without owner release and did not reacquire on failure.
- Rendition writer exited on the existing valid explicit-segment path with `segment index media byte length must equal asset byte length`.
- Private schema/channel RED: `13/14` structured-codec tests and `10/11` channel tests passed; the signed frame field was dropped from both physical and logical private round trips.

### GREEN

The focused private schema generator completed successfully:

```text
node src/channel/channel-hyperdb-build.cjs
```

The final authorized Plan 02 command covered only the focused upload, asset, network, offload, private/public channel, schema, and implicated rendition-writer suites:

```text
PATH=/Users/jd/.nvm/versions/node/v22.19.0/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  npx brittle \
    test/upload-playback-support.test.mjs \
    test/upload-structured-metadata.test.mjs \
    test/upload-offload.test.mjs \
    test/publication-batch.test.mjs \
    test/publication-v1-migration.test.mjs \
    test/media-catalog-runtime.test.mjs \
    test/rendition-writer.test.mjs \
    test/source-offload-api.test.mjs \
    test/scoped-network-runtime.test.mjs \
    test/scoped-network-runtime-portable.test.mjs \
    test/scoped-runtime-source-contract.test.mjs \
    test/multiwriter-channel-hyperdb.test.mjs \
    test/structured-content-codec.test.mjs \
    test/channel-catalog-api.test.mjs \
    test/public-channel-bee-sync.test.mjs \
    test/public-channel-hyperdb.test.mjs \
    test/public-channel-owner-metadata.test.mjs
```

Observed:

```text
1..107
# tests = 107/107 pass
# asserts = 953/953 pass
# ok

1..28
# tests 28
# pass 28
# fail 0
```

No formatter, lint, project-wide build, broad suite, or test outside the authorized focused files was run.

### Concerns

No blocking concern remains in the four findings. The replay batch intentionally exists only for new staged uploads; previously persisted uncertain rows without exact signed frames remain fail-closed rather than synthesizing or re-signing operations.
