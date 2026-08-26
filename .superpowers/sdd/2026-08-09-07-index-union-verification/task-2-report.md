# Task 2 report — selected source verification

## Status

Implementation and focused adversarial test authorship are complete. The universal schema source and backend handler surfaces are wired; generated schema/HRPC outputs were refreshed later by the parent validation session, not by this worker. Per worker constraints, no command, test, build, schema generation, lint, formatter, typecheck, git command, or commit was run by this worker.

## Changed files and symbols

- `packages/backend/src/indexer/query-codec.js`
  - Added canonical `publication-by-work` and `rendition-by-publication` selectors.
  - Added canonical `publication` and `rendition` result frames. Partial-store `normalizedTitle`, rendition `format`, and byte-length facts remain nullable end to end; no dispatcher sentinel is invented.
  - Added nullable, revision-bound `sourceRevision` to requests.
- `packages/backend/src/indexer/query-dispatcher.js`
  - Maps the new typed rows/results, enforces announced capabilities, and forwards the initial traversal revision as well as cursor revisions.
- `packages/backend/src/indexer/service-announcement.js`
  - Added the two typed traversal capabilities to the bounded allowlist.
- `packages/backend/src/indexer/store.js`
  - Added exact publisher/work publication lookup and exact publication/rendition traversal through the existing `publication-rendition` relation plus bounded exact rendition-index resolution.
  - Added selector-specific opaque continuation validation and preserved one durable source revision across the traversal.
- `packages/backend/src/search/index-federation.js`
  - Replaced direct external-result candidate issuance with bounded exact-ref → publication → rendition traversal.
  - Emits one URL-less unverified candidate per concrete `{publisherId, external source record, publication source record, publicationId, candidate manifestId, renditionId, assetId}` tuple.
  - Keeps both source record references and the candidate manifest ID only in the federation-owned opaque cache record.
  - Added a symbol-private cache-record resolution seam, construction-time immutable validation for static service arrays, per-search validation for dynamic retained-service providers, deterministic selection of at most the configured maximum, referenced real deadline timers, and close/drain cleanup.
- `packages/backend/src/search/source-verifier.js` (new)
  - Added `createSourceVerifier`, `verifySelectedCandidate`, explicit `SOURCE_VERIFICATION_ERROR_CODES`, deeply immutable and exact-field-whitelisted verified results, abort-raced checkpoints around every source lookup, underlying-execute plus separately tracked availability-task drain/rollback, and `createScopedAssetAvailabilityProbe`.
- `packages/backend/src/api/search.js`, `packages/backend/src/api.js`
  - Added root `searchIndexCandidates(selector)` and `verifyIndexCandidate(candidateRef)` methods without playback URL minting.
- `packages/backend/src/search/candidate-contract.js` (new)
  - Added bounded outbound wire and inbound companion normalizers. Outbound records whitelist typed facts and pair every nullable uint with an explicit presence boolean plus codec-storage zero; inbound/app adapters reconstruct public `null` versus legitimate `0`, reject hidden absent data, strip wire flags, enforce all bounds, and preserve fixed non-payload structured errors.
- `packages/backend/src/runtime.js`
  - Added lifecycle-owned `createIndexVerificationRuntime` with deferred search/verify methods and close/drain ordering.
  - Added shared `SearchIndexCandidates` and `VerifyIndexCandidate` handlers using the same bounded adapter as mobile HRPC.
- `packages/backend/src/mobile-handlers.js`, `packages/backend/src/hrpc-handlers.js`
  - Registered the two universal backend handler names and adapters to the root API methods.
- `packages/backend/src/network/scoped-runtime.js`, `packages/backend/src/orchestrator.js`
  - Added a deterministic bounded runtime-private view of currently retained index-service query adapters, contained same-core dependent subrange owners with exact per-owner authorization/revalidation, fail-closed dependent revocation when the last exact-scope owner releases, and an opt-in `requirePeerEvidence` asset-block mode that bypasses only the local fast return and still requires a cryptographically verified remote block response.
  - Production search requests no more than the federation’s configured service maximum from that live view only when client application searches; verification uses the same scoped runtime’s selected `[0,1)` asset-range transport with `requirePeerEvidence: true`.
- `packages/spec/schema.cjs`
  - Added bounded typed CompanionCandidateV2/current-verification records plus `search-index-candidates` and `verify-index-candidate` requests, responses, and RPC registrations. Nullable strings remain optional; every nullable uint has an explicit required presence boolean. Verified publisher descriptors carry the authenticated current root key and policy sequence. No URL, credential, source record reference, cookie, or capability field exists.
- `packages/spec/lib/app-rpc-adapter-codegen.cjs`
  - Classified both commands in the generated app RPC search namespace and added response-side presence reconstruction so absent uint storage zeros become public `null`, while explicitly present zero remains `0`.
- `packages/backend/test/index-query-protocol.test.mjs`
  - Authored typed selector/result codec, capability, source-revision, and dispatcher-path assertions.
- `packages/backend/test/indexer-store.test.mjs`
  - Authored revision-bound exact work → publication → paged rendition traversal coverage.
- `packages/backend/test/index-federated-search.test.mjs`
  - Replaced direct-result happy paths with typed three-stage traversal fixtures; updated tuple, cache (including exact candidate-manifest anchoring), pagination, retained-service refresh, static construction-time and dynamic per-search service bounds, real and injected deadline, abort, expiry, and other bounds assertions. Every test that inspects private cached locators owns an explicit local cache, including the malformed-pagination isolation case.
- `packages/backend/test/index-source-verification.test.mjs` (new)
  - Authored signed external-claim plus publication fixtures, adversarial verification/lifecycle/API cases, a real `createIndexerStore` two-rendition regression that explicitly selects and verifies only the second tuple, a real nullable-index-fact federation → search transport → verification → verified transport/generated-codec regression, and scoped short-range contributor evidence coverage. The fixture signer canonically encodes each operation body with its declared record type, including `CLAIM`. Explicit-code assertions structurally capture promise rejection before checking the code and bounded message. The default never-settling availability probe proves the real referenced verifier deadline remains event-loop-live.
- `packages/backend/test/index-candidate-handler.test.mjs` (new)
  - Authored shared-runtime/mobile adapter parity, deferred verification, bounds, structured error, and forbidden-capability stripping coverage.
- `packages/backend/test/scoped-network-runtime.test.mjs`, `packages/backend/test/scoped-runtime-source-contract.test.mjs`, `packages/spec/test/app-rpc-adapter.test.mjs`
  - Authored production runtime wiring, contained full-range/subrange lease ownership, cached-block peer-evidence/default-fast-path behavior, and generated app-client absent-versus-real-zero reconstruction coverage.
- `packages/spec/test/index-candidate-contract.test.mjs` (new)
  - Authored schema-source/HRPC registration assertions and post-generation codec round trips for minimal nullable/empty and concrete verified candidates.

## Exact verification chain and invariants

1. Resolve only the selected opaque `candidateRef` through the federation-private owner token; reject malformed, expired, evicted, forged, or cross-federation references.
2. Resolve the publisher through the configured local catalog registry.
3. Re-derive `publisherId` from the bound genesis root and require publisher, catalog bootstrap, catalog key, and view key agreement.
4. Decode and canonically verify the current namespace descriptor and authorization state.
5. Capture the exact current catalog head/digest.
6. Load `accepted/<external operation recordId>` by the cached external source reference; require canonical frame bytes and exact record ID.
7. Require that operation’s exact projection identity to resolve to a byte-identical current `projection/claim/<claimId>` frame.
8. Verify its admitted signer, accepted sequence bounds, capability, policy/revocation constraints, and publisher-envelope signature.
9. Decode and verify the embedded signed `ExternalReferenceClaim`; require the exact searched namespace/identifier. Derive the work entity only from the unique current manifest-claim link and require the signed claim to name it; an index-provided work ID is only an annotation.
10. Repeat exact accepted/current/signature/authorization checks independently for the cached publication source reference and `projection/publication/<publicationId>`.
11. Decode the publication payload canonically; verify the manifest signature is authorized by the exact publication operation signer, payload bytes are exact, and manifest/publication IDs are freshly derived and equal the selected tuple.
12. Require the manifest to link the exact current external claim and work entity.
13. Resolve exactly one rendition matching the already-selected `renditionId`; the verifier performs no ranking or rendition choice.
   Index title, work ID, container, and byte-length hints never authorize or veto the source; successful verification replaces them with the exact current signed values.
14. Recreate the canonical rendition descriptor and static asset core reference, reconstructing and checking static key/asset ID, tree hash, block count, block size, and byte length against the selected asset ID.
15. Perform one bounded live `[0,1)` asset-block availability probe through the injected/runtime-owned scoped asset-range seam; require at least one verified contributing peer and return exact fresh bounded evidence with `completeSeeders: 0` because a one-block proof does not establish whole-asset completeness.
16. Refresh the catalog, require unchanged descriptor epoch and byte-derived head/authorization digests, and recheck both exact current projections before returning.
17. Return a deeply immutable `source-verified` candidate whose root-API object is built from explicit safe fields only: namespace/identifier external reference, fixed publication IDs/title, canonical rendition/asset descriptors, current descriptor/head, and fresh evidence. Signed claim extras and arbitrary manifest provenance/claim objects are not copied. It contains no HTTP URL, credential, header, cookie, or control capability.

Independent index observations remain discovery/ranking evidence only. They never authorize a source, and cached index facts are all re-derived from the current publisher projection before source verification succeeds.

## Lifecycle and ownership

- Federation cache entries are random 32-byte base64url references, bounded, expiring, locally owner-tagged, and removed on federation close without touching caller-owned cache entries.
- Federation searches and verifier operations own abort controllers and bounded deadline timers; both search and verifier timers remain referenced while awaited work depends on them and are cleared in `finally`. Every verifier source await has an abort checkpoint, the underlying execute promise is drained before ownership is released, and caller abort/close drain before returning.
- Availability probe promises are tracked independently after the outer timeout can return. Close waits for each delayed retain/request to settle and for its exact owner rollback; a probe races abort around retain/request, awaits any in-flight work, and releases before the task settles.
- The verifier does not close the caller’s catalog registry, scoped network, index services, or cache.
- `createIndexVerificationRuntime` owns verifier-before-federation close ordering and registers exactly one lifecycle cleanup resource; production creates it over a live deterministic bounded view of scoped-runtime-owned retained index services.
- Each scoped availability attempt creates a unique bounded owner token and an exact contained `[0,1)` dependent sublease, even when a full playback lease already owns the same core. Releasing the verifier sublease preserves the exact-scope playback owner; releasing the last exact-scope owner atomically revokes every narrower dependent owner/mode before normal scope teardown cancels work and destroys the broad session/download. Cached local blocks count only after `requirePeerEvidence` obtains and cryptographically verifies a remote response; sends/probes/local presence do not count, and `completeSeeders` remains zero.
- Universal handler transport exposes exactly the bounded candidate records and fixed structured errors; it neither serializes arbitrary JSON nor reflects exception payloads that could contain source URLs or secrets.

## Tests authored (not run)

- Valid current signed claim/publication/rendition/static source verification.
- Real index-store two-rendition traversal, two candidate refs, explicit client application selection of the second, and exact-second verification/probe.
- Forged genesis root, bootstrap binding, catalog key, and descriptor/authorization policy sequence disagreement.
- Wrong operation manifest ID, selected rendition ID, asset/static key, and corrupted canonical frames.
- Retracted external claim, retracted publication, superseded projection, and missing accepted operation.
- Catalog head and epoch mutation during availability probing.
- Expired, forged, evicted, and cross-federation candidate refs.
- Availability timeout, malformed/future/overlong/over-count evidence, unavailable evidence, caller abort, close abort/drain, delayed-retain rollback before close settlement, and caller-cache preservation.
- Deferred root API behavior: search performs typed index traversal but does not resolve catalogs or probe availability until `verifyIndexCandidate` receives client application’s selected ref; adversarial signed claim/provenance URL, cookie, credential, and header fields are absent from the returned root object.
- Real null/unknown index format/byte-length facts survive federation, explicit wire presence encoding, generated decode, and companion reconstruction; false title/work/container/byte-length annotations are corrected rather than treated as publisher authority.
- Default real-timer stalled-service regressions prove both federation and verifier deadlines remain event-loop-live, settle/drain underlying work, and prevent late source lookup continuation. Dynamic retained-service refresh and max-service subset selection are covered.
- Scoped one-block availability uses unique owners, coexists as an exact dependent subrange under a full-range owner, releases only its lease when the full owner remains, and is atomically revoked with all narrower dependents if the last exact-scope owner releases. Regression coverage asserts short-first preservation, full-first fail-closed scope teardown and broad-download destruction, cryptographically verified peer evidence even for a cached local block, the default local fast path, exact contributors with `completeSeeders: 0`, and non-boolean peer-evidence rejection.
- Typed codec round trips, including null publication title/rendition format over paired Protomux and a separate canonical page preserving concrete `Pilot`/`video/mp4` facts, canonical ordering, malformed IDs/revisions, capability checks, durable-revision binding, pagination, request/page bounds, and exact store traversal.
- Universal schema-source/handler coverage, forbidden-field checks, all nullable-uint presence pairs, Hyperschema’s established optional-bool metadata convention, behavioral absent-versus-real-zero companion reconstruction, bounded adapter failures, app RPC classification/normalization, and post-generation minimal/concrete candidate codec round trips.

## Self-review and concerns

- The implementation uses the existing `publication-rendition` relation and an exact bounded `renditionExact` lookup rather than changing generated HyperDB schema artifacts; this avoids schema generation while preserving exact, bounded lookup semantics.
- Availability truth is deliberately narrow: a verified one-block live response establishes fresh bounded peer availability, not completeness of the whole asset; `completeSeeders` is therefore zero for the production scoped probe.
- Production construction now supplies a dynamic bounded view of scoped-runtime-owned retained index-service adapters, the publisher catalog registry, and the scoped range transport to `createIndexVerificationRuntime`; no production unsupported fallback is used.
- Peer availability now means at least one remote peer supplied a canonical proof plus block bytes that passed the existing static-core verification path during this bounded request. A local cached block, successful send, or protocol probe is not evidence.
- A selected publisher must already have an authenticated/bound local catalog; an unknown publisher fails closed with structured `source-invalid`. Obtaining and authenticating a publisher bootstrap locator from an index candidate is intentionally Plan 09 candidate-resolver scope, not authority inferred in Task 2.
- Generated `packages/spec/spec/**` schema/HRPC/app-adapter outputs were deliberately not hand-edited; the parent’s later schema-generation validation refreshed them from the source changes.
- Tests and commands were intentionally not run in this worker session, so validation evidence belongs to the parent session.
