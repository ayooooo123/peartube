# Native DHT Private Routing — M3 Wire Registry

**Status:** Draft — independently reviewed and owner approval pending

**Date:** 2026-07-15

**Behavior specification:** `2026-07-14-native-dht-private-routing-m3-design.md`

**Stability:** Experimental and unstable; no production security or wire-compatibility claim

This registry is the byte-level companion to the M3 behavior specification. It
freezes one non-overlapping identifier namespace, canonical encodings, bounded
collections, signature inputs, fragmentation, and the already-approved
tail/final-exit transcripts. The behavior specification remains normative for
state-machine and privacy behavior. This registry will become normative for
bytes only after independent review and explicit owner approval.

This document covers capability discovery, circuit construction, opaque
destination authority, routed RPC, and the private-record storage overlay.
Implementation and publishing remain blocked until explicit owner approval of
this registry. A later external cryptographic review is also required before
any production security or stable-wire claim.

## 1. Global Encoding Rules

### 1.1 Version and scalar encoding

- `M3_PROTOCOL_VERSION = 1` and is encoded as unsigned `u32be` wherever a
  protocol version appears.
- `u8`, `u16be`, `u32be`, and `u64be` are unsigned, fixed-width, big-endian
  integers. Decoders reject negative values, fractional values, overflow, and
  JavaScript numbers that are not safe integers before encoding. `u64be` is
  represented internally as a non-negative `BigInt` and must not be coerced
  through `Number`.
- There are no varints, nullable fields, implicit defaults, optional fields,
  sentinel integers, or implementation-defined enum values in M3 v1.
- A fixed buffer written as `nB` is exactly `n` bytes.
- The only variable-byte encoding is `u16be byteLength || bytes`. The length is
  the byte length, not a character or element count. A field-specific maximum
  applies before allocation. Zero length is accepted only where this registry
  explicitly permits it.
- UTF-8 is used only for the literal ASCII domains printed in this registry.
  Implementations must use their exact bytes, with no terminator or Unicode
  normalization.
- A decoder must consume exactly one complete object. Missing bytes, trailing
  bytes, unknown IDs/enums/flags, non-canonical ordering, duplicate entries,
  or a length inconsistent with the containing object are fatal.
- Decoders copy every accepted byte field before retaining or exposing it.
  They never retain a caller-owned view. Secret temporaries are erased on every
  success, failure, timeout, and destroy path.

### 1.2 Canonical object envelope and embedded commands

Every standalone object or message in this registry uses this eight-byte
header:

```text
u32  protocolVersion = 1
u16  messageId
u16  bodyByteLength
bodyByteLength bytes body
auth suffix, if and only if the message table requires one
```

`bodyByteLength` excludes the auth suffix. An Ed25519 auth suffix is exactly
64 bytes. The explicitly registered exit/storage carrier uses a 16-byte
XChaCha20-Poly1305 tag suffix. An unsigned message has no suffix. AEAD
authentication supplied by another context envelope is not repeated in this
header and is not counted as a suffix.
The total message size is therefore `8 + bodyByteLength + authSuffixBytes`.

The nine typed commands whose names end in `/1` are the sole exception: their
command ID and command version are carried by `ROUTED_REQUEST_V1`, and their
fixed-width bytes are the request's `encodedBody`. They are not independently
wrapped in another eight-byte header. Their signed response objects, tokens,
and receipts are standalone canonical objects and do use the header. A decoder
must reject both a double-enveloped command body and a standalone command body.

For an Ed25519-signed message with domain `D`, the signature input is exactly:

```text
u16be UTF8(D).byteLength || UTF8(D) ||
u32be(1) || u16be(messageId) || u16be(bodyByteLength) || body
```

The signature is over the complete byte string once. The signer public key is
the exact identity field named by that message. Signatures are verified before
any signed object is cached, selected, or used to allocate long-lived state.
No signature domain is reused for another message kind.

Unless a digest below explicitly reproduces an already-approved construction,
a message digest named `digest(D, bytes)` is:

```text
cryptoSuite.hash([u16be UTF8(D).byteLength, UTF8(D), bytes])
```

and is exactly 32 bytes. The admitted-limits, exit-origin-policy,
payload-parameters, tail-transcript, and final-exit digests instead use the
exact approved constructions in Section 7.

### 1.3 Canonical addresses

A network address is exactly 17 bytes:

```text
u8   addressFamily  // 4 = IPv4, 6 = IPv6
16B  addressBytes
```

For IPv4, the first 12 address bytes must be zero and the final four bytes are
the address in network byte order. IPv4-mapped IPv6, textual addresses, zone
identifiers, hostnames, and any other family value are rejected. For IPv6 all
16 bytes are the network-order address. IPv6 addresses that encode IPv4-mapped
space (`::ffff:0:0/96`) are rejected so one endpoint has only one encoding.

A reachable endpoint is exactly 19 bytes:

```text
17B  canonical address
u16  port
```

Port zero is rejected. Unspecified, multicast, and broadcast addresses are
rejected for advertisements and link endpoints. Whether a private, loopback,
or link-local address is reachable is a deployment policy; its byte encoding
is still canonical. Endpoint equality is byte equality over all 19 bytes.

### 1.4 Common enums and constants

```text
BRANCH_CLASS:
  0 = LOOKUP
  1 = ANNOUNCE

M3_LINK_ROLE:
  0 = CLIENT
  1 = SAFETY_RELAY
  2 = DHT_EXIT

RELAY_CAPABILITY bit mask:
  0x00000001 = CIRCUIT_RELAY_V1
  0x00000002 = DHT_EXIT_V1
  0x00000004 = PRIVATE_RECORDS_V1
  known mask  = 0x00000007

CAPACITY_CLASS:
  0 = SMALL
  1 = MEDIUM
  2 = LARGE

MUTATION_FLAG:
  0 = READ_ONLY
  1 = MUTATING

DESTINATION_VALIDATION_CLASS:
  0 = EXIT_LOCAL
  1 = DHT_NODE_HANDLE
  2 = SIGNED_CAPABILITY_HANDLE
```

Unknown values and unknown capability bits are rejected. A capability mask is
non-zero. `LOOKUP = 0` and `ANNOUNCE = 1` are the only branch classes.

### 1.5 Identifier allocation

All M3 object/message and command identifiers share one unsigned `u16`
namespace. An ID has one meaning only, even when carried by a different
transport.

| Range           | Owner in M3 v1                                      |
| --------------- | --------------------------------------------------- |
| `0x0000`        | Invalid/unassigned                                  |
| `0x0001–0x001f` | Capability, discovery, and generic fragmentation    |
| `0x0020–0x003f` | Bilateral link and incremental extension            |
| `0x0040–0x005f` | Tail/final-exit activation and exit-network carrier |
| `0x0060–0x00ff` | Reserved for future circuit-core v1 messages        |
| `0x0100–0x017f` | Destination references, routed RPC, value commands  |
| `0x0180–0x01ff` | Routed RPC errors/control                           |
| `0x0200–0x027f` | Private-record overlay discovery                    |
| `0x0280–0x02ff` | Record prepare/commit/read/receipts                 |
| `0x0300–0xffff` | Unassigned; reject in M3 v1                         |

Core assignments are:

| ID       | Name                            | Authentication            |
| -------- | ------------------------------- | ------------------------- |
| `0x0001` | `CAPABILITY_ADVERTISEMENT_V1`   | Ed25519                   |
| `0x0002` | `CAPS_QUERY_V1`                 | transport/request binding |
| `0x0003` | `CAPS_RESPONSE_V1`              | Ed25519                   |
| `0x0004` | `ACTIVE_CHALLENGE_V1`           | live CAPS cookie          |
| `0x0005` | `ACTIVE_CHALLENGE_RESPONSE_V1`  | cookie + Ed25519/X25519   |
| `0x0006` | `RELAY_DISCOVER_V1`             | tail-control AEAD         |
| `0x0007` | `RELAY_DISCOVER_RESPONSE_V1`    | tail-control AEAD         |
| `0x0008` | `CORE_FRAGMENT_V1`              | containing transport      |
| `0x0009` | `CAPS_COOKIE_CHALLENGE_V1`      | keyed BLAKE2b cookie      |
| `0x0020` | `LINK_OFFER_V1`                 | Ed25519                   |
| `0x0021` | `LINK_ACCEPT_V1`                | Ed25519                   |
| `0x0022` | `REDACTED_RESPONDER_PROOF_V1`   | Ed25519                   |
| `0x0023` | `EXTENDED_V1`                   | prior tail-control AEAD   |
| `0x0024` | `TAIL_READY_V1`                 | Ed25519 + new tail AEAD   |
| `0x0025` | `EXTEND_REQUEST_V1`             | current tail-control AEAD |
| `0x0040` | `DHT_EXIT_ACTIVATE_V1`          | tail-finalize AEAD        |
| `0x0041` | `DHT_EXIT_READY_V1`             | Ed25519 + tail-finalize   |
| `0x0042` | `DHT_EXIT_READY_ACK_V1`         | final-finalize AEAD       |
| `0x0043` | `DHT_EXIT_OPEN_V1`              | final-finalize AEAD       |
| `0x0044` | `DHT_EXIT_SEEDS_V1`             | Ed25519 + terminal AEAD   |
| `0x0050` | `EXIT_RPC_OPEN_V1`              | Ed25519                   |
| `0x0051` | `EXIT_RPC_ACCEPT_V1`            | storage-session AEAD      |
| `0x0052` | `EXIT_RPC_FRAGMENT_V1`          | storage-session AEAD      |
| `0x0053` | `EXIT_RPC_REQUEST_V1`           | storage-session AEAD      |
| `0x0054` | `EXIT_RPC_RESPONSE_V1`          | storage-session AEAD      |
| `0x0100` | `DESTINATION_REF_V1`            | exit MAC + route context  |
| `0x0101` | `ROUTED_REQUEST_V1`             | route-payload AEAD        |
| `0x0102` | `ROUTED_REPLY_V1`               | route-payload AEAD        |
| `0x0120` | `IMMUTABLE_GET/1`               | typed routed command      |
| `0x0121` | `IMMUTABLE_PUT/1`               | typed routed command      |
| `0x0122` | `MUTABLE_GET/1`                 | typed routed command      |
| `0x0123` | `MUTABLE_PUT/1`                 | typed routed command      |
| `0x0200` | `PRIVATE_FIND_NODE/1`           | typed routed command      |
| `0x0201` | `PRIVATE_FIND_NODE_RESPONSE_V1` | Ed25519                   |
| `0x0280` | `PRIVATE_PRESENCE_RECORD_V1`    | endpoint Ed25519          |
| `0x0281` | `PRIVATE_TOMBSTONE_V1`          | endpoint Ed25519          |
| `0x0282` | `PRIVATE_LOOKUP_RESPONSE_V1`    | storage Ed25519           |
| `0x0283` | `PRIVATE_WRITE_TOKEN_V1`        | storage MAC               |
| `0x0284` | `PRIVATE_WRITE_RECEIPT_V1`      | storage Ed25519           |
| `0x02a0` | `PRIVATE_LOOKUP/1`              | typed routed command      |
| `0x02a1` | `PRIVATE_PREPARE/1`             | typed routed command      |
| `0x02a2` | `PRIVATE_ANNOUNCE/1`            | typed routed command      |
| `0x02a3` | `PRIVATE_UNANNOUNCE/1`          | typed routed command      |

## 2. Capability Advertisement and Service Policy

### 2.1 `CAPABILITY_ADVERTISEMENT_V1` (`0x0001`)

Signature domain:
`hyperdht-private-routes/m3/capability-advertisement/v1`.

The signed body is:

```text
32B  relayIdentity                 // Ed25519 public key and signer
32B  currentDhtNodeId
19B  reachableEndpoint
32B  routeEncryptionPublicKey      // X25519, epoch scoped
u32  capabilityMask
u32  minimumProtocolVersion        // exactly 1 in M3 v1
u32  maximumProtocolVersion        // exactly 1 in M3 v1
u16  cellSize                      // exactly 1200
u16  maxCellPayload                // exactly 1146
u16  contextEnvelopeSize           // exactly 1101
u16  routeFrameSize                // exactly 1100
u16  maxRoutePayload               // exactly 1073
u16  datagramReplayWindow          // exactly 64
u16  maxConcurrentCircuits         // 1..65535
u8   capacityClass
u32  maxCellsPerCircuit            // non-zero
u32  maxBytesPerCircuit            // non-zero
u32  maxCommandsPerCircuit         // non-zero
u32  idleTimeoutMs                 // non-zero
u32  maxQueuedBytes                // non-zero
u64  epoch                         // non-zero
u64  issuedAtMs
u64  expiresAtMs                   // issuedAtMs < expiry <= issuedAtMs + 1,800,000
u16  providerServicePolicyEntryCount // exactly 0, 4, 5, or 9
providerServicePolicyEntryCount * 32B providerServicePolicyEntry
```

Each provider-service-policy entry uses this exact encoding:

```text
u16  commandId
u16  commandVersion
u32  maxRequestBytes
u32  maxResponseBytes              // complete ROUTED_REPLY_V1 wire bytes
u32  timeoutMs
u16  maxOutstanding
u32  requestCost
u32  responseCost
u32  maxAmplificationBytes
u8   mutationFlag
u8   destinationValidationClass
```

Entries are strictly sorted by unsigned `(commandId, commandVersion)` and may
not duplicate a pair. Every entry must byte-equal one of the nine complete
tuples in Section 10.5. Object, response, error, reserved, or unassigned IDs
and arbitrary budgets are invalid.

The advertised entries describe services this node provides, not commands a
different DHT exit may originate through it. The capability-to-entry mapping is
exactly:

| Advertised service capabilities  | Required entries                |
| -------------------------------- | ------------------------------- |
| neither exit nor private records | 0                               |
| `DHT_EXIT_V1` only               | the 4 immutable/mutable entries |
| `PRIVATE_RECORDS_V1` only        | the 5 private-record entries    |
| both exit and private records    | all 9 entries                   |

No other subset is valid. `PRIVATE_RECORDS_V1` is independent of
`DHT_EXIT_V1` and `CIRCUIT_RELAY_V1`: a storage-only node need not participate
in an M2 route or derive an M2 route role. A node advertising `DHT_EXIT_V1`
must also advertise `CIRCUIT_RELAY_V1`, because terminating the route is an
operational dependency of the exit service. A route participant derives M2
`ROLE.SAFETY` when it offers circuit forwarding without exit service and M2
`ROLE.PRIVATE` when it offers `DHT_EXIT_V1`; storage capability alone imposes
no M2 role.

The fixed body is 188 bytes. Each policy entry is 32 bytes. Therefore:

```text
bodyBytes = 188 + 32 * providerServicePolicyEntryCount
wireBytes = 8 + bodyBytes + 64
minimum   = 260 bytes
maximum   = 548 bytes (9 policy entries)
```

The maximum signed advertisement fits one 1,073-byte route payload. The
advertisement digest used elsewhere is:

```text
cryptoSuite.hash([
  UTF8('hyperdht-private-routes/m3/capability-advertisement-digest/v1'),
  completeSignedAdvertisementBytes
])
```

The digest is computed only after canonical decoding and signature validation.
The current DHT node ID is routing metadata and is not treated as a signing
identity. M3 v1 nevertheless requires an IPv4 `reachableEndpoint`: existing
`dht-rpc/lib/peer.js` derives an ID only from compact-encoded IPv4 plus port.
The receiver hashes exactly `4B IPv4 octets || u16le(port)` with the existing
32-byte `sodium.crypto_generichash` derivation and requires byte equality with
`currentDhtNodeId`. (The advertisement's canonical endpoint still encodes its
port as registry `u16be`; derivation re-encodes the numeric port with the
existing little-endian codec.) IPv6 remains a
canonical address encoding for future objects but is invalid in an M3 v1
capability advertisement or DHT-node handle. The route-encryption key must be a
valid non-low-order X25519 public key. Expired advertisements, advertisements with a lifetime greater than
1,800,000 ms (30 minutes), epochs older than an already accepted epoch for the
same identity, zero limits, framing mismatches, and role/capability mismatches
are rejected. A same-identity, same-epoch advertisement is accepted only when
its complete signed bytes are byte-identical. A different same-epoch object is
equivocation: both objects and that identity are quarantined until expiry.
Every policy, capability, endpoint, or limit change requires a strictly greater
epoch and a fresh `routeEncryptionPublicKey`; reuse of the prior epoch key is
rejected. Older epochs never become current again. The 30-minute lifetime is a draft security/availability choice
in Section 15 and is not owner-approved.

### 2.2 Exit-origin command-policy digest

The exit-origin command-policy digest in final-exit activation describes commands
the DHT exit may originate. It is distinct from the provider-service entries
inside any one advertisement. In M3 v1, `DHT_EXIT_V1` authorizes exactly the
nine complete Section 10.5 tuples, even when the exit itself advertises only
the four legacy services and sends private-record commands to a separate
storage provider.

The digest is:

```text
cryptoSuite.hash([domain, encoding])
```

where `domain` is the raw UTF-8 bytes of
`hyperdht-private-routes/final-exit/service-policy/v1`, and `encoding` is:

```text
u16 entryCount || entries in strict (commandId, commandVersion) order
```

where `entryCount` is exactly 9 and the entries are the exact nine 32-byte
Section 10.5 tuples. This byte encoding and its digest are immutable constants
of M3 protocol version 1, compiled independently into client and exit. The
signed advertisement authorizes use of the exit through `DHT_EXIT_V1`; it does
not let the operator choose this origin policy or its budgets. A change to any
tuple requires a new protocol version. There is no domain-length prefix in this
approved digest construction. Duplicate, unsorted, missing, unknown, or
invalid entries make the digest invalid. Advertisement validation separately
enforces the provider entry set in Section 2.1; that set is not copied into this
digest.

## 3. Capability and Relay Discovery

### 3.1 Collection rules

Every advertisement collection contains at most
`MAX_CAPABILITY_ADVERTISEMENTS = 8`. An element is encoded as:

```text
u16 advertisementByteLength || complete signed advertisement bytes
```

`advertisementByteLength` is `260..548`. Collections contain no duplicate
advertisement digest or relay identity. They are strictly sorted by:

1. ascending unsigned XOR distance between the request `randomTarget` and the
   advertisement's `currentDhtNodeId`;
2. lexicographic `relayIdentity` bytes;
3. ascending `epoch`.

The receiver recomputes this order and rejects the entire collection if it is
non-canonical. A returned advertisement must include every requested
capability bit to qualify as a result, although incompatible signed entries may
be retained only as bounded negative evidence and never selected.

### 3.2 `CAPS_QUERY_V1` (`0x0002`)

```text
u32  requestedCapabilityMask
32B  randomTarget
32B  queryNonce
u8   maximumResults               // 1..8
u8   cookiePhase                  // 0 initial, 1 validated retry
u64  cookieExpiresAtMs            // zero in phase 0
32B  returnRoutabilityCookie      // all zero in phase 0
```

The body is exactly 110 bytes and the wire message is exactly 118 bytes. The
mask is non-zero and contains only known bits. The query nonce must be freshly
random. Phase 0 requires zero expiry and an all-zero cookie and can elicit only
the challenge below. Phase 1 repeats every other query byte and echoes the
challenge expiry/cookie. It can elicit advertisements only after validation
against the observed packet source. The non-extending 5,000 ms exchange
deadline begins when phase 0 is sent and includes retry and reassembly.

### 3.3 `CAPS_COOKIE_CHALLENGE_V1` (`0x0009`)

```text
32B  queryNonce
u64  cookieExpiresAtMs
32B  returnRoutabilityCookie
```

The body is exactly 72 bytes and the wire datagram is exactly 80 bytes, less
than the 118-byte phase-0 query. Expiry is after receipt and no later than
5,000 ms after it. The cookie is 32-byte keyed BLAKE2b under a
responder-local secret over:

```text
u16be domainByteLength ||
UTF8('hyperdht-private-routes/m3/caps-return-cookie/v1') ||
19B observedSourceEndpoint || u32be requestedCapabilityMask ||
randomTarget || queryNonce || u8 maximumResults || u64be cookieExpiresAtMs
```

The responder generates the current secret as exactly 32 CSPRNG bytes. It
rotates that secret exactly every 300,000 ms, retains the immediately prior
secret for exactly 5,000 ms, and keeps at most those two secrets. It erases the
prior secret after that retention interval and erases both secrets on stop. It
stores no phase-0 state. A phase-1 retry
must arrive from the exact bound endpoint before expiry. The cookie authorizes
only one query-bound CAPS object to that endpoint. An exact replay can receive
only the byte-identical cached response; conflicting reuse is dropped. The
cache is capped at 4,096 entries and five seconds. Before cookie validation,
the complete response budget is one 80-byte challenge and never exceeds the
118-byte request; the responder performs no advertisement signatures,
fragment emission, or bulk reassembly allocation.

### 3.4 `CAPS_RESPONSE_V1` (`0x0003`)

Signature domain: `hyperdht-private-routes/m3/caps-response/v1`.

```text
32B  responderIdentity            // signer
32B  queryNonce                   // exact request nonce
u64  responseTimeMs
u8   advertisementCount           // 1..min(request.maximumResults, 8)
repeated u16 advertisementByteLength || signed advertisement
64B  Ed25519 signature suffix
```

The responder identity is an advertised relay/storage identity, not a DHT node
ID. The response signature makes fragmentation and query binding detectable;
each candidate advertisement still requires its own signature and later active
challenge. The collection includes exactly one current advertisement whose
identity and reachable endpoint match the responder and queried endpoint; that
self-advertisement counts against the result limit. The body is
`73 + sum(2 + advertisementByteLength)` bytes. Its exact bounds are:

```text
one minimum advert:    body 335, wire 407
eight maximum adverts: body 4473, wire 4545
```

A nonce mismatch, absent cookie validation, response received from a different queried endpoint,
invalid responder signature, late response, count/length mismatch, invalid
candidate, duplicate, or non-canonical sort order rejects the response.

### 3.5 `ACTIVE_CHALLENGE_V1` (`0x0004`)

```text
32B  advertisementDigest
32B  challengeNonce
32B  challengerEphemeralPublicKey // X25519
u64  challengeExpiresAtMs
32B  capsQueryNonce
u64  cookieExpiresAtMs
32B  returnRoutabilityCookie
```

The body is exactly 176 bytes and the wire message is exactly 184 bytes. The
deadline is at most 5,000 ms after local send time. The challenger key and
nonce are fresh for one challenge. Cookie-gated direct challenge is permitted
only for (a) a client probing a prospective guard or (b) a route exit probing a
`PRIVATE_RECORDS_V1` storage candidate under its bounded capability-cache
admission budget before minting a `SIGNED_CAPABILITY_HANDLE`. In both cases it
must arrive from the same observed source endpoint that completed the
challenger's own phase-1 CAPS query/cookie flow, while that exact tuple remains
live in the responder's bounded five-second cache. The exit uses its own public
source endpoint and never forwards or substitutes a client endpoint.
Pre-validation work is bounded to fixed-field parsing, one
4,096-entry cache lookup, and at most one keyed-BLAKE2b cookie recomputation.
The responder performs no X25519, Ed25519 signing, route-key proof work, or
exchange allocation before that succeeds. Invalid/unbound challenge receives
zero response bytes.

Clients never directly challenge middle or exit candidates.
Behind a guard, the current tail sends signed `LINK_OFFER_V1` through the
partially authenticated route; its 374-byte authenticated request, LINK_ACCEPT,
and tail transcript jointly prove the candidate identity/route key. Thus routed
discovery has an authenticated adjacency path and does not require a CAPS
cookie visible to the client or candidate.

### 3.6 `ACTIVE_CHALLENGE_RESPONSE_V1` (`0x0005`)

Signature domain: `hyperdht-private-routes/m3/active-challenge-response/v1`.

```text
32B  advertisementDigest
32B  responderIdentity            // signer; equals advertisement identity
32B  challengeNonce
32B  challengerEphemeralPublicKey // exact challenge value
32B  responderNonce
u64  challengeExpiresAtMs         // exact challenge value
32B  capsQueryNonce               // exact challenge value
u64  cookieExpiresAtMs            // exact challenge value
32B  returnRoutabilityCookie      // exact challenge value
32B  routeKeyPossessionProof
64B  Ed25519 signature suffix
```

The body is exactly 272 bytes and the wire message is exactly 344 bytes. The
responder computes X25519 using its advertised route-encryption secret and the
challenger ephemeral public key. A low-order input or all-zero shared secret is
rejected. The proof is the 32-byte keyed BLAKE2b output whose key is that shared
secret and whose input is:

```text
u16be domainByteLength || UTF8(domain) ||
advertisementDigest || responderIdentity || challengeNonce ||
challengerEphemeralPublicKey || responderNonce || u64be(challengeExpiresAtMs) ||
capsQueryNonce || u64be(cookieExpiresAtMs) || returnRoutabilityCookie
```

where `domain` is
`hyperdht-private-routes/m3/active-challenge/route-key-proof/v1`.
The Ed25519 signature covers the body including the possession proof. The
receiver requires equality with the live advertisement and outstanding
challenge, verifies both proofs, consumes the nonce once, and rejects expired,
replayed, cross-endpoint, cross-advertisement, or cross-epoch responses.

### 3.7 `RELAY_DISCOVER_V1` (`0x0006`)

```text
u32  requestedCapabilityMask
32B  randomTarget
32B  queryNonce
u8   maximumResults               // 1..8
```

The body is exactly 69 bytes and the wire message is exactly 77 bytes. It is
accepted only in `TAIL_CONTROL_ORDERED` at the current tail and never on a
direct bootstrap socket. The current tail performs the bounded public DHT walk;
the client-supplied target orders discovery only and does not authorize a dial.
The complete query/response exchange has a non-extending 5,000 ms deadline from
the request send.

### 3.8 `RELAY_DISCOVER_RESPONSE_V1` (`0x0007`)

```text
32B  queryNonce
u64  responseTimeMs
u8   advertisementCount           // 0..8
repeated u16 advertisementByteLength || signed advertisement
```

The tail-control AEAD authenticates this response; each candidate is also
independently signed. The body is `41 + sum(2 + advertisementByteLength)`.
Exact bounds are 41-byte body/49-byte wire for zero results and 4441-byte
body/4449-byte wire for eight maximum advertisements. The request nonce,
capability filter, uniqueness, sort order, and fragment bounds are mandatory.

## 4. Core Object Fragmentation

Only a complete canonical message is semantically decoded. Fragmentation never
changes its ID, signature input, digest, or body. `CORE_FRAGMENT_V1` (`0x0008`)
has this body:

```text
u16  objectMessageId
32B  objectDigest
u32  totalObjectBytes
u16  fragmentIndex
u16  fragmentCount
u32  fragmentOffset
u16  fragmentDataBytes
fragmentDataBytes bytes fragmentData
```

The fixed fragment body is 48 bytes and the complete fragment header is 56
bytes including the canonical eight-byte message header. `objectDigest` is:

```text
cryptoSuite.hash([
  UTF8('hyperdht-private-routes/m3/core-fragment/object/v1'),
  completeCanonicalObjectBytes
])
```

The following bounds are exact:

| Transport                              | Packet/payload cap | Fragment data cap | Object cap | Fragment cap |
| -------------------------------------- | ------------------ | ----------------- | ---------- | ------------ |
| Routed M3 context payload              | 1073               | 1017              | 12288      | 13           |
| Direct bootstrap UDP response datagram | 1200               | 1144              | 12288      | 11           |

`fragmentCount = ceil(totalObjectBytes / fragmentDataCap)`. Every fragment
except the last has exactly `fragmentDataCap` data bytes. For fragment `i`,
`fragmentOffset = i * fragmentDataCap`; the last fragment carries exactly the
remaining bytes. `fragmentIndex < fragmentCount`, all counts are non-zero, and
`objectMessageId` must match the reassembled object's header. Sparse,
overlapping, duplicate-index-with-different-bytes, misaligned, over-cap,
digest-mismatched, trailing, and nested `CORE_FRAGMENT_V1` objects are rejected.
An identical duplicate fragment is discarded without extending any deadline.

A routed receiver permits at most four concurrent reassemblies and 49,152
reserved object bytes per circuit. A direct bootstrap receiver permits at most
two concurrent reassemblies and 24,576 reserved object bytes per queried
endpoint. Reservation occurs only after fragment zero passes all scalar bounds;
for direct CAPS it additionally requires a valid phase-1 return-routability
cookie and live query tuple before any reservation. Later fragments cannot increase it. Reassembly expires exactly 5,000 ms after
the first accepted fragment, is never extended, and erases partial storage.

The direct bootstrap transport is deliberately narrower than routed M3:

- it sends only `CAPS_QUERY_V1`, `CAPS_COOKIE_CHALLENGE_V1`,
  `CAPS_RESPONSE_V1`, `ACTIVE_CHALLENGE_V1`,
  `ACTIVE_CHALLENGE_RESPONSE_V1`, and cookie-authorized fragments whose
  `objectMessageId` is `CAPS_RESPONSE_V1`;
- requests and unfragmented responses are one UDP datagram of at most 1,200
  bytes;
- at most one CAPS query is outstanding per canonical endpoint; fragments are
  emitted or accepted only after cookie validation and only for that endpoint,
  nonce, query fields, and five-second deadline;
- one query accepts one completed response object; later fragments are dropped;
- no fragment elicits a fragment-level acknowledgement or error, preventing
  reflection amplification;
- the response signature is checked after reassembly and before advertisements
  are exposed.

`RELAY_DISCOVER_RESPONSE_V1`, `DHT_EXIT_SEEDS_V1`, and outer routed command/reply objects are the M3 objects
expected to require routed fragmentation. `CAPS_RESPONSE_V1` requires direct
fragmentation when its canonical bytes exceed 1,200. Every other core setup
message fits one 1,073-byte routed payload and, where direct transport is
permitted, one 1,200-byte datagram.

## 4A. Exit-to-Network RPC Carriers

The client never uses either carrier in this section. The route exit originates
all packets from its own public endpoint after validating a branch-bound
destination handle. There is no client address field and no direct fallback.

### 4A.1 Existing DHT-RPC compatibility carrier

The four immutable/mutable commands use the unchanged dht-rpc v6 IPv4 UDP
request/response codec and ordinary DHT token. They do not use M3 object
fragmentation. An exit uses its DHT-RPC client socket, accepts a response only
from the requested IPv4 endpoint with the outstanding transaction ID, and uses
a 1,251-byte receive buffer solely to detect and drop any datagram longer than
`DHT_RPC_COMPAT_DATAGRAM_MAX = 1250`.

The bound follows the existing codec exactly. A request has ten fixed bytes
(type/version, flags, transaction ID, six-byte IPv4 destination), one-byte
command, and a 32-byte target. A persistent response adds a 32-byte responder
ID, a 32-byte token, and at most twenty six-byte closer nodes plus their
one-byte array count, for a 195-byte response prefix. Compact buffer lengths
for the bounded values below occupy three bytes.

```text
immutable GET request                         = 10 + 1 + 32 = 43
immutable PUT request                         = 43 + 32 + 3 + 1024 = 1102
immutable GET maximum response                = 195 + 3 + 1024 = 1222
mutable signed PUT value                      = 32 + 9 + 3 + 896 + 64 = 1004
mutable PUT request                           = 43 + 32 + 3 + 1004 = 1082
mutable GET maximum response value            = 9 + 3 + 896 + 64 = 972
mutable GET maximum response                  = 195 + 3 + 972 = 1170
all valid maxima                              <= 1222 <= 1250
IPv4 packet at the ceiling                    = 20 + 8 + 1250 = 1278
```

Nine bytes is the current compact-uint maximum for a JavaScript-safe mutable
sequence. The remaining 28 bytes below the 1,250-byte ceiling tolerate no new
field: unknown flags, more than twenty closer nodes, trailing bytes, invalid
peer-ID derivation, a truncation indication, or a longer datagram is rejected.
The exit allocates at most one 1,251-byte receive buffer per outstanding legacy
request, at the Section 10.5 outstanding limits, for the original three-second
deadline. This is one bounded interoperable UDP datagram, not a new
unauthenticated fragmentation protocol.

### 4A.2 Authenticated private-storage session

The five private-record commands use the registered carrier below. The exit
already retains the selected storage node's signed capability advertisement in
the handle table. Its `routeEncryptionPublicKey` is the discoverable static
X25519 public key; storage retains the matching epoch-scoped secret. Each
exchange uses a fresh exit ephemeral X25519 key and fresh 16-byte `exchangeId`.

`EXIT_RPC_OPEN_V1` (`0x0050`) has signature domain
`hyperdht-private-routes/m3/exit-rpc-open/v1` and body:

```text
16B  exchangeId
32B  storageIdentity
32B  storageAdvertisementDigest
32B  exitAdvertisementDigest
u16  exitAdvertisementByteLength     // exactly 388 or 548
exitAdvertisementByteLength bytes complete signed exit advertisement
32B  exitEphemeralPublicKey
u64  absoluteDeadlineMs
u16  requestObjectBytes              // 38..1199
u16  requestFragmentCount            // 1..2
32B  requestObjectDigest
64B  exit Ed25519 signature suffix
```

The body is `190 + exitAdvertisementByteLength`, or 578..738 bytes; wire size
is 650..810 bytes. The embedded advertisement must advertise `DHT_EXIT_V1` and
therefore has either the four-entry provider policy (388 bytes) or the
nine-entry provider policy (548 bytes). It need not advertise
`PRIVATE_RECORDS_V1`. Its signer signs OPEN. `exitAdvertisementDigest` and
`storageAdvertisementDigest` are each exactly the 32-byte Section 2.1
capability-advertisement digest of the named complete signed advertisement; the
embedded exit advertisement must reproduce the former byte-for-byte. The
separately obtained current target-storage advertisement named by the handle
and `storageAdvertisementDigest` must advertise `PRIVATE_RECORDS_V1`, so its
provider policy contains exactly five or nine entries (420 or 548 bytes). The
exit's authority to originate the private command comes from the immutable M3
v1 exit-origin policy in Section 2.2, not from a private-record provider entry
in the exit advertisement.

Before X25519 or allocation, storage applies a per-source cap of eight
syntactically valid OPEN packets per second and a global token bucket of 64
Ed25519 OPEN verifications per second with burst 128, independent of source
addresses. Exhaustion silently drops OPEN before signature or X25519 work. It
then verifies source endpoint equals the advertisement, peer-ID equality, both
signatures, epoch/expiry, storage identity and exact current storage-advertisement
digest, deadline at most five seconds, fresh exchange ID, canonical counts, and
digest. Only then may it derive keys and reserve the exact request size.

The accepted replay key is `(exitIdentity, exchangeId)` and is retained until
the OPEN deadline, at most five seconds, in a 4,096-entry global cache. After
fixed-size/canonical parsing, a byte-for-byte cache match is checked before
consuming either verification-rate budget. An exact byte-identical OPEN replay receives only the byte-identical cached ACCEPT and
does not verify signatures, run X25519/KDF, allocate, or extend any deadline.
A different validly signed OPEN for the same key is conflicting reuse: storage
destroys any partial exchange, caches the conflict through the original
deadline, and responds to neither object. Invalid OPEN is silently dropped and
elicits no response.

Let `S = X25519(storageRouteSecret, exitEphemeralPublicKey)`, rejecting
low-order keys and all-zero `S`. The exact transcript is:

```text
u16be domainByteLength ||
UTF8('hyperdht-private-routes/m3/exit-storage-session/v1') ||
u32be(1) || exchangeId || exitIdentity || storageIdentity ||
exitAdvertisementDigest || storageAdvertisementDigest ||
exitEphemeralPublicKey || storageRouteEncryptionPublicKey ||
u64be(absoluteDeadlineMs) || u16be(requestObjectBytes) ||
u16be(requestFragmentCount) || requestObjectDigest
```

The domain is exactly 50 bytes. The fixed fields after it are exactly 256
bytes, so the complete transcript is exactly `2 + 50 + 256 = 308` bytes. No
generic or implementation-selected digest operation occurs while constructing
it.

Each keyed BLAKE2b invocation produces exactly 32 output bytes under `S` over
`u16be(labelLength) || UTF8(label) || u32be(transcriptLength) || transcript`.
The four exact labels are `exit-storage/request-key/v1`,
`exit-storage/request-nonce/v1`, `exit-storage/response-key/v1`, and
`exit-storage/response-nonce/v1`. Request and response keys use all 32 output
bytes; request and response nonce prefixes use the first 16 output bytes. These
output-consumption lengths are not label lengths. `S` and the ephemeral secret
are erased immediately after derivation.

`EXIT_RPC_ACCEPT_V1` (`0x0051`) has this 124-byte body:

```text
16B exchangeId
32B exitIdentity
32B storageIdentity
32B requestObjectDigest
u64 absoluteDeadlineMs
u16 requestObjectBytes
u16 maximumResponseObjectBytes       // exactly 8090
16B XChaCha20-Poly1305 tag suffix
```

Its wire size is 148 bytes. The tag authenticates an empty plaintext with the
response key, nonce `responseNoncePrefix || u64be(0)`, and the complete
eight-byte header plus body as associated data. The exit sends no fragments
until this tag validates against the exact OPEN transcript.

`EXIT_RPC_FRAGMENT_V1` (`0x0052`) body is:

```text
16B exchangeId
u8  direction                         // 0 request, 1 response
u16 fragmentIndex
u16 fragmentCount
u16 totalObjectBytes
u16 fragmentOffset
u16 fragmentDataBytes
fragmentDataBytes bytes ciphertext
16B XChaCha20-Poly1305 tag suffix
```

The fixed body is 27 bytes and wire size is `51 + fragmentDataBytes`, so one
1,200-byte UDP datagram carries exactly 1,149 data bytes. Request fragments use
the request key and nonce `requestNoncePrefix || u64be(fragmentIndex + 1)`;
response fragments use the response key and analogous response nonce. The
complete canonical header and fixed fragment fields are associated data.
Fragments are full-sized except the last, strictly offset, and exact duplicate
retransmissions are ignored. Different bytes at one index, overlap, sparse
completion, wrong direction/source endpoint, replay outside this exchange, or
digest mismatch destroys the exchange.

`EXIT_RPC_REQUEST_V1` (`0x0053`) is the reassembled request object:

```text
16B exchangeId
u16 commandId
u16 commandVersion
u64 absoluteDeadlineMs
u16 encodedBodyByteLength
encodedBodyByteLength bytes encodedBody
```

It has `30 + encodedBodyByteLength` body bytes and `38..1199` wire bytes.
`EXIT_RPC_RESPONSE_V1` (`0x0054`) is:

```text
16B exchangeId
u16 errorCode
u16 encodedResponseByteLength
encodedResponseByteLength bytes encodedResponse
```

It has `20 + encodedResponseByteLength` body bytes and at most 8,090 wire
bytes. `errorCode = 0` is success and requires the exact command-specific
encoded success body from Sections 10.6 and 11.3–11.6. A successful empty body
is permitted only where those sections explicitly define one.

The only storage-carrier errors are `0x0180` malformed, `0x0181` unsupported
command, `0x0182` policy mismatch, `0x0185` deadline expired, `0x0186` busy,
`0x0187` response too large, `0x0188` amplification exceeded, `0x018b` token
invalid, `0x018c` storage unavailable, `0x018d` record conflict, and `0x018e`
quota exceeded. Each error requires `encodedResponseByteLength = 0` and maps
unchanged to the same `ROUTED_REPLY_V1.errorCode`. Codes `0x0183`, `0x0184`,
`0x0189`, and `0x018a` are exit-local only and are invalid on this carrier, as
is every other non-zero value. An authenticated invalid carrier code/body
destroys the exchange and the exit reports local `0x018a` upstream rejected;
authentication failure or deadline without a valid response reports local
`0x0189` upstream timeout. No destination references or raw addresses cross
this carrier.

Request reassembly is at most two fragments; response reassembly is at most
eight because `ceil(8090 / 1149) = 8`. Both expire at the OPEN deadline, never
later than 5,000 ms, and are never extended. Storage permits at most four
admitted exchanges/49,152 reserved bytes per authenticated exit identity and
source endpoint and 128 exchanges/1,572,864 bytes globally. An exit permits at
most four response reassemblies/49,152 bytes per storage identity and the same
global bound. Reservation occurs only after valid OPEN/ACCEPT authentication;
later fragments cannot increase it. There is no fragment acknowledgement,
nested fragmentation, unauthenticated bulk response, or response before the
complete authenticated request passes command policy.

## 5. Bilateral Link Authorization and Incremental Extension

### 5.1 Common link constraints

The extension index and claimed roles have one legal matrix:

| Index | Initiator role | Responder role | Responder M2 role |
| ----- | -------------- | -------------- | ----------------- |
| 0     | `CLIENT`       | `SAFETY_RELAY` | `ROLE.SAFETY`     |
| 1     | `SAFETY_RELAY` | `SAFETY_RELAY` | `ROLE.SAFETY`     |
| 2     | `SAFETY_RELAY` | `DHT_EXIT`     | `ROLE.PRIVATE`    |

Indices cannot be skipped or reused in one branch generation. The two branches
must share exactly the index-0 guard identity and endpoint while that guard
lease is active, but never branch ID, circuit ID, generation, signature,
ephemeral key, accepted limits, counter, replay state, queue, or teardown state.
No identity at index 1 or 2 may equal the guard, any identity in the other
branch, or another identity in its own branch. Thus the only cross-branch
identity equality is lookup index 0 = announce index 0; all four middle/exit
identities are pairwise distinct, and every branch rejects repeats or loops.

The canonical admitted/requested-limits encoding is exactly 26 bytes:

```text
u16  cellSize                      // exactly 1200
u32  maxCells
u32  maxBytes
u32  maxCommands
u32  idleTimeoutMs
u64  expiresAtMs                  // no more than 300,000 ms after minting
```

All limits are non-zero. `expiresAtMs` must be in the future and no later than
the advertisement, branch, circuit, or offer deadline. An admitted numeric
limit may not exceed the corresponding requested or advertised limit.

### 5.2 `LINK_OFFER_V1` (`0x0020`)

Signature domain: `hyperdht-private-routes/m3/link-offer/v1`.

```text
32B  responderAdvertisementDigest
32B  initiatorIdentity             // signer
32B  responderIdentity
u8   initiatorRole
u8   responderRole
u8   branchClass
16B  branchId
16B  circuitId
u64  generation
u8   extensionIndex
32B  initiatorLinkEphemeralPublicKey
32B  clientTailEphemeralPublicKey
32B  clientNonce
32B  payloadParametersDigest
26B  requestedLimits
u64  offerDeadlineMs
64B  Ed25519 signature suffix
```

The body is exactly 302 bytes and the wire message is exactly 374 bytes. At
index zero the initiator identity is the fresh Ed25519 client circuit identity;
at indices one and two it is the current tail's advertised relay identity.
Before signing, sending, or using an index-zero offer, the client's
`BootstrapIO` must verify a live cookie-bound direct active challenge for the
exact guard advertisement and observed endpoint. It then issues a one-time,
client-local guard-admission capability bound to that advertisement digest,
endpoint, client circuit identity, branch ID, circuit ID, generation, and the
challenge expiry. Emitting the offer consumes the capability; it cannot be
reused across offers, branches, circuits, identities, endpoints, generations,
or expiries. This is a sender-side precondition only. It adds no wire field and
does not change the sizes above. The `LINK_OFFER_V1` responder does not receive,
verify, or infer the client's challenge state or local admission capability; it
validates only the signed offer and its own advertisement/adjacency state.
Both ephemeral keys must be valid non-low-order X25519 public keys. IDs, keys,
and the client nonce are non-zero and fresh. The responder identity, route role,
endpoint, and route key must match the signed advertisement digest. The offer
deadline is at most 5,000 ms after local send time and at most the requested
expiry. A payload-parameter mismatch, role/index mismatch, expired or replayed
offer, self-link, or repeated branch identity is rejected without installing
forwarding state. Cross-branch identity presence is also rejected except for
the sole required equality: lookup index-0 guard identity and endpoint must
equal announce index-0 guard identity and endpoint. That exception never
permits guard equality at index 1/2 or reuse of cryptographic state.

The complete offer digest used by the adjacent responder is:

```text
digest('hyperdht-private-routes/m3/link-offer-digest/v1',
       completeSignedLinkOfferBytes)
```

### 5.3 `LINK_ACCEPT_V1` (`0x0021`)

Signature domain: `hyperdht-private-routes/m3/link-accept/v1`.

```text
32B  completeOfferDigest
32B  responderAdvertisementDigest
32B  responderIdentity             // signer
19B  observedPredecessorEndpoint   // adjacency-local
32B  responderLinkEphemeralPublicKey
26B  admittedLimits
u64  acceptedAtMs
32B  acceptNonce
64B  Ed25519 signature suffix
```

The body is exactly 213 bytes and the wire message is exactly 285 bytes. The
accept is valid only on the adjacency that received the offer. The responder
identity and advertisement digest must equal the offer. `acceptedAtMs` is not
later than the offer deadline. The accept nonce and responder ephemeral key are
fresh. The observed endpoint is the canonical endpoint from which the
responder actually authenticated the offer; no caller-supplied value may
replace it.

`LINK_ACCEPT_V1` is never forwarded beyond its adjacent initiator. Its endpoint,
ephemeral key, complete digest, and any transcript containing them are absent
from tail-control and final-exit transcripts. A malformed, late, replayed,
cross-offer, cross-adjacency, over-limit, or address-substituted accept installs
no link and erases partial key material.

The complete accept digest is:

```text
digest('hyperdht-private-routes/m3/link-accept-digest/v1',
       completeSignedLinkAcceptBytes)
```

It is adjacency-local and must not appear in the redacted proof.

### 5.4 `REDACTED_RESPONDER_PROOF_V1` (`0x0022`)

Signature domain: `hyperdht-private-routes/m3/redacted-responder-proof/v1`.

```text
32B  responderAdvertisementDigest
32B  initiatorIdentity
32B  responderIdentity             // signer
u8   branchClass
16B  branchId
16B  circuitId
u64  generation
u8   extensionIndex
32B  clientTailEphemeralPublicKey
32B  clientNonce
32B  advertisedRouteEncryptionPublicKey
32B  admittedLimitsDigest
u64  expiresAtMs
32B  responderProofNonce
64B  Ed25519 signature suffix
```

The body is exactly 306 bytes and the wire message is exactly 378 bytes. The
proof is the responder's signed statement that it accepted the named direct
predecessor for this branch/index under the stated limits. It contains no
endpoint, link ephemeral key, complete offer/accept digest, or earlier route
identity. The client verifies that all fields equal its selected advertisement,
extension request, and accepted limits. `expiresAtMs` equals the admitted limit
expiry. Proof nonces are unique per responder identity, epoch, branch,
generation, and index. Reuse or conflicting proof bytes are rejected.

The admitted-limits digest is the approved construction in Section 7.1, not a
digest of the address-bearing accept.

### 5.5 `EXTEND_REQUEST_V1` (`0x0025`)

Indices one and two begin with this client-authenticated request inside the
ordered source↔current-tail context. Index zero is the direct client→guard
link and does not use this message.

```text
u8   branchClass
16B  branchId
16B  circuitId
u64  generation
u8   extensionIndex              // exactly current index + 1; only 1 or 2
u16  advertisementByteLength     // 260..548
advertisementByteLength bytes complete signed candidate advertisement
32B  clientTailEphemeralPublicKey
32B  clientNonce
32B  payloadParametersDigest
26B  requestedLimits
32B  extensionNonce
```

The fixed body excluding the advertisement is 198 bytes. The body is
458..746 bytes and the complete wire object is 466..754 bytes. Every request
therefore fits one routed payload. The current tail accepts it only
in `TAIL_CONTROL_ORDERED`, under the current branch/circuit/generation, and
within a non-extending 5,000 ms extension deadline. It verifies the nested
advertisement signature, expiry, next-role requirements, path diversity,
payload digest, limits, X25519 key, nonces, and fragment digest before dialing.

The tail, not the client, then constructs and signs the adjacency-local
`LINK_OFFER_V1`. Its responder advertisement digest, client tail key, client
nonce, payload digest, requested limits, branch fields, and index must
byte-equal this request. `EXTENDED_V1.extensionNonce` must equal this request.
The request never grants the client direct-dial authority; only the current
tail may contact the nested advertisement endpoint. For index two, the request
is encrypted to the middle, so the guard sees only fixed routed cells and not
the exit advertisement or endpoint.

### 5.6 `EXTENDED_V1` (`0x0023`)

```text
u8   branchClass
16B  branchId
16B  circuitId
u64  generation
u8   extensionIndex
32B  responderAdvertisementDigest
u16  redactedProofByteLength       // exactly 378
378B REDACTED_RESPONDER_PROOF_V1
32B  extensionNonce
```

The body is exactly 486 bytes and the wire message is exactly 494 bytes. It is
sent by the prior tail only inside the still-current ordered tail-control
context. The extension nonce is the exact nonce from the client's authenticated
extension command. The client requires all duplicated fields and the nested
proof to match. The nested message must be canonical, complete, signed, and not
fragmented. `EXTENDED_V1` by itself does not activate the new context; the
client waits for `TAIL_READY_V1`.

### 5.7 `TAIL_READY_V1` (`0x0024`)

Signature domain: `hyperdht-private-routes/m3/tail-ready/v1`.

```text
u8   branchClass
16B  branchId
16B  circuitId
u64  generation
u8   extensionIndex
32B  tailControlTranscriptDigest
32B  tailIdentity                  // signer
32B  tailAdvertisementDigest
32B  clientNonce
32B  readyNonce
u64  expiresAtMs
64B  Ed25519 signature suffix
```

The body is exactly 210 bytes and the wire message is exactly 282 bytes. It is
sealed under the newly derived reverse `TAIL_CONTROL_ORDERED` key and signed by
the advertised tail identity. The transcript digest is:

```text
cryptoSuite.hash([
  UTF8('hyperdht-private-routes/m3/tail-control/transcript-digest/v1'),
  completeEncodedTailControlTranscript
])
```

All route identifiers, index, advertisement, client nonce, identity, and expiry
must equal the locally derived values. It contains no predecessor endpoint,
adjacency ephemeral key, link-accept digest, earlier relay identity, or complete
route digest. A client installs the new tail only after signature, AEAD,
counter, transcript, and state validation, then destroys the prior tail-control
context.

### 5.8 Link-message size table

| Message                       | Body bytes | Auth bytes | Wire bytes | One route payload |
| ----------------------------- | ---------- | ---------- | ---------- | ----------------- |
| `LINK_OFFER_V1`               | 302        | 64         | 374        | yes               |
| `LINK_ACCEPT_V1`              | 213        | 64         | 285        | yes               |
| `REDACTED_RESPONDER_PROOF_V1` | 306        | 64         | 378        | yes               |
| `EXTEND_REQUEST_V1`           | 458..746   | 0          | 466..754   | yes               |
| `EXTENDED_V1`                 | 486        | 0          | 494        | yes               |
| `TAIL_READY_V1`               | 210        | 64         | 282        | yes               |

## 6. Exit Activation Messages

### 6.1 `DHT_EXIT_ACTIVATE_V1` (`0x0040`)

```text
32B  clientActivationNonce
32B  exitOriginCommandPolicyDigest
32B  payloadParametersDigest
```

The body is exactly 96 bytes and the wire message is exactly 104 bytes. It is
carried only by the extension-index-2 forward `TAIL_FINALIZE_DATAGRAM` context.
The nonce is freshly random. The exit advertisement must currently authorize
`DHT_EXIT_V1`. `exitOriginCommandPolicyDigest` must equal the immutable M3-v1
nine-command constant in Section 2.2 as independently computed by both peers;
it is not copied from the advertisement's four- or nine-entry provider policy.
`payloadParametersDigest` must equal the advertised and negotiated fixed
parameters byte for byte. A different tuple using the same activation nonce is
a fatal conflicting semantic duplicate. An identical tuple is idempotent.

### 6.2 `DHT_EXIT_READY_V1` (`0x0041`)

Signature domain: `hyperdht-private-routes/m3/dht-exit-ready/v1`.

```text
u8   branchClass
16B  branchId
16B  circuitId
u64  generation
32B  exitIdentity                  // signer
32B  clientActivationNonce
32B  exitOriginCommandPolicyDigest
32B  payloadParametersDigest
32B  finalExitTranscriptDigest
32B  readyNonce
64B  Ed25519 signature suffix
```

The body is exactly 233 bytes and the wire message is exactly 305 bytes. It is
carried only by the extension-index-2 reverse `TAIL_FINALIZE_DATAGRAM` context.
The exit caches the complete signed semantic bytes. An identical activation
causes those exact bytes to be resealed under a fresh datagram counter; READY is
never resigned or semantically regenerated for a retry.

`finalExitTranscriptDigest` is:

```text
cryptoSuite.hash([
  UTF8('hyperdht-private-routes/m3/final-exit/transcript-digest/v1'),
  completeEncodedFinalExitTranscript
])
```

The client requires exact equality with its locally computed transcript and
all duplicated activation/circuit fields before deriving or installing final
contexts. A ready nonce is fresh per activation nonce and is part of the signed
cached body.

### 6.3 `DHT_EXIT_READY_ACK_V1` (`0x0042`)

```text
u8   branchClass
16B  branchId
16B  circuitId
u64  generation
32B  clientActivationNonce
32B  readyDigest
```

The body is exactly 105 bytes and the wire message is exactly 113 bytes. It is
carried only by the forward `FINAL_EXIT_FINALIZE_DATAGRAM` context. `readyDigest`
is:

```text
cryptoSuite.hash([
  UTF8('hyperdht-private-routes/m3/dht-exit-ready-digest/v1'),
  completeSignedDhtExitReadyBytes
])
```

The client caches the semantic ACK bytes. Duplicate valid READY triggers the
same semantic ACK under a fresh finalization datagram counter. A different
READY digest or activation nonce for the same circuit/generation is fatal.

### 6.4 `DHT_EXIT_OPEN_V1` (`0x0043`)

```text
u8   branchClass
16B  branchId
16B  circuitId
u64  generation
32B  ackDigest
32B  clientActivationNonce
32B  exitOriginCommandPolicyDigest
32B  payloadParametersDigest
```

The body is exactly 169 bytes and the wire message is exactly 177 bytes. It is
carried only by the reverse `FINAL_EXIT_FINALIZE_DATAGRAM` context. `ackDigest`
is:

```text
cryptoSuite.hash([
  UTF8('hyperdht-private-routes/m3/dht-exit-ready-ack-digest/v1'),
  completeDhtExitReadyAckBytes
])
```

The exit caches the exact semantic OPEN body. An identical authenticated ACK
causes it to reseal that body under a fresh reverse datagram counter. The
client enters `OPEN` only after every field matches its cached activation,
READY, ACK, branch, circuit, and generation.

### 6.5 `DHT_EXIT_SEEDS_V1` (`0x0044`)

After OPEN, the exit supplies the client-controlled iterative engines with
initial exit-issued authority. This closes the bootstrap loop without giving
the client raw addresses or allowing it to ask the exit to mint arbitrary IDs.
Signature domain:
`hyperdht-private-routes/m3/dht-exit-seeds/v1`.

```text
u8   branchClass
16B  branchId
16B  circuitId
u64  generation
32B  exitIdentity                 // signer and issuing exit
32B  seedSetNonce
u8   dhtSeedCount                 // 1..3
dhtSeedCount * 172B DESTINATION_REF_V1
u8   storageSeedCount             // 0..5
repeated:
  u16 advertisementByteLength     // exactly 420 or 548
  advertisementByteLength bytes complete signed capability advertisement
  172B DESTINATION_REF_V1
32B  seedSetDigest
64B  Ed25519 signature suffix
```

The fixed body is 139 bytes. With one DHT seed and no storage seed, the body is
311 bytes and the complete message is 383 bytes. With three DHT seeds and five
maximum advertisements/references, the body is 4,265 bytes and the complete
message is 4,337 bytes, requiring five routed fragments.

`seedSetDigest` is:

```text
digest('hyperdht-private-routes/m3/dht-exit-seeds/set/v1',
       u8 dhtSeedCount || repeated complete DHT reference bytes ||
       u8 storageSeedCount || repeated advertisement length,
       advertisement bytes, and complete storage reference bytes)
```

Every DHT reference has class `DHT_NODE_HANDLE` and comes only from the exit's
configured bootstrap set or currently validated public routing table. DHT
references are unique and strictly sorted by `destinationId`, then complete
handle bytes. Every storage pair has a current actively challenged
`PRIVATE_RECORDS_V1` advertisement and a `SIGNED_CAPABILITY_HANDLE` whose ID is
the advertisement signer's derived storage ID. Storage pairs are unique and
strictly sorted by storage ID, relay identity, then epoch. Advertisement and
reference equality is checked before either enters client query state.

An exit opening a branch that requires private-record commands must supply at
least one storage seed, whether its own provider advertisement has four or nine
entries. A branch that does not require private records supplies zero. The exit completes any
bounded seed discovery and active validation before READY, caches this semantic
seed set, and sends it under `TERMINAL_CONTROL_ORDERED` immediately after OPEN.
The client does not declare the branch DHT-ready until the signed set is
validated. Missing, empty-invalid, conflicting, or late seeds within 5,000 ms
of OPEN destroy the branch and surface privacy/records unavailable; they never
trigger direct bootstrap or caller-selected probing. Retransmission uses the
same signed semantic object with ordinary routed fragmentation and no special
acknowledgement.

The DHT-seed cap of three, storage-seed cap of five, exact proactive delivery,
and five-second readiness deadline are draft decisions in Section 15 and are
not owner-approved.

### 6.6 Exit-message size table

| Message                 | Body bytes | Auth bytes | Wire bytes | One route payload |
| ----------------------- | ---------- | ---------- | ---------- | ----------------- |
| `DHT_EXIT_ACTIVATE_V1`  | 96         | 0          | 104        | yes               |
| `DHT_EXIT_READY_V1`     | 233        | 64         | 305        | yes               |
| `DHT_EXIT_READY_ACK_V1` | 105        | 0          | 113        | yes               |
| `DHT_EXIT_OPEN_V1`      | 169        | 0          | 177        | yes               |
| `DHT_EXIT_SEEDS_V1`     | 311..4,265 | 64         | 383..4,337 | fragmented at max |

## 7. Approved Transcripts, Digests, and Key Schedule

This section reproduces the approved behavior specification. Implementations
must not replace these constructions with generic HKDF or the generic digest
helper in Section 1.2.

### 7.1 Admitted-limits digest

The exact 26-byte admitted-limits encoding is:

```text
u16 cellSize ||
u32 maxCells ||
u32 maxBytes ||
u32 maxCommands ||
u32 idleTimeoutMs ||
u64 expiresAtMs
```

The digest is:

```text
cryptoSuite.hash([domain, encoding])
```

where `domain` is the 46 raw UTF-8 bytes of
`hyperdht-private-routes/tail-control/limits/v1`. There is no length prefix
around this digest domain.

### 7.2 `TAIL_CONTROL_TRANSCRIPT_V1`

The transcript encoding is:

```text
u16be domainByteLength || UTF8(domain) || fields
```

where `domain` is the 50-byte ASCII string
`hyperdht-private-routes/tail-control/transcript/v1` and fields are exactly:

```text
u32  M3 protocol version          // 1
u8   branch class
16B  branch ID
16B  circuit ID
u64  branch generation
u8   extension index              // 0 guard, 1 middle, 2 exit
32B  client tail ephemeral public key
32B  advertised tail route-encryption public key
32B  candidate advertisement digest
32B  client nonce
32B  tail Ed25519 identity
32B  canonical admitted-limits digest
```

The fields are 238 bytes and the complete transcript is exactly 290 bytes:
`2 + 50 + 238`. No field is optional. The X25519 shared secret is computed only
from the client tail ephemeral secret and advertised tail route-encryption
public key (or their reciprocal secret/public pair). Adjacency-local link
ephemeral keys and address-bearing accept data are not inputs.

For each output, M3 uses keyed BLAKE2b with the 32-byte X25519 shared secret as
the key over:

```text
u16be labelByteLength || UTF8(label) ||
u32be M3_PROTOCOL_VERSION ||
u32be transcriptByteLength || transcript
```

The four tail-control labels are:

```text
hyperdht-private-routes/kdf/v1/tail-control/forward-key
hyperdht-private-routes/kdf/v1/tail-control/reverse-key
hyperdht-private-routes/kdf/v1/tail-control/forward-nonce
hyperdht-private-routes/kdf/v1/tail-control/reverse-nonce
```

For extension index two only, the same shared secret and transcript derive four
separate pre-open datagram outputs:

```text
hyperdht-private-routes/kdf/v1/tail-finalize/forward-key
hyperdht-private-routes/kdf/v1/tail-finalize/reverse-key
hyperdht-private-routes/kdf/v1/tail-finalize/forward-nonce
hyperdht-private-routes/kdf/v1/tail-finalize/reverse-nonce
```

Every keyed-BLAKE2b output is 32 bytes. Key outputs use all 32 bytes. Nonce
outputs use only their first 16 bytes as the XChaCha20 nonce prefix, matching
the inherited counter-based nonce construction. Forward and reverse ordered
tail-control counters start at zero and use exact-next validation. Forward and
reverse tail-finalize counters start at zero and use independent 64-counter
datagram replay windows.

### 7.3 `FINAL_EXIT_TRANSCRIPT_V1`

The final transcript encoding is:

```text
u16be domainByteLength || UTF8(domain) || fields
```

where `domain` is the 48-byte ASCII string
`hyperdht-private-routes/final-exit/transcript/v1` and fields are exactly:

```text
u32  M3 protocol version          // 1
u8   branch class
16B  branch ID
16B  circuit ID
u64  branch generation
32B  TAIL_CONTROL_TRANSCRIPT_V1 digest
32B  exit advertisement digest
32B  exit Ed25519 identity
32B  client activation nonce
32B  M3-v1 exit-origin command-policy digest
32B  M2 payload-parameters digest
```

The fields are 237 bytes and the complete transcript is exactly 287 bytes:
`2 + 48 + 237`.

The tail transcript digest in this transcript is exactly:

```text
cryptoSuite.hash([
  UTF8('hyperdht-private-routes/final-exit/tail-digest/v1'),
  completeEncodedTailControlTranscript
])
```

The domain is 49 raw bytes and has no length prefix in this digest. The
exit-origin command-policy digest is the exact immutable construction in
Section 2.2. Both client and exit compute it locally and require equality; the
four- or nine-entry exit provider policy does not alter this transcript field.

### 7.4 Payload-parameters digest

The exact 20-byte encoding is:

```text
u16 cellSize                  // 1200
u16 maxCellPayload            // 1146
u16 contextEnvelopeSize       // 1101
u16 routeFrameSize            // 1100
u16 maxRoutePayload           // 1073
u16 datagramReplayWindow      // 64
u32 maxQueuedBytes
u32 idleTimeoutMs
```

The digest is:

```text
cryptoSuite.hash([domain, encoding])
```

where `domain` is the 56 raw UTF-8 bytes of
`hyperdht-private-routes/final-exit/payload-parameters/v1`. There is no domain
length prefix. `maxQueuedBytes` must equal the verified advertisement value and
`idleTimeoutMs` must equal the admitted-limits value. Any inherited constant or
negotiated-value mismatch fails activation.

### 7.5 Final-exit outputs

The retained extension-index-2 X25519 shared secret and complete 287-byte final
transcript use the same keyed-BLAKE2b input construction as Section 7.2 to
derive exactly these twelve outputs:

```text
hyperdht-private-routes/kdf/v1/final-exit/payload/forward-key
hyperdht-private-routes/kdf/v1/final-exit/payload/reverse-key
hyperdht-private-routes/kdf/v1/final-exit/payload/forward-nonce
hyperdht-private-routes/kdf/v1/final-exit/payload/reverse-nonce
hyperdht-private-routes/kdf/v1/final-exit/control/forward-key
hyperdht-private-routes/kdf/v1/final-exit/control/reverse-key
hyperdht-private-routes/kdf/v1/final-exit/control/forward-nonce
hyperdht-private-routes/kdf/v1/final-exit/control/reverse-nonce
hyperdht-private-routes/kdf/v1/final-exit/finalize/forward-key
hyperdht-private-routes/kdf/v1/final-exit/finalize/reverse-key
hyperdht-private-routes/kdf/v1/final-exit/finalize/forward-nonce
hyperdht-private-routes/kdf/v1/final-exit/finalize/reverse-nonce
```

Every output is 32 bytes; key outputs use all 32 bytes and nonce-prefix outputs
use the first 16. Payload and terminal-control directions each start independent
exact-next counters at zero. Final-exit/finalize directions each start an
independent 64-counter datagram replay window at zero. No key, nonce prefix,
counter, replay window, or semantic replay state is shared across tail control,
tail finalize, final-exit finalize, route payload, or terminal control.

## 8. Context Envelope and Associated Data

### 8.1 Fixed framing

The inherited and M3 framing values are immutable:

```text
CELL_SIZE                    = 1200
MAX_CELL_PAYLOAD             = 1146
M3_CONTEXT_ENVELOPE_SIZE     = 1101
ROUTE_FRAME_SIZE             = 1100
MAX_ROUTE_PAYLOAD            = 1073
DATAGRAM_REPLAY_WINDOW       = 64
```

The M3 envelope inside the routed cell is exactly:

```text
u8     contextClass
1100B  context-specific encrypted route frame
```

The 1,100-byte inner frame retains the M2 layout:

```text
u64  innerCounter            // clear, at offset 0
1092B ciphertext             // 1076-byte plaintext + 16-byte AEAD tag
```

The plaintext is exactly:

```text
u8   inheritedDeliveryClass
u16  logicalPayloadBytes
logicalPayloadBytes payload
(1073 - logicalPayloadBytes) random padding
```

The delivery class is fixed by M3 context class and is not negotiable:

| Context class                  | Value | Required inherited delivery class |
| ------------------------------ | ----- | --------------------------------- |
| `TAIL_CONTROL_ORDERED`         | 0     | M2 `CONTROL = 0`                  |
| `TAIL_FINALIZE_DATAGRAM`       | 1     | M2 `DATAGRAM = 2`                 |
| `FINAL_EXIT_FINALIZE_DATAGRAM` | 2     | M2 `DATAGRAM = 2`                 |
| `ROUTE_PAYLOAD`                | 3     | M2 `STREAM = 1`                   |
| `TERMINAL_CONTROL_ORDERED`     | 4     | M2 `CONTROL = 0`                  |

All other context values are rejected. A valid AEAD opening with the wrong
inherited delivery class is also rejected and destroys setup/open state as the
behavior specification requires. Logical payload length is `0..1073`, but a
canonical M3 message decoder may impose a non-zero or smaller message-specific
bound.

### 8.2 Exact `M3ContextAD`

Every M3 context uses exactly these 54 bytes of AEAD associated data:

```text
u8   contextClass
u32  M3ProtocolVersion           // 1
16B  branchId
16B  circuitId
u64  generation
u8   direction                   // 0 forward, 1 reverse
u64  innerCounter
```

The arithmetic is `1 + 4 + 16 + 16 + 8 + 1 + 8 = 54`. All integers are
big-endian. `innerCounter` is copied from the clear eight bytes at inner-frame
offset zero and is exactly the counter used for nonce construction and selected
ordered/replay-window validation. The associated data replaces M2
`RoutePayloadCodec` associated data; it is not prefixed or suffixed with the M2
descriptor ID or any duplicated route fields.

The receiver selects one key/state from the public class and current circuit
state. It never trial-opens another context. Class, version, branch, circuit,
generation, direction, or counter substitution fails authentication.

### 8.3 Context state/class matrix

This is the complete actor/state/class/direction/message matrix:

| Receiver | State        | Accepted class / direction / semantic message                                                                                          |
| -------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| client   | extending    | `TAIL_CONTROL_ORDERED` reverse control permitted by the extension state machine                                                        |
| exit     | tail-ready   | `TAIL_CONTROL_ORDERED` forward control; `TAIL_FINALIZE_DATAGRAM` forward `DHT_EXIT_ACTIVATE_V1` only                                   |
| client   | `ACTIVATING` | `TAIL_FINALIZE_DATAGRAM` reverse `DHT_EXIT_READY_V1` only                                                                              |
| exit     | `FINALIZING` | `TAIL_FINALIZE_DATAGRAM` forward identical `DHT_EXIT_ACTIVATE_V1`; `FINAL_EXIT_FINALIZE_DATAGRAM` forward `DHT_EXIT_READY_ACK_V1` only |
| client   | `ACKING`     | `TAIL_FINALIZE_DATAGRAM` reverse identical `DHT_EXIT_READY_V1`; `FINAL_EXIT_FINALIZE_DATAGRAM` reverse `DHT_EXIT_OPEN_V1` only         |
| client   | `OPEN`       | `ROUTE_PAYLOAD` reverse; `TERMINAL_CONTROL_ORDERED` reverse; Section 9.3 receive-only READY/OPEN grace                                 |
| exit     | `OPEN`       | `ROUTE_PAYLOAD` forward; `TERMINAL_CONTROL_ORDERED` forward; Section 9.3 ACTIVATE/ACK grace handlers only                              |
| either   | `DRAINING`   | existing `ROUTE_PAYLOAD` and `TERMINAL_CONTROL_ORDERED` in the actor's established direction only                                      |
| either   | `DESTROYED`  | none                                                                                                                                   |

An idempotent duplicate is accepted only in the exact actor row, direction,
class, state, message ID, activation nonce, and byte-equal semantic tuple shown
above. A class cannot smuggle another registered message, and an actor never
accepts the peer's half of ACTIVATE/READY/ACK/OPEN.

Unknown classes, wrong-size envelopes, a known class outside this matrix, more
than one logical interpretation, or key/state absence fails closed. Ordered
contexts use exact-next counters. Datagram contexts accept authenticated gaps
and reordering within a 64-counter window. A repeated or too-old authenticated
datagram counter is discarded without semantic state change or teardown; all
other setup authentication/counter failures are fatal.

## 9. Finalization State Machine, Retries, and Grace

### 9.1 States and semantic idempotence

The exact state progression is:

```text
TAIL_READY -> ACTIVATING -> FINALIZING -> ACKING -> OPEN
     \-------------- any failure/timeout ------------> DESTROYED
```

1. The client sends one semantic `DHT_EXIT_ACTIVATE_V1` under a fresh
   tail-finalize forward datagram counter and enters `ACTIVATING`.
2. The exit validates the tuple, derives final outputs once, enters half-open
   `FINALIZING`, caches the signed semantic READY, and sends it under a fresh
   reverse tail-finalize counter.
3. The client validates READY, derives final outputs once, enters `ACKING`,
   caches ACK, and sends it under a fresh final-exit/finalize forward counter.
   It sends no routed DHT payload.
4. The exit validates ACK, enters `OPEN`, installs the retired state below, and
   sends cached OPEN under a fresh final-exit/finalize reverse counter.
5. The client validates OPEN, enters `OPEN`, installs its retired receive state,
   and only then may send route payload.

The semantic duplicate key is `(messageId, clientActivationNonce)`. ACTIVATE
also requires byte equality of both digests; READY, ACK, and OPEN require byte
equality of their entire cached semantic message. An identical semantic
duplicate triggers only the cached next response under a fresh datagram
counter. A conflicting tuple, digest, or body destroys the circuit. Duplicate
messages never derive keys or advance state twice.

### 9.2 Deadline and sends

The finalization deadline is exactly 5,000 ms from the client's initial
ACTIVATE send. Each pending semantic message has one initial send and at most
four retries after intervals of 250, 500, 1,000, and 2,000 ms. Relative to the
initial send, the only send times are:

```text
0 ms, 250 ms, 750 ms, 1750 ms, 3750 ms
```

Thus each semantic message has at most five sends. Every resend uses the exact
cached semantic bytes and a fresh counter from its own datagram domain. An
identical ACTIVATE prompts READY; an identical/duplicate READY prompts ACK; an
identical ACK prompts OPEN. A client consumes duplicate/delayed OPEN without a
state change. The deadline is never extended by progress, duplicate counters,
semantic duplicates, or retransmission. Failure to reach OPEN by 5,000 ms
destroys and erases all partial state.

### 9.3 Five-second retired-context grace

On entering OPEN, both sides start an exact 5,000 ms grace timer:

- the exit retains the tail-finalize forward receive key/window,
  final-exit/finalize forward receive key/window, final-exit/finalize reverse
  send key/counter, activation semantic cache, and cached OPEN;
- the client retains the tail-finalize reverse receive key/window and
  final-exit/finalize reverse receive key/window as receive-only tombstones;
- an authenticated delayed ACTIVATE at the exit or duplicate ACK causes only
  cached OPEN retransmission under a fresh final-exit/finalize reverse counter;
- an authenticated delayed READY or OPEN at the client is consumed and
  discarded without state change.

Grace handlers cannot derive keys, reopen a transition, accept route payload,
reset circuit lifetime, extend grace, or advance state except for the exit's
retained finalization send counter when retransmitting cached OPEN. At grace
expiry all retained finalization keys, windows, counters, and semantic caches
are erased. The ordered tail-control shared secret and keys are erased at OPEN,
not at grace expiry. Authentication failure remains fatal; repeated/too-old
authenticated datagram counters and these retired handlers are the only
non-fatal setup-counter cases.

## 10. Destination Authority and Routed RPC

### 10.1 `DESTINATION_REF_V1` (`0x0100`)

A destination reference is a complete canonical object with no auth suffix. Its
body is exactly:

```text
32B  destinationId
u16  handleByteLength             // exactly 130
130B opaqueHandle
```

The body is 164 bytes and the complete object is exactly 172 bytes. The public
adapter representation is only `{ id: destinationId, handle: opaqueHandle }`.
Both fields are copied. Neither field, nor any nested public adapter value, may
contain a host, port, canonical endpoint, hostname, or caller-computed dialing
authority.

The 130 handle bytes are opaque outside the issuing exit. Their exit-side
encoding is:

```text
u8   handleVersion                // exactly 1
u8   destinationValidationClass
u64  expiresAtMs
32B  issuingExitIdentity
16B  branchId
16B  circuitId
u64  branchGeneration
32B  handleNonce
16B  handleAuthTag
```

The first 114 bytes are the `handlePrefix`. `handleNonce` is unpredictable and
unique while the exit secret is live. The exit table selected by that nonce
owns this non-wire `serverBinding`:

```text
19B  canonicalEndpoint
32B  derivedDhtNodeId
u8   provenanceClass
32B  provenanceDigest
u16  allowedCommandBitmap
32B  capabilityAdvertisementDigest // all zero for a plain DHT-node handle
```

`provenanceClass` is `0 = CONFIGURED_BOOTSTRAP`, `1 = PUBLIC_ROUTING_TABLE`,
`2 = VALIDATED_PROTOCOL_REFERRAL`, `3 = ACTIVE_CAPABILITY_CACHE`, or
`4 = RECENT_VALID_PROTOCOL_TRAFFIC`. The command bitmap uses bits zero through
eight in the exact command order in Section 10.5. Other bits are zero. The
`serverBindingDigest` is:

```text
digest('hyperdht-private-routes/m3/destination/server-binding/v1',
       completeServerBindingBytes)
```

`handleAuthTag` is the first 16 bytes of keyed BLAKE2b under the exit-local
handle secret over:

```text
u16be domainByteLength || UTF8(domain) ||
handlePrefix || destinationId || serverBindingDigest
```

where `domain` is
`hyperdht-private-routes/m3/destination/handle-auth/v1`. The exit generates
this secret as exactly 32 fresh CSPRNG bytes once per exit branch generation at
OPEN. It does not rotate during that generation, is never reused by another
branch or generation, is never shared with the client, and is erased when the
branch is destroyed. A handle is valid only when both its tag verifies under
that generation's secret and its mandatory live table entry exists.

The explicit handle binds the issuing exit, branch, circuit, generation,
validation class, and expiry. The containing `ROUTE_PAYLOAD` context supplies
the same exit session, branch, circuit, generation, and direction implicitly;
the exit requires exact equality. The endpoint, provenance, command bitmap,
and advertisement digest remain exit-local but are authenticated through the
table entry and tag. A missing table entry is invalid even if the tag happens
to verify.

The handle expires no more than 300,000 ms (five minutes) after minting and no
later than its issuing advertisement, branch, circuit, or generation. The
five-minute cap is a draft security/availability choice in Section 15 and is
not owner-approved.

For `DHT_NODE_HANDLE`, `destinationId` equals the exit-derived address-based
DHT node ID and the capability digest is zero. For
`SIGNED_CAPABILITY_HANDLE`, it equals the storage ID derived in Section 11.1,
and the table contains a currently valid, actively challenged
`PRIVATE_RECORDS_V1` advertisement. `EXIT_LOCAL` is reserved for commands
implemented by the issuing exit itself; none of the nine M3 commands in
Section 10.5 use it. A handle never changes validation class.

A client cannot request handle minting by sending a raw endpoint, DHT node ID,
or self-signed advertisement. Ordinary closer-node addresses become eligible
only when the exit learned them in a protocol-valid response from an admitted
handle, then completed its bounded reachability validation. A private-storage
candidate becomes eligible only after the exit received its candidate-signed
advertisement as protocol evidence, contacted that advertised endpoint under
its own budget, completed its own CAPS cookie exchange, and completed the
cookie-bound active challenge. The exit may then return
the original signed advertisement and a newly minted reference whose
`destinationId` matches it. The advertisement is evidence to validate; it is
never handle authority by itself.

### 10.2 `ROUTED_REQUEST_V1` (`0x0101`)

```text
16B  requestId
u8   operationClass              // LOOKUP = 0 or ANNOUNCE = 1
u16  commandId
u16  commandVersion              // exactly 1 for M3 commands
u8   mutationFlag
u8   destinationValidationClass
u32  maxResponseBytes             // complete ROUTED_REPLY_V1 wire bytes
u32  maxAmplificationBytes
u32  requestCost
u32  responseCost
u64  absoluteDeadlineMs
172B DESTINATION_REF_V1
u16  encodedBodyByteLength
encodedBodyByteLength bytes encodedBody
```

The fixed body is 221 bytes and total wire size is
`229 + encodedBodyByteLength`. `requestId` is freshly random per logical
request and is reused by that request's bounded transport retries only. It is
scoped to one branch generation. `absoluteDeadlineMs` is Unix epoch
milliseconds and must satisfy `exitNowMs <= absoluteDeadlineMs <=
exitNowMs + policy.timeoutMs`; the exit never extends it. Clock disagreement
can fail availability but cannot widen authority.

The five policy values after `commandVersion` must byte-equal the applicable
tuple in the immutable nine-entry M3 v1 exit-origin policy bound during final
activation under Section 2.2. They are not selected by, or looked up in, the
exit advertisement's provider-service entries. `operationClass`, mutation flag, destination
class, command body length, command-specific token rules, and branch selection
must also equal Section 10.5. A mismatch is a policy violation, not a request
for negotiation. The exit validates the complete request and handle before any
upstream IO.

The exit caches the semantic result for at most 5,000 ms and never beyond the
request deadline. An identical `(branchGeneration, requestId)` and byte-equal
request may receive the cached reply. The same key with different bytes is a
fatal conflicting duplicate. Mutation idempotence additionally depends on the
command token/nonces in Sections 10.6 and 11.6.

### 10.3 `ROUTED_REPLY_V1` (`0x0102`)

```text
16B  requestId
u16  commandId
u16  commandVersion
u8   operationClass
172B from                    // complete DESTINATION_REF_V1
u16  errorCode               // zero on success
u16  tokenByteLength         // exactly 0 or 32
tokenByteLength bytes token
u8   closerNodeCount
closerNodeCount * 172B closerNode
u16  encodedResponseByteLength
encodedResponseByteLength bytes encodedResponse
```

The fixed body is 200 bytes and total wire size is:

```text
208 + tokenByteLength + 172 * closerNodeCount +
encodedResponseByteLength
```

The request ID, command ID/version, operation class, and complete `from`
reference must byte-equal the request. Equality includes the complete opaque
handle, not only `destinationId`. This check precedes token retention, closer
node admission, response decoding, mapping, or mutation commit.

On success `errorCode = 0`. On error, token, closer nodes, and encoded response
are all empty. Error IDs are:

| ID       | Name                                  |
| -------- | ------------------------------------- |
| `0x0180` | `ROUTED_ERROR_MALFORMED`              |
| `0x0181` | `ROUTED_ERROR_UNSUPPORTED_COMMAND`    |
| `0x0182` | `ROUTED_ERROR_POLICY_MISMATCH`        |
| `0x0183` | `ROUTED_ERROR_DESTINATION_INVALID`    |
| `0x0184` | `ROUTED_ERROR_DESTINATION_EXPIRED`    |
| `0x0185` | `ROUTED_ERROR_DEADLINE_EXPIRED`       |
| `0x0186` | `ROUTED_ERROR_BUSY`                   |
| `0x0187` | `ROUTED_ERROR_RESPONSE_TOO_LARGE`     |
| `0x0188` | `ROUTED_ERROR_AMPLIFICATION_EXCEEDED` |
| `0x0189` | `ROUTED_ERROR_UPSTREAM_TIMEOUT`       |
| `0x018a` | `ROUTED_ERROR_UPSTREAM_REJECTED`      |
| `0x018b` | `ROUTED_ERROR_TOKEN_INVALID`          |
| `0x018c` | `ROUTED_ERROR_STORAGE_UNAVAILABLE`    |
| `0x018d` | `ROUTED_ERROR_RECORD_CONFLICT`        |
| `0x018e` | `ROUTED_ERROR_QUOTA_EXCEEDED`         |

Errors contain no diagnostic body. Unknown/non-zero unassigned errors reject
the reply. The generic token is exactly the existing 32-byte DHT token and is
permitted only on successful immutable/mutable GET. It remains bound to the
same exit, generation, and exact `from` handle for the corresponding PUT.

`closerNodeCount` is at most 20. Immutable/mutable GET permits at most 20
`DHT_NODE_HANDLE` references; `PRIVATE_FIND_NODE` permits exactly the number
of validated candidates in its signed response, at most five, all
`SIGNED_CAPABILITY_HANDLE`; all other commands require zero. Closer references
are strictly sorted by unsigned XOR distance from the command target, then by
`destinationId`, and cannot duplicate an ID. Within one query, the first valid
handle for an ID wins; a later handle for that ID is ignored, not substituted.

`actualCompleteReplyBytes` is the entire `ROUTED_REPLY_V1`, including its
208-byte fixed wire portion, token, all destination references, and encoded
response. The policy checks are independently:

```text
actualCompleteReplyBytes <= policy.maxResponseBytes
actualCompleteReplyBytes <= (229 + encodedBodyByteLength) +
                            policy.maxAmplificationBytes
```

The command-specific encoded-response and closer limits apply in addition.
Tokens and referrals therefore consume the same signed amplification budget as
application bytes and cannot bypass accounting.

### 10.4 Cancellation and late replies

M3 defines no network `CANCEL`. Local cancellation, session destruction,
suspend, generation abort, deadline, or DHT destruction settles the operation
once, releases its policy capacity once, and asks the circuit transport to
discard any queued fragments. A later reply or completed reassembly is dropped
before decoding and cannot update tokens, handles, query state, counters other
than the already authenticated route receive counter, or costs. Cancellation
does not extend the exit cache or deadline and elicits no response.

### 10.5 Command-policy inventory

These are the only M3 routed commands. Together, their policy tuples are the
immutable M3-v1 exit-origin policy bound under Section 2.2. Provider
advertisements include only the capability-selected subset from Section 2.1.
`Request body max` is the encoded command
body. `Reply wire max` and `Amp max` cover the complete outer routed messages.

| Command/version        | Operation class    | Request body max | Reply wire max | Timeout | Outstanding | Req cost | Resp cost | Amp max | Mutation | Destination class |
| ---------------------- | ------------------ | ---------------- | -------------- | ------- | ----------- | -------- | --------- | ------- | -------- | ----------------- |
| `PRIVATE_FIND_NODE/1`  | lookup or announce | 69               | 4031           | 5000    | 3           | 2        | 8         | 3733    | read     | signed capability |
| `PRIVATE_LOOKUP/1`     | lookup only        | 134              | 8270           | 5000    | 3           | 2        | 12        | 7907    | read     | signed capability |
| `PRIVATE_PREPARE/1`    | announce only      | 189              | 288            | 3000    | 5           | 3        | 2         | 0       | mutate   | signed capability |
| `PRIVATE_ANNOUNCE/1`   | announce only      | 1161             | 581            | 5000    | 5           | 5        | 3         | 0       | mutate   | signed capability |
| `PRIVATE_UNANNOUNCE/1` | announce only      | 393              | 581            | 5000    | 5           | 5        | 3         | 0       | mutate   | signed capability |
| `IMMUTABLE_GET/1`      | lookup or announce | 32               | 4706           | 3000    | 10          | 1        | 2         | 4445    | read     | DHT node          |
| `IMMUTABLE_PUT/1`      | announce only      | 1090             | 209            | 3000    | 5           | 3        | 1         | 0       | mutate   | DHT node          |
| `MUTABLE_GET/1`        | lookup or announce | 40               | 4650           | 3000    | 10          | 1        | 2         | 4381    | read     | DHT node          |
| `MUTABLE_PUT/1`        | announce only      | 1066             | 209            | 3000    | 5           | 3        | 1         | 0       | mutate   | DHT node          |

In the encoded 32-byte policy entry, `read` is `READ_ONLY = 0`,
`mutate` is `MUTATING = 1`, `DHT node` is `DHT_NODE_HANDLE = 1`, and `signed
capability` is `SIGNED_CAPABILITY_HANDLE = 2`. The string operation classes in
the table are not wire strings: the request carries only `LOOKUP = 0` or
`ANNOUNCE = 1`.

The exit-origin policy always has all nine entries. A provider advertisement
has zero, four, five, or nine entries under Section 2.1; all other counts or
subsets reject. A nine-entry signed advertisement is
`188 + 9 * 32 + 72 = 548` bytes, leaving 525 bytes in one 1,073-byte route
payload.

### 10.6 Immutable and mutable command bodies

M3 does not put compact-encoding varints inside its canonical command bodies.
The exit translates these fixed-width wrappers to the existing HyperDHT value
codecs after validation and translates the reply back. This preserves Task
0A's no-varint rule while retaining existing content hashes and mutable
signature verification.

`MAX_IMMUTABLE_VALUE_BYTES = 1024` and `MAX_MUTABLE_VALUE_BYTES = 896`.
Zero-length values are rejected on PUT and in a present GET response.

```text
IMMUTABLE_GET request (32 bytes):
  32B target

IMMUTABLE_GET response (3..1026 bytes when found):
  u16 valueByteLength             // 1..1024
  valueByteLength bytes value

IMMUTABLE_PUT request (67..1090 bytes):
  32B target
  32B dhtToken
  u16 valueByteLength             // 1..1024
  valueByteLength bytes value

IMMUTABLE_PUT response (1 byte):
  u8 stored                       // exactly 1

MUTABLE_GET request (40 bytes):
  32B target
  u64 minimumSequence

MUTABLE_GET response (75..970 bytes when found):
  u64 sequence
  u16 valueByteLength             // 1..896
  valueByteLength bytes value
  64B endpointSignature

MUTABLE_PUT request (171..1066 bytes):
  32B target
  32B dhtToken
  32B endpointPublicKey
  u64 sequence
  u16 valueByteLength             // 1..896
  valueByteLength bytes value
  64B endpointSignature

MUTABLE_PUT response (1 byte):
  u8 stored                       // exactly 1
```

For immutable data, the client and storage node require `target` to equal the
existing 32-byte HyperDHT hash of `value`. For mutable data, `target` must equal
the existing hash of `endpointPublicKey`; the signature is verified with the
existing HyperDHT mutable-signature domain and canonical legacy signable bytes.
For either GET, an empty generic `encodedResponse` means not found; no sentinel
appears inside a command body. Sequence is carried as `u64be` here. Mutable
command sequences are restricted to `0..2^53-1` so the current HyperDHT codec
can represent them exactly; larger values are rejected rather than coerced.
PUT uses the exact token returned by GET through the same exit, generation, and
destination reference.

## 11. Private-Storage Overlay and Records

### 11.1 Identities, parameters, and advertisements

The derivations are exact raw concatenations, reproducing the approved design:

```text
storageId = cryptoSuite.hash([
  UTF8('hyperdht/private-record-storage/v1'),
  storageEd25519PublicKey
])

recordTarget = cryptoSuite.hash([
  UTF8('hyperdht/private-record-topic/v1'),
  topic
])
```

Both outputs and `topic` are 32 bytes. The canonical overlay parameters are:

```text
u8 K     = 5
u8 alpha = 3
u8 W     = 3
u8 R     = 3
```

These four bytes occur first in every private-storage command body and in every
storage-signed response/receipt below. Requests are authenticated by route
AEAD; responses are signed or storage-MACed. No negotiation or alternative
value is accepted.

There is no separate M3 storage-advertisement format. The signed
`CAPABILITY_ADVERTISEMENT_V1` is the storage advertisement when it contains
`PRIVATE_RECORDS_V1` and includes exactly the five private provider policies or
all nine provider policies from Section 10.5. Storage capability alone imposes
no M2 route role. A referral transports that complete signed advertisement
verbatim. Its address is candidate evidence, not client dial or handle
authority.

### 11.2 Presence and tombstone objects (`0x0280`, `0x0281`)

`PRIVATE_PRESENCE_RECORD_V1` signature domain is
`hyperdht-private-routes/m3/private-presence-record/v1`.
`PRIVATE_TOMBSTONE_V1` signature domain is
`hyperdht-private-routes/m3/private-tombstone/v1`.
In both, `endpointPublicKey` is the signer and the body is:

```text
u32  protocolVersion              // exactly 1
u32  endpointCapabilityMask       // exactly 0x00000001 in M3
32B  topic
32B  endpointPublicKey            // signer
u64  sequence                     // 1..2^64-1
u8   recordKind                   // LIVE = 0 or TOMBSTONE = 1
u64  issuedAtMs
u64  expiresAtMs
u16  descriptorByteLength
descriptorByteLength bytes descriptor
32B  descriptorDigest
64B  endpoint signature suffix
```

`0x00000001` means `NON_DIALABLE_PRIVATE_DISCOVERY_V1`; all other endpoint
capability bits are rejected in M3. A presence record uses ID `0x0280`, kind
`LIVE`, and descriptor length `1..768`. A tombstone uses ID `0x0281`, kind
`TOMBSTONE`, and descriptor length exactly zero. The descriptor digest is:

```text
digest('hyperdht-private-routes/m3/private-descriptor/v1', descriptor)
```

Thus a tombstone carries the deterministic digest of empty bytes, not all-zero
bytes. The fixed body is 131 bytes. A presence record is 204..971 wire bytes;
a tombstone is exactly 203 wire bytes. The signature suffix covers every field
through the descriptor digest using Section 1.2 and its message-specific
domain. The record digest used below is:

```text
digest('hyperdht-private-routes/m3/private-record-digest/v1',
       completeSignedRecordOrTombstoneBytes)
```

`issuedAtMs` may be at most 300,000 ms in the future relative to storage time.
A live expiry is after issuance and at most 86,400,000 ms after issuance. A
tombstone expiry is at least 86,400,000 ms and at most 604,800,000 ms after
issuance. Storage retains an accepted tombstone until at least
`acceptanceTimeMs + 86,400,000`, even if its signed expiry would be earlier;
the receipt's `storedUntilMs` reports the effective bound.

For `(topic, endpointPublicKey)`, higher sequence wins. Byte-identical signed
objects are idempotent. Same sequence with a different kind or record digest is
endpoint equivocation and neither value may be selected by a client. A live
record cannot replace a same-or-higher tombstone. A tombstone that supersedes a
stored live record must have a strictly higher sequence. Expired live records
are not returned. A reader accepts a tombstone only while its signed
`expiresAtMs > readerNowMs`; this is independently verifiable from the object.
After signed expiry, storage retains it internally through `storedUntilMs`
solely to reject rollback by an older/equal live record, never returns it from
lookup, and never counts it toward a read result. No record field is derived
from or populated with the packet source address.

### 11.3 `PRIVATE_FIND_NODE/1` and signed response

The request body is exactly 69 bytes:

```text
4B   overlayParameters            // K=5, alpha=3, W=3, R=3
32B  recordTarget
32B  queryNonce
u8   maximumResults               // 1..5
```

The target is caller-computed only for XOR ordering; it never grants a dial or
handle. The nonce is fresh per iterative query.

`PRIVATE_FIND_NODE_RESPONSE_V1` (`0x0201`) is signed with domain
`hyperdht-private-routes/m3/private-find-node-response/v1` by
`storageIdentity`:

```text
4B   overlayParameters
32B  storageIdentity              // signer
32B  queryNonce
32B  recordTarget
u64  responseTimeMs
u8   advertisementCount           // 0..request.maximumResults, at most 5
repeated u16 advertisementByteLength || signed capability advertisement
32B  candidateSetDigest
64B  storage signature suffix
```

The fixed body is 141 bytes. `candidateSetDigest` is:

```text
digest('hyperdht-private-routes/m3/private-find-node/candidates/v1',
       u8 advertisementCount || repeated length-and-advertisement bytes)
```

Every advertisement has `PRIVATE_RECORDS_V1`, a valid current signature and
expiry, and a storage ID derived from its signer. Entries are unique by storage
identity and advertisement digest and strictly sorted by XOR distance from
`recordTarget`, then storage ID, relay identity, and epoch. The response is
213 bytes with zero results and at most 2,963 bytes with five 548-byte
advertisements.

Before returning the generic routed reply, the exit actively validates each
candidate under its own bounded budget and removes failures. The reply's
closer references and the signed response advertisements have equal counts and
one-to-one order; every reference is `SIGNED_CAPABILITY_HANDLE` and its ID is
the corresponding derived storage ID. The client verifies this equality. A
storage response alone cannot cause a handle to be minted or an address to be
contacted by the client.

Overlay convergence uses only distinct valid identities. It stops when the
closest K remain unchanged for one complete alpha-wide round with no closer
identity. A duplicate identity, conflicting current advertisement for one
identity/epoch, invalid order, or response/ref mismatch rejects the response.
The successful command `encodedResponse` is exactly the complete signed
response object. Its signer and derived storage ID must equal the requested
destination's signed-capability identity.

### 11.4 `PRIVATE_LOOKUP/1` and signed empty/non-empty response

The request body is exactly 134 bytes:

```text
4B   overlayParameters
32B  topic
32B  recordTarget                 // must equal the derivation from topic
32B  queryNonce
32B  selectedSetDigest
u8   selectedSetSize              // exactly 5
u8   maximumRecords               // 1..8
```

The selected-set digest is over the final five distinct storage identities,
sorted by XOR distance from `recordTarget` then lexicographically:

```text
digest('hyperdht-private-routes/m3/private-storage/selected-set/v1',
       u8(5) || five * 32B storageIdentity)
```

`PRIVATE_LOOKUP_RESPONSE_V1` (`0x0282`) uses signature domain
`hyperdht-private-routes/m3/private-lookup-response/v1`:

```text
4B   overlayParameters
32B  storageIdentity              // signer
32B  topic
32B  recordTarget
32B  queryNonce
32B  selectedSetDigest
u8   selectedSetSize              // exactly 5
u64  responseTimeMs
u8   recordCount                  // 0..request.maximumRecords, at most 8
repeated u16 recordByteLength || complete signed record/tombstone
32B  responseDigest
64B  storage signature suffix
```

The fixed body is 206 bytes. `responseDigest` is:

```text
digest('hyperdht-private-routes/m3/private-lookup/records/v1',
       all body bytes from overlayParameters through the final record byte)
```

Records must match the request topic, be unexpired under Section 11.2, and be
unique by endpoint public key within one response. They are strictly sorted by
endpoint public key, then sequence, kind, and record digest. Since endpoint
keys are unique within one response, the latter keys only make verification
total and do not permit duplicates. The signed empty response has count zero,
body 206, and wire size 278 bytes. It states only that this storage identity
returned no records at `responseTimeMs`; it is never proof of absence.

With eight maximum presence records, the body is 7,990 bytes and wire size is
8,062 bytes. The outer routed reply is 8,270 bytes. The client accepts a
response only when the signer is a distinct member of its exact final set,
every echoed field matches, and the response arrives before its query
deadline. Only distinct valid final-set identities count toward `R=3`.
Duplicate responses from one identity count once. Below R, no records or
absence result is returned. Across valid responses, same endpoint/topic and
sequence with differing kind or digest is equivocation; neither value is
selected.

The successful command `encodedResponse` is exactly the complete signed
lookup-response object. Discovery must produce exactly K valid final-set
identities before lookup begins; fewer than K is storage-unavailable rather
than a smaller selected set.

### 11.5 `PRIVATE_PREPARE/1` and write token

The request body is exactly 189 bytes:

```text
4B   overlayParameters
u8   commandKind                  // LIVE_WRITE = 0, TOMBSTONE_WRITE = 1
32B  topic
32B  endpointPublicKey
u64  sequence
32B  recordDigest
u64  recordExpiresAtMs
u64  branchGeneration
32B  destinationRefDigest
32B  operationNonce
```

`destinationRefDigest` is:

```text
digest('hyperdht-private-routes/m3/destination-ref-digest/v1', completeDestinationRefBytes)
```

The domain is exactly 52 ASCII bytes. `operationNonce` is fresh once
for the logical K-node write and is the write replay nonce carried through all
prepare, commit, and receipt messages. The exit requires the generation and
destination digest to equal the authenticated outer request before forwarding.

`PRIVATE_WRITE_TOKEN_V1` (`0x0283`) is an 80-byte canonical object with no
suffix:

```text
u64  tokenExpiresAtMs
32B  tokenNonce
32B  tokenAuthTag
```

The token expiry is after preparation and at most 30,000 ms later. The nonce is
fresh. `tokenAuthTag` is 32-byte keyed BLAKE2b under a rotating storage-local
token secret over:

```text
u16be domainByteLength || UTF8(domain) ||
u32be(1) || u16be(0x0283) || u16be(72) ||
u64be(tokenExpiresAtMs) || tokenNonce ||
storageIdentity || observedExitEndpoint || destinationRefDigest ||
topic || endpointPublicKey || u64be(sequence) || recordDigest ||
u64be(recordExpiresAtMs) || u64be(branchGeneration) ||
u16be(commitCommandId) || operationNonce || overlayParameters
```

where `domain` is
`hyperdht-private-routes/m3/private-write-token/v1`,
`observedExitEndpoint` is the 19-byte endpoint from which storage actually
received prepare, and `commitCommandId` is `0x02a2` or `0x02a3`. The observed
endpoint is covered but never returned to the client. Storage retains the same
bindings keyed by token nonce until expiry; commit must arrive from the exact
observed exit endpoint. A token from another storage identity, exit endpoint,
destination handle, topic, endpoint key, sequence, record, generation,
operation, or command kind cannot validate.

The successful `PRIVATE_PREPARE` encoded response is exactly this 80-byte
token. The storage node generates its token secret as exactly 32 CSPRNG bytes,
rotates it exactly every 300,000 ms, and retains the immediately prior secret
for exactly 30,000 ms. It keeps at most two token secrets, erases the replaced
secret at the end of that retention interval, and erases all token secrets on
stop.

### 11.6 Commit commands and signed receipt

The `PRIVATE_ANNOUNCE/1` and `PRIVATE_UNANNOUNCE/1` command bodies are:

```text
4B   overlayParameters
80B  PRIVATE_WRITE_TOKEN_V1
32B  destinationRefDigest
u64  branchGeneration
32B  operationNonce
32B  commitNonce
u16  recordByteLength
recordByteLength bytes complete signed record/tombstone
```

The fixed portion is 190 bytes. Announce requires one presence object and is
394..1,161 bytes. Unannounce requires the exact 203-byte tombstone and is 393
bytes. `commitNonce` is fresh per storage destination. The outer destination,
generation, record kind, and every prepared field must match the token. A
token is single-commit. An identical `(tokenNonce, operationNonce,
commitNonce)` and byte-equal commit is idempotent and returns the cached exact
receipt; a conflicting reuse is rejected. Cached idempotent results expire
with the token and do not count twice at the client.

`PRIVATE_WRITE_RECEIPT_V1` (`0x0284`) has signature domain
`hyperdht-private-routes/m3/private-write-receipt/v1` and body:

```text
4B   overlayParameters
32B  storageIdentity              // signer
u8   recordKind
32B  topic
32B  endpointPublicKey
u64  sequence
32B  recordDigest
u64  acceptedExpiryMs
u64  storedUntilMs
u64  acceptedAtMs
u64  branchGeneration
32B  destinationRefDigest
32B  operationNonce
32B  commitNonce
32B  receiptNonce
64B  storage signature suffix
```

The body is 301 bytes and wire size is 373 bytes. `receiptNonce` is fresh per
accepted commit and cached for an identical retry. `acceptedExpiryMs` equals
the signed record expiry. `storedUntilMs` is at least that expiry for live
records and obeys the tombstone-retention floor in Section 11.2. A receipt
proves storage acceptance/retention only; it never extends the signed reader
eligibility of a tombstone beyond `acceptedExpiryMs`. A receipt
counts only when its signer is a distinct identity in the client's exact final
K set, its derived storage ID matches that set, and every operation/record/
handle/generation field matches. Duplicate identities or receipt nonces count
once. Replaying one receipt into another operation, storage slot, record,
sequence, expiry, branch, or final set cannot satisfy `W=3`.

The successful announce/unannounce encoded response is exactly the complete
373-byte receipt. Its signer and derived storage ID must equal the requested
destination and the identity that MACed the prepare token.

### 11.7 Collection and rejection rules

All private collections are bounded before allocation. Capability collections
use Section 3; find responses contain at most five advertisements; lookup
responses contain at most eight complete records; routed closer sets contain
at most 20 references and only the command-specific classes/counts in Section
10.3. Length prefixes must equal the nested canonical object exactly.

Every identity, destination ID, nonce, digest, token, and signature is non-zero
unless this registry names an all-zero sentinel. There are no such sentinels in
the storage slice. Signed storage identities are distinct by 32-byte public-key
equality, not by handle, address, or response count. An identity outside the
final selected set never counts toward R or W.

Canonical sorting is unsigned XOR distance first wherever a target is named,
then bytewise identity, then the explicit tie-breakers above. Duplicate IDs,
identities, digests, handles, records, receipt nonces, or a non-canonical order
reject the enclosing collection. A conflicting same-sequence endpoint record
is surfaced as equivocation; it is never resolved by arrival order. Invalid,
expired, or unauthorized objects are rejected, do not consume quorum, and do
not become referrals.

## 12. Routed and Storage Fragmentation and Size Audit

### 12.1 Routed formulas

| Object                              | Maximum wire bytes | Routed fragments | Notes                                     |
| ----------------------------------- | ------------------ | ---------------- | ----------------------------------------- |
| Destination reference               | 172                | 1                | never fragmented alone                    |
| Routed request, private find        | 298                | 1                | `229 + 69`                                |
| Routed request, private lookup      | 363                | 1                | `229 + 134`                               |
| Routed request, private prepare     | 418                | 1                | `229 + 189`                               |
| Routed request, private announce    | 1390               | 2                | `229 + 1161`                              |
| Routed request, private unannounce  | 622                | 1                | `229 + 393`                               |
| Routed request, immutable put       | 1319               | 2                | `229 + 1090`                              |
| Routed request, mutable put         | 1295               | 2                | `229 + 1066`                              |
| Routed reply, private find          | 4031               | 4                | `208 + 5*172 + 2963`                      |
| Routed reply, private lookup        | 8270               | 9                | no token or closer refs                   |
| Routed reply, immutable GET maximum | 4706               | 5                | `208 + 32 + 20*172 + 1026`                |
| Routed reply, mutable GET maximum   | 4650               | 5                | `208 + 32 + 20*172 + 970`                 |
| Routed reply, private write receipt | 581                | 1                | `208 + 373`                               |
| Extend request maximum              | 754                | 1                | `8 + 198 + 548`                           |
| Exit seed set maximum               | 4337               | 5                | `72 + 139 + 3*172 + 5*(2+548+172)`        |
| Private presence record             | 971                | 1                | complete signed nested object             |
| Private find response object        | 2963               | 3                | fragmented only if carried as core object |
| Private lookup response object      | 8062               | 8                | fragmented only if carried as core object |

The fragmented object is always the complete outer `ROUTED_REQUEST_V1` or
`ROUTED_REPLY_V1`; nested records and signed responses are not independently
fragmented inside it. If a signed response object is transported alone for a
test or service boundary, the last two table rows give its core fragment
count. Every count uses `ceil(wireBytes / 1017)` and remains below the Task 0A
13-fragment and 12,288-byte routed-object caps.

### 12.2 Verified maxima and policy capacity

```text
PRIVATE_FIND_NODE_RESPONSE maximum:
  body = 141 + 5 * (2 + 548) = 2891
  wire = 8 + 2891 + 64 = 2963

PRIVATE_LOOKUP_RESPONSE maximum:
  body = 206 + 8 * (2 + 971) = 7990
  wire = 8 + 7990 + 64 = 8062

ROUTED_REPLY private-find maximum:
  208 + 5 * 172 + 2963 = 4031
  ceil(4031 / 1017) = 4

ROUTED_REPLY private-lookup maximum:
  208 + 8062 = 8270
  ceil(8270 / 1017) = 9

Largest M3 routed/storage object:
  8270 < 12288
  9 < 13

Provider-service-policy capacity:
  required entries = exactly 0, 4, 5, or 9 by capability
  548-byte nine-entry advertisement < 1073-byte route payload
```

Client↔exit routed reassemblies use `CORE_FRAGMENT_V1` and Section 4 bounds.
Exit↔storage reassemblies use only the authenticated `EXIT_RPC_FRAGMENT_V1`
carrier and post-admission bounds in Section 4A. No carrier has fragment ACKs.

## 13. Core Size Audit

### 13.1 Message formulas

| Message/object            | Body formula or exact body              | Maximum wire bytes        | Carrier                                    |
| ------------------------- | --------------------------------------- | ------------------------- | ------------------------------------------ |
| Capability advertisement  | `188 + 32p`, `p in {0,4,5,9}`           | 548                       | one route payload or collection element    |
| CAPS query                | 110                                     | 118                       | one direct datagram                        |
| CAPS cookie challenge     | 72                                      | 80                        | one direct datagram                        |
| CAPS response             | `73 + sum(2 + advertBytes)`, count <= 8 | 4545                      | cookie-gated direct fragments              |
| Active challenge          | 176                                     | 184                       | cookie-gated direct guard/storage datagram |
| Active challenge response | 272                                     | 344                       | cookie-gated direct guard/storage datagram |
| Relay discover            | 69                                      | 77                        | one tail-control payload                   |
| Relay discover response   | `41 + sum(2 + advertBytes)`, count <= 8 | 4449                      | routed object; fragment above 1073         |
| Core fragment             | `48 + fragmentDataBytes`                | 1073 routed / 1200 direct | containing transport                       |
| Link offer                | 302                                     | 374                       | one route payload/direct adjacency message |
| Link accept               | 213                                     | 285                       | one adjacency-local message                |
| Redacted responder proof  | 306                                     | 378                       | nested in EXTENDED                         |
| Extended                  | 486                                     | 494                       | one tail-control payload                   |
| Tail ready                | 210                                     | 282                       | one tail-control payload                   |
| Extend request            | `198 + advertBytes`                     | 754                       | one tail-control payload                   |
| Exit activate             | 96                                      | 104                       | one tail-finalize payload                  |
| Exit ready                | 233                                     | 305                       | one tail-finalize payload                  |
| Exit ready ACK            | 105                                     | 113                       | one final-finalize payload                 |
| Exit OPEN                 | 169                                     | 177                       | one final-finalize payload                 |
| Exit seed set             | `139 + 172d + sum(2 + advert + 172)`    | 4337                      | terminal-control object; fragment at max   |
| Exit RPC OPEN             | `190 + a`, `a in {388,548}`             | 650..810                  | authenticated direct admission             |
| Exit RPC ACCEPT           | 124                                     | 148                       | authenticated direct acceptance            |
| Exit RPC fragment         | `27 + fragmentDataBytes`                | 1200                      | admitted direct storage session            |
| Exit RPC request object   | `30 + encodedBodyBytes`                 | 1199                      | encrypted carrier fragments                |
| Exit RPC response object  | `20 + encodedResponseBytes`             | 8090                      | encrypted carrier fragments                |

`p` is the provider-service-policy entry count. Maximum collection formulas use eight
elements of `u16 length + 548-byte advertisement`. The collection responses,
maximum extension request, exit seed set, and outer routed objects use the
fragmentation counts in Sections 12 and 13.3. Every other registered message
fits one selected-carrier payload.

### 13.2 Maximum fragmentation arithmetic

```text
CAPS_RESPONSE_V1 maximum:
  ceil(4545 / 1144) = 4 direct-bootstrap fragments

RELAY_DISCOVER_RESPONSE_V1 maximum:
  ceil(4449 / 1017) = 5 routed fragments

EXTEND_REQUEST_V1 maximum:
  754 <= 1073, unfragmented

DHT_EXIT_SEEDS_V1 maximum:
  ceil(4337 / 1017) = 5 routed fragments

EXIT_RPC_RESPONSE_V1 maximum:
  ceil(8090 / 1149) = 8 authenticated storage fragments

Global object cap:
  ceil(12288 / 1017) = 13 routed fragments
  ceil(12288 / 1144) = 11 direct fragments
```

The global 12,288-byte object cap, 13/11 fragment caps, 5,000 ms deadline, and
concurrent-byte caps in Section 4 are applied before object allocation. The
response-specific maxima above are smaller and must also be enforced.

### 13.3 Authoritative size, carrier, fragmentation, and timeout table

This is the **only authoritative size/carrier table** in this registry. All
earlier size tables and formulas are derivation aids. A discrepancy with this
table blocks implementation and requires a reviewed registry amendment.

`Envelope` is the canonical eight-byte object header plus any 64-byte signature
suffix, and excludes the body. For an embedded `/1` command it is zero because
the command ID/version and raw body are already inside `ROUTED_REQUEST_V1`.
`Max wire` for those commands shows both the complete outer request and the
largest permitted complete reply. A fragment count includes the complete outer
object, not a nested command or record. `1` means no `CORE_FRAGMENT_V1` wrapper.

| ID       | Registered message/object       | Body bytes (fixed..max)                | Envelope | Max wire                   | Selected carrier/context                          | Fragment data / max count            | Timeout or validity                        |
| -------- | ------------------------------- | -------------------------------------- | -------- | -------------------------- | ------------------------------------------------- | ------------------------------------ | ------------------------------------------ |
| `0x0001` | `CAPABILITY_ADVERTISEMENT_V1`   | `188..476`                             | 72       | 548                        | nested discovery object; direct or routed         | none / 1                             | signed expiry, at most 1,800,000 ms        |
| `0x0002` | `CAPS_QUERY_V1`                 | 110                                    | 8        | 118                        | direct bootstrap UDP request                      | none / 1                             | 5,000 ms exchange                          |
| `0x0003` | `CAPS_RESPONSE_V1`              | `335..4,473`                           | 72       | 4,545                      | cookie-gated direct bootstrap UDP response        | 1,144 / 4                            | 5,000 ms exchange/reassembly               |
| `0x0004` | `ACTIVE_CHALLENGE_V1`           | 176                                    | 8        | 184                        | cookie-gated client→guard or exit→storage UDP     | none / 1                             | at most 5,000 ms                           |
| `0x0005` | `ACTIVE_CHALLENGE_RESPONSE_V1`  | 272                                    | 72       | 344                        | cookie-gated guard→client or storage→exit UDP     | none / 1                             | challenge expiry, at most 5,000 ms         |
| `0x0006` | `RELAY_DISCOVER_V1`             | 69                                     | 8        | 77                         | `TAIL_CONTROL_ORDERED`                            | none / 1                             | 5,000 ms exchange                          |
| `0x0007` | `RELAY_DISCOVER_RESPONSE_V1`    | `41..4,441`                            | 8        | 4,449                      | `TAIL_CONTROL_ORDERED`                            | 1,017 / 5                            | 5,000 ms exchange/reassembly               |
| `0x0008` | `CORE_FRAGMENT_V1`              | routed `48..1,065`; direct `48..1,192` | 8        | routed 1,073; direct 1,200 | containing routed context or CAPS direct response | 1,017 / 13 routed; 1,144 / 11 direct | 5,000 ms non-extending reassembly          |
| `0x0009` | `CAPS_COOKIE_CHALLENGE_V1`      | 72                                     | 8        | 80                         | direct bootstrap UDP response                     | none / 1                             | at most 5,000 ms                           |
| `0x0020` | `LINK_OFFER_V1`                 | 302                                    | 72       | 374                        | adjacency-local setup transport                   | none / 1                             | offer deadline, at most 5,000 ms           |
| `0x0021` | `LINK_ACCEPT_V1`                | 213                                    | 72       | 285                        | adjacency-local setup transport                   | none / 1                             | offer deadline, at most 5,000 ms           |
| `0x0022` | `REDACTED_RESPONDER_PROOF_V1`   | 306                                    | 72       | 378                        | nested in `EXTENDED_V1`                           | none / 1                             | admitted-link expiry                       |
| `0x0023` | `EXTENDED_V1`                   | 486                                    | 8        | 494                        | prior `TAIL_CONTROL_ORDERED`                      | none / 1                             | offer/extension deadline, at most 5,000 ms |
| `0x0024` | `TAIL_READY_V1`                 | 210                                    | 72       | 282                        | new reverse `TAIL_CONTROL_ORDERED`                | none / 1                             | admitted-link expiry                       |
| `0x0025` | `EXTEND_REQUEST_V1`             | `458..746`                             | 8        | `466..754`                 | current `TAIL_CONTROL_ORDERED`                    | none / 1                             | 5,000 ms extension deadline                |
| `0x0040` | `DHT_EXIT_ACTIVATE_V1`          | 96                                     | 8        | 104                        | forward `TAIL_FINALIZE_DATAGRAM`                  | none / 1                             | shared 5,000 ms finalization deadline      |
| `0x0041` | `DHT_EXIT_READY_V1`             | 233                                    | 72       | 305                        | reverse `TAIL_FINALIZE_DATAGRAM`                  | none / 1                             | shared 5,000 ms finalization deadline      |
| `0x0042` | `DHT_EXIT_READY_ACK_V1`         | 105                                    | 8        | 113                        | forward `FINAL_EXIT_FINALIZE_DATAGRAM`            | none / 1                             | shared 5,000 ms finalization deadline      |
| `0x0043` | `DHT_EXIT_OPEN_V1`              | 169                                    | 8        | 177                        | reverse `FINAL_EXIT_FINALIZE_DATAGRAM`            | none / 1                             | 5,000 ms retired-context grace after OPEN  |
| `0x0044` | `DHT_EXIT_SEEDS_V1`             | `311..4,265`                           | 72       | `383..4,337`               | reverse `TERMINAL_CONTROL_ORDERED`                | 1,017 / 5                            | 5,000 ms from OPEN                         |
| `0x0050` | `EXIT_RPC_OPEN_V1`              | `578..738`                             | 72       | `650..810`                 | direct exit-to-storage UDP                        | none / 1                             | at most 5,000 ms                           |
| `0x0051` | `EXIT_RPC_ACCEPT_V1`            | 124                                    | 24       | 148                        | direct exit-to-storage UDP                        | none / 1                             | OPEN deadline                              |
| `0x0052` | `EXIT_RPC_FRAGMENT_V1`          | `27..1,176`                            | 24       | `51..1,200`                | admitted exit-to-storage session                  | 1,149 / 8                            | OPEN deadline, at most 5,000 ms            |
| `0x0053` | `EXIT_RPC_REQUEST_V1`           | `30..1,191`                            | 8        | `38..1,199`                | encrypted storage-session object                  | 1,149 / 2                            | OPEN deadline                              |
| `0x0054` | `EXIT_RPC_RESPONSE_V1`          | `20..8,082`                            | 8        | `28..8,090`                | encrypted storage-session object                  | 1,149 / 8                            | OPEN deadline                              |
| `0x0100` | `DESTINATION_REF_V1`            | 164                                    | 8        | 172                        | nested `ROUTE_PAYLOAD` authority                  | none / 1                             | at most 300,000 ms and route-bound         |
| `0x0101` | `ROUTED_REQUEST_V1`             | `221..1,382`                           | 8        | 1,390                      | forward `ROUTE_PAYLOAD`                           | 1,017 / 2                            | selected command policy, at most 5,000 ms  |
| `0x0102` | `ROUTED_REPLY_V1`               | `200..8,262`                           | 8        | 8,270                      | reverse `ROUTE_PAYLOAD`                           | 1,017 / 9                            | original request deadline                  |
| `0x0120` | `IMMUTABLE_GET/1`               | 32 request                             | 0        | 261 request / 4,706 reply  | embedded `ROUTE_PAYLOAD` command                  | 1,017 / 5 for exchange maximum       | 3,000 ms                                   |
| `0x0121` | `IMMUTABLE_PUT/1`               | `67..1,090` request                    | 0        | 1,319 request / 209 reply  | embedded `ROUTE_PAYLOAD` command                  | 1,017 / 2 for exchange maximum       | 3,000 ms                                   |
| `0x0122` | `MUTABLE_GET/1`                 | 40 request                             | 0        | 269 request / 4,650 reply  | embedded `ROUTE_PAYLOAD` command                  | 1,017 / 5 for exchange maximum       | 3,000 ms                                   |
| `0x0123` | `MUTABLE_PUT/1`                 | `171..1,066` request                   | 0        | 1,295 request / 209 reply  | embedded `ROUTE_PAYLOAD` command                  | 1,017 / 2 for exchange maximum       | 3,000 ms                                   |
| `0x0200` | `PRIVATE_FIND_NODE/1`           | 69 request                             | 0        | 298 request / 4,031 reply  | embedded `ROUTE_PAYLOAD` command                  | 1,017 / 4 for exchange maximum       | 5,000 ms                                   |
| `0x0201` | `PRIVATE_FIND_NODE_RESPONSE_V1` | `141..2,891`                           | 72       | 2,963                      | nested in `ROUTED_REPLY_V1`                       | 1,017 / 3 if transported alone       | original 5,000 ms request deadline         |
| `0x0280` | `PRIVATE_PRESENCE_RECORD_V1`    | `132..899`                             | 72       | `204..971`                 | nested storage command/response                   | none / 1                             | live expiry, at most 86,400,000 ms         |
| `0x0281` | `PRIVATE_TOMBSTONE_V1`          | 131                                    | 72       | 203                        | nested storage command/response                   | none / 1                             | signed 1..7 days; retained at least 1 day  |
| `0x0282` | `PRIVATE_LOOKUP_RESPONSE_V1`    | `206..7,990`                           | 72       | 8,062                      | nested in `ROUTED_REPLY_V1`                       | 1,017 / 8 if transported alone       | original 5,000 ms request deadline         |
| `0x0283` | `PRIVATE_WRITE_TOKEN_V1`        | 72                                     | 8        | 80                         | nested in prepare reply/commit request            | none / 1                             | at most 30,000 ms                          |
| `0x0284` | `PRIVATE_WRITE_RECEIPT_V1`      | 301                                    | 72       | 373                        | nested in commit `ROUTED_REPLY_V1`                | none / 1                             | original 5,000 ms request deadline         |
| `0x02a0` | `PRIVATE_LOOKUP/1`              | 134 request                            | 0        | 363 request / 8,270 reply  | embedded `ROUTE_PAYLOAD` command                  | 1,017 / 9 for exchange maximum       | 5,000 ms                                   |
| `0x02a1` | `PRIVATE_PREPARE/1`             | 189 request                            | 0        | 418 request / 288 reply    | embedded `ROUTE_PAYLOAD` command                  | none / 1                             | 3,000 ms                                   |
| `0x02a2` | `PRIVATE_ANNOUNCE/1`            | `394..1,161` request                   | 0        | 1,390 request / 581 reply  | embedded `ROUTE_PAYLOAD` command                  | 1,017 / 2 for exchange maximum       | 5,000 ms                                   |
| `0x02a3` | `PRIVATE_UNANNOUNCE/1`          | 393 request                            | 0        | 622 request / 581 reply    | embedded `ROUTE_PAYLOAD` command                  | none / 1                             | 5,000 ms                                   |

The `PRIVATE_PRESENCE_RECORD_V1` fixed portion is 131 bytes; its non-empty
descriptor makes its minimum body 132 bytes. This is why the table shows
`132..899`, while `PRIVATE_TOMBSTONE_V1` uses the same 131-byte fixed body and
an empty descriptor.

### 13.4 Independent framing and global-cap proof

The inherited M2 cell framing is:

```text
1200 = 36-byte clear cell header + 1148-byte ciphertext + 16-byte AEAD tag
1148 = 2-byte cell payload length + 1146-byte maximum cell payload
```

The M3 logical framing inside that payload is:

```text
1101 = 1-byte public context class + 1100-byte encrypted route frame
1100 = 8-byte clear inner counter + 1092-byte ciphertext
1092 = 1076-byte plaintext + 16-byte AEAD tag
1076 = 1-byte inherited delivery class + 2-byte logical length + 1073 bytes
```

Thus `1101 <= 1146`, leaving exactly 45 bytes for inherited cell padding, and
the maximum M3 logical payload is exactly 1,073 bytes. A canonical fragment has
`8 + 48 = 56` bytes of envelope/fixed body, so:

```text
routed fragment data = 1073 - 56 = 1017
direct fragment data = 1200 - 56 = 1144

12 * 1017 = 12204 < 12288 <= 13 * 1017 = 13221
10 * 1144 = 11440 < 12288 <= 11 * 1144 = 12584
```

Therefore the 12,288-byte global complete-object cap requires at most 13 routed
fragments or 11 direct bootstrap fragments, and neither smaller cap suffices.
The cap includes the complete canonical object header and signature suffix.

## 14. Exhaustive Identifier and Implementation Inventory

This checklist includes every assigned ID. `Body/wire` is repeated here to
make ownership review self-contained; Section 13.3 remains authoritative for
size/carrier conflicts. All 15 error IDs are valid inside authenticated
`ROUTED_REPLY_V1.errorCode`. The exact eleven-code subset `0x0180`, `0x0181`,
`0x0182`, `0x0185..0x0188`, and `0x018b..0x018e` is also valid inside
authenticated `EXIT_RPC_RESPONSE_V1.errorCode`; `0x0183`, `0x0184`, `0x0189`,
and `0x018a` are exit-local and routed-reply-only. Error values do not create
standalone objects.

| ID/version  | Object, message, command, or error    | Transport / context                          | Authentication / domain                                                     | Max body / wire bytes | Approved-design behavior section               | Implementation owner |
| ----------- | ------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------- | --------------------- | ---------------------------------------------- | -------------------- |
| `0x0001/v1` | `CAPABILITY_ADVERTISEMENT_V1`         | direct/routed nested evidence                | Ed25519, `hyperdht-private-routes/m3/capability-advertisement/v1`           | 476 / 548             | Advertised Capabilities                        | private-routes       |
| `0x0002/v1` | `CAPS_QUERY_V1`                       | direct bootstrap UDP                         | endpoint-bound return cookie                                                | 110 / 118             | Permissionless Discovery                       | private-routes       |
| `0x0003/v1` | `CAPS_RESPONSE_V1`                    | cookie-gated direct UDP/fragments            | Ed25519, `hyperdht-private-routes/m3/caps-response/v1`                      | 4,473 / 4,545         | Permissionless Discovery                       | private-routes       |
| `0x0004/v1` | `ACTIVE_CHALLENGE_V1`                 | cookie-gated client→guard / exit→storage UDP | live CAPS return-routability tuple                                          | 176 / 184             | Advertised Capabilities                        | private-routes       |
| `0x0005/v1` | `ACTIVE_CHALLENGE_RESPONSE_V1`        | cookie-gated guard→client / storage→exit UDP | Ed25519 domain in Section 3.6 plus X25519/keyed-BLAKE2b proof               | 272 / 344             | Advertised Capabilities                        | private-routes       |
| `0x0006/v1` | `RELAY_DISCOVER_V1`                   | `TAIL_CONTROL_ORDERED`                       | context AEAD                                                                | 69 / 77               | Permissionless Discovery                       | private-routes       |
| `0x0007/v1` | `RELAY_DISCOVER_RESPONSE_V1`          | `TAIL_CONTROL_ORDERED`/fragments             | context AEAD plus nested signatures                                         | 4,441 / 4,449         | Permissionless Discovery                       | private-routes       |
| `0x0008/v1` | `CORE_FRAGMENT_V1`                    | containing direct/routed carrier             | containing transport; whole-object digest                                   | 1,192 / 1,200 direct  | Relationship to M2 / On-wire Context Selection | private-routes       |
| `0x0009/v1` | `CAPS_COOKIE_CHALLENGE_V1`            | direct bootstrap UDP                         | keyed BLAKE2b, observed source/query binding                                | 72 / 80               | Permissionless Discovery                       | private-routes       |
| `0x0020/v1` | `LINK_OFFER_V1`                       | adjacency-local setup                        | Ed25519, `hyperdht-private-routes/m3/link-offer/v1`                         | 302 / 374             | Production Bilateral Link Authorization        | private-routes       |
| `0x0021/v1` | `LINK_ACCEPT_V1`                      | adjacency-local setup                        | Ed25519, `hyperdht-private-routes/m3/link-accept/v1`                        | 213 / 285             | Production Bilateral Link Authorization        | private-routes       |
| `0x0022/v1` | `REDACTED_RESPONDER_PROOF_V1`         | nested `EXTENDED_V1`                         | Ed25519, `hyperdht-private-routes/m3/redacted-responder-proof/v1`           | 306 / 378             | Production Bilateral Link Authorization        | private-routes       |
| `0x0023/v1` | `EXTENDED_V1`                         | prior `TAIL_CONTROL_ORDERED`                 | context AEAD plus nested responder signature                                | 486 / 494             | Incremental Tail-control Context               | private-routes       |
| `0x0024/v1` | `TAIL_READY_V1`                       | new reverse `TAIL_CONTROL_ORDERED`           | context AEAD + Ed25519, `hyperdht-private-routes/m3/tail-ready/v1`          | 210 / 282             | Incremental Tail-control Context               | private-routes       |
| `0x0025/v1` | `EXTEND_REQUEST_V1`                   | current `TAIL_CONTROL_ORDERED`               | context AEAD plus nested candidate signature                                | 746 / 754             | Incremental Tail-control Context               | private-routes       |
| `0x0040/v1` | `DHT_EXIT_ACTIVATE_V1`                | forward `TAIL_FINALIZE_DATAGRAM`             | context AEAD                                                                | 96 / 104              | Final Exit Key Handoff                         | private-routes       |
| `0x0041/v1` | `DHT_EXIT_READY_V1`                   | reverse `TAIL_FINALIZE_DATAGRAM`             | context AEAD + Ed25519, `hyperdht-private-routes/m3/dht-exit-ready/v1`      | 233 / 305             | Final Exit Key Handoff                         | private-routes       |
| `0x0042/v1` | `DHT_EXIT_READY_ACK_V1`               | forward `FINAL_EXIT_FINALIZE_DATAGRAM`       | context AEAD                                                                | 105 / 113             | Finalization Acknowledgement                   | private-routes       |
| `0x0043/v1` | `DHT_EXIT_OPEN_V1`                    | reverse `FINAL_EXIT_FINALIZE_DATAGRAM`       | context AEAD                                                                | 169 / 177             | Finalization Acknowledgement                   | private-routes       |
| `0x0044/v1` | `DHT_EXIT_SEEDS_V1`                   | reverse `TERMINAL_CONTROL_ORDERED`           | context AEAD + Ed25519, `hyperdht-private-routes/m3/dht-exit-seeds/v1`      | 4,265 / 4,337         | Native DHT-RPC Transport / Compatible Storage  | private-routes       |
| `0x0050/v1` | `EXIT_RPC_OPEN_V1`                    | direct exit-to-storage UDP                   | exit Ed25519 + signed advertisement                                         | `578..738 / 650..810` | Native DHT-RPC Transport                       | private-routes       |
| `0x0051/v1` | `EXIT_RPC_ACCEPT_V1`                  | direct exit-to-storage UDP                   | storage-session XChaCha20-Poly1305                                          | 124 / 148             | Native DHT-RPC Transport                       | private-routes       |
| `0x0052/v1` | `EXIT_RPC_FRAGMENT_V1`                | admitted exit-to-storage UDP                 | directional storage-session AEAD                                            | 1,176 / 1,200         | Native DHT-RPC Transport                       | private-routes       |
| `0x0053/v1` | `EXIT_RPC_REQUEST_V1`                 | encrypted storage-session object             | request-direction AEAD                                                      | 1,191 / 1,199         | Native DHT-RPC Transport                       | private-routes       |
| `0x0054/v1` | `EXIT_RPC_RESPONSE_V1`                | encrypted storage-session object             | response AEAD + closed 11-code error mapping                                | 8,082 / 8,090         | Native DHT-RPC Transport                       | private-routes       |
| `0x0100/v1` | `DESTINATION_REF_V1`                  | nested `ROUTE_PAYLOAD`                       | exit-local keyed-BLAKE2b tag + live table entry + route context             | 164 / 172             | Native DHT-RPC Transport                       | private-routes       |
| `0x0101/v1` | `ROUTED_REQUEST_V1`                   | forward `ROUTE_PAYLOAD`                      | context AEAD + exact advertised policy                                      | 1,382 / 1,390         | Native DHT-RPC Transport / Command Policy      | private-routes       |
| `0x0102/v1` | `ROUTED_REPLY_V1`                     | reverse `ROUTE_PAYLOAD`                      | context AEAD + exact request/reference equality                             | 8,262 / 8,270         | Native DHT-RPC Transport                       | private-routes       |
| `0x0120/1`  | `IMMUTABLE_GET`                       | embedded routed command                      | route AEAD; immutable content hash on result                                | 32 / 261 request      | Command Policy                                 | dht-rpc              |
| `0x0121/1`  | `IMMUTABLE_PUT`                       | embedded routed command                      | route AEAD + same-exit token + immutable content hash                       | 1,090 / 1,319 request | Token and Address Binding / Command Policy     | dht-rpc              |
| `0x0122/1`  | `MUTABLE_GET`                         | embedded routed command                      | route AEAD + existing HyperDHT mutable signature on result                  | 40 / 269 request      | Command Policy                                 | dht-rpc              |
| `0x0123/1`  | `MUTABLE_PUT`                         | embedded routed command                      | route AEAD + same-exit token + existing mutable signature                   | 1,066 / 1,295 request | Token and Address Binding / Command Policy     | dht-rpc              |
| `0x0180/v1` | `ROUTED_ERROR_MALFORMED`              | routed reply / storage response              | route or storage-session AEAD; empty payload                                | n/a / reply cap 8,270 | Errors and Observability                       | private-routes       |
| `0x0181/v1` | `ROUTED_ERROR_UNSUPPORTED_COMMAND`    | routed reply / storage response              | route or storage-session AEAD; empty payload                                | n/a / reply cap 8,270 | Command Policy / Errors                        | private-routes       |
| `0x0182/v1` | `ROUTED_ERROR_POLICY_MISMATCH`        | routed reply / storage response              | route or storage-session AEAD; empty payload                                | n/a / reply cap 8,270 | Command Policy / Errors                        | private-routes       |
| `0x0183/v1` | `ROUTED_ERROR_DESTINATION_INVALID`    | routed reply only; exit-local                | route AEAD; empty payload                                                   | n/a / reply cap 8,270 | Native DHT-RPC Transport / Errors              | private-routes       |
| `0x0184/v1` | `ROUTED_ERROR_DESTINATION_EXPIRED`    | routed reply only; exit-local                | route AEAD; empty payload                                                   | n/a / reply cap 8,270 | Native DHT-RPC Transport / Errors              | private-routes       |
| `0x0185/v1` | `ROUTED_ERROR_DEADLINE_EXPIRED`       | routed reply / storage response              | route or storage-session AEAD; empty payload                                | n/a / reply cap 8,270 | Native DHT-RPC Transport / Errors              | private-routes       |
| `0x0186/v1` | `ROUTED_ERROR_BUSY`                   | routed reply / storage response              | route or storage-session AEAD; empty payload                                | n/a / reply cap 8,270 | Abuse and Resource Control                     | private-routes       |
| `0x0187/v1` | `ROUTED_ERROR_RESPONSE_TOO_LARGE`     | routed reply / storage response              | route or storage-session AEAD; empty payload                                | n/a / reply cap 8,270 | Abuse and Resource Control                     | private-routes       |
| `0x0188/v1` | `ROUTED_ERROR_AMPLIFICATION_EXCEEDED` | routed reply / storage response              | route or storage-session AEAD; empty payload                                | n/a / reply cap 8,270 | Abuse and Resource Control                     | private-routes       |
| `0x0189/v1` | `ROUTED_ERROR_UPSTREAM_TIMEOUT`       | routed reply only; exit-local                | route AEAD; empty payload                                                   | n/a / reply cap 8,270 | Native DHT-RPC Transport / Errors              | private-routes       |
| `0x018a/v1` | `ROUTED_ERROR_UPSTREAM_REJECTED`      | routed reply only; exit-local                | route AEAD; empty payload                                                   | n/a / reply cap 8,270 | Native DHT-RPC Transport / Errors              | private-routes       |
| `0x018b/v1` | `ROUTED_ERROR_TOKEN_INVALID`          | routed reply / storage response              | route or storage-session AEAD; empty payload                                | n/a / reply cap 8,270 | Token and Address Binding                      | private-routes       |
| `0x018c/v1` | `ROUTED_ERROR_STORAGE_UNAVAILABLE`    | routed reply / storage response              | route or storage-session AEAD; empty payload                                | n/a / reply cap 8,270 | Compatible Storage Overlay                     | private-routes       |
| `0x018d/v1` | `ROUTED_ERROR_RECORD_CONFLICT`        | routed reply / storage response              | route or storage-session AEAD; empty payload                                | n/a / reply cap 8,270 | Native Private Presence Records                | private-routes       |
| `0x018e/v1` | `ROUTED_ERROR_QUOTA_EXCEEDED`         | routed reply / storage response              | route or storage-session AEAD; empty payload                                | n/a / reply cap 8,270 | Abuse and Resource Control                     | private-routes       |
| `0x0200/1`  | `PRIVATE_FIND_NODE`                   | embedded routed command                      | route AEAD; target orders only                                              | 69 / 298 request      | Compatible Storage Overlay                     | HyperDHT             |
| `0x0201/v1` | `PRIVATE_FIND_NODE_RESPONSE_V1`       | nested routed reply                          | storage Ed25519, `hyperdht-private-routes/m3/private-find-node-response/v1` | 2,891 / 2,963         | Compatible Storage Overlay                     | HyperDHT             |
| `0x0280/v1` | `PRIVATE_PRESENCE_RECORD_V1`          | nested storage object                        | endpoint Ed25519, `hyperdht-private-routes/m3/private-presence-record/v1`   | 899 / 971             | Native Private Presence Records                | HyperDHT             |
| `0x0281/v1` | `PRIVATE_TOMBSTONE_V1`                | nested storage object                        | endpoint Ed25519, `hyperdht-private-routes/m3/private-tombstone/v1`         | 131 / 203             | Native Private Presence Records                | HyperDHT             |
| `0x0282/v1` | `PRIVATE_LOOKUP_RESPONSE_V1`          | nested routed reply                          | storage Ed25519, `hyperdht-private-routes/m3/private-lookup-response/v1`    | 7,990 / 8,062         | Prepare, Commit, and Receipts / Lookup         | HyperDHT             |
| `0x0283/v1` | `PRIVATE_WRITE_TOKEN_V1`              | nested prepare reply/commit                  | storage-local keyed-BLAKE2b MAC over full binding                           | 72 / 80               | Prepare, Commit, and Receipts                  | HyperDHT             |
| `0x0284/v1` | `PRIVATE_WRITE_RECEIPT_V1`            | nested routed reply                          | storage Ed25519, `hyperdht-private-routes/m3/private-write-receipt/v1`      | 301 / 373             | Prepare, Commit, and Receipts                  | HyperDHT             |
| `0x02a0/1`  | `PRIVATE_LOOKUP`                      | embedded routed command                      | route AEAD + signed storage responses                                       | 134 / 363 request     | Native Private Presence Records / Lookup       | HyperDHT             |
| `0x02a1/1`  | `PRIVATE_PREPARE`                     | embedded routed command                      | route AEAD + storage MAC token                                              | 189 / 418 request     | Prepare, Commit, and Receipts                  | HyperDHT             |
| `0x02a2/1`  | `PRIVATE_ANNOUNCE`                    | embedded routed command                      | route AEAD + token + endpoint record signature                              | 1,161 / 1,390 request | Prepare, Commit, and Receipts                  | HyperDHT             |
| `0x02a3/1`  | `PRIVATE_UNANNOUNCE`                  | embedded routed command                      | route AEAD + token + endpoint tombstone signature                           | 393 / 622 request     | Prepare, Commit, and Receipts                  | HyperDHT             |

Inventory count: **58 assigned IDs**: 43 messages/objects/commands and 15 routed
error values. Every Task 0 item is visible above: capability advertisement;
CAPS query/cookie/response; challenge pair; relay-discovery pair; link offer/accept; redacted
proof; extension request/EXTENDED; TAIL_READY; ACTIVATE/READY/ACK/OPEN; exit DHT
and storage seeds; destination reference;
routed request/reply/errors; authenticated exit/storage carrier; immutable/mutable commands; storage
advertisement/referral via the capability advertisement; presence/tombstone;
find request/response; lookup and signed-empty response; prepare/token; and
announce/unannounce/receipt.

## 15. Owner/Security Approval Decisions

Nothing in this table is implied to be approved. These choices were needed to
make the byte registry implementable but were not fixed by the already-approved
behavior design. The owner/security review must explicitly approve, amend, or
reject every row. Amendments require rerunning all size, ID, and transcript
checks before Task 1.

| Pending decision                      | Draft selection in this registry                                                                                                                                                                                       | Security/availability tradeoff and alternatives                                                                                                                                                                                                                                                        |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Scalar and object framing             | Big-endian fixed-width scalars; eight-byte `u32 version / u16 ID / u16 body length`; `u16` byte-string lengths; no varints/defaults                                                                                    | Simple canonical parsing and signatures at modest fixed overhead. Alternatives are compact-encoding varints or per-message framing, both with more malleability/version-skew risk.                                                                                                                     |
| Shared numeric namespace              | Ranges and exact IDs in Sections 1.5 and 14; reserved IDs fail closed                                                                                                                                                  | Prevents cross-type reinterpretation but consumes one global allocation. Alternative is transport-local namespaces with greater collision/audit risk.                                                                                                                                                  |
| Signature/digest domains              | Exact new per-object domains in Sections 1–11; generic digest has a length-prefixed domain, while behavior-approved legacy digests retain raw domains                                                                  | Strong separation but more vectors and implementation surface. Alternative is one transcript schema/domain, which raises substitution risk.                                                                                                                                                            |
| Canonical network address             | Canonical 17/19-byte form; advertisements restricted to IPv4 and exact existing DHT-RPC peer-ID derivation                                                                                                             | Preserves interoperability and prevents an unproven IPv6 ID scheme. IPv6 advertisements require a later coordinated DHT-RPC version.                                                                                                                                                                   |
| Provider and exit-origin policies     | Provider advertisements contain exactly 0, 4, 5, or 9 tuples by independent service capabilities; finalization binds the immutable nine-tuple M3-v1 exit-origin constant                                               | Separates services a node accepts from commands an exit originates while preventing operator-selected budgets. Alternatives are coupled capabilities or signed per-exit origin policy, which reduce deployment flexibility or permit downgrade/equivocation.                                           |
| Capability implication/role rule      | `PRIVATE_RECORDS_V1` is independent and imposes no M2 role; `DHT_EXIT_V1` requires `CIRCUIT_RELAY_V1` and `ROLE.PRIVATE`; relay-only route participants derive safety                                                  | Supports storage-only deployment while retaining the route dependency of exits. Coupling storage to exit/relay wastes mobile/storage capacity; making exit independent of relay leaves an unusable route endpoint.                                                                                     |
| Advertisement lifetime                | Maximum 30 minutes, monotonic epochs, fresh route-encryption key on policy change                                                                                                                                      | Limits stale-key replay and cache poisoning. Shorter values increase mobile refresh/battery cost; longer values improve intermittent reliability but prolong compromise/staleness.                                                                                                                     |
| Advertisement collection cap          | At most 8 advertisements in CAPS/relay discovery                                                                                                                                                                       | Bounds memory/amplification while offering limited diversity. Alternatives 4 or 16 trade discovery success against response size and referral bias.                                                                                                                                                    |
| CAPS self-advertisement               | A signed CAPS response must contain exactly one current self-ad matching the responder and queried endpoint                                                                                                            | Prevents an unsigned referrer-only identity and makes the responder accountable. It can reduce availability for compatible referral-only bootstrap nodes; alternative is a separately signed responder certificate.                                                                                    |
| CAPS return routability/resources     | 118-byte phase-0 query; 80-byte stateless endpoint/query cookie; 4,096-entry/5,000 ms replay cache; exactly 32-byte CSPRNG cookie secret rotated every 300,000 ms with only the prior secret retained exactly 5,000 ms | Eliminates reflection and bounds memory/key exposure. Smaller caches or shorter overlap reduce replay service/mobile tolerance; larger caches/overlap or slower rotation consume memory and prolong key exposure. Bulk CAPS, client→guard challenge, and exit→storage admission require the live echo. |
| Storage OPEN admission resources      | Per-source syntactically valid OPEN cap 8/s; global Ed25519 bucket 64/s with burst 128; accepted replay cache exactly 4,096 entries through the at-most-5,000 ms deadline                                              | Bounds spoofed-source signature/X25519/allocation work while allowing bursts and exact replay recovery. Lower limits can reject mobile reconnect bursts; higher/per-source-only limits increase distributed DoS work; a larger cache consumes more memory.                                             |
| Discovery exchanges                   | CAPS and routed relay discovery each have a 5,000 ms non-extending exchange deadline                                                                                                                                   | Bounds sockets/reassembly and mobile wakeups. A longer deadline helps high-latency paths; adaptive deadlines increase fingerprinting/state complexity.                                                                                                                                                 |
| Fragment/object caps                  | Complete object cap 12,288 bytes; 1,017 routed/1,144 direct fragment data; at most 13/11 fragments; no nested fragments or fragment ACK                                                                                | Covers all current maxima and bounds amplification. A smaller cap blocks lookup batches; a larger cap increases memory/DoS exposure.                                                                                                                                                                   |
| Reassembly resources                  | 5,000 ms non-extending; routed 4/49,152; cookie-validated CAPS 2/24,576; admitted storage carrier 4/49,152 and 128/1,572,864 global                                                                                    | Hard memory bounds and no trickle extension; no bulk allocation precedes return-routability or signed OPEN admission.                                                                                                                                                                                  |
| Challenge/link deadlines              | Active challenge and link offer/extension are capped at 5,000 ms                                                                                                                                                       | Limits replay/state retention. Longer deadlines improve poor-mobile-link construction but preserve partial secrets/state longer.                                                                                                                                                                       |
| Extension request layout              | Client sends one signed-advertisement-bearing `EXTEND_REQUEST_V1`; 754-byte maximum fits one current-tail payload                                                                                                      | Closes the client→tail authorization transcript without direct dialing. The closed nine-policy cap removes prior fragmentation.                                                                                                                                                                        |
| Initial exit seed delivery            | Signed proactive `DHT_EXIT_SEEDS_V1` after OPEN; 1..3 DHT refs and 1..5 storage pairs when the branch requires private records; five-second readiness deadline                                                         | Gives client-side iteration an address-free starting set without requiring the exit to provide storage. More seeds improve convergence but amplify a fresh circuit; on-demand EXIT_LOCAL commands add a request surface and policy entry.                                                              |
| Opaque destination authority          | 130-byte handle, 16-byte MAC tag, mandatory live exit table entry, five-minute maximum lifetime; fresh 32-byte CSPRNG secret per exit branch generation at OPEN, never rotated/reused, erased at branch destroy        | Strong branch/exit binding and bounded stale authority at 172 bytes per reference. A rotating shared secret complicates live-handle validation; a cross-generation secret widens compromise; shorter handles/tags or stateless handles weaken collision/forgery or revocation properties.              |
| Provenance classes and command bitmap | Five exit-local provenance enums; nine-bit allowlist in a `u16`; capability digest retained locally                                                                                                                    | Makes minting auditable and command-specific. A richer provenance graph improves evidence but expands parser/state complexity; a coarse single class weakens policy review.                                                                                                                            |
| Request identity and retry cache      | 16-byte random request IDs; exact byte-equal retries; result cache at most 5,000 ms and never past deadline; no wire CANCEL                                                                                            | Bounds collision/replay state and avoids a cancellation oracle. Larger IDs add bytes; shorter cache increases duplicate mutation work; CANCEL improves resource release but adds state transitions.                                                                                                    |
| Routed error surface                  | IDs `0x0180..0x018e`; errors carry no token, referrals, or diagnostic body                                                                                                                                             | Coarse authenticated failures reduce oracle/amplification risk. Rich errors improve debugging but expose load/provenance detail.                                                                                                                                                                       |
| Command budgets                       | Exact request/response/timeout/outstanding/cost/amplification tuples in Section 10.5                                                                                                                                   | Current values admit all bounded objects and cap work. Lower response budgets break batched results; higher outstanding/amplification values increase exit/storage abuse.                                                                                                                              |
| Amplification accounting              | Complete `ROUTED_REPLY_V1` bytes, including 208 fixed bytes, token, all refs, and response, are bounded against complete request bytes                                                                                 | Prevents token/referral overhead from bypassing signed policy. Body-only accounting is smaller but unsafe.                                                                                                                                                                                             |
| Legacy value translation              | Fixed-width wrappers; immutable max 1,024 bytes; mutable max 896 bytes; no compact-encoding varints inside canonical M3 bodies                                                                                         | Canonical M3 parsing while preserving legacy hashes/signatures. Reusing legacy codecs reduces translation code but introduces variable encodings into signed policy bounds.                                                                                                                            |
| Exit-to-network carriers              | Legacy IPv4 DHT-RPC stays one bounded datagram; private storage uses globally rate-limited signed OPEN, exact 308-byte KDF transcript, cached ACCEPT, and AEAD fragments                                               | Preserves legacy interoperability while bounding spoofed-source signature work, duplicate derivation/allocation, and authenticated fragmentation.                                                                                                                                                      |
| Storage-carrier errors                | Success is zero; eleven exact routed-error values map unchanged; destination/timeout/upstream codes remain exit-local; all other values fail closed                                                                    | Reuses the authenticated routed error surface without letting storage impersonate exit-local authority or attach diagnostic amplification.                                                                                                                                                             |
| Mutable sequence compatibility        | Wire `u64be`, restricted to `0..2^53-1` for current HyperDHT exact representation                                                                                                                                      | Avoids truncation in legacy JS codecs. Full `u64` support requires a coordinated upstream BigInt migration; a `u53` wire type would make future extension harder.                                                                                                                                      |
| Record descriptor and batch caps      | Non-dialable descriptor `1..768` bytes; lookup at most 8 records; closer refs at most 20; find returns at most K=5                                                                                                     | Fits the largest reply in 9 fragments and bounds storage. Smaller descriptors may constrain M4 migration; larger batches exceed current object/memory budget.                                                                                                                                          |
| Record clock/lifetime policy          | Future skew 300,000 ms; live at most 1 day; tombstone 1–7 days; readers stop at signed expiry; longer internal retention only suppresses rollback                                                                      | Gives readers a signed eligibility bound while allowing storage to reject stale resurrection. Longer reader lifetime prolongs stale absence.                                                                                                                                                           |
| Storage token/cache bounds            | 32-byte token nonce/tag and 30,000 ms lifetime; 32-byte CSPRNG token secret rotated exactly every 300,000 ms, prior retained exactly 30,000 ms, at most two keys; idempotent commit cached only until expiry           | Keeps prepare/commit short and accepts tokens across one rotation. Shorter retention/expiry increases mobile write failures; longer retention or more keys widens compromise/replay state and memory; non-rotating secrets widen exposure.                                                             |
| Exact final-set semantics             | Discovery must have exactly five distinct storage identities; reads count three distinct valid identities and writes three distinct valid receipt signers                                                              | Prevents duplicate handles/responses from manufacturing quorum. Allowing smaller sets improves sparse-network availability but materially weakens the quorum claim.                                                                                                                                    |
| Sorting/duplicate policy              | Canonical XOR/identity/epoch ordering; duplicate identity/digest/handle rejects enclosing signed collections, except later same-ID query handles are ignored                                                           | Deterministic transcripts prevent reordering malleability. Tolerant sorting improves interoperability but complicates signed-set equality and equivocation handling.                                                                                                                                   |

The following are **not** new selections in this table: branch values, the five
context classes, the 64-counter replay window, exact 1,200/1,101/1,100/1,073
framing, `M3ContextAD`, the tail/final-exit transcripts and KDF construction,
the five-send finalization schedule, K/alpha/W/R, and the behavioral privacy
rules. They are reproduced byte-for-byte from the owner-approved behavior
design and are audited in Section 16.3.

## 16. End-to-End Authority, Allocation, and Cryptographic Audit

### 16.1 Privacy and authority invariants

- **No client-supplied raw address:** the public destination adapter is exactly
  `{ id, handle }`. The only endpoint is inside the issuing exit's non-wire
  `serverBinding`; command bodies, replies, records, and public adapters contain
  no host or port.
- **An arbitrary ID cannot mint a handle:** a DHT ID or signed advertisement is
  evidence only. The exit must learn an endpoint through an allowed provenance,
  validate reachability or active capability itself, create a live table entry,
  and MAC its digest. Both the table entry and tag are mandatory.
- **The reply cannot substitute authority:** `ROUTED_REPLY_V1.from` must be
  byte-equal to the complete requested `DESTINATION_REF_V1`, including the
  opaque handle, before token, closer-reference, or response processing.
- **Provenance is exit-owned:** endpoint, derived ID, provenance class/digest,
  command bitmap, capability digest, handle secret, and table lifetime never
  come from a caller-controlled destination object.
- **Token/handle/exit/branch/generation continuity:** the route context and
  handle repeat exit identity, branch, circuit, and generation; prepare binds
  the complete destination-reference digest and generation; the storage MAC
  additionally binds its identity, actually observed exit endpoint, record,
  command, and operation; commit repeats the destination digest/generation;
  the signed receipt repeats destination digest, generation, operation, and
  commit nonces. Any mismatch fails before quorum credit.
- **Observed exit endpoint stays storage-local:** it appears only in the token
  MAC input and retained token binding. It is absent from the 80-byte token,
  signed receipt, lookup response, record, and every value returned to the
  client.
- **Empty is not absence:** one signed empty lookup response says only what one
  named storage identity returned at one time. A client returns no result until
  at least three distinct valid final-set identities respond, and even that is
  explicitly not cryptographic proof of absence.
- **Final-set counting is by identity:** convergence, R, and W count distinct
  verified Ed25519 storage identities from the exact final five, never handles,
  endpoints, response count, token count, or receipt nonce. Duplicate identity
  evidence counts once; an identity outside the set counts zero.

These checks preserve the required end-to-end chain:

```text
exit-observed provenance -> exit table + MACed handle -> exact routed request
-> storage-observed exit + MACed prepare token -> same-generation commit
-> signed final-set receipt/response -> distinct-identity quorum
```

### 16.2 Numeric allocation audit

The assigned set is exactly:

```text
0x0001..0x0009
0x0020..0x0025
0x0040..0x0044
0x0050..0x0054
0x0100..0x0102
0x0120..0x0123
0x0180..0x018e
0x0200..0x0201
0x0280..0x0284
0x02a0..0x02a3
```

That is `9 + 6 + 5 + 5 + 3 + 4 + 15 + 2 + 5 + 4 = 58` unique IDs.
No assignment is zero, in reserved `0x0060..0x00ff`, or at/above `0x0300`.
Within the owned ranges, all unlisted values remain unassigned and are rejected.
Commands and error values share the namespace with objects deliberately; no
numeric value has more than one meaning. Every standalone object carries
protocol version 1, and every embedded command separately carries command
version 1.

### 16.3 Approved enum, context, transcript, and KDF alignment

| Approved behavior artifact  | Exact registry reproduction                                                                                                          | Audit result |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| Protocol/branch enums       | M3 version `1`; `LOOKUP=0`, `ANNOUNCE=1`                                                                                             | exact        |
| Context enums               | tail ordered `0`, tail finalize `1`, final-exit finalize `2`, payload `3`, terminal control `4`                                      | exact        |
| Framing/replay              | `1200/1146/1101/1100/1073`; datagram window 64                                                                                       | exact        |
| `M3ContextAD`               | `u8 class / u32 version / 16B branch / 16B circuit / u64 generation / u8 direction / u64 counter` = 54 bytes                         | exact        |
| Tail transcript             | 50-byte domain + two-byte length + 238 fixed field bytes = 290; exact approved field order                                           | exact        |
| Tail derivation input       | keyed BLAKE2b under X25519 secret over `u16 label length / label / u32 version / u32 transcript length / transcript`                 | exact        |
| Tail output labels          | four `tail-control/*` plus four index-2 `tail-finalize/*`; keys 32 bytes, nonce prefixes first 16                                    | exact        |
| Final-exit transcript       | 48-byte domain + two-byte length + 237 fixed field bytes = 287; exact approved field order                                           | exact        |
| Approved raw-domain digests | admitted limits, exit-origin policy, tail digest, and payload parameters use raw domains exactly as approved, not the generic helper | exact        |
| Final output labels         | twelve distinct payload/control/finalize forward/reverse key/nonce labels; keys 32 bytes, nonce prefixes first 16                    | exact        |
| Counter semantics           | ordered exact-next; finalize datagrams independent 64-counter replay windows; no shared state                                        | exact        |

The literal approved domain byte lengths are independently checked as 46
(admitted limits), 50 (tail transcript), 48 (final transcript), 49 (tail
digest), and 56 (payload parameters). The canonical KDF/context definitions in
Sections 7–9 contain no added address, guard identity, link ephemeral, or
complete-path input and no omitted approved field.

## 17. Rejection and State-Allocation Principles

All core decoders and state machines apply these rules in order:

1. Check carrier size, canonical header, protocol version, known message ID,
   message-specific auth-suffix size, and exact remaining bytes before parsing
   fields or allocating a variable body.
2. Check scalar ranges, fixed constants, enum/flag masks, collection counts,
   per-element lengths, total object limits, and canonical ordering before
   copying collections.
3. Verify outer AEAD/request binding, then message signature and required
   digest/X25519 proof before caching or allocating persistent state. A direct
   fragmented response is reassembled within its pre-reserved cap before its
   response signature can be verified; it is never exposed before verification.
4. Check expiry, epoch monotonicity, replay/semantic-duplicate state,
   role/capability derivation, branch identity diversity, exact transcript
   equality, and current state/class permission.
5. Allocate link/circuit state only after all checks that do not require that
   state. Any later failure destroys partial state and erases owned secrets.

There is no skip-unknown behavior in M3 v1. Unknown messages, versions, enums,
flags, command IDs, context classes, or reserved-range values are errors rather
than extension points. Malformed authenticated circuit traffic destroys the
affected circuit without a detailed error oracle. Malformed unauthenticated
bootstrap traffic is silently dropped and never receives an amplifying reply.

No message authorizes an arbitrary host, port, DHT node ID, or application
command. Routed authority exists only as an exit-issued, live, branch-bound
`DESTINATION_REF_V1`; commands outside the nine-entry inventory fail closed.

## 18. Review Gate

Before Task 1 implementation begins, this registry must receive:

- independent protocol review of ID allocation, every signature/digest/KDF
  input, fragmentation bounds, context framing, replay behavior, and all size
  arithmetic;
- explicit owner approval;
- a behavior-spec cross-link stating that this registry is normative for bytes
  and the approved design is normative for behavior.

Until those steps are complete, status remains draft, all values are unstable,
and no implementation or publication may claim M3 wire compatibility.
