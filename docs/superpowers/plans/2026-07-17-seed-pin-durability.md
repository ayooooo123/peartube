# Seed-Pin Durability Transport Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a newly imported item public only after one trusted relay/paired device or two ordinary peers demonstrably hold every required Hypercore range.

**Architecture:** Build a versioned Protomux seed-pin protocol on the existing authenticated backend swarm stream, share its receiver registration between Node and Bare relay startup paths, persist relay pin state, and aggregate verified full-range holders across every required media/artwork ref before advancing the publication state machine from plan 1.

**Tech Stack:** Node.js/Bare-compatible ESM, Protomux, compact-encoding, Corestore/Hypercore remote bitfields, Hyperbee metadata, Brittle

**Spec:** `docs/superpowers/specs/2026-07-17-peartube-add-cli-design.md` sections “Peer seeding request” and “Verified Secondary Seeding”

**Depends on:** `docs/superpowers/plans/2026-07-17-content-persistence-publication.md`

---

## Chunk 1: Aggregate Durability Semantics

### Task 1: Extract aggregate full-copy assessment

**Files:**
- Create: `packages/backend/src/durability/aggregate-assessment.js`
- Modify: `packages/backend/src/api.js:828-850,4063-4110`
- Modify: `packages/backend/src/index.js`
- Create: `packages/backend/test/aggregate-durability.test.mjs`

- [ ] **Step 1: Write failing aggregate-holder tests**

Model required refs and each ref’s verified holder keys:

```js
const refs = [
  { coreKey: 'aa', start: 0, end: 10, kind: 'media' },
  { coreKey: 'bb', start: 2, end: 4, kind: 'thumbnail' }
]
const observations = new Map([
  ['aa:0:10', new Set(['peer-1', 'peer-2'])],
  ['bb:2:4', new Set(['peer-1'])]
])

assert.deepEqual(intersectFullCopyHolders(refs, observations), new Set(['peer-1']))
```

Cover false positives where media is on peer A and thumbnail is on peer B; the result must have zero qualifying complete-item holders.

- [ ] **Step 2: Run and observe missing module**

Run: `npm exec -- brittle test/aggregate-durability.test.mjs` from `packages/backend`

Expected: FAIL with module not found.

- [ ] **Step 3: Implement pure aggregation and policy**

Export:

```js
export function canonicalizeDurabilityRefs(refs) { /* validate, sort, dedupe */ }
export function intersectFullCopyHolders(refs, observations) { /* same holder set across all refs */ }
export function evaluateDurabilityPolicy({ holderKeys, trustedRelayKeys, pairedDeviceKeys, ordinaryRequired = 2 }) {
  const trusted = holderKeys.filter((key) => trustedRelayKeys.has(key))
  const paired = holderKeys.filter((key) => pairedDeviceKeys.has(key))
  const ordinary = holderKeys.filter((key) => !trustedRelayKeys.has(key) && !pairedDeviceKeys.has(key))
  return { eligible: trusted.length >= 1 || paired.length >= 1 || ordinary.length >= ordinaryRequired, trusted, paired, ordinary }
}
```

Reject partial/open-ended refs and invalid range order.

- [ ] **Step 4: Refactor `assessUploadOffload` to reuse the policy**

Preserve the existing API response. Add an internal/exported `assessDurableManifest(refs, trust)` that reads per-core peer objects, records verified full-range holders, intersects them, then calls the pure policy. Do not trust soft receipts.

- [ ] **Step 5: Run focused durability regressions**

```bash
npm exec -- brittle test/aggregate-durability.test.mjs test/upload-offload.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit aggregate assessment**

```bash
git add packages/backend/src/durability/aggregate-assessment.js packages/backend/src/api.js packages/backend/src/index.js packages/backend/test/aggregate-durability.test.mjs
git commit -m "feat(backend): verify aggregate upload durability"
```

### Task 2: Define durable manifest and request authentication

**Files:**
- Create: `packages/backend/src/seed-pin/manifest.js`
- Create: `packages/backend/src/seed-pin/auth.js`
- Create: `packages/backend/test/seed-pin-auth.test.mjs`

- [ ] **Step 1: Write failing canonicalization and auth tests**

Build a fixed identity, live Noise key, descriptor proof, manifest refs, and expiry. Assert:

- semantically identical reordered refs produce the same request ID
- a changed range changes the ID/signature
- expired requests fail
- descriptor identity mismatch fails
- attested requester device key mismatch fails
- live remote Noise key mismatch fails
- replay of the same valid request ID remains verifiable/idempotent

- [ ] **Step 2: Run and verify modules are absent**

Run: `npm exec -- brittle test/seed-pin-auth.test.mjs`

Expected: FAIL.

- [ ] **Step 3: Implement a canonical manifest**

```js
export function createDurableManifest({ channelKey, rowId, refs }) {
  const normalizedRefs = canonicalizeDurabilityRefs(refs)
  return {
    version: 1,
    channelKey: normalizeHex(channelKey),
    rowId: String(rowId),
    refs: normalizedRefs,
    requestId: sha256Canonical({ channelKey, rowId, refs: normalizedRefs })
  }
}
```

Include complete media, thumbnail, and required staged channel artwork refs; omit artwork only when explicitly absent.

- [ ] **Step 4: Implement identity-attested live-device authentication**

Requester signs canonical `{ requestId, manifest, expiresAt }` using `IdentityKey.attestData(payload, ctx.swarm.keyPair, descriptorProof)`. Receiver verifies with `IdentityKey.verify`, requires descriptor identity equality, requires verified device/requester key equality with the live remote Noise public key, and rejects expired payloads.

- [ ] **Step 5: Run auth tests**

Expected: PASS.

- [ ] **Step 6: Commit manifest/auth**

```bash
git add packages/backend/src/seed-pin/manifest.js packages/backend/src/seed-pin/auth.js packages/backend/test/seed-pin-auth.test.mjs
git commit -m "feat(backend): define authenticated seed pin manifests"
```

## Chunk 2: Pin Storage and Protomux Transport

### Task 3: Persist accepted relay pins and seed requested ranges

**Files:**
- Create: `packages/backend/src/seed-pin/pin-store.js`
- Create: `packages/backend/src/seed-pin/pin-worker.js`
- Create: `packages/backend/test/seed-pin-worker.test.mjs`

- [ ] **Step 1: Write failing pin lifecycle tests**

Using temporary Corestores, assert:

- accepted request and refs survive store recreation
- request ID replay returns the existing status
- worker opens each requested core and waits for exact ranges
- progress records update monotonically
- complete status means every ref is locally available
- cancel/release removes retention only when policy permits
- quota failure is explicit and never marked complete

- [ ] **Step 2: Run and observe missing modules**

Run: `npm exec -- brittle test/seed-pin-worker.test.mjs`

Expected: FAIL.

- [ ] **Step 3: Implement metadata storage**

Use the relay runtime’s existing metadata Hyperbee, with versioned key prefixes:

```text
seed-pin/v1/request/<requestId>
seed-pin/v1/channel/<channelKey>/<requestId>
```

Store canonical manifest, requester identity/device keys, accepted/updated timestamps, status, error, and per-ref downloaded byte counts. Never store identity secret material.

- [ ] **Step 4: Implement bounded worker execution**

`PinWorker` accepts a configured concurrency and capacity policy. For each ref, open the Corestore core by key, request exactly `[start,end)`, wait until local bitfield confirms every block, retain a session/core reference while pinned, and checkpoint progress. On restart, resume accepted/downloading requests.

- [ ] **Step 5: Run worker tests**

Expected: PASS.

- [ ] **Step 6: Commit pin storage**

```bash
git add packages/backend/src/seed-pin/pin-store.js packages/backend/src/seed-pin/pin-worker.js packages/backend/test/seed-pin-worker.test.mjs
git commit -m "feat(backend): persist and execute relay seed pins"
```

### Task 4: Implement the versioned seed-pin protocol

**Files:**
- Create: `packages/backend/src/seed-pin/protocol.js`
- Create: `packages/backend/src/seed-pin/client.js`
- Create: `packages/backend/src/seed-pin/server.js`
- Create: `packages/backend/src/seed-pin/index.js`
- Modify: `packages/backend/package.json:8-47`
- Create: `packages/backend/test/seed-pin-protocol.test.mjs`

- [ ] **Step 1: Write failing in-memory protocol tests**

Create paired duplex streams/Protomux connections. Assert:

- `PIN_REQUEST` carries request ID, canonical manifest, expiry, signed channel descriptor, requester identity key, and an `IdentityKey.attestData` authorization over the canonical request digest
- the verified attestation device key must equal the live connection’s remote Noise/swarm public key
- descriptor identity/channel, authorization identity, manifest channel, request ID, expiry, and manifest digest must all bind to one request
- accepted response contains stable status
- progress/status queries correlate by request ID and may be made only by the authenticated original requester
- wrong live peer key, invalid/tampered attestation, identity/channel mismatch, altered manifest, expiry, policy rejection, and capacity exhaustion produce explicit codes
- exact replay is idempotent; a reused request ID with any different authenticated body is rejected without storage/allocation
- disconnect/reconnect on the same authenticated device and `resume()` recover status

- [ ] **Step 2: Run and verify protocol is absent**

Run: `npm exec -- brittle test/seed-pin-protocol.test.mjs`

Expected: FAIL.

- [ ] **Step 3: Implement a compact, versioned wire contract**

Protocol name: `peartube/seed-pin/1`.

Messages:

```js
{
  request: {
    requestId,
    manifest,
    expiresAt,
    descriptor,
    requesterIdentityKey,
    authorizationAttestation
  },
  response: { requestId, accepted, status, code, error },
  statusRequest: { requestId, requesterIdentityKey, authorizationAttestation },
  statusResponse: { requestId, status, refs, complete, code, error }
}
```

Use `compact-encoding`; enforce maximum ref counts/string sizes before allocation. Define one canonical authorization payload containing protocol version, request ID, canonical manifest digest, channel key, requester identity key, and expiry. The client attests this payload with `IdentityKey.attestData(payload, ctx.swarm.keyPair, activeIdentityDeviceProof)`. Never transmit or persist a device secret key.

- [ ] **Step 4: Implement client correlation and resume**

Maintain one request map per connected mux. Reject pending calls on stream close with a retryable transport error, not success. `resume(requestIds)` re-attests status requests on the reconnected live swarm key and re-queries persisted accepted requests; it cannot transfer request ownership to another device.

- [ ] **Step 5: Implement server admission and storage delegation**

Before admission or allocation, the server verifies the signed channel descriptor, verifies the authorization attestation with `IdentityKey.verify(..., { expectedIdentity: requesterIdentityKey })`, compares the verified attested device public key byte-for-byte with the connection’s remote Noise/swarm public key, and checks every request/channel/manifest/digest/expiry binding. It keys replay storage by authenticated identity + request ID + authorization digest. Only then apply relay channel/owner admission and capacity policy, store accepted requests, and start/query the pin worker. Status requests repeat live-device authentication and must match persisted ownership. Do not mix replication-range verification into the wire server.

- [ ] **Step 6: Run protocol tests**

Expected: PASS.

- [ ] **Step 7: Commit transport**

```bash
git add packages/backend/src/seed-pin packages/backend/package.json packages/backend/test/seed-pin-protocol.test.mjs
git commit -m "feat(backend): add seed pin Protomux protocol"
```

## Chunk 3: Universal Registration and Publication Barrier

### Task 5: Register the receiver in backend and relay startup paths

**Files:**
- Modify: `packages/backend/src/orchestrator.js:1-240`
- Create: `packages/backend/src/seed-pin/admission.js`
- Create: `packages/backend/test/seed-pin-admission.test.mjs`
- Modify: `packages/cli/src/runtime.js:90-270`
- Create: `packages/cli/src/seed-pin-admission.js`
- Modify: `packages/cli/src/config.js:34-80,420-530,619-630`
- Modify: `packages/cli/src/constants.js:34-80`
- Modify: `packages/cli/config.example.yml`
- Create: `packages/cli/test/seed-pin-runtime.test.mjs`
- Create: `packages/cli/test/seed-pin-admission.test.mjs`
- Modify: `packages/cli/scripts/run-tests.mjs`

- [ ] **Step 1: Write failing shared-registration tests**

Stub `registerSeedPinProtocol` and assert it is called:

- after Corestore/swarm initialization and before discovery in backend orchestrator
- after relay storage initialization and before `publicFeed.start()` in `createRelayRuntime`
- with admission/capacity policy in relay mode
- with the active identity’s stored swarm-device proof for authenticated client requests
- on existing connections and future swarm connections without duplicate mux pairs
- with `ctx.trustedRelayKeys` populated from existing `network.trustedRelayKeys` plus persisted relay links; those same keys drive blind-peer/discovery connection attempts and durability eligibility
- backend receiver admission accepts only a valid attested device whose requester identity is one of the local owned identities and whose channel is locally owned/paired; a foreign identity, unpaired channel, or bare remote key allowlist match is rejected

This prevents fixing only one Node/Bare startup path and proves the trusted one-relay path is reachable from configuration/link state rather than only from a test fixture.

- [ ] **Step 2: Run focused backend and CLI tests**

```bash
npm --prefix packages/backend exec -- brittle test/seed-pin-admission.test.mjs
./node_modules/.bin/brittle test/seed-pin-runtime.test.mjs
./node_modules/.bin/brittle test/seed-pin-admission.test.mjs
```

Expected: FAIL.

- [ ] **Step 3: Add explicit relay configuration**

Add defaults and config normalization for:

```yaml
seedPin:
  enabled: true
  maxBytes: 536870912000
  maxConcurrent: 2
  retentionDays: 30
  trustedClients: []
```

`packages/backend/src/seed-pin/admission.js` implements the backend default paired-own-device policy from authenticated identity/channel facts; it never accepts an arbitrary network peer merely because transport authentication passed. The CLI relay factory applies relay mode, allowlist/owner admission, capacity, retention, and trusted-client configuration. Reject invalid/negative relay values during config resolution.

- [ ] **Step 4: Register in both runtime paths**

Call the same `registerSeedPinProtocol(ctx, { admission, store, worker })` API from backend orchestrator and `createRelayRuntime`. The orchestrator constructs the backend paired-own-device admission from `identityManager`/owned channels; the relay runtime constructs the configured relay admission. Registration must attach to existing connections and subscribe to future swarm connections without replacing Corestore replication. Sender registration creates clients only after the connection remote key is known and exposes connected clients keyed by that authenticated swarm key. Preserve existing `network.trustedRelayKeys`, persisted relay-link, and blind-peer discovery plumbing; do not add a second trust store.

- [ ] **Step 5: Register and run CLI/runtime tests**

Add both CLI files to `TEST_FILES` in `scripts/run-tests.mjs`, then run all three focused files as above. Expected: PASS.

- [ ] **Step 6: Commit universal registration**

```bash
git add packages/backend/src/orchestrator.js packages/backend/src/seed-pin/admission.js packages/backend/test/seed-pin-admission.test.mjs packages/cli/src/runtime.js packages/cli/src/seed-pin-admission.js packages/cli/src/config.js packages/cli/src/constants.js packages/cli/config.example.yml packages/cli/test/seed-pin-runtime.test.mjs packages/cli/test/seed-pin-admission.test.mjs packages/cli/scripts/run-tests.mjs
git commit -m "feat(p2p): register seed pins in backend and relay runtimes"
```

### Task 6: Drive immediate pinning and verified publication

**Files:**
- Create: `packages/backend/src/content-replication.js`
- Modify: `packages/backend/src/index.js`
- Modify: `packages/backend/package.json`
- Create: `packages/backend/test/content-replication.test.mjs`

- [ ] **Step 1: Write failing orchestration tests**

Against fakes, verify this state sequence:

```text
replicationPending -> PIN_REQUEST accepted -> remote full ranges observed
-> durabilityVerified -> projected -> announced -> published
```

Cover:

- one configured or persisted trusted relay is connected, authenticated, and passes
- one paired device passes
- one ordinary peer does not pass
- two ordinary peers holding every ref pass
- split holders across refs do not pass
- a complete but untrusted relay receipt/range observation does not satisfy the one-trusted-relay branch
- disconnect after soft acceptance remains pending
- restart resumes status/assessment without uploading media again
- announce failure remains at `announcing`/`projected`, retries the announcement, then finalizes exactly once

- [ ] **Step 2: Run and verify module is absent**

Run: `npm exec -- brittle test/content-replication.test.mjs`

Expected: FAIL.

- [ ] **Step 3: Implement bounded publication orchestration**

`createContentReplication` receives the plan-1 publication primitives, connected seed-pin clients, durable-manifest builder, aggregate assessor, and checkpoint callbacks. It must:

1. submit pin requests to eligible connected peers;
2. poll/resume status only to know when full-copy verification may be worthwhile;
3. verify actual remote Hypercore ranges using aggregate assessment;
4. mark durable, project, announce, and finalize idempotently;
5. return `replicationPending` when policy cannot pass;
6. never call a bypass/publish-anyway path.

Keep queue persistence outside this module; plan 4 supplies durable checkpoints.

- [ ] **Step 4: Emit structured progress**

Return/emit stable phases and byte totals:

```js
{ phase: 'replicating', peerKey, completedBytes, totalBytes }
{ phase: 'verifying', qualifyingHolders, requiredHolders }
{ phase: 'announcing' }
{ phase: 'published' }
```

- [ ] **Step 5: Run tests**

```bash
npm exec -- brittle test/content-replication.test.mjs test/aggregate-durability.test.mjs test/content-publication.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit publication barrier**

```bash
git add packages/backend/src/content-replication.js packages/backend/src/index.js packages/backend/package.json packages/backend/test/content-replication.test.mjs
git commit -m "feat(backend): require verified seeding before publication"
```

### Task 7: Run an end-to-end two-process durability smoke

**Files:**
- Create: `packages/backend/test/fixtures/seed-pin-smoke.mjs`
- Create: `packages/backend/test/seed-pin-integration.test.mjs`

- [ ] **Step 1: Write the integration harness**

Launch an uploader backend and a relay backend with temporary storage and direct test transport. Configure or persist the relay swarm key in the uploader’s existing trusted-relay/link path before startup, prove it populates `ctx.trustedRelayKeys`, upload a small deterministic fixture as `replicationPending`, connect and authenticate the relay, request its complete media/thumbnail refs, and await verified public projection.

- [ ] **Step 2: Assert real range possession**

Read the uploader’s assessment and the relay’s opened cores. Assert the live authenticated remote key equals the configured trusted relay key and is in the intersection of full-copy holders for every ref; do not assert only protocol `complete` status.

- [ ] **Step 3: Test interruption**

Disconnect mid-transfer. Assert the private draft remains, no public video/feed entry exists, and local uploader bytes remain. Reconnect, reopen the relay store, resume, and assert publication occurs once.

- [ ] **Step 4: Run the integration smoke**

Run from `packages/backend`:

```bash
npm exec -- brittle test/seed-pin-integration.test.mjs
```

Expected: PASS with one published item and verified relay ranges.

- [ ] **Step 5: Run touched regression suites**

From `packages/backend`:

```bash
npm exec -- brittle test/upload-offload.test.mjs test/content-replication.test.mjs test/seed-pin-protocol.test.mjs test/seed-pin-worker.test.mjs
```

From `packages/cli`:

```bash
./node_modules/.bin/brittle test/seed-pin-runtime.test.mjs
./node_modules/.bin/brittle test/seed-pin-admission.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit integration coverage**

```bash
git add packages/backend/test/fixtures/seed-pin-smoke.mjs packages/backend/test/seed-pin-integration.test.mjs
git commit -m "test(p2p): verify immediate relay handoff durability"
```

## Plan 2 Completion Gate

The slice is complete only when Node and Bare-compatible startup paths register the same receiver, accepted pins survive restart, actual remote ranges—not receipts—prove a same-holder complete item, interruption leaves content private, and reconnect completes publication exactly once.
