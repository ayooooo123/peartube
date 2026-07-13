# HyperDHT Private Routes Protocol

## Status and requirements language

This document defines **EXPERIMENTAL** protocol version **0**. Version 0 has no compatibility promise. Implementations and recorded test vectors MAY change incompatibly before independent protocol and cryptographic review.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative requirements.

All constants in this document, including domain labels, cell sizes, field encodings, key schedules, nonce construction, padding, replay-window sizes, timeouts, and limits, are testable prototype parameters, not an audited stable wire format.

## Vocabulary

- **Endpoint identity:** the long-term Ed25519 public key that identifies a source or destination endpoint and authorizes private-route descriptors directly or through delegation.
- **Relay identity:** a relay's long-term Ed25519 public key, bound by signed advertisements to its route-encryption key, deterministic role, capabilities, epoch, and expiry.
- **Safety Route:** the source-selected route segment from the source through its guard and zero or more safety relays.
- **Private Route:** the destination-selected route segment from its public private-entry relay through zero or more private relays to the destination.
- **Compiled route:** the concatenation of one Safety Route and one Private Route, with no direct source-to-destination edge.
- **Guard:** the stable first relay on a source endpoint's Safety Route. It sees the source IP but MUST NOT learn the destination from route plaintext.
- **DHT gateway:** an explicitly capable public node that terminates routed DHT-RPC requests, performs ordinary HyperDHT operations from its own public socket, and returns results through the route.
- **Circuit:** bounded, epoch-scoped forwarding state and cryptographic state for one compiled route.
- **Descriptor:** an authenticated, expiring object that publishes a Private Route's public entry and opaque activation material without destination dial information or a cleartext complete path.
- **Cell:** a fixed-size, padded, hop-authenticated unit carrying control, stream, or datagram data over a circuit.
- **Epoch:** a bounded route lifetime that scopes advertisements, descriptors, delegation, circuit state, identifiers, keys, and replay state. State MUST NOT be reused across epochs.

## Deterministic relay roles

Every implementation MUST derive a relay's role from its relay identity public key as follows:

```text
BLAKE2b-256("hyperdht-private-routes/role/v0" || identityPublicKey)[0] & 1
```

The result `0` is the safety role and `1` is the private role. Concatenation uses the literal UTF-8 domain label followed by the raw identity public-key bytes. Advertisements cannot select or override a role. Route construction MUST recompute it and reject mismatches. A relay identity MUST NOT occupy both segments of one compiled route.

This identity separation does not prevent an operator from creating multiple identities across roles; those identities count as collusion/Sybil behavior.

## Descriptor authorization

A descriptor MUST be authorized by either:

1. a direct Ed25519 signature made by the endpoint identity key; or
2. an endpoint-signed delegation certificate naming the descriptor's route-signing key.

A delegation certificate MUST bind the private-routing protocol and version, endpoint identity, delegated route-signing public key, permitted epoch range, permitted descriptor capabilities, and a short expiry. It MUST NOT authorize DHT or application signatures. A delegated descriptor MUST fit entirely within the delegation's epoch, capability, and expiry scope.

The descriptor signature MUST bind its authorization, requested endpoint identity, route-signing key, ephemeral destination route-encryption key, public entry relay identity, epoch, expiry, capabilities, cell parameters, and encrypted nested route material. Retrieving a descriptor under a rendezvous key or merely naming an endpoint identity is not authorization and MUST NOT make any descriptor field directly dialable.

Implementations MUST validate field bounds, version and capabilities, time and epoch, requested endpoint binding, deterministic private role of the entry relay, authorization chain, and descriptor signature before using a descriptor. A descriptor MUST NOT contain the destination IP, destination direct dial information, or an unencrypted complete relay list.

## Circuit establishment and lifecycle

Circuit setup is authenticated independently of the later end-to-end Hyperswarm Noise handshake. It has two distinct transcript scopes:

1. An adjacency-local `LinkCreate`/`LinkCreated` exchange uses fresh X25519 key agreement to derive transcript-bound, direction-specific link keys. Its authenticated transcript MUST bind only that adjacency's two relay or endpoint identities, adjacency-local incoming and outgoing identifiers, epoch, protocol version, cell-class parameters, and link transcript. It MUST NOT claim to authenticate either complete route segment or reveal identities beyond that adjacency.
2. End-to-end `CREATE`/`CREATED` activation authenticates the compiled circuit between the source and destination. Its transcript MUST bind hashes of the Safety Route segment transcript, Private Route segment transcript, verified descriptor, requested endpoint identity, route epoch, and negotiated circuit parameters. Segment hashes commit to the route construction without disclosing hidden relay identities or the complete path to either endpoint or any individual relay. `CREATED` MUST confirm the same activation transcript before the source opens the circuit.

The circuit state machine is:

```text
CREATE -> CREATED -> OPEN -> DRAINING -> DESTROYED
```

- **CREATE:** setup is incomplete. Only bounded setup control cells are allowed. Application data MUST be rejected.
- **CREATED:** the destination has authenticated the complete activation transcript and returned confirmation. The source MUST verify it before transition to `OPEN`.
- **OPEN:** authenticated control, stream, and datagram cells are allowed subject to capabilities, counters, replay rules, quotas, and expiry.
- **DRAINING:** no new streams or datagram flows may start. Existing allowed work MAY complete within a bounded drain deadline.
- **DESTROYED:** no traffic is accepted or forwarded. All forwarding bindings, queues, replay state, counters, and route secrets have been removed.

`RoutePayloadCodec` is a post-authentication primitive. It accepts only a one-use, internally branded context minted after the `CREATED` transcript has been authenticated. The context is bound to its endpoint role: the source may seal only forward traffic and open only reverse traffic, while the destination may seal only reverse traffic and open only forward traffic. The mint is deliberately absent from the package entry point. Task 11's verified `CREATED` handler is the sole planned production issuer; direct construction from raw route keys is internal and unsupported.

Each direction has cryptographically disjoint STREAM and DATAGRAM counter namespaces under its route key and nonce prefix. Each class uses an independent logical unsigned 63-bit counter. The authenticated 64-bit wire counter is `logical << 1` for STREAM and `(logical << 1) | 1` for DATAGRAM. After AEAD authentication, the receiver MUST reject a body class whose namespace bit does not match, then pass only `wire >> 1` to that class's replay receiver. Dropped or reordered DATAGRAM frames therefore cannot create a STREAM ordering gap. A process-local, bounded, fail-closed nonce-domain registry claims the outbound `(key, noncePrefix)` by a fixed-size digest before codec construction; unused pending claims may be disposed, while activated claims remain spent after teardown so a fresh sender can never restart the same nonce domain at zero.

Implementations MUST NOT skip or reverse transitions. Any failed confirmation, invalid transition, authentication failure, transport close, setup timeout, circuit timeout, expiry, quota failure requiring teardown, or counter exhaustion MUST fail closed. Teardown MUST send an authenticated close when the adjacent transport remains available, remove both forward and reverse bindings, erase route keys and intermediate secrets, and enter `DESTROYED`. Timeout and expiry decisions MUST be locally enforced even if an authenticated close cannot be delivered.

Failure, including exhausted route candidates, MUST NOT enable direct endpoint dialing, an ordinary public endpoint DHT socket, or hole punching.

## Counters and replay protection

Every installed hop MUST maintain independent forward and reverse keys, counters, and replay state. Counters and replay state are scoped to one circuit, direction, key, and epoch and MUST NOT survive key rotation or circuit destruction. Authentication MUST be checked before a received counter can update replay state.

### Ordered control and stream cells

Control and stream classes use strictly ordered, unsigned 64-bit monotonic counters. The first accepted counter is the direction's configured initial counter. Each subsequent cell MUST have exactly the next counter value. Duplicates, gaps, regressions, reordered cells, and exhausted or wrapped counters MUST be rejected. Counter exhaustion MUST close the circuit through authenticated teardown and key erasure; counters MUST never wrap or reuse a nonce.

### Unordered datagram cells

Datagram cells use an unsigned 64-bit counter and a bounded sliding replay window for each direction. An authenticated counter newer than the current maximum advances the window. An authenticated counter within the window is accepted only if its bit has not already been marked. Duplicate counters and counters older than the window are rejected. Reordering within the current window is allowed. Counter exhaustion MUST close the circuit through authenticated teardown and key erasure. Window size is a negotiated, bounded prototype parameter and MUST be authenticated in the setup transcript.

## Prototype cryptographic suite

Version 0 uses the following prototype suite:

- Ed25519 for endpoint, delegation, descriptor, relay-advertisement, and control signatures;
- X25519 for fresh circuit and adjacent-hop key agreement;
- keyed BLAKE2b-256 with explicit domain-separated transcript and KDF labels for forward and reverse keys and nonce material;
- XChaCha20-Poly1305 for hop-authenticated encrypted cells.

Signatures and KDF inputs MUST use unambiguous length-delimited encodings and versioned domain labels. Each cell nonce MUST be unique for its direction key and derived from authenticated, direction-specific nonce material plus its counter; callers MUST NOT supply arbitrary full nonces. Cell headers and negotiated routing parameters MUST be authenticated. Secret material MUST be erased on close, timeout, expiry, exhaustion, setup failure, transport loss, and destruction.

This suite and its constants exist to make Milestone 0 executable and testable. They have not been externally audited and do not define a stable wire format.
