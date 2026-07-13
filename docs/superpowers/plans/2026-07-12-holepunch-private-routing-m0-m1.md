# Holepunch Private Routing Milestones 0–1 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an independently testable, socket-free `hyperdht-private-routes` package containing the experimental protocol vocabulary, authenticated descriptors and cells, privacy-domain authorization, bounded relay state, and a deterministic compiled-route simulator.

**Architecture:** Incubate the standalone package at `packages/private-routes` without wiring it into PearTube, HyperDHT, Hyperswarm, or UDX. Production modules accept injected clocks, randomness, and link transports; tests compose them with a deterministic virtual network and verify each node's permitted view. The prototype uses Holepunch-compatible JS primitives but labels every wire constant experimental until external cryptographic review.

**Tech Stack:** ESM JavaScript, Bare/Node, Brittle, `b4a`, `compact-encoding`, `hypercore-crypto`, `sodium-universal`, Prettier Holepunch config, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-07-12-holepunch-private-routing-design.md`

---

## File Map

Create an independently installable package; do not add it to the root dependency graph yet.

| Path | Responsibility |
| --- | --- |
| `packages/private-routes/index.js` | Small supported export surface only |
| `packages/private-routes/lib/errors.js` | Stable fail-closed error codes |
| `packages/private-routes/lib/protocol.js` | Experimental version, cell classes, deterministic relay roles, domain labels |
| `packages/private-routes/lib/crypto-suite.js` | Injectible signing, hashing, key agreement, KDF, and AEAD adapter |
| `packages/private-routes/lib/descriptor.js` | Endpoint delegation and private-route descriptor codecs/verification |
| `packages/private-routes/lib/privacy-domains.js` | Accumulated provenance and per-operation authorization |
| `packages/private-routes/lib/counters.js` | Ordered receivers and unordered sliding replay windows |
| `packages/private-routes/lib/cell-codec.js` | Fixed-size authenticated cell seal/open and payload bounds |
| `packages/private-routes/lib/route-payload.js` | End-to-end fixed-size ciphertext relays cannot decrypt |
| `packages/private-routes/lib/fragments.js` | Bounded message fragmentation and ordered reassembly |
| `packages/private-routes/lib/relay-service.js` | Bounded route-local forward/reverse bindings and teardown |
| `packages/private-routes/lib/link-setup.js` | Adjacent-hop authenticated key exchange and opaque binding tickets |
| `packages/private-routes/lib/activation.js` | Nested private instructions and authenticated CREATE/CREATED transcripts |
| `packages/private-routes/lib/activation-fragments.js` | Pre-OPEN ordered control fragmentation with bounded cleanup |
| `packages/private-routes/lib/route-manager.js` | Path validation, activation, readiness, draining, and fail-closed state |
| `packages/private-routes/lib/virtual-network.js` | Clock-injected links, packet trace, and deterministic fault injection |
| `packages/private-routes/test/helpers.js` | Seeded identities, clocks, routes, and assertion helpers |
| `packages/private-routes/test/*.test.js` | Brittle unit, property, adversarial, and virtual end-to-end tests |
| `packages/private-routes/fuzz/cell.js` | Reproducible standalone cell mutation harness |
| `packages/private-routes/docs/protocol.md` | Milestone 0 normative vocabulary/state machines and experimental suite |
| `packages/private-routes/docs/threat-model.md` | Claims, observer views, exclusions, and flow matrix |
| `.github/workflows/private-routes.yml` | Path-filtered Node and Bare package CI |

Do not create DHT gateway, UDX, HyperDHT, Hyperswarm, Hypercore, PearTube UI, or mobile integration files in this plan.

## Chunk 1: Protocol Foundation

### Task 1: Scaffold the independent experimental package and RFC documents

**Files:**
- Create: `packages/private-routes/package.json`
- Create: `packages/private-routes/package-lock.json`
- Create: `packages/private-routes/.gitignore`
- Create: `packages/private-routes/.prettierrc`
- Create: `packages/private-routes/README.md`
- Create: `packages/private-routes/docs/protocol.md`
- Create: `packages/private-routes/docs/threat-model.md`

- [ ] **Step 1: Create the package manifest without runtime integration**

Use this manifest:

```json
{
  "name": "hyperdht-private-routes",
  "version": "0.0.0",
  "private": true,
  "description": "Experimental private-route overlay for the Holepunch stack",
  "type": "module",
  "main": "./index.js",
  "exports": {
    ".": "./index.js"
  },
  "files": [
    "index.js",
    "lib",
    "docs",
    "README.md"
  ],
  "scripts": {
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "test": "brittle test/*.test.js",
    "test:node": "brittle-node test/*.test.js",
    "test:one": "brittle-node",
    "test:bare": "brittle-bare test/*.test.js",
    "fuzz:cell": "node fuzz/cell.js"
  },
  "dependencies": {
    "b4a": "^1.8.0",
    "compact-encoding": "^2.19.2",
    "hypercore-crypto": "^3.6.1",
    "sodium-universal": "^5.0.0"
  },
  "devDependencies": {
    "bare-runtime": "1.30.3",
    "brittle": "^3.19.1",
    "prettier": "^3.6.2",
    "prettier-config-holepunch": "^2.0.0"
  }
}
```

Keep `private: true` until the protocol and cryptography are independently reviewed. `.gitignore` must contain `node_modules/`, `coverage/`, and `fuzz/corpus/`; `.prettierrc` must contain only `"prettier-config-holepunch"`.

- [ ] **Step 2: Install only this package and commit its lockfile**

Run: `npm install --prefix packages/private-routes`

Expected: exit 0; `packages/private-routes/package-lock.json` is created; no root lockfile changes.

- [ ] **Step 3: Write the Milestone 0 protocol RFC**

`docs/protocol.md` must normatively define:

- protocol status `EXPERIMENTAL`, version `0`, and no compatibility promise;
- terms: endpoint identity, relay identity, Safety Route, Private Route, compiled route, guard, DHT gateway, circuit, descriptor, cell, epoch;
- deterministic relay role: `BLAKE2b-256("hyperdht-private-routes/role/v0" || identityPublicKey)[0] & 1` (`0 = safety`, `1 = private`);
- direct endpoint signature or endpoint-signed delegation certificate requirements;
- `CREATE → CREATED → OPEN → DRAINING → DESTROYED` state transitions;
- ordered control/stream counter rules and unordered datagram replay-window rules;
- authenticated close, timeout, expiry, counter exhaustion, and key erasure;
- prototype suite: Ed25519 signatures, X25519 key agreement, keyed BLAKE2b transcript/KDF labels, XChaCha20-Poly1305 cells;
- explicit statement that constants are testable prototype parameters, not an audited stable wire format.

- [ ] **Step 4: Write the package threat model and README**

Copy the approved claims and role/phase flow matrix from the spec, including these exact limitations:

- the guard sees the source IP;
- the final private relay sees the destination IP;
- a DHT gateway sees DHT keys/topics, operation type, timing, and size;
- separate identities controlled by one operator count as collusion/Sybil behavior;
- global timing correlation, ordinary HTTP/HTTPS, DNS, and Tor-level anonymity are out of scope;
- failure never enables direct dialing or hole punching.

README usage must say “virtual protocol core only—no real network privacy yet” and document independent commands under `packages/private-routes`.

- [ ] **Step 5: Verify formatting and package isolation**

Run: `npm run format --prefix packages/private-routes`

Expected: exit 0.

Run: `git status --short`

Expected: only the new plan/package files and later planned workflow are changed; no existing package or root lockfile is modified.

- [ ] **Step 6: Commit the scaffold and RFC**

```bash
git add packages/private-routes/package.json packages/private-routes/package-lock.json packages/private-routes/.gitignore packages/private-routes/.prettierrc packages/private-routes/README.md packages/private-routes/docs
git commit -m "docs: define experimental private route protocol"
```

### Task 2: Lock protocol constants, error codes, and deterministic relay roles with tests

**Files:**
- Create: `packages/private-routes/lib/errors.js`
- Create: `packages/private-routes/lib/protocol.js`
- Create: `packages/private-routes/test/protocol.test.js`
- Create: `packages/private-routes/test/helpers.js`

- [ ] **Step 1: Write failing tests for stable errors and relay roles**

```js
import test from 'brittle'
import b4a from 'b4a'
import { PrivateRouteError, roleForIdentity, ROLE } from '../index.js'

test('relay role is deterministic and binary', (t) => {
  const identity = b4a.alloc(32, 7)
  const first = roleForIdentity(identity)
  t.is(first, roleForIdentity(identity))
  t.is(first, ROLE.PRIVATE, 'v0 known-answer identity 07…07 hashes to private')
  t.ok(first === ROLE.SAFETY || first === ROLE.PRIVATE)
})

test('invalid relay identities fail closed with stable code', (t) => {
  let err = null
  try {
    roleForIdentity(b4a.alloc(31))
  } catch (cause) {
    err = cause
  }
  t.is(err.code, 'INVALID_IDENTITY')
  t.ok(err instanceof PrivateRouteError)
})

test('v0 wire enums and domains are exact known answers', (t) => {
  t.alike(ROLE, { SAFETY: 0, PRIVATE: 1 })
  t.alike(CELL_CLASS, { CONTROL: 0, STREAM: 1, DATAGRAM: 2 })
  t.alike(DIRECTION, { FORWARD: 0, REVERSE: 1 })
  t.alike(CIRCUIT_STATE, { CREATE: 0, CREATED: 1, OPEN: 2, DRAINING: 3, DESTROYED: 4 })
  t.alike(CAPABILITY, { FORWARD: 1, DATAGRAM: 2, STREAM: 4, KNOWN: 7 })
  const expectedDomains = {
    ROLE: 'hyperdht-private-routes/role/v0',
    RELAY_ADVERTISEMENT: 'hyperdht-private-routes/relay-advertisement/v0',
    DESCRIPTOR_DIRECT: 'hyperdht-private-routes/descriptor/direct/v0',
    DELEGATION: 'hyperdht-private-routes/delegation/v0',
    DESCRIPTOR_DELEGATED: 'hyperdht-private-routes/descriptor/delegated/v0',
    KDF_FORWARD_KEY: 'hyperdht-private-routes/kdf/v0/forward-key',
    KDF_REVERSE_KEY: 'hyperdht-private-routes/kdf/v0/reverse-key',
    KDF_FORWARD_NONCE: 'hyperdht-private-routes/kdf/v0/forward-nonce',
    KDF_REVERSE_NONCE: 'hyperdht-private-routes/kdf/v0/reverse-nonce',
    LINK_CREATE: 'hyperdht-private-routes/link/create/v0',
    LINK_CREATED: 'hyperdht-private-routes/link/created/v0',
    TEMPLATE_REGISTER: 'hyperdht-private-routes/template/register/v0',
    TEMPLATE_REGISTERED: 'hyperdht-private-routes/template/registered/v0',
    ACTIVATE_CREATE: 'hyperdht-private-routes/activate/create/v0',
    ACTIVATE_ENTRY_PROOF: 'hyperdht-private-routes/activate/entry-proof/v0',
    ACTIVATE_DESTINATION_PROOF: 'hyperdht-private-routes/activate/destination-proof/v0',
    ACTIVATE_CHALLENGE: 'hyperdht-private-routes/activate/challenge/v0',
    ACTIVATE_PARAMETERS: 'hyperdht-private-routes/activate/parameters/v0',
    CELL_HEADER: 'hyperdht-private-routes/cell/header/v0',
    ROUTE_PAYLOAD: 'hyperdht-private-routes/route-payload/v0'
  }
  t.alike(Object.fromEntries(Object.entries(DOMAIN).map(([key, value]) => [key, b4a.toString(value)])), expectedDomains)
})

test('every stable constructor exposes only its declared code', (t) => {
  const expectedCodes = [
    'INVALID_IDENTITY', 'INVALID_KEY', 'INVALID_ROLE', 'INVALID_ROUTE',
    'INVALID_DESCRIPTOR', 'UNAUTHORIZED', 'REPLAY', 'COUNTER_INVALID',
    'COUNTER_GAP', 'COUNTER_EXHAUSTED', 'CELL_INVALID', 'CIRCUIT_LIMIT',
    'CIRCUIT_STATE', 'ROUTE_UNAVAILABLE', 'VIRTUAL_LIMIT'
  ]
  t.alike(ERROR_CODES, expectedCodes)
  for (const code of expectedCodes) {
    const err = PrivateRouteError[code]()
    t.is(err.code, code)
    t.is(err.name, 'PrivateRouteError')
    t.is(/[0-9a-f]{32}|(?:\d{1,3}\.){3}\d{1,3}/i.test(err.message), false)
  }
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm run test:one --prefix packages/private-routes -- test/protocol.test.js`

Expected: FAIL because `../index.js` and protocol exports do not exist.

- [ ] **Step 3: Implement only the tested protocol vocabulary**

`lib/protocol.js` exports the exact frozen enums, capability map, literal ordered error-code array, and complete domain map in the failing test, plus `PROTOCOL_VERSION = 0` and `roleForIdentity(publicKey)`. Validate 32-byte `b4a` buffers before hashing. Use `hypercore-crypto.hash([DOMAIN.ROLE, publicKey])` and the low bit of byte zero.

`lib/errors.js` exports `PrivateRouteError` plus constructors for the literal tested codes, including test-harness-only `VIRTUAL_LIMIT`. Error messages must not contain keys, addresses, or full routes.

Create `index.js` exporting only supported symbols, not internal helpers.

- [ ] **Step 4: Run RED test to GREEN, then run all current tests**

Run: `npm run test:one --prefix packages/private-routes -- test/protocol.test.js`

Expected: PASS.

Run: `npm test --prefix packages/private-routes`

Expected: PASS with no warnings.

- [ ] **Step 5: Commit**

```bash
git add packages/private-routes/index.js packages/private-routes/lib/errors.js packages/private-routes/lib/protocol.js packages/private-routes/test
git commit -m "feat: add private route protocol vocabulary"
```

### Task 3: Implement and test the injectable cryptographic suite

**Files:**
- Create: `packages/private-routes/lib/crypto-suite.js`
- Create: `packages/private-routes/test/crypto-suite.test.js`

- [ ] **Step 1: Write a failing X25519 agreement and invalid-key test**

```js
test('X25519 derives the same nonzero shared secret on both sides', (t) => {
  const alice = encryptionKeyPair(seed(1))
  const bob = encryptionKeyPair(seed(2))
  const left = cryptoSuite.keyAgreement(alice.secretKey, bob.publicKey)
  const right = cryptoSuite.keyAgreement(bob.secretKey, alice.publicKey)
  t.alike(left, right)
  t.is(b4a.equals(left, b4a.alloc(32)), false)
})

test('X25519 rejects a low-order all-zero public key', (t) => {
  const alice = encryptionKeyPair(seed(1))
  expectCode(t, () => cryptoSuite.keyAgreement(alice.secretKey, b4a.alloc(32)), 'INVALID_KEY')
})
```

Run: `npm run test:one --prefix packages/private-routes -- test/crypto-suite.test.js`

Expected: FAIL because `cryptoSuite.keyAgreement` does not exist.

- [ ] **Step 2: Implement only key generation and validated agreement, then verify GREEN**

Wrap `hypercore-crypto.encryptionKeyPair(seed)` and `sodium.crypto_scalarmult`. Validate exact 32-byte inputs, reject a false sodium return value and an all-zero result, and return a defensive `b4a` copy allocated outside shared slabs.

Run: `npm run test:one --prefix packages/private-routes -- test/crypto-suite.test.js`

Expected: both X25519 tests PASS.

- [ ] **Step 3: Write failing KDF domain-separation tests**

```js
test('KDF separates direction, purpose, transcript, and nonce prefixes', (t) => {
  const a = cryptoSuite.deriveKeys(seed(3), b4a.from('transcript-a'))
  const b = cryptoSuite.deriveKeys(seed(3), b4a.from('transcript-b'))
  t.is(b4a.equals(a.forwardKey, a.reverseKey), false)
  t.is(b4a.equals(a.forwardNoncePrefix, a.reverseNoncePrefix), false)
  t.is(b4a.equals(a.forwardKey, b.forwardKey), false)
  t.is(a.forwardNoncePrefix.byteLength, 16)
  t.is(b4a.toString(a.forwardKey, 'hex'), '3976601ef753f92f19e4d544d6a80526635bd8af0dd09efd18e224493d44fb04')
  t.is(b4a.toString(a.reverseKey, 'hex'), 'ba56480d6d8391e60bf57bd8846cf1a6ee7466b5ec3e7bd7325f2224227e19f2')
  t.is(b4a.toString(a.forwardNoncePrefix, 'hex'), 'a4300237c95a17d6b7b5c1eb5d0bf837')
})
```

Run the focused file again.

Expected: FAIL because `deriveKeys` is missing.

- [ ] **Step 4: Implement exact transcript-bound KDF labels, then verify GREEN**

Limit transcript to 4096 bytes. For each output label, compute `BLAKE2b-256(key = sharedSecret[32], message = uint16be(labelLength) || UTF8(label) || uint32be(protocolVersion) || uint32be(transcriptLength) || transcript)`. Labels are exactly `hyperdht-private-routes/kdf/v0/forward-key`, `/reverse-key`, `/forward-nonce`, and `/reverse-nonce`; truncate nonce outputs to their first 16 bytes. Build a 24-byte XChaCha nonce as `prefix[16] || uint64be(counter)`. No caller supplies a full nonce. The hard-coded test vector uses `sharedSecret = 03` repeated 32 times and transcript `transcript-a`.

Run the focused file.

Expected: all agreement and KDF tests PASS.

- [ ] **Step 5: Write failing AEAD authenticity and nonce-uniqueness tests**

The exact APIs are `seal({ key, noncePrefix, counter, associatedData, plaintext }) -> ciphertext` and `open({ key, noncePrefix, counter, associatedData, ciphertext }) -> plaintext|null`. They validate 32-byte key, 16-byte prefix, `0 <= counter <= 2^64-1`, associated data <= 512 bytes, and a named primitive-adapter bound `MAX_AEAD_PLAINTEXT = 65_535`; Task 7 applies the much smaller exact cell-body bound. They defensively copy output and never mutate input. Seal identical plaintext/header with forward counter `0n`, forward counter `1n`, and reverse counter `0n`; assert all ciphertexts differ. Mutate associated data and ciphertext one byte at a time; `open` must return `null`.

Add this known answer: with the KDF vector's forward key/prefix, counter `0n`, associated data `header-v0`, and plaintext `hello`, nonce hex is `a4300237c95a17d6b7b5c1eb5d0bf8370000000000000000` and ciphertext hex is `c51fa92d7a49769b21ebcf07d72c7ae7bead2de70b`.

Run the focused file.

Expected: FAIL because `seal`/`open` are missing.

- [ ] **Step 6: Implement the frozen adapter and verify Node-compatible primitives**

Expose:

```js
export const cryptoSuite = Object.freeze({
  keyPair: crypto.keyPair,
  encryptionKeyPair: crypto.encryptionKeyPair,
  sign: crypto.sign,
  verify: crypto.verify,
  hash: crypto.hash,
  randomBytes: crypto.randomBytes,
  keyAgreement,
  deriveKeys,
  seal,
  open
})
```

`seal/open` wrap `crypto_aead_xchacha20poly1305_ietf_*`; the cell codec, not this primitive adapter, owns counters and replay state. Run the focused file and full package suite; both must PASS.

Run: `npm run test:bare --prefix packages/private-routes`

Expected: the same crypto vectors PASS under Bare before committing this task.

- [ ] **Step 7: Commit the independently tested primitive adapter**

```bash
git add packages/private-routes/lib/crypto-suite.js packages/private-routes/test/crypto-suite.test.js packages/private-routes/test/helpers.js packages/private-routes/index.js
git commit -m "feat: add private route crypto adapter"
```

### Task 4: Implement endpoint-authorized descriptors and delegation verification

**Files:**
- Create: `packages/private-routes/lib/descriptor.js`
- Create: `packages/private-routes/test/descriptor.test.js`

- [ ] **Step 1: Lock the complete experimental-v0 schema in failing round-trip tests**

Use these exact bounded fields and order:

```text
UnsignedRelayAdvertisementV0 = version:u32, identityKey:fixed32,
  routeEncryptionKey:fixed32, dial:boundedBytes(256), role:u8,
  capabilities:u32, epoch:u64be, expiresAt:u64be
RelayAdvertisementV0 = unsignedRelayAdvertisement, relaySignature:fixed64

UnsignedDelegationV0 = version:u32, endpointKey:fixed32, routeSigningKey:fixed32,
  notBefore:u64be, expiresAt:u64be, minEpoch:u64be, maxEpoch:u64be,
  capabilities:u32
DelegationV0 = unsignedDelegation, endpointSignature:fixed64

UnsignedDescriptorV0 = version:u32, authorizationMode:u8, descriptorId:fixed32,
  endpointKey:fixed32, routeSigningKey:fixed32, routeEncryptionKey:fixed32,
  entryAdvertisement:boundedBytes(1024), epoch:u64be,
  expiresAt:u64be, capabilities:u32, cellSize:u16,
  encryptedHops:boundedBytes(4096), delegation:optional(DelegationV0)
DescriptorV0 = unsignedDescriptor, descriptorSignature:fixed64
```

The total encoded descriptor maximum is 8192 bytes. Authorization modes are exactly `DIRECT = 0` and `DELEGATED = 1`; capabilities are `FORWARD = 1`, `DATAGRAM = 2`, `STREAM = 4`. Direct mode encodes no delegation bytes and requires their absence; delegated mode requires exactly one canonical delegation. Reject unknown modes/bits and trailing bytes. All `u64be` fields decode as `BigInt`, reject negative/out-of-range inputs, and never round-trip through JavaScript `Number`. Require version `0`, `cellSize = 1200`, a nonempty relay dial value, nonempty encrypted hops, and known capability bits only.

The relay advertisement is signed by `identityKey` over `RELAY_ADVERTISEMENT_DOMAIN || encode(UnsignedRelayAdvertisementV0)`. Verification recomputes deterministic role, requires `ROLE.PRIVATE` for a descriptor entry, checks descriptor epoch/capabilities against the advertisement, and checks expiry. Circuit activation later requires the entry to prove possession of both its Ed25519 identity key and advertised X25519 route-encryption key; failure destroys the partial route.

Run: `npm run test:one --prefix packages/private-routes -- test/descriptor.test.js`

Expected: FAIL because codecs and bounds are missing.

- [ ] **Step 2: Implement only bounded canonical codecs and verify round trips GREEN**

Reject oversize buffers before nested decode/allocation. `verifyDescriptor` returns an opaque branded `VerifiedDescriptor`; security-critical bytes live in module-private `WeakMap` state and every getter returns a new `b4a` copy. Export a checker capability for RouteManager, not the brand or constructor. Add post-verification mutation tests that overwrite the original encoding and every getter result, then read again and prove endpoint key, entry advertisement/dial, route keys, and encrypted hops are unchanged. Plain objects and cloned results fail the checker.

- [ ] **Step 3: Write failing direct endpoint authorization tests**

Direct mode requires `routeSigningKey === endpointKey`; the endpoint key signs `DESCRIPTOR_DIRECT_DOMAIN || encode(UnsignedDescriptorV0)`. Add a valid direct case plus one test each for a distinct self-signed route key, missing/unexpected delegation bytes, unknown auth mode, wrong requested endpoint, relay-advertisement signature/dial/identity/key mutation, wrong entry role, advertisement/descriptor epoch or capability mismatch, expired advertisement/descriptor, wrong version, unknown capability bit, trailing bytes, unsafe-number input, and mutation of every signed field. Use `privateRoleIdentity(seedStart)` so the valid entry deterministically derives to `ROLE.PRIVATE`.

Expected RED: the structurally valid descriptor is not yet cryptographically authorized.

- [ ] **Step 4: Implement direct verification in fail-cheap order and verify GREEN**

Order: total/field bounds → version/capabilities/cell size → time/epoch → requested endpoint → deterministic `ROLE.PRIVATE` entry → direct key equality → Ed25519 signature. Use domain `hyperdht-private-routes/descriptor/direct/v0` and return stable error codes without including field contents.

- [ ] **Step 5: Write failing scoped delegation tests**

Delegation preimage is `DELEGATION_DOMAIN || encode(UnsignedDelegationV0)` signed by the endpoint. Delegated descriptor preimage is `DESCRIPTOR_DELEGATED_DOMAIN || encode(UnsignedDescriptorV0)` signed by `routeSigningKey`. Test one valid chain and separate failures for endpoint signature, descriptor signature, protocol version, requested endpoint, capability subset, not-before/expiry, epoch range, changed route key, safety-role entry, and omitted delegation.

- [ ] **Step 6: Implement delegated verification and run the full matrix GREEN**

Require descriptor capabilities to be a subset of delegated capabilities and descriptor epoch/expiry to fit entirely inside the delegation scope. Verify endpoint delegation before route signature. Domains are `hyperdht-private-routes/delegation/v0` and `hyperdht-private-routes/descriptor/delegated/v0`.

Run: `npm run test:one --prefix packages/private-routes -- test/descriptor.test.js`

Expected: every direct/delegated case PASS.

Run: `npm test --prefix packages/private-routes`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/private-routes/lib/descriptor.js packages/private-routes/test/descriptor.test.js packages/private-routes/test/helpers.js packages/private-routes/index.js
git commit -m "feat: authenticate private route descriptors"
```

### Task 5: Separate accumulated provenance from operation authorization

**Files:**
- Create: `packages/private-routes/lib/privacy-domains.js`
- Create: `packages/private-routes/lib/discovery-evidence.js`
- Create: `packages/private-routes/lib/circuit-authority.js`
- Create: `packages/private-routes/test/privacy-domains.test.js`

- [ ] **Step 1: Write a failing capability-boundary test for public discovery evidence**

```js
test('route material cannot mint verified public discovery evidence', (t) => {
  const { checker } = discoveryEvidenceFixture({ now: () => 100 })
  const { checker: descriptorChecker } = descriptorFixture()
  const { checker: circuitChecker } = circuitAuthorityFixture()
  const registry = new PrivacyDomainRegistry({ evidenceChecker: checker, descriptorChecker, circuitChecker, now: () => 100 })
  const peer = identity(4).publicKey

  registry.learnRoute(peer, { provenance: 'private-only', epoch: 2, expiresAt: 200 })

  t.is(registry.allows(peer, 'route-forward'), true)
  t.is(registry.allows(peer, 'guard-dial'), false)
  t.is(registry.allows(peer, 'direct-ping'), false)
  t.is(registry.allows(peer, 'public-return'), false)
  expectCode(t, () => registry.learnPublic({ peer, authenticated: true }), 'UNAUTHORIZED')
})
```

Run the focused file and expect RED because the evidence authority does not exist.

- [ ] **Step 2: Implement the non-exported evidence brand and verify GREEN**

`createDiscoveryEvidenceAuthority()` returns three distinct frozen capability objects with no shared methods:

```js
{
  receiptIssuer: { issue({ advertisementHash, peerIdentity, observedDial, observedAt, channel }) },
  verifier: { verify(encodedAdvertisement, receipt) },
  checker: { isVerified(evidence), read(evidence) }
}
```

Only the future public-DHT transport owns `receiptIssuer`; only its discovery adapter owns `verifier`; the registry receives only `checker`. RouteManager, descriptor parsing, and route imports receive none of the issuer/verifier capabilities.

The signed advertisement uses the exact `RelayAdvertisementV0` schema and signature domain from Task 4. `receiptIssuer` stores closure-private receipt state in a `WeakMap`: exact advertisement BLAKE2b hash, peer identity, canonical dial bytes, observed time, channel enum `PUBLIC_DHT = 0`, and consumed flag. `verifier.verify()` requires the signed advertisement identity/dial/hash to match that state, `0 <= now - observedAt <= 30_000`, a nonfuture observation, current advertisement expiry, and one-time unused receipt; it marks the receipt consumed before returning evidence. Evidence lives in another private `WeakMap`; `checker.read()` returns immutable scalars and copy-on-read buffers.

Add exact failing tests, then minimal implementation, for: plain/cloned evidence, expired advertisement/receipt, future receipt, mismatched peer, mismatched dial, mismatched advertisement hash, wrong channel, replayed receipt, self-signed advertisement without a receipt, and route-imported bytes. Each focused test must first fail for the named missing check and then pass without changing its assertion.

- [ ] **Step 3: Write the complete policy matrix as table-driven failing tests**

Use this exact private-mode matrix when not quarantined and not expired:

| Operation | Required evidence |
| --- | --- |
| `guard-dial` | verified public discovery, deterministic `SAFETY` role, and `selectedGuard: true` |
| `route-entry-dial` | verified relay advertisement embedded in an opaque verified descriptor, deterministic `PRIVATE` role, matching active epoch, plus opaque final-safety circuit capability for that exact circuit/epoch |
| `route-forward` | `route-entry` or `private-only`, matching active epoch |
| `direct-dial` | never allowed by this private-mode registry |
| `direct-ping` | never allowed by this private-mode registry |
| `public-return` | verified public discovery and explicit `relay-discovery` consumer context only |

Unknown operations return `false`. Add cases for accumulated `public + route-entry`, wrong role, wrong epoch, expiry using the injected clock, unauthenticated promotion, and no `selectedGuard` flag.

Run: `npm run test:one --prefix packages/private-routes -- test/privacy-domains.test.js`

Expected: FAIL because the exhaustive policy is missing.

- [ ] **Step 4: Implement accumulated records and exhaustive authorization GREEN**

Store by immutable hex identity: `{ provenance: Set, publicEvidence, routeEpochs: Map, capabilities: Map, quarantined }`. Route imports can add only `private-only` records directly. A `route-entry` record is created only from the opaque `VerifiedDescriptor` checker and retains the already verified relay advertisement; raw route material cannot create one. `learnPublic(evidence)` accepts only the evidence checker's live branded object. The registry constructor receives the three checker-only capabilities `{ evidenceChecker, descriptorChecker, circuitChecker }`; it receives no issuer/verifier.

`createCircuitAuthority()` returns separate `issuer` and `checker` objects backed by private `WeakMap` state. RouteManager alone receives `issuer.issueFinalSafety({ circuitId: fixed16, epoch, finalSafetyIdentity, entryIdentity, expiresAt })`; the registry receives only `checker.read(context)`. Issuance and checking require deterministic `SAFETY` and `PRIVATE` roles respectively. `route-entry-dial` requires `now < expiresAt`, the requested registry identity to equal `entryIdentity`, and circuit ID/epoch/final-safety identity to match installed route state. Strings, plain/cloned objects, endpoint contexts, swapped-role identities, expired contexts, and a valid context from another circuit/epoch/relay are denied. `allows(identity, operation, context)` otherwise uses an exhaustive switch implementing the table; default is false.

Run the focused file.

Expected: policy matrix PASS.

- [ ] **Step 5: Write failing conflict/quarantine tests**

Present two individually valid public evidence objects for one identity with byte-unequal canonical dial material or capabilities in the same epoch. Then repeat with (a) a verified descriptor advertisement versus independently verified public evidence in the same epoch and (b) two verified route descriptors claiming the same identity and epoch. Same-epoch conflicts quarantine all affected authorization; byte-identical claims are idempotent. Adjacent epochs are separate scopes: add a test where epoch `n` drains while epoch `n + 1` opens with rotated keys/dial material, both remain usable only in their own circuit contexts, and each expires independently without quarantine. Confirm expiry of a route epoch removes only that route provenance, not independent public provenance.

- [ ] **Step 6: Implement idempotent quarantine and verify all tests GREEN**

Quarantine clears all dial authorization and is not undone by later route material. Only a separately defined future operator action may clear it; do not add such an API now.

Run: `npm run test:one --prefix packages/private-routes -- test/privacy-domains.test.js`

Expected: PASS.

Run: `npm test --prefix packages/private-routes`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/private-routes/lib/discovery-evidence.js packages/private-routes/lib/circuit-authority.js packages/private-routes/lib/privacy-domains.js packages/private-routes/test/privacy-domains.test.js packages/private-routes/index.js
git commit -m "feat: enforce private route provenance policy"
```

### Task 6: Implement exact ordered and unordered counter semantics

**Files:**
- Create: `packages/private-routes/lib/counters.js`
- Create: `packages/private-routes/test/counters.test.js`

- [ ] **Step 1: Write failing tests for ordered gaps and unordered replay**

```js
test('ordered receiver buffers a bounded authenticated gap then drains', (t) => {
  const receiver = new OrderedReceiver({ window: 4, gapTimeout: 50, now: () => 0 })
  t.alike(receiver.pushAuthenticated(1n, 'b'), [])
  t.alike(receiver.pushAuthenticated(0n, 'a'), ['a', 'b'])
  expectCode(t, () => receiver.pushAuthenticated(1n, 'again'), 'REPLAY')
})

test('datagram window includes its exact floor and rejects below it', (t) => {
  const receiver = new DatagramReplayWindow({ window: 8 })
  t.is(receiver.acceptAuthenticated(7n), true)
  t.is(receiver.floor, 0n)
  t.is(receiver.acceptAuthenticated(0n), true)
  expectCode(t, () => receiver.acceptAuthenticated(0n), 'REPLAY')
  t.is(receiver.acceptAuthenticated(8n), true)
  t.is(receiver.floor, 1n)
})

test('sender never wraps after emitting uint64 max', (t) => {
  const sender = new SenderCounter({ initial: MAX_COUNTER })
  t.is(sender.next(), MAX_COUNTER)
  t.is(sender.closed, true)
  expectCode(t, () => sender.next(), 'COUNTER_EXHAUSTED')
})
```

Counter receivers are explicitly post-authentication-only; their method names encode this boundary. `CellCodec.open()` is the only production caller and invokes them only after AEAD success. Add a cell-codec regression in Task 7 proving a forged cell never calls `pushAuthenticated`/`acceptAuthenticated` and therefore cannot advance state.

- [ ] **Step 2: Run and verify RED**

Run: `npm run test:one --prefix packages/private-routes -- test/counters.test.js`

Expected: FAIL because counter receivers are missing.

- [ ] **Step 3: Implement the exact floor and ordered-buffer rules**

Use `BigInt` counters only, initially expecting `0n`. For datagrams, after accepting highest counter `h`, the inclusive floor is `max(0, h - BigInt(window) + 1n)`; unseen counters at the floor are accepted and counters below it are `REPLAY`. The bitmap advances only in `acceptAuthenticated`.

For ordered cells, the first missing counter starts `gapStartedAt`. Buffer at most `window - 1` later cells. `expire(now)` throws `COUNTER_GAP`, clears buffered payloads, and sets `closed = true` when `now - gapStartedAt >= gapTimeout`. Receipt of the missing counter drains contiguous payloads and clears the timer.

Run the focused file.

Expected: the two core tests PASS.

- [ ] **Step 4: Write failing boundary, timeout, rotation, and exhaustion tests**

Define `MAX_COUNTER = (1n << 64n) - 1n` and experimental `ROTATE_AT = MAX_COUNTER - 1024n`. Add exact tests for negative/non-BigInt input (`COUNTER_INVALID`), too-large ordered gap (`COUNTER_GAP`), timeout at `gapTimeout - 1` versus exactly `gapTimeout`, and `needsRotation === true` once the next/emitted/highest counter reaches `ROTATE_AT`. Assert `err.code`, `closed`, and empty buffered state.

Oracles are separate: `SenderCounter.next()` returns `MAX_COUNTER` once, atomically sets `closed = true`, and every later call throws `COUNTER_EXHAUSTED`. An ordered receiver delivers authenticated `MAX_COUNTER`, then closes and clears any impossible buffered state. A datagram receiver delivers authenticated `MAX_COUNTER`, then immediately closes and rejects all later datagrams—including previously unseen lower in-window counters—with `COUNTER_EXHAUSTED`; this deliberate fail-closed edge behavior is documented because normal rotation begins 1024 counters earlier.

- [ ] **Step 5: Implement only the tested boundaries and verify GREEN**

`SenderCounter` exposes read-only `value`, `needsRotation`, and `closed`. Receivers expose read-only `floor`/`next`, `needsRotation`, `closed`, and `buffered` counters. Exhaustion is a teardown signal consumed by RouteManager; it never wraps to zero.

- [ ] **Step 6: Run focused and all tests GREEN**

Run: `npm run test:one --prefix packages/private-routes -- test/counters.test.js`

Expected: PASS.

Run: `npm test --prefix packages/private-routes`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/private-routes/lib/counters.js packages/private-routes/test/counters.test.js packages/private-routes/index.js
git commit -m "feat: add routed cell counter windows"
```

## Chunk 2: Virtual Routing Core

### Task 7: Seal and open fixed-size authenticated cells

**Files:**
- Create: `packages/private-routes/lib/cell-codec.js`
- Create: `packages/private-routes/test/cell-codec.test.js`

- [ ] **Step 1: Write failing fixed-size round-trip test**

```js
test('cell round trip preserves payload and hides its length on wire', (t) => {
  const codec = new CellCodec({ crypto: deterministicCrypto(9), cellSize: 1200 })
  const context = cellContext({ counter: 3n, direction: 'forward', receiver: authenticatedReceiver() })
  const sealed = codec.seal(context, b4a.from('hello'))

  t.is(sealed.byteLength, 1200)
  t.alike(codec.open(context, sealed), b4a.from('hello'))
  t.is(sealed.indexOf(b4a.from('hello')), -1)
})
```

Add separate tests for every authenticated header field, wrong direction/key/epoch/circuit, truncated/oversized cell, maximum payload, one-byte overflow, deterministic padding injection, and counter state not advancing after authentication failure.

- [ ] **Step 2: Run and verify RED**

Run: `npm run test:one --prefix packages/private-routes -- test/cell-codec.test.js`

Expected: FAIL because `CellCodec` is missing.

- [ ] **Step 3: Implement the experimental cell layout**

Lock this exact experimental layout:

```text
public header (36 bytes): version:u8=0, class:u8, direction:u8, flags:u8=0,
  epoch:u64be, routeLocalCircuitId:fixed16, counter:u64be
encrypted body plaintext (1148 bytes): payloadLength:u16be,
  payload:bytes(MAX_CELL_PAYLOAD=1146), zero/random padding to 1148
AEAD tag: 16 bytes
cell = publicHeader[36] || XChaCha20Poly1305(body)[1164] = 1200 bytes
associatedData = DOMAIN.CELL_HEADER || publicHeader
```

Reject unknown flags/classes/directions, non-BigInt epoch/counter, payload length above 1146, and any packet length other than 1200 before allocation. Use `b4a`, never global `Buffer`.

`seal({ key, noncePrefix, senderCounter, class, direction, epoch, circuitId, payload })` obtains the counter only from `SenderCounter.next()`. `open({ key, noncePrefix, receiver, expectedClass, expectedDirection, expectedEpoch, expectedCircuitId }, packet)` authenticates before calling `receiver.pushAuthenticated(counter, payload)` for ordered/control or `receiver.acceptAuthenticated(counter)` for datagrams. A spy test must prove mutated header/ciphertext produces `CELL_INVALID`, leaves receiver state unchanged, and records zero authenticated-receiver calls.

`open()` authenticates before consulting the injected ordered/datagram receiver, returns a fresh payload slice, and zeroes temporary plaintext on failure.

Add a known-answer test using real crypto, zero padding, forward key/prefix from Task 3, class `STREAM`, direction `FORWARD`, epoch `8n`, circuit ID `11` repeated 16 bytes, counter `3n`, and payload `hello`: header hex is `000100000000000000000008111111111111111111111111111111110000000000000003`; BLAKE2b-256 of the complete 1200-byte cell is `85cef0e1ccb809ab4a305568aa6a7ee9cd570289353be0a6f554de4287857e27`.

- [ ] **Step 4: Run focused and full tests GREEN**

Run: `npm run test:one --prefix packages/private-routes -- test/cell-codec.test.js`

Expected: PASS.

Run: `npm test --prefix packages/private-routes`

Expected: PASS.

- [ ] **Step 5: Commit the link-cell codec**

```bash
git add packages/private-routes/lib/cell-codec.js packages/private-routes/test/cell-codec.test.js packages/private-routes/test/helpers.js packages/private-routes/index.js
git commit -m "feat: add fixed-size routed link cells"
```

### Task 8: Add end-to-end route ciphertext and bounded fragmentation

**Files:**
- Create: `packages/private-routes/lib/route-payload.js`
- Create: `packages/private-routes/lib/fragments.js`
- Create: `packages/private-routes/test/route-payload.test.js`
- Create: `packages/private-routes/test/fragments.test.js`

- [ ] **Step 1: Write a failing relay-opacity route-payload test**

Define `ROUTE_FRAME_SIZE = 1100`. The frame is `counter:u64be || ciphertext[1092]`; ciphertext decrypts only with source/destination end-to-end keys to `class:u8 || payloadLength:u16be || payload[MAX_ROUTE_PAYLOAD=1073] || padding` (1076 plaintext bytes plus 16-byte tag). Associated data is `descriptorId || circuitId || direction:u8 || counter:u64be`; nonce uses the end-to-end direction prefix plus counter.

Seal `private payload`, wrap the 1100-byte frame in a 1200-byte link cell, open the link cell as a relay, and assert the relay sees exactly 1100 opaque bytes containing neither plaintext nor an independently decryptable route body. Destination `RoutePayloadCodec.open()` must recover the payload.

Run: `npm run test:one --prefix packages/private-routes -- test/route-payload.test.js`

Expected: FAIL because `RoutePayloadCodec` is missing.

- [ ] **Step 2: Implement end-to-end seal/open and verify GREEN**

`RoutePayloadCodec` owns separate forward/reverse `SenderCounter` and receivers derived only after authenticated `CREATED`. Relays never receive this codec or its keys; they only copy its fixed 1100-byte output between link cells. AEAD verification occurs before `pushAuthenticated`/`acceptAuthenticated`; a receiver spy proves wrong key/associated data/direction/ciphertext makes zero calls and leaves all counters unchanged. Mutation, wrong descriptor/circuit/direction/counter/key, replay, and exhaustion fail closed. Run focused and full tests; both PASS.

- [ ] **Step 3: Write failing fragmentation and bounded-reassembly tests**

The encrypted fragment header is 20 bytes (`messageId:fixed16, index:u16be, total:u16be`), so `MAX_FRAGMENT_DATA = MAX_ROUTE_PAYLOAD - 20 = 1053`. Given `3 * MAX_FRAGMENT_DATA + 7`, assert `fragment()` produces four frames and `Reassembler.pushAuthenticated()` returns the exact message only after all arrive.

Lock exact limits: `MAX_MESSAGE_BYTES = 16 * 1024 * 1024`, `MAX_MESSAGES = 64`, `MAX_BUFFERED_BYTES = 32 * 1024 * 1024`, `MAX_COMPLETED_IDS = 4096`, `MESSAGE_TIMEOUT = 30_000`. Add one-behavior tests for `total=0`, `index>=total`, `total > ceil(MAX_MESSAGE_BYTES / MAX_FRAGMENT_DATA)`, conflicting duplicate index, byte-identical duplicate, message-ID reuse after completion, inconsistent total, per-message/global limit, concurrent limit, completed-ID limit, expiry, and destroy.

Run: `npm run test:one --prefix packages/private-routes -- test/fragments.test.js`

Expected: FAIL because fragmentation/reassembly is missing.

- [ ] **Step 4: Implement bounded fragments and verify GREEN**

The fragment header is inside end-to-end authenticated route plaintext. `Reassembler` accepts only route-authenticated fragments, copies bytes, and checks integer multiplication/addition before allocation. A malformed/conflicting fragment destroys and zeroes only that message; exceeding global/concurrent limits rejects the new message without damaging existing valid messages; `destroy()` zeroes all. A completed message ID is retained until route epoch expiry. At `MAX_COMPLETED_IDS`, reject a new message with `CIRCUIT_LIMIT` and keep existing tombstones; never evict early. A byte-identical completed fragment under a fresh valid route counter returns `REPLAY`, allocates no state, and leaves the route open; link-level reuse of the same route counter remains a circuit-failing replay.

Run the focused fragment file, then `npm test --prefix packages/private-routes`.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/private-routes/lib/route-payload.js packages/private-routes/lib/fragments.js packages/private-routes/test/route-payload.test.js packages/private-routes/test/fragments.test.js packages/private-routes/test/helpers.js packages/private-routes/index.js
git commit -m "feat: add end-to-end routed payloads"
```

### Task 9: Build a deterministic observable virtual network

**Files:**
- Create: `packages/private-routes/lib/virtual-network.js`
- Create: `packages/private-routes/test/virtual-network.test.js`

- [ ] **Step 1: Write a failing deterministic delivery/visibility test**

```js
test('virtual link exposes only sender and receiver for each delivery', (t) => {
  const network = new VirtualNetwork({ now: 0 })
  network.register('source', () => {})
  network.register('guard', (packet) => network.send('guard', 'relay', packet))
  network.register('relay', () => {})

  network.send('source', 'guard', b4a.from('cell'))
  network.flush()

  t.alike(network.edges(), [
    ['source', 'guard'],
    ['guard', 'relay']
  ])
  t.alike(network.view('guard').map((event) => event.peer), ['source', 'relay'])
  t.alike(network.view('relay').map((event) => event.peer), ['guard'])
})
```

- [ ] **Step 2: Run and verify RED**

Run: `npm run test:one --prefix packages/private-routes -- test/virtual-network.test.js`

Expected: FAIL because `VirtualNetwork` is missing.

- [ ] **Step 3: Implement clock, links, trace, and fault hooks**

Use a FIFO queue ordered by `(deliverAt, sequence)`. `send(from, to, packet)` rejects unknown nodes and copies packet bytes. `advance(ms)` and `flush({ maxDeliveries = 100_000 })` are synchronous and deterministic; reaching the bound stops delivery, clears the pending adversarial batch, and throws `VIRTUAL_LIMIT` so cyclic/duplicating handlers cannot hang. A fault hook may return `drop`, one delayed packet, or a bounded array of packets for duplication/reordering. Trace events contain only observer-local peer, direction, byte length, virtual time, and a test-only opaque packet ID—never full topology. Add tests for copied input, stable same-time ordering, unknown nodes, bounded duplication, and the delivery guard.

- [ ] **Step 4: Run focused and full tests GREEN**

Run: `npm run test:one --prefix packages/private-routes -- test/virtual-network.test.js`

Expected: PASS.

Run: `npm test --prefix packages/private-routes`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/private-routes/lib/virtual-network.js packages/private-routes/test/virtual-network.test.js packages/private-routes/index.js
git commit -m "test: add deterministic private route network"
```

### Task 10: Enforce bounded relay bindings and bidirectional teardown

**Files:**
- Create: `packages/private-routes/lib/link-setup.js`
- Create: `packages/private-routes/lib/relay-service.js`
- Create: `packages/private-routes/test/link-setup.test.js`
- Create: `packages/private-routes/test/relay-service.test.js`

- [ ] **Step 1: Write failing adjacent-link key setup tests**

```text
LinkCreateBaseV0 = version:u8, circuitId:fixed16, epoch:u64be,
  initiatorIdentity:fixed32, responderIdentity:fixed32,
  initiatorLocalId:fixed16, responderLocalId:fixed16,
  initiatorEphemeralKey:fixed32, expiresAt:u64be
LinkCreateUnsignedV0 = linkCreateBase, staticChallengeCipher:fixed48
LinkCreateV0 = unsigned, initiatorIdentitySignature:fixed64
LinkCreatedUnsignedV0 = version:u8, circuitId:fixed16, epoch:u64be,
  initiatorIdentity:fixed32, responderIdentity:fixed32,
  initiatorLocalId:fixed16, responderLocalId:fixed16,
  initiatorEphemeralKey:fixed32, responderEphemeralKey:fixed32,
  createHash:fixed32, challengeHash:fixed32, expiresAt:u64be
LinkCreatedV0 = unsigned, staticPossessionTag:fixed16,
  responderIdentitySignature:fixed64
```

`linkBaseHash = BLAKE2b(DOMAIN.LINK_CREATE || encode(LinkCreateBaseV0))`. Initiator and responder-advertised static X25519 key derive a shared secret, then `deriveKeys(shared, DOMAIN.LINK_CREATE || linkBaseHash)`. Encrypt challenge `[32]` with forward key/prefix, counter `0`, associated data `linkBaseHash`; `staticChallengeCipher` is 48 bytes. Initiator signs `DOMAIN.LINK_CREATE || encode(LinkCreateUnsignedV0)` with its advertised Ed25519 identity key. Responder verifies that signature before challenge decryption, creates a fresh ephemeral X25519 key, and computes `staticPossessionTag` by sealing empty plaintext with the static shared reverse key/prefix, counter `1`, associated data `BLAKE2b(challenge) || BLAKE2b(encode(LinkCreateV0))`. It signs `DOMAIN.LINK_CREATED || encode(LinkCreatedUnsignedV0) || staticPossessionTag`.

Both derive ephemeral-ephemeral shared secret. For each literal class byte `CONTROL=0`, `STREAM=1`, `DATAGRAM=2`, call `deriveKeys(shared, DOMAIN.LINK_CREATED || BLAKE2b(LinkCreateV0) || BLAKE2b(LinkCreatedV0) || classByte)`. This yields independent forward/reverse keys, prefixes, and counters per class; CONTROL and STREAM receivers are ordered, DATAGRAM uses its replay window.

Lock vectors with static shared secret `03×32`, link-base hash `04×32`, challenge `05×32`, and LinkCreate hash `06×32`: challenge cipher is `6f712676663138cab149aaaa580a96d2599559a900e6f1985a13f760845f10acbd15b7e929ca7fc3c7bcbb7d687f936b`; possession tag is `8106cf71313cef2ab00f781e97a2db30`. For transcript-vector inputs `LinkCreateHash=06×32`, `LinkCreatedHash=07×32`, class `CONTROL=0`, `BLAKE2b(DOMAIN.LINK_CREATED || inputs)` is `ecb723d81ec8aafec62e286aa33206afc9bb8d893bb633dc0e0abbfd340bd99f`.

The binding authority stores resulting contexts in private WeakMap state and returns opaque peer-specific tickets. For each class, initiator TX key/prefix equals responder RX and responder TX equals initiator RX; all sender/receiver counter objects are distinct. Add RED tests for valid agreement, forged initiator identity/signature, wrong responder identity/static or ephemeral keys, changed IDs/epoch/expiry/transcript, replay, responder signature/tag failure, same key across classes/directions, and any equal derived key across two adjacencies.

- [ ] **Step 2: Implement link setup and opaque ticket checker GREEN**

Safety RouteManager performs this exchange for each Safety adjacency. Source activation performs it freshly at each hidden private adjacency after the registered template is accepted; descriptor templates contain no ticket IDs or link keys. Entry attachment performs a fresh link setup between final Safety relay and private entry. Only each adjacent node's RelayService receives its checker-readable per-source ticket; source never receives hidden private tickets or keys.

Run: `npm run test:one --prefix packages/private-routes -- test/link-setup.test.js`

Expected: all key equality/separation, proof, replay, and visibility cases PASS.

- [ ] **Step 3: Write failing lifecycle and resource-limit tests**

```js
test('relay forwards through one route-local binding in both directions', (t) => {
  const { relay, previous, next, sealInbound, sent } = relayFixture({ maxCircuits: 1 })
  relay.install(binding({ previous, next }))

  relay.receive(previous.identity, sealInbound('forward', routeFrame(1)))
  relay.receive(next.identity, sealInbound('reverse', routeFrame(2)))

  t.alike(sent.map(({ peer }) => peer), [next.identity, previous.identity])
  t.ok(sent.every(({ packet }) => packet.byteLength === 1200))
})
```

The fixture gives tests link keys but `RelayService.receive(peerIdentity, rawPacket)` accepts only raw 1200-byte packets. Add tests proving plain/forged decoded objects are rejected, plus duplicate IDs, wrong peer/direction/epoch, inbound-key failure, outbound binding mismatch, independent inbound/outbound counters, half-open timeout, circuit/global limits, authenticated `DESTROY`, transport close, expiry, and zero active state after failure.

- [ ] **Step 4: Run and verify RED**

Run: `npm run test:one --prefix packages/private-routes -- test/relay-service.test.js`

Expected: FAIL because `RelayService` is missing.

- [ ] **Step 5: Implement the minimal relay state machine**

Use two maps keyed by `peerIdentityHex + routeLocalCircuitIdHex` to one shared record. `install(previousTicket, nextTicket)` accepts only opaque tickets from the link-setup checker and verifies circuit/epoch/current relay identity/opposite adjacency. One peer-specific ticket contains six class/direction contexts: TX and RX for each of CONTROL, STREAM, DATAGRAM; each context owns one key, nonce prefix, and sender or receiver counter. A relay record combining previous and next tickets therefore owns 12 contexts, 12 keys/prefixes, and 12 counter objects. Tests enumerate all 12 and prove each inbound/outbound class selects only its correct adjacent ticket/context. Defaults are exact experimental limits: 128 circuits, 256 KiB queued per circuit, 8 MiB globally, and 5,000 ms half-open timeout.

`receive(peer, rawPacket)` reads only the public route-local ID to select a candidate binding, then uses `CellCodec.open()` with that binding's class-specific inbound key/nonce/expected peer/direction/epoch and post-auth counter.

- For `CONTROL`, authenticated payload may be `0..1146` bytes. Half-open activation handlers consume locally addressed fragments or forward the unchanged fragment through the next installed/just-negotiated CONTROL binding with its independent ordered counter. Multi-fragment CREATE/CREATED tests traverse every Safety and private hop before RoutePayload keys exist.
- For `STREAM` or `DATAGRAM`, state must be `OPEN` and payload must be exactly one 1100-byte opaque RoutePayload frame. RelayService never receives end-to-end keys or calls `RoutePayloadCodec.open()`; it re-seals the unchanged frame with the opposite class binding's key/nonce/sender counter and new route-local ID.

A test hook may hash before/after payload to prove equality but may not expose bytes through production API. Wrong class/state/length fails `CELL_INVALID`; CONTROL, STREAM, and DATAGRAM counters and keys cannot collide.

Cleanup is idempotent: first pre-seal at most one bounded authenticated destroy notice per adjacent binding using live counters/keys; delete both maps and queues; zero every copied link key/nonce/frame with `b4a.fill(0)` and close counters; finally transmit only the already sealed notices. Tests prove maps are gone before the send callback, packets still authenticate at peers, and all relay-owned secret buffers are zero when transmission occurs. Fixture-owned copies and a test-only injected zeroization observer provide assertions without production secret getters.

No relay API accepts endpoint IPs, DHT keys, Hyperswarm topics, end-to-end route keys, hidden path arrays, or caller-asserted “authenticated” objects.

- [ ] **Step 6: Run focused and all tests GREEN**

Run: `npm run test:one --prefix packages/private-routes -- test/relay-service.test.js`

Expected: PASS.

Run: `npm test --prefix packages/private-routes`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/private-routes/lib/link-setup.js packages/private-routes/lib/relay-service.js packages/private-routes/test/link-setup.test.js packages/private-routes/test/relay-service.test.js packages/private-routes/index.js
git commit -m "feat: add bounded private route relay state"
```

### Task 11: Construct, activate, drain, and destroy compiled virtual routes

**Files:**
- Create: `packages/private-routes/lib/activation.js`
- Create: `packages/private-routes/lib/activation-fragments.js`
- Create: `packages/private-routes/lib/route-manager.js`
- Create: `packages/private-routes/test/activation.test.js`
- Create: `packages/private-routes/test/route-manager.test.js`
- Create: `packages/private-routes/test/compiled-route.test.js`

- [ ] **Step 1: Write failing destination-private-route construction tests**

Lock this encrypted instruction schema before route activation:

```text
PrivateTemplateV0 = version:u8, descriptorId:fixed32, templateId:fixed16,
  epoch:u64be, expiresAt:u64be, relayIdentity:fixed32,
  nextAdvertisement:boundedBytesU16(1024),
  nextLayer:boundedBytesU16(4096)
```

The destination validates every hidden relay advertisement/signature/`PRIVATE` role, duplicate identity/dial, loop, maximum 3 private hops, epoch, and expiry. It builds from destination outward with a 64-byte destination-local opaque token as innermost `nextLayer`.

Each template is encrypted with libsodium sealed box (`crypto_box_seal`) to that relay's advertised X25519 key: output is ephemeral public key `[32] || authenticated box ciphertext [plaintext + 16]`, exactly 48 bytes overhead. Sealed box has no external nonce/AD; descriptor/epoch/relay/template bindings are inside the authenticated plaintext, and the endpoint-authorized descriptor signs the complete outer encrypted byte string. With fixed template overhead 101 bytes, maximum advertisement 1024, three private hops, and 64-byte final token, recurrence `L(0)=64; L(n)=48+101+1024+L(n-1)` gives `L(3)=3583 <= encryptedHops limit 4096`; reject a fourth hop or any computed length overflow before allocation.

Because sealed box does not authenticate its sender, register each template before publication with exact schemas:

```text
TemplateRegisterUnsignedV0 = version:u8, authorizationMode:u8,
  descriptorId:fixed32, templateId:fixed16, epoch:u64be, expiresAt:u64be,
  endpointKey:fixed32, routeSigningKey:fixed32, relayIdentity:fixed32,
  templateCommitment:fixed32, nextCommitment:fixed32,
  delegation:mode-dependent DelegationV0
TemplateRegisterV0 = unsigned, destinationSignature:fixed64
TemplateRegisteredUnsignedV0 = version:u8, descriptorId:fixed32,
  templateId:fixed16, epoch:u64be, expiresAt:u64be,
  relayIdentity:fixed32, templateCommitment:fixed32
TemplateRegisteredV0 = unsigned, relayIdentitySignature:fixed64
```

Direct/delegated authorization and canonical mode rules are identical to Task 4. Destination signs `DOMAIN.TEMPLATE_REGISTER || encode(unsigned)` with endpoint or delegated route key. Relay verifies authorization, decrypts its sealed template, requires all plaintext fields and `BLAKE2b(sealedTemplate)` to match registration, persistently stores only `{ descriptorId, templateId, epoch, expiry, commitment, next commitment }`, and signs `DOMAIN.TEMPLATE_REGISTERED || encode(ackUnsigned)`. Persistent registration state contains no route-local ID, link key, ticket, counter, or queue. Destination keeps acknowledgements locally and publishes only after every signature verifies and a traversal reaches its local final token. The descriptor signs the outer encrypted template; it does not contain an unverifiable acknowledgement root.

Registration uses the destination's already established Safety Route to reach the private entry. From there, authenticated CONTROL messages and temporary fresh Task 10 adjacency links carry the nested registration hop-by-hop; those temporary links necessarily allocate per-adjacency IDs, tickets, class contexts, counters, keys, and bounded queues. The entry contacts only the next private relay, the middle contacts only its neighbors, and only the final private relay opens the temporary endpoint-facing link accepted by the destination. The destination never directly contacts entry/middle private relays.

On successful final acknowledgement, 5,000 ms timeout, signature/template rejection, or dropped acknowledgement, pre-seal destroy notices and close/zero every temporary private registration link, ID, ticket, counter, key, queue, fragment buffer, and endpoint-facing link using Task 10 ordering. Keep the destination's preexisting Safety Route and successfully registered commitment records intact; on failed traversal, remove only commitment records created by that incomplete registration transaction. Tests assert these exact postconditions for all four outcomes. Registration-phase observer tests assert the destination sees only its guard and temporary final private relay, entry/middle never see the destination, and no relay sees both endpoint addresses.

Activation supplies only the already authenticated `{ descriptorId, templateId, epoch, templateCommitment }` plus its unique source activation tuple. A hidden relay accepts only a still-live exact registered tuple, then allocates fresh per-source state; no unsupported final-descriptor hash proof is required. Forged sealed templates, validly sealed but unregistered templates, wrong destination/relay signatures, commitment/next-commitment mismatch, expired registration, and registration replay with conflicting bytes are rejected. Identical registration is idempotent; registration state expires independently of per-source circuits.

Templates contain no route-local IDs, counters, or reusable binding tickets. Add a valid three-relay registration/ack test and one RED test per validation, authentication, registration, size, and binding failure. After GREEN, assert the source-facing opaque `VerifiedDescriptor` exposes only entry advertisement and encrypted bytes: serialization, getters, and source trace contain no hidden identity, dial, template, ack, or path array.

- [ ] **Step 2: Implement nested private instructions and verify only adjacent views GREEN**

For every source activation, each private relay decrypts only its reusable template, validates descriptor/template/epoch/expiry/own identity, allocates fresh random route-local IDs, performs a fresh Task 10 LinkCreate/LinkCreated exchange with the next relay, receives new per-circuit opaque tickets/counters, installs half-open state, and forwards `nextLayer`. Replay key is `(descriptorId, templateId, sourceEphemeralKey, sourceCircuitId, epoch)`, allowing different sources while rejecting the same activation.

Add a two-concurrent-source test using one descriptor. Prove every hidden hop has distinct IDs, link tickets, keys, and counters per source; teardown of source A leaves source B open and reverse delivery correct. A test asks each relay's observer view and proves entry sees only each final Safety relay plus private relay 2; middle sees private 1/private 3; final sees private middle/destination; none sees a source and destination together or learns another circuit's local IDs.

Run: `npm run test:one --prefix packages/private-routes -- test/activation.test.js`

Expected: nested construction/view tests PASS.

- [ ] **Step 3: Write failing Safety Route validation and circuit-capability tests**

```js
test('compiled route rejects loops, wrong roles, and direct fallback', async (t) => {
  const fixture = routeFixture()
  const manager = fixture.manager

  const err = await captureError(() => manager.open({
    safety: [fixture.guard, fixture.duplicateGuard],
    descriptor: fixture.verifiedDescriptor
  }))
  t.is(err.code, 'INVALID_ROUTE')
  t.is(manager.directFallback, undefined)
  t.is(fixture.network.hasEdge('source', 'destination'), false)
})
```

Construct `RouteManager` with `{ network, registry, crypto, clock, descriptorChecker, circuitIssuer, limits }`. Add exact RED cases for Safety role, endpoint delegation, expiry, maximum 3 Safety hops, duplicate identity/dial, guard/gateway identity conflict, descriptor checker forgery, and privacy-domain denial. Prove `circuitIssuer.issueFinalSafety()` is not called until every Safety binding is authenticated and installed; partial setup receives no route-entry capability.

- [ ] **Step 4: Implement Safety validation/installation and verify GREEN**

Run: `npm run test:one --prefix packages/private-routes -- test/route-manager.test.js`

Expected: path validation and capability-order tests PASS; no private hidden material becomes visible.

- [ ] **Step 5: Write failing pre-OPEN activation fragmentation tests**

Activation objects travel only in authenticated ordered `CONTROL` link cells before RoutePayload keys exist. Define `ActivationFragmentV0 = messageId:fixed16 || index:u16be || total:u16be || objectLength:u16be || data`; its header is 22 bytes and `MAX_ACTIVATION_FRAGMENT_DATA = 1146 - 22 = 1124`. Set `MAX_ACTIVATION_OBJECT = 8192`, `MAX_ACTIVATION_FRAGMENTS = 8`, exactly one in-progress activation object per circuit, and `ACTIVATION_FRAGMENT_TIMEOUT = 5_000`.

Add exact tests for a 4,313-byte CREATE requiring four fragments, ordered delivery across every Safety/private hop, distinct CONTROL link IDs/keys/counters on each adjacency, `total=0`, total above 8, index out of range, inconsistent object length/total, duplicate/conflicting fragment, object length above 8192, incomplete timeout, replayed completed message ID, and link authentication failure. The reassembler is invoked only after `CellCodec` authenticates/control-counter-orders the cell; a spy proves invalid link cells make zero fragment calls. Every failure clears/zeroes that circuit's partial activation buffer and half-open bindings while leaving unrelated circuits intact.

- [ ] **Step 6: Implement activation fragmentation and verify GREEN**

Run: `npm run test:one --prefix packages/private-routes -- test/activation.test.js`

Expected: exact fragmentation, replay, timeout, authentication-order, and cleanup cases PASS.

- [ ] **Step 7: Write failing entry CREATE possession-proof tests**

Use exact schemas:

```text
CreateV0 = version:u8, circuitId:fixed16, epoch:u64be, descriptorId:fixed32,
  sourceEphemeralKey:fixed32, safetyTranscriptHash:fixed32,
  entryChallengeCipher:fixed48, destinationChallengeCipher:fixed48,
  encryptedHops:boundedBytes(4096)
EntryProofUnsignedV0 = version:u8, circuitId:fixed16, epoch:u64be,
  entryIdentity:fixed32, createHash:fixed32, entryChallengeHash:fixed32,
  expiresAt:u64be
EntryProofV0 = unsigned, possessionTag:fixed16, identitySignature:fixed64
```

Define `CreateBaseV0` canonically as every `CreateV0` field except both challenge ciphers, with `encryptedHops` represented by `BLAKE2b(encryptedHops)`; `createBaseHash = BLAKE2b(DOMAIN.ACTIVATE_CREATE || encode(CreateBaseV0))`. Source and advertised entry derive X25519 shared secret. For role byte `ENTRY = 0`, derive challenge keys with transcript `DOMAIN.ACTIVATE_CHALLENGE || createBaseHash || role`. `entryChallengeCipher = seal(forwardKey, forwardNoncePrefix, counter=0, associatedData=createBaseHash || role, plaintext=challenge[32])`. `possessionTag` is the 16-byte result of sealing empty plaintext with the derived reverse key/prefix, counter `1`, and associated data `BLAKE2b(challenge) || BLAKE2b(encode(CreateV0))`. Entry proves Ed25519 ownership by signing `DOMAIN.ACTIVATE_ENTRY_PROOF || encode(EntryProofUnsignedV0) || possessionTag`.

Lock a fixed vector with shared secret `03×32`, create-base hash `04×32`, challenge `05×32`, role `0`, and Create hash `06×32`: challenge cipher is `f130e6a69d7b3ce6cebeada16abefdfae291d68ba35d7932a12baaaacbd02b0bfaa9dd22e6f66ab4d4b4e6e85427c3e2`; possession tag is `ebd028ec0ed4a401d143a91694a06f95`. Test valid proof, wrong Ed25519 key, wrong advertised X25519 key, create-field mutation, challenge/tag mutation, replayed `(epoch,circuitId,createHash)`, 5,000 ms timeout, and zero partial bindings/secrets after each failure.

- [ ] **Step 8: Implement entry proof, replay cache, and cleanup GREEN**

Replay keys persist through the route epoch and are bounded by configured circuit limit. Verification order is structural bounds → descriptor/entry/epoch/circuit match → replay lookup → Ed25519 signature → X25519-derived challenge tag. Mark replay state before installing the next private layer; any later failure tears down it and all half-open bindings.

- [ ] **Step 9: Write failing destination CREATED transcript tests**

```text
CreatedUnsignedV0 = version:u8, circuitId:fixed16, epoch:u64be,
  descriptorId:fixed32, endpointIdentity:fixed32,
  compiledTranscriptHash:fixed32, parametersHash:fixed32,
  destinationChallengeHash:fixed32, entryProofHash:fixed32,
  expiresAt:u64be
CreatedV0 = unsigned, possessionTag:fixed16, routeSignature:fixed64
```

`compiledTranscriptHash = BLAKE2b(DOMAIN.ACTIVATE_DESTINATION_PROOF || safetyTranscriptHash || BLAKE2b(encryptedHops) || BLAKE2b(entryProof) || sourceEphemeralKey || circuitId || u64be(epoch))`. Encode parameters exactly as `version:u8 || cellSize:u16be || routeFrameSize:u16be || maxCellPayload:u16be || maxRoutePayload:u16be || capabilities:u32be || safetyMin:u8 || safetyMax:u8 || privateMin:u8 || privateMax:u8 || counterWindow:u16be`; hash `DOMAIN.ACTIVATE_PARAMETERS || encodedParameters`. For values `0,1200,1100,1146,1073,7,1,3,1,3,64`, encoded hex is `0004b0044c047a043100000007010301030040` and hash is `360071d84b1025f19abacef12337c1a66a92267799c240f592fb56290ddfbc95`.

Destination challenge uses role byte `DESTINATION = 1` and the same exact challenge construction with the descriptor route-encryption X25519 shared secret. Its possession tag binds `BLAKE2b(challenge) || compiledTranscriptHash || parametersHash`; its route signature preimage is `DOMAIN.ACTIVATE_DESTINATION_PROOF || encode(CreatedUnsignedV0) || possessionTag`. With shared secret `03×32`, create-base hash `04×32`, challenge `07×32`, compiled transcript hash `08×32`, and the parameters hash above, challenge cipher is `6a88ea7af80771fa26b3817894f41f32a9021b11eccb2f2521137b9111d5473c50bda6698887a4dd08e7ba7812553838` and possession tag is `3e0df041a520a11c80cfb53323f126b1`.

Add one RED test each for valid CREATED, wrong endpoint/route signature, wrong descriptor X25519 key, every transcript field mutation, challenge/tag mutation, replay, expiry, wrong parameters, and suppressed CREATED timing out at 5,000 ms. No circuit may become `OPEN` before all checks pass.

- [ ] **Step 10: Implement destination proof and derive end-to-end payload keys GREEN**

After CREATED verifies, derive RoutePayload forward/reverse keys from the destination X25519 shared secret using transcript `DOMAIN.ROUTE_PAYLOAD || compiledTranscriptHash`; activation challenges use `DOMAIN.ACTIVATE_CHALLENGE`, so nonce/key material cannot overlap. Destroy source challenge plaintext and ephemeral secret after derivation. Replay tombstones are inserted before any binding becomes `OPEN` and survive every later activation failure until route epoch expiry. Run activation tests; all PASS.

- [ ] **Step 11: Write the failing bidirectional compiled-route test**

Use one public API only: `circuit.sendDatagram(data)`, `circuit.sendStreamFrame(data)`, `circuit.drain()`, and `circuit.destroy()`.

```js
test('source and destination exchange fixed cells without a direct edge', async (t) => {
  const route = await createCompiledRoute({ safetyHops: 2, privateHops: 2 })
  const received = []
  route.destination.ondata = (data) => received.push(data)

  route.circuit.sendDatagram(b4a.from('private payload'))
  route.network.flush()

  t.alike(received, [b4a.from('private payload')])
  t.is(route.network.hasEdge('source', 'destination'), false)
  t.alike(route.network.directPeers('source'), ['guard'])
  t.alike(route.network.directPeers('destination'), ['private-final'])
  t.is(route.state, 'open')
})
```

Every relay test hook records the 1100-byte opaque frame hash and asserts no relay receives RoutePayload keys or finds plaintext. Assert the permitted view of source, guard, every Safety relay, entry, every hidden private relay, destination, and test harness separately; only the harness may inspect full topology.

- [ ] **Step 12: Complete delivery only after observing RED, then verify GREEN**

Run before completing simulator wiring: `npm run test:one --prefix packages/private-routes -- test/compiled-route.test.js`

Expected: FAIL because end-to-end activation/delivery is incomplete.

Complete only the missing activation/delivery code, then rerun the same command.

Expected: PASS.

Run: `npm test --prefix packages/private-routes`

Expected: PASS.

- [ ] **Step 13: Add failing lifecycle/rotation cleanup tests, then minimal GREEN behavior**

Test exact transitions: `CREATE → CREATED → OPEN`; new epoch opens while old is `DRAINING`; old accepts reverse receive only and rejects new sends with `CIRCUIT_STATE`; drain expires at 5,000 ms; `SenderCounter.needsRotation` starts replacement before exhaustion; relay loss attempts one route replacement and otherwise returns `ROUTE_UNAVAILABLE`. For wrong proof, timeout, relay loss, counter exhaustion, queue overflow, and explicit destroy, assert state `DESTROYED`, zero relay maps/queues/owned secrets, no pending virtual deliveries, and no call to any transport/fallback other than installed adjacent virtual links.

Run focused activation/route/compiled files, then full package tests. Expected: PASS.

- [ ] **Step 14: Commit**

```bash
git add packages/private-routes/lib/activation.js packages/private-routes/lib/activation-fragments.js packages/private-routes/lib/route-manager.js packages/private-routes/test/activation.test.js packages/private-routes/test/route-manager.test.js packages/private-routes/test/compiled-route.test.js packages/private-routes/test/helpers.js packages/private-routes/index.js
git commit -m "feat: simulate compiled private routes"
```

### Task 12: Add adversarial, property, fuzz, and CI gates

**Files:**
- Create: `packages/private-routes/test/adversarial.test.js`
- Create: `packages/private-routes/test/property.test.js`
- Create: `packages/private-routes/fuzz/cell.js`
- Create: `.github/workflows/private-routes.yml`
- Modify: `packages/private-routes/README.md`

- [ ] **Step 1: Write named failing adversarial cases with exact oracles**

Use one Brittle test per row, a 5,000 ms activation timeout, and explicit `err.code` assertions:

| Fault | Virtual action | Expected result |
| --- | --- | --- |
| dropped CREATE | drop first CREATE; advance to 5,000 | `ROUTE_UNAVAILABLE`, `DESTROYED`, zero bindings/bytes |
| late CREATED | deliver at 5,001 | same; late proof rejected without reinstall |
| duplicate/replay | deliver authenticated packet twice | second is `REPLAY`; circuit destroyed and cleaned |
| datagram reorder in window | reverse two unseen counters within window | both delivered once; circuit remains `OPEN` |
| datagram below floor | deliver unseen counter below inclusive floor | `REPLAY`; circuit destroyed and cleaned |
| known-binding header mutation | flip version/class/direction/flags/epoch/counter bytes while retaining installed circuit ID | `CELL_INVALID`; counter unchanged; selected circuit cleaned |
| circuit-ID mutation | flip each circuit-ID byte so no binding matches | stateless `CELL_INVALID`; all installed circuits/counters remain unchanged |
| ciphertext mutation | flip representative first/middle/final ciphertext bytes | `CELL_INVALID`; counter unchanged; cleanup |
| wrong direction | replay forward packet on reverse binding | `CELL_INVALID`; cleanup |
| suppressed entry/destination proof | drop each proof independently; advance to 5,000 | `ROUTE_UNAVAILABLE`; all half-open state removed |

Every circuit-selected failing row must end with `activeCircuits = 0`, `queuedBytes = 0`, `ownedSecretBytes = 0`, no pending deliveries, and no source-destination edge. The unknown circuit-ID row is explicitly stateless: it asserts the preexisting active count, counters, queues, secrets, and pending deliveries are byte-for-byte unchanged. The in-window success row retains only the expected installed bindings.

Run: `npm run test:one --prefix packages/private-routes -- test/adversarial.test.js`

Expected: the newly added row FAILS for its named missing cleanup/check before implementation; do not accept a vague “at least one” failure.

- [ ] **Step 2: Implement only missing fail-closed cleanup behavior**

Do not relax a test oracle to accept partial success. Route failure must destroy partial state, zero queued plaintext, and surface `ROUTE_UNAVAILABLE` without calling any unmodeled transport.

Rerun: `npm run test:one --prefix packages/private-routes -- test/adversarial.test.js`

Expected: PASS.

- [ ] **Step 3: Add deterministic property tests and run them directly**

Use a small seeded xorshift generator in `test/helpers.js`, not a new runtime dependency. Across at least 500 generated cases per CI run, assert:

- arbitrary payloads up to the exact maximum round-trip;
- mutation of any cell byte never yields altered accepted plaintext;
- accepted datagram counters are delivered at most once;
- arbitrary fragmentation/reassembly preserves bytes and bounds memory;
- generated paths with loops, wrong roles, excessive hops, or unauthorized provenance never open;
- after every generated teardown sequence all relay maps and queues are empty.

Print the seed on failure so every case is reproducible.

Generated fragmentation cases distinguish valid permutations (all unique indexes, consistent total, within limits) from malformed permutations (duplicate/conflicting/out-of-range/over-limit); valid cases reassemble exactly once and malformed cases return the specified stable code with the per-message cleanup rule from Task 8.

Run: `npm run test:one --prefix packages/private-routes -- test/property.test.js`

Expected: `500` generated cases PASS with printed base seed `1`; on failure output includes seed, case index, and the original reproducible operation sequence. Shrinking/minimization is not part of this milestone.

- [ ] **Step 4: Add a bounded standalone fuzz harness**

`fuzz/cell.js` accepts `--seed` and `--iterations`, defaults to a fixed seed and 10,000 iterations. Mutation classes and accepted outcomes are exact: unchanged valid cell → byte-exact payload; second identical delivery → `REPLAY`; any bit mutation/truncation/extension → `CELL_INVALID`; a separately generated valid next counter → exact payload. No mutated cell may produce altered accepted plaintext.

Inject a counting allocator into codec scratch allocation. Set `MAX_CELL_WORKING_BYTES = 4096`; each iteration resets current bytes, tracks high-water bytes, and fails if current becomes negative/nonzero after cleanup or high-water exceeds the limit. Error text fails the harness if it contains 32+ hex characters, IPv4/IPv6 address syntax, descriptor IDs, or fixture secrets. Unexpected exceptions/crashes are never accepted outcomes.

Run: `npm run fuzz:cell --prefix packages/private-routes -- --seed 1 --iterations 10000`

Expected: exit 0 and print `seed=1 iterations=10000 unexpected=0 highWater<=4096`.

- [ ] **Step 5: Add independent GitHub Actions CI**

Create this path-filtered workflow. The listed SHAs were resolved from the maintainers' `v4`/`v1` tags on 2026-07-12; re-check their upstream commits and security advisories during implementation before copying them unchanged:

```yaml
name: Private routes

on:
  pull_request:
    paths:
      - 'packages/private-routes/**'
      - '.github/workflows/private-routes.yml'
  push:
    branches: [main]
    paths:
      - 'packages/private-routes/**'
      - '.github/workflows/private-routes.yml'

permissions:
  contents: read

jobs:
  node:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: packages/private-routes
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: packages/private-routes/package-lock.json
      - run: npm ci
      - run: npm run format:check
      - run: npm run test:node
      - run: npm run fuzz:cell -- --seed 1 --iterations 10000

  bare:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: packages/private-routes
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5
      - uses: holepunchto/actions/bare-base@bec12a999b9472a571f1e78f3e22685319930d2f
      - run: npm ci
      - run: npm run test:bare
```

If upstream review selects newer commits, replace them with full SHAs and record the reviewed tag/commit in the implementation commit message. Never use floating action tags.

- [ ] **Step 6: Run the complete package verification matrix**

Run:

```bash
npm ci --prefix packages/private-routes
npm run format:check --prefix packages/private-routes
npm run test:node --prefix packages/private-routes
npm exec --prefix packages/private-routes -- bare --version
npm run test:bare --prefix packages/private-routes
npm run fuzz:cell --prefix packages/private-routes -- --seed 1 --iterations 10000
git diff --check
```

Expected: every command exits 0; `npm ci` installs the manifest-pinned `bare-runtime@1.30.3`, `npm exec ... bare --version` reports `1.30.3`, and Brittle runs through that local binary. The exact-SHA GitHub Bare job is an additional authoritative clean-Linux gate, not a substitute for recording whether local Bare ran.

- [ ] **Step 7: Confirm scope and package contents**

Run: `npm pack --dry-run --prefix packages/private-routes`

Expected: only `index.js`, `lib/**`, `docs/**`, `README.md`, and manifest metadata; no tests, fuzz corpus, keys, addresses, captures, or PearTube files.

Run: `git diff --name-only 96019c2e3ab254debb1dcea12a2eab9ec35b64d3`

Expected: plan, `packages/private-routes/**`, and `.github/workflows/private-routes.yml` only.

- [ ] **Step 8: Update README with verified limitations and commit**

README must list the exact tested observer model, explicitly say “not production anonymity,” link the approved design/spec, and make UDX/HyperDHT/Hyperswarm/Hypercore integration the next milestone rather than implying it exists.

```bash
git add packages/private-routes .github/workflows/private-routes.yml
git commit -m "test: harden virtual private routes"
```

## Completion Gate

Milestones 0–1 are complete only when all of the following are evidenced in fresh output:

- Node and Bare suites pass independently from `packages/private-routes`;
- every production behavior was introduced after a focused failing Brittle test;
- descriptors require endpoint authorization and reject mutation/expiry/scope mismatch;
- private-only provenance never enables direct dial, ping, or public return;
- replay, wrong direction, counter exhaustion, malformed cells, and relay faults fail closed;
- a virtual source and destination exchange bidirectional fixed-size cells across both route segments;
- observer traces show endpoints only contact their permitted adjacent relay;
- all teardown paths leave zero circuit bindings and queued bytes;
- deterministic property/fuzz runs pass with reproducible seeds;
- CI uses read-only permissions, exact action SHAs, and `npm ci`;
- the package remains private and makes no real-network privacy claim.

Do not begin Milestone 2 until this completion gate is reviewed and approved.
