# Plan 06 Task 1 Report

## Status

Implementation complete; validation is intentionally pending under the Task 1 instruction not to run commands, tests, builds, generation, lint, formatting, or typechecking.

## Files changed

- Created `packages/backend/src/indexer/service-announcement.js`.
- Created `packages/backend/src/indexer/protocol.js`.
- Modified `packages/backend/src/indexer/index.js` to expose the Task 1 public announcement and protocol surface from the package entry.
- Modified `packages/backend/src/network/scoped-runtime.js`.
- Modified `packages/backend/src/network/topics.js`.
- Modified `packages/backend/src/network/frame.js` after integration review found that peer-frame encoding lacked the new `index` purpose. `index` now uses unused stable code 7 without colliding with `live` code 4.
- Created `packages/backend/test/index-service-announcement.test.mjs`.
- Created `packages/backend/test/index-service-protocol.test.mjs`.
- Created this report.

`packages/backend/test/scoped-network-runtime.test.mjs` was not changed; the focused direct-peer runtime assertions live in `index-service-protocol.test.mjs`.

## RED tests / prior failures

The tests were authored before the production implementation. They cover the required missing announcement module, missing protocol module, missing `index` hello/topic/capability, missing direct-peer lifecycle, and the pre-existing peer-frame `unknown purpose` integration gap.

No RED command was executed and no failure output is claimed: the task explicitly prohibited commands and tests. Before implementation, the new imports could not resolve and `encodePeerFrame({ purpose: 'index' })` would have thrown `unknown purpose`; these are code-established prior gaps, not observed test-run output.

### Announcement coverage

1. Canonical signed encode/decode round trip and stable re-signing.
2. Body tampering, signature tampering, record-domain mismatch, and signer-derived `indexerId` mismatch.
3. Live transport public-key equality against the signed transport key.
4. Inclusive expiry boundary, rejection after expiry, and future issuance.
5. Stateful monotonic sequence acceptance and replay/lower-sequence rejection.
6. Duplicate, unsupported, and over-limit dimensions.
7. Duplicate, undeclared-dimension, and over-limit shard ranges.
8. Duplicate, unsupported, and over-limit query capabilities.
9. Reversed/equal/empty/non-NFC shard bounds.
10. Announcement, body-field, and trailing-byte ceilings.

### Protocol and runtime coverage

1. Stable peer-frame purpose code 7 round trip for `index`, while `live` continues to round trip as code 4.
2. Handshake-before-use and activation only after a valid scoped hello.
3. Signed transport-key equality checked against the live Noise `remotePublicKey` before channel creation.
4. Required `index-query:v1` scoped capability.
5. Expired and unsupported announcement rejection before channel creation.
6. Lower-of-local-and-remote frame-limit negotiation.
7. Idempotent protocol teardown without closing the caller's connection or index store.
8. `joinPeer()`/`leavePeer()` reference counting across independently signed services sharing one transport key.
9. No global Hyperswarm topic join for an index scope.
10. Monotonic same-transport supersession without `joinPeer()`/`leavePeer()` churn.
11. Announcement timer expiry closing the retained index scope, leaving its direct peer, and preserving its caller-owned store.
12. Channel attachment only on the connection whose live transport identity equals the signed service key.
13. Runtime close releasing the direct peer exactly once while preserving caller-owned connection, store, and swarm.

## Behavior implemented

- `IndexServiceAnnouncementV1` uses a fixed compact-encoding body inside the existing canonical application envelope. It does not use JSON.
- The body cryptographically binds version, protocol major/minor, signer-derived indexer identity, exact 32-byte transport public key, sorted supported dimensions, sorted typed shard ranges, sorted query capabilities, exact 32-byte policy digest, monotonic sequence, `issuedAt`, and `expiresAt`.
- `indexerId` is derived as `BLAKE2b-256("peartube.indexer.id.v1" || signingPublicKey)` and cannot be chosen independently of the envelope signer.
- Encoding rejects noncanonical ordering/bytes, record-domain mismatch, body/envelope mismatch, timestamp mismatch, trailing bytes, duplicate values, unknown values, malformed shard bounds, and all configured ceilings.
- Verification fails closed on canonicalization, record ID, signature, signer/indexer binding, current time, optional expected indexer, optional live transport key, optional local supported dimension/query-capability sets, and optional `Map`-backed sequence/replay state.
- Expiry is valid at `now === expiresAt` and invalid at `now > expiresAt`.
- `attachIndexServiceProtocol({ connection, announcement, indexStore, limits })` first verifies announcement trust, then separately authenticates the signed transport key against the live connection `remotePublicKey`, and only then creates the `peartube/scoped-network/<major>/index` Protomux channel.
- The protocol reuses scoped hello/session admission, requires `index-query:v1`, negotiates the lower bounded frame ceiling, rejects all Task 2 query traffic, closes on expiry or handshake failure, and has idempotent teardown.
- Scoped runtime retains verified index services as direct-only scopes. It calls `swarm.joinPeer(transportPublicKey)` once per referenced transport, filters connection events by the signed key before channel attachment, and calls `swarm.leavePeer(key)` only after the final retained service reference is released.
- Index scopes never call global `swarm.join(topic)`. Network-policy suspension leaves joined direct peers and activation restores them from retained references.
- Expiry, explicit release, supersession, network shutdown, and runtime close deterministically close index sessions/scopes and clear timers. Same-transport supersession closes old sessions and reauthorizes the scope without direct-peer join churn. Runtime close does not close the caller-owned index store, connection, swarm, or general store.
- Peer-frame and scoped-hello purpose code 7 now both identify `index`; existing bootstrap, publisher, asset, live peer-frame, archive, and archive-discovery codes are unchanged.

## Review round 1 fixes

- Index runtime authorization now reads only the exact 32-byte `connection.remotePublicKey`. Signed-looking `info.publicKey` event metadata cannot authorize an index channel; missing/mismatched live keys never create or activate an index channel.
- Retain, release, expiry, and supersession transitions are serialized per `indexerId`. Verification atomically advances the in-process sequence floor before asynchronous teardown, so concurrent different-transport sequence updates cannot let a stale operation overwrite a newer service.
- `attachIndexServiceProtocol` now requires an explicit `limits.sequenceState` `Map`, verifies against a candidate copy, authenticates the live transport, and only then commits the new sequence floor. Repeated and lower announcements cannot attach.
- `packages/backend/src/indexer/index.js` exports the new announcement constants/helpers and `INDEX_SERVICE_PROTOCOL`/`attachIndexServiceProtocol`; focused coverage asserts the package entry.
- Added RED coverage for forged event metadata versus the live Noise key, missing live keys, a controlled concurrent-teardown race, direct attach replay/lower-sequence rejection, required sequence context, and public entry exports.

## Review round 2 fixes

- Runtime close is now a shared idempotent promise that marks the runtime closed synchronously, clears index expiry timers, drains every queued/in-flight per-indexer transition, and only then removes scopes/direct-peer state.
- Queued retains recheck active status when they enter their serialized transition. Different-transport replacements recheck again after awaited teardown and before creating a scope, timer, peer reference, or service record.
- Releases invoked after closure return a deterministic non-retained result without adding another transition. A retain already blocked in teardown rejects once close starts; after close resolves, no index transition can recreate runtime state.
- Added a controlled teardown barrier RED case that starts a replacement, closes concurrently, releases the barrier, and asserts rejection, closed diagnostics, no index scope resurrection, one original peer join, idempotent close, and caller-owned store preservation.

## Review round 3 fixes

- Network policy changes now execute on one serialized tail in invocation order. An overlapping disable must finish leaving peers before a later enable rejoins every retained direct reference, so the final enabled policy cannot retain a service with an effectively departed peer.
- Runtime close marks the runtime closed, clears timers, drains/cancels the policy tail, then drains index transitions before final scope/peer cleanup.
- Protomux incoming pair handlers are registered before filtering an unmatched direct index transport. A server-side connection that arrives while only another index service is retained can therefore pair a later retained signed scope; `attachScope` still enforces its exact live Noise key before channel creation.
- Direct protocol replay floors are now committed only after announcement/transport verification, limits, topic, mux, channel, and local hello setup succeed. The floor is reserved immediately before synchronous open; setup failure rolls back only that reservation and never lowers a newer reentrant floor.
- Added RED barriers for overlapping disable/enable ordering, connection-first/server-pair-later activation, and invalid frame-limit setup followed by a successful same-sequence retry.

## Exact public interfaces

### `packages/backend/src/indexer/service-announcement.js`

- `IndexServiceAnnouncementV1` with `{ version, encode, decode, create, sign, verify }`.
- `createIndexServiceAnnouncement(input, signer)`.
- `signIndexServiceAnnouncement(input, signer)`.
- `encodeIndexServiceAnnouncement(announcement)`.
- `decodeIndexServiceAnnouncement(bytes)`.
- `encodeIndexServiceAnnouncementBody(body)`.
- `decodeIndexServiceAnnouncementBody(bytes)`.
- `verifyIndexServiceAnnouncement(announcement, options)`.
- `deriveIndexerId(signingPublicKey)`.
- Version, domain, record-type, supported-value, and byte/count ceiling constants used by focused tests and callers.

`verifyIndexServiceAnnouncement` options are `now`, `remotePublicKey`, `expectedIndexerId`, `supportedDimensions`, `supportedQueryCapabilities`, and optional mutable `sequenceState: Map<indexerIdHex, sequence>`.

### `packages/backend/src/indexer/protocol.js`

- `INDEX_SERVICE_PROTOCOL`.
- `attachIndexServiceProtocol({ connection, announcement, indexStore, limits })`.


`limits.sequenceState: Map<indexerIdHex, sequence>` is required. The returned handle exposes read-only `state`, negotiated `maxFrameBytes`, `channel`, `receive(encoded)`, and idempotent `close(reason)`.

### Network integration

- `INDEX_QUERY_CAPABILITY = 'index-query:v1'` from `network/scoped-runtime.js`.
- `deriveIndexTopic({ protocolMajor, indexerId })` and `describeScopedTopic('index', input)` from `network/topics.js`.
- Runtime methods `retainIndexService({ announcement, indexStore, limits })` and `releaseIndexService({ indexerId })`, also exposed by `createScopedNetworkApi`.
- All announcement/protocol exports above are re-exported from `packages/backend/src/indexer/index.js`.

## Explicit non-goals

- No index query request/page/error/cancel codecs.
- No query dispatch or index-store reads.
- No Task 2 client, query correlation, pagination, or cancellation.
- No bootstrap announcement publication, catalog registration, federation, locator anti-entropy, search ranking, or result union/deduplication.
- No global index-service discovery.
- No `@hyperswarm/rpc`, dependency, generated schema, host, platform, UI, or unrelated runtime change.
- No ownership transfer for connection, store, swarm, or index store.

## Blockers / concerns

- No implementation blocker remains.
- `index` uses newly allocated purpose code 7 in both scoped hello and peer frames. Focused coverage also asserts that the existing peer-frame `live` purpose remains code 4, preventing a decode collision.
- Query messages deliberately fail closed until Plan 06 Task 2 adds its bounded typed codecs and dispatch.
- Runtime sequence floors are process-lifetime state in Task 1. Durable announcement replay floors belong to the later discovery/anti-entropy persistence work.

## Validation pending

Per instruction, no command or test was run by this worker. Parent validation remains pending for:

Parent's first focused run exposed a test-fixture error before the protocol assertion: the intended expired announcement used `expiresAt === issuedAt`, which canonical creation correctly rejects. The fixture now signs a valid historical interval (`issuedAt < expiresAt < verification now`); the focused rerun remains pending.

Review round 1 fixes have not been rerun. Parent validation remains pending after the live-key, transition-serialization, direct replay-context, and package-export changes.

Review round 2 close-race fixes have not been rerun. Parent validation remains pending for the controlled teardown/close regression and existing focused suites.

Review round 3 policy/pair/setup-order fixes have not been rerun. Parent validation remains pending for the new overlap, incoming-pair, and replay-floor rollback regressions.

- `packages/backend/test/index-service-announcement.test.mjs`
- `packages/backend/test/index-service-protocol.test.mjs`
- `packages/backend/test/scoped-network-runtime.test.mjs`
- Any broader compatibility check the parent selects for the peer-frame purpose-table change.
