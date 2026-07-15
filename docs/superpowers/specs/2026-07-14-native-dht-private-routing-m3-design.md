# Native DHT Private Routing — Milestone 3 Design

**Status:** Independently reviewed and owner-approved, including Task 0 amendments
**Date:** 2026-07-14  
**Parent design:** `2026-07-12-holepunch-private-routing-design.md`  
**First consumer:** PearTube  
**Protocol package:** `hyperdht-private-routes`

**Byte registry:**
[`2026-07-14-native-dht-private-routing-m3-wire-registry.md`](./2026-07-14-native-dht-private-routing-m3-wire-registry.md)

The original pre-Task-0 behavior baseline and the Task 0 amendments were
independently reviewed. The owner explicitly approved the amended design and
linked registry on 2026-07-15 against registry commit
`b43e0ecb1aafa48f24d64d64dbe5dd735bb743a7`. This design is normative for
behavior and the registry is normative for bytes. Any conflict between the two
documents blocks implementation and requires a reviewed amendment to both; an
implementer must not choose a convenient interpretation locally.

## Summary

Milestone 3 integrates the verified private-route transport with DHT-RPC and HyperDHT. It replaces the earlier application-level gateway idea with a permissionless, protocol-native relay capability. Persistent DHT nodes may opt into circuit forwarding, typed DHT egress, private-record storage, or any combination. Clients discover those capabilities through ordinary DHT participation and build fixed three-relay circuits without consulting a trusted registry.

The client continues to run the iterative DHT algorithm. An exit executes only one bounded, typed RPC against one live provenance-qualified destination handle at a time and returns the ordinary response through the circuit. It never becomes a trusted query engine or an unrestricted UDP proxy.

M3 proves private DHT discovery and record access. It does not yet claim that a Hyperswarm Noise connection or Hypercore replication runs over the route; that is the M4 gate.

After explicit owner approval, this amended document is normative for M3 where it conflicts with the parent design. It is intended to supersede the parent's M3 gateway-completed query model, signed bootstrap-seed requirement, M3 server-signaling scope, and assumption that the full Hyperswarm interface subset lands in M3. The parent design remains normative for the M4 destination-selected Private Route and end-to-end Noise goals.

## Relationship to M2

M2 provides the cryptographic and transport substrate:

- fixed 1,200-byte padded, hop-authenticated cells;
- independent forward and reverse keys, counters, and replay state;
- bounded UDX queues and hop-by-hop backpressure;
- authenticated route creation, activation, confirmation, and destruction;
- autonomous teardown and secret erasure;
- a real seven-process UDX topology with a Linux network-namespace packet oracle;
- Node and Bare compatibility.

M3 reuses those primitives but extends their orchestration. M2's seven-role coordinator graph is a test profile, not a production path builder. M3 adds a dynamic short-route profile, production bilateral link authorization, a terminating exit endpoint, and mobile liveness policy. It reuses the M2 cell codec, link key schedule, counters, replay handling, relay forwarding, activation phases, backpressure, and teardown states rather than creating parallel cryptographic machinery.

## Goals

- Make private routing a native, optional DHT-RPC and HyperDHT capability.
- Hide a private client's network address from DHT exits, DHT storage nodes, lookup results, announced records, and other endpoints.
- Preserve client-controlled Kademlia traversal, query fanout, signatures, validation, and retry behavior.
- Discover volunteer relays without a privileged registry or project-operated gateway class.
- Keep lookup and announce metadata at different exits by default.
- Remain usable on mobile through bounded state, active-time leases, make-before-break rotation, and no continuous cover traffic.
- Fail closed: private mode must never silently emit direct DHT traffic.
- Preserve legacy DHT-RPC and HyperDHT behavior when private routing is disabled.
- Structure changes as focused, upstream-compatible package and fork changes.

## Non-Goals

- Establishing routed Hyperswarm or Hypercore connections; that is M4.
- Hiding the client IP from its first-hop guard or the bounded bootstrap contacts needed to find that guard.
- Hiding lookup or announce keys from the DHT exit or private-record storage nodes.
- Defending against a global passive observer or a colluding guard and exit.
- Fully permissionless Sybil resistance, relay incentives, payments, or abuse adjudication.
- Constant-rate cover traffic on mobile.
- Relaying arbitrary UDP, TCP, HTTP, or application traffic.
- Making existing HyperDHT nodes understand new private records without a compatible protocol implementation.

## Privacy Claim and Threat Model

M3 provides **network-location privacy, not query privacy**.

### Protected properties

- A DHT exit and a private-record storage node observe the exit's address, never the client's address.
- A non-colluding guard sees the client address and the next relay, but not the DHT command, topic, destination node, record, or response.
- A non-colluding middle sees only its adjacent guard and exit.
- A non-colluding exit sees the DHT operation and contacted DHT node, but not the client address.
- Lookup results and private announcements contain no client dial address.
- Record and announcement signatures remain endpoint-generated and end-to-end verifiable.
- Relay failure, route exhaustion, unsupported commands, and network changes cannot trigger direct fallback.

### Explicitly visible

- The first-hop guard sees the client IP and can link circuits sharing that guard.
- A bounded number of initial bootstrap contacts can see the client IP before a guard is pinned.
- The exit sees lookup and announce keys, timing, contacted DHT nodes, and approximate volume for its branch.
- Private-record storage nodes see record keys, signed storage envelopes, and complete descriptor bytes; they do not see the client address and are not asked to interpret descriptor bytes.
- Adjacent relays see timing, packet counts, and volume despite fixed cell sizes.

### Out of scope

- A guard and exit correlating timing or colluding directly.
- One operator controlling several identities in different path positions.
- A global passive observer.
- Host compromise, malicious endpoint code, or application-level identity correlation.
- Preventing a malicious exit from dropping traffic. Omission is handled as an availability failure.

## Architecture

```text
HyperDHT API: privateRouting.mode = 'required'
                         │
        HyperDHT private record codecs and signatures
                         │
     DHT-RPC client-side iterative query and transport hooks
                         │
  lookup circuit                         announce circuit
       │                                       │
       └────────────── shared guard ───────────┘
                   │                   │
             lookup middle       announce middle
                   │                   │
              lookup exit         announce exit
                   │                   │
              validated public/private-capable DHT nodes
                         │
              UDX and the existing public network
```

The private-route layer is above UDX and below DHT-RPC. UDX remains unaware of DHT identities, path selection, privacy policy, and routed commands.

## Advertised Capabilities

Private routing is opt-in. A persistent node may advertise these service
capabilities without storage implying exit or relay:

- `CIRCUIT_RELAY_V1`: forward bounded opaque route cells;
- `DHT_EXIT_V1`: execute typed single-node DHT-RPC operations;
- `PRIVATE_RECORDS_V1`: store and return private presence records;
- supported wire versions, command policies, cell parameters, and coarse capacity classes.

`PRIVATE_RECORDS_V1` may be advertised alone by a storage-only node.
`DHT_EXIT_V1` requires `CIRCUIT_RELAY_V1` because an exit must terminate an M2
route, but it does not require `PRIVATE_RECORDS_V1`.

A short-lived advertisement contains the relay identity, current DHT node ID and reachable address, an epoch-scoped route-encryption key, capabilities, protocol limits, epoch, and expiry. It is signed by the relay identity already used by the M2 protocol. M3 v1 advertisements use IPv4 because existing DHT-RPC peer IDs are derived from its exact six-byte IPv4/port codec; the advertised ID must equal that derivation. Same-epoch advertisements must be byte-identical, while any policy change requires a higher epoch and fresh route-encryption key. Route construction includes an active challenge that proves current possession of the advertised identity and route-encryption key at the observed endpoint. Replayed, equivocating, or expired advertisements cannot establish a circuit.

Capacity values are hints, not promises. A dishonest advertisement can cause only selection and availability failure; it cannot expand the client's permitted command surface or disable local bounds.

### Identity domains

M3 keeps two identities distinct:

- **Relay/storage identity:** a long-term Ed25519 public key used to sign advertisements, link handshakes, private-storage receipts, and capability state. For a node participating in an M2 route, its domain-separated hash determines `ROLE.SAFETY` or `ROLE.PRIVATE` eligibility. A storage-only `PRIVATE_RECORDS_V1` node has this signing identity but no M2 route-role requirement.
- **DHT node ID:** the existing DHT-RPC identifier derived from the node's network address. It is routing metadata, not a signing identity and not proof that an address is safe to contact.

M3 defines a new versioned capability-advertisement codec and signature domain. It does not reuse M2's forward/datagram/stream capability mask as though that mask already described DHT exit or storage services.

The new wire integer is `M3_PROTOCOL_VERSION = 1`. Branch class `0` is lookup and branch class `1` is announce; all other values are rejected in this version.

## Permissionless Discovery Without a Registry

Relay discovery uses DHT participation rather than a signed operator list:

1. The client contacts a bounded number of ordinary HyperDHT bootstrap candidates. This unavoidable bootstrap phase is explicitly outside the post-guard IP-exposure guarantee.
2. It sends an initial `CAPS_QUERY_V1`, containing a protocol version, requested capability mask, random XOR target, nonce, maximum result count, and empty return-routability-cookie fields. The responder may return only a smaller stateless cookie challenge. The client echoes that endpoint-bound cookie before the responder may return its own signed advertisement and a bounded list of verbatim candidate-signed advertisements. This prevents an unauthenticated small query from reflecting a fragmented bulk response. A referrer cannot forge a candidate advertisement.
3. The client pins a reachable `ROLE.SAFETY` guard as soon as one passes signature, expiry, capability, and a direct active challenge bound to the still-live CAPS return-routability cookie/query tuple. Invalid direct challenges receive no response or expensive cryptographic work.
4. After guard pinning, the client invokes `RELAY_DISCOVER_V1` over its source↔guard tail-control context. The guard performs ordinary random-target DHT walks using its public DHT participation and returns bounded candidate-signed advertisements. These targets are random discovery probes, not application topics.
5. The client selects a `ROLE.SAFETY` middle and asks the guard to extend through that tail-control context. The guard contacts the selected address with its signed `LINK_OFFER_V1`; LINK_ACCEPT and the tail transcript replace direct active challenge for middle/exit candidates and prove advertisement identity/route-key possession through the authenticated adjacency. The client never probes it directly.
6. Once the client→guard→middle route and a fresh source↔middle tail-control context exist, the client invokes the same bounded discovery service at the middle to obtain `ROLE.PRIVATE` exit candidates. The exit offer travels inside that context, so the guard forwards fixed-size opaque cells and does not learn the selected exit. Exit validation and link extension run through the partial route.
7. If the client cannot find enough compatible and diverse nodes, `required` mode remains unavailable. It never downgrades to direct DHT traffic.

`CAPS_QUERY_V1` responses contain at most eight advertisements, have an exact encoded-size limit, and are never accepted without each candidate's own signature and later active validation. Cold start has one global `MAX_DIRECT_GUARD_CHALLENGES = 3` budget across compatible-bootstrap self-advertisements, compatible-bootstrap referrals, and legacy referrals. The client may rank eight returned advertisements but actively challenges at most three addresses in total before failing closed. Referrals are availability hints: a malicious bootstrap, guard, or middle may bias or censor them but cannot make the client dial a middle or exit outside the partially constructed route.

### Cold start

`BootstrapIO` alone owns cold-start direct discovery and the first index-zero
guard challenge/link. It is not retained as post-readiness revalidation
authority.

The preferred cold start contacts at most three configured bootstrap candidates sequentially and has at least one that supports `CAPS_QUERY_V1`, either as a guard or as a source of signed guard advertisements. This is a deployment availability assumption, not a trusted registry.

When all configured bootstrap nodes are legacy nodes, the client may perform one strictly bounded direct discovery walk: one non-iterative, single-node legacy `FIND_NODE` request to one configured bootstrap followed by at most three sequential direct capability probes to nodes returned by that response. It must not invoke DHT-RPC's normal iterative query engine. Every contacted address is recorded in the privacy-readiness report because it saw the client IP. Discovery stops immediately when a guard is pinned. If no guard is found within the bound, private readiness fails closed. Applications may disable this legacy cold-start walk and require a compatible configured bootstrap.

The temporary bootstrap/discovery socket is destroyed before private readiness. No prospective middle, exit, storage node, or ordinary application DHT target is ever probed directly by the client.

Implementations may cache signed advertisements until expiry, but route state, observed reachability, failure scores, and capacity observations are local. There is no global reputation authority.

## Selection and Diversity

Selection prefers, without treating any signal as proof of trust:

- observed routing-table persistence and uptime;
- distinct relay identities;
- distant XOR buckets;
- distinct IPv4 prefixes or IPv6 allocation prefixes where known;
- different observed network paths where the runtime exposes that information;
- low recent failure and overload rates;
- compatible versions and adequate advertised limits.

Lookup and announce must use the same guard identity and endpoint at index zero while the guard lease is active. That is the sole overlap exception. The two middles and two exits are pairwise distinct, none equals the guard, and no branch contains a repeated identity or route loop. Existing M2 privacy-domain and dial-authority rules remain mandatory.

These heuristics raise the cost of simple Sybil placement but do not solve Sybil resistance. Documentation and UI must not imply otherwise.

## Circuit Topology and Lifecycle

M3 uses two fixed three-relay branches:

```text
                  ┌─> lookup middle ─> lookup exit
client ─> guard ──┤
                  └─> announce middle ─> announce exit
```

### Exact M2 role mapping

Each branch is a dynamic short-route profile:

```text
M3 client       = M2 source endpoint
M3 guard        = M2 safety guard, must derive as ROLE.SAFETY
M3 middle       = M2 safety final, must derive as ROLE.SAFETY
M3 DHT exit     = new terminating service endpoint, must derive as ROLE.PRIVATE
```

The exit is both the final adjacent route participant and the owner of the end-to-end route payload codec. It is not modeled as an M2 private entry followed by an imaginary destination. M3 therefore extends activation with a `DHT_EXIT_V1` terminal confirmation that binds only exit-visible state: the immutable M3-v1 exit-origin command policy, branch class, branch and circuit IDs, branch generation, exit advertisement digest, current tail-control transcript, fresh client nonce, and negotiated M2 key/cell parameters. The client validates earlier path construction locally; no complete-path transcript or commitment is disclosed to the exit.

The following M2 state remains unchanged: cell sealing/opening, link key derivation, direction-specific counters, replay windows, relay forwarding records, bounded queues, `START→PREPARED→ACTIVATE→READY`, authenticated destroy, expiry, and secret erasure. M3 extends path compilation, terminal activation, link admission, configurable liveness, and concurrent generation ownership.

### Production bilateral link authorization

M2's coordinator-signed topology grants remain test scaffolding and are not accepted by production M3 route construction. Every adjacent M3 link uses a bilateral handshake:

1. Before creating an index-zero offer, the client verifies the live cookie-bound direct active challenge for the exact guard advertisement and endpoint. Cold start uses `BootstrapIO`. After private readiness, branch rotation, rebuild, and resume use the narrow `GuardRevalidationIO` defined below for the already pinned guard only. The owning IO internally issues a one-time local guard-admission capability bound to that advertisement, endpoint, client circuit identity, branch, circuit, generation, and challenge expiry, then consumes it itself when emitting `LINK_OFFER_V1`. No capability or offer-sending authority is returned to an outside caller.
2. The owning IO sends the signed `LINK_OFFER_V1`, binding the responder advertisement digest, both claimed roles, branch class, branch and circuit identifiers, generation, ephemeral link key, protocol parameters, and a short deadline. A client signs with a fresh circuit identity; a relay signs with its advertised relay identity.
3. The responder verifies role derivation, its advertisement and expiry, protocol compatibility, loop/identity rules, and capacity. It does not receive or verify the client's challenge state or guard-admission capability. Indices one and two use the signed adjacency offer and tail proof instead of direct challenge.
4. The responder returns `LINK_ACCEPT_V1`, signed by its relay identity, binding the complete offer transcript, observed predecessor endpoint, its ephemeral link key, admitted limits, and expiry.
5. Both sides derive the existing M2 directional link contexts from the mutually authenticated transcript. Failure or timeout installs no forwarding state.

For the first link, the fresh client circuit identity is the initiator. For later links, the current tail relay is the initiator after receiving an authenticated extension request in the tail-control context defined below. The client accepts the extension only after receiving an `EXTENDED_V1` confirmation binding the selected advertisement and a redacted responder proof. Address-bearing `LINK_ACCEPT_V1` fields remain link-local between adjacent nodes and are never forwarded to a later tail. This authorizes only one adjacent link and reveals no complete path. A relay advertisement is an invitation to request bounded service, not a pre-issued topology grant.

### Incremental tail-control context

Every accepted extension establishes a temporary end-to-end control context between the client and the current tail:

1. The first direct client→guard link runs this derivation as extension index `0`; middle and exit use indices `1` and `2`. Indices cannot be skipped or reused within a generation.
2. The client creates a fresh X25519 keypair and 32-byte nonce for that extension. The extension carries the **client tail ephemeral public key**.
3. The signed candidate advertisement carries the tail's epoch-scoped **advertised route-encryption public key**. The tail retains the corresponding route-encryption secret key.
4. Client and tail compute the same 32-byte X25519 shared secret from exactly those inputs: client tail ephemeral secret × advertised route-encryption public, or advertised route-encryption secret × client tail ephemeral public.
5. They encode the fixed-order, length-delimited `TAIL_CONTROL_TRANSCRIPT_V1` below and pass the shared secret and transcript to the M3 tail-control derivation.
6. The tail returns `TAIL_READY_V1`, authenticated under the new reverse key and separately signed by the advertised tail identity. It contains no predecessor address and no earlier route identity or transcript digest.
7. The client sends fixed-size tail-control cells through the installed route. Intermediate relays forward them using M2 circuit bindings but cannot open the tail-control payload.

`TAIL_CONTROL_TRANSCRIPT_V1` has this canonical field order and exact types:

```text
u32  M3 protocol version
u8   branch class
16B  branch ID
16B  circuit ID
u64  branch generation
u8   extension index (0 guard, 1 middle, 2 exit)
32B  client tail ephemeral public key
32B  advertised tail route-encryption public key
32B  candidate advertisement digest
32B  client nonce
32B  tail Ed25519 identity
32B  canonical admitted-limits digest
```

The transcript encoding is `u16be domainByteLength || UTF8(domain) || fields`, where `domain` is `hyperdht-private-routes/tail-control/transcript/v1` and `fields` are the fixed-width values above. The admitted-limits digest is `cryptoSuite.hash([domain, encoding])`, where `domain` is `hyperdht-private-routes/tail-control/limits/v1` and `encoding` is `u16 cellSize || u32 maxCells || u32 maxBytes || u32 maxCommands || u32 idleTimeoutMs || u64 expiresAtMs`. Integers are unsigned big-endian. No field is optional.

M3 extends `cryptoSuite.deriveKeys`; it does not introduce generic HKDF. For each output it computes keyed BLAKE2b with the 32-byte X25519 shared secret as key over `u16 labelLength || label || u32 M3ProtocolVersion || u32 transcriptLength || transcript`, the same construction used by M2. The four new labels are:

```text
hyperdht-private-routes/kdf/v1/tail-control/forward-key
hyperdht-private-routes/kdf/v1/tail-control/reverse-key
hyperdht-private-routes/kdf/v1/tail-control/forward-nonce
hyperdht-private-routes/kdf/v1/tail-control/reverse-nonce
```

Forward and reverse keys are the full 32-byte outputs. Forward and reverse XChaCha20 nonce prefixes are the first 16 bytes of their respective 32-byte nonce outputs, matching M2 counter-based nonce construction. The adjacency-local ephemeral keys from `LINK_OFFER_V1`/`LINK_ACCEPT_V1` are not tail-control inputs and do not appear in the redacted proof.

Each tail-control direction has its own monotonic counter, exact-next replay rule, deadline, and byte/command budget. Its expiry is the earliest of the advertisement, branch, circuit, or admitted-link expiry. Authentication failure, counter failure, timeout, extension failure, or route teardown erases both directions and all partially derived secrets. When a new tail confirms, the previous tail-control context is destroyed; it cannot authorize later extensions.

For extension index `2` only, the same shared secret and `TAIL_CONTROL_TRANSCRIPT_V1` also derive a separate pre-open finalization datagram context under four additional labels:

```text
hyperdht-private-routes/kdf/v1/tail-finalize/forward-key
hyperdht-private-routes/kdf/v1/tail-finalize/reverse-key
hyperdht-private-routes/kdf/v1/tail-finalize/forward-nonce
hyperdht-private-routes/kdf/v1/tail-finalize/reverse-nonce
```

These outputs have the same 32-byte key and 16-byte nonce-prefix rules but use independent forward/reverse M2 datagram replay-window counters starting at zero with window size 64. They carry only `DHT_EXIT_ACTIVATE_V1` and `DHT_EXIT_READY_V1`. Gaps and reordering within the window are accepted; a repeated or too-old counter is authenticated and discarded without advancing semantic state or tearing down the circuit. The ordered tail-control keys never carry a retransmitted finalization message.

### Final exit key handoff

After extension index `2` produces a source↔exit tail-control context, the client sends `DHT_EXIT_ACTIVATE_V1` through the tail-finalize forward datagram context. It contains a fresh 32-byte activation nonce, the M3-v1 exit-origin command-policy digest, and the M2 payload-parameters digest. The signed exit advertisement must authorize `DHT_EXIT_V1`, but its provider-service entry set may contain four or nine entries. Both peers independently compute the exit-origin digest from the immutable nine-command M3-v1 protocol constant, verify exact equality plus the negotiated payload limits, and bind that value in signed `DHT_EXIT_READY_V1` through the tail-finalize reverse datagram context.

Both sides retain the index-2 X25519 shared secret and encode `FINAL_EXIT_TRANSCRIPT_V1` as `u16be domainByteLength || UTF8(domain) || fields`, with domain `hyperdht-private-routes/final-exit/transcript/v1` and these fixed-order fields:

```text
u32  M3 protocol version
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

The tail transcript digest is `cryptoSuite.hash([UTF8('hyperdht-private-routes/final-exit/tail-digest/v1'), completeEncodedTailTranscript])`. The exit-origin command-policy digest equals `cryptoSuite.hash([domain, encoding])`, retaining domain `hyperdht-private-routes/final-exit/service-policy/v1`. Its encoding is exactly `u16 entryCount`, with `entryCount = 9`, followed by all nine immutable M3-v1 command tuples sorted by `(commandId, commandVersion)`. Each tuple is `u16 commandId || u16 commandVersion || u32 maxRequestBytes || u32 maxResponseBytes || u32 timeoutMs || u16 maxOutstanding || u32 requestCost || u32 responseCost || u32 maxAmplificationBytes || u8 mutationFlag || u8 destinationValidationClass`. `mutationFlag` is exactly `0 = READ_ONLY` or `1 = MUTATING`. `destinationValidationClass` is exactly `0 = EXIT_LOCAL`, `1 = DHT_NODE_HANDLE`, or `2 = SIGNED_CAPABILITY_HANDLE`. Duplicate, missing, unsorted, unknown, or locally altered entries are invalid.

M3 performs no exit-origin policy subset negotiation. This exact nine-entry encoding and digest are immutable constants of M3 protocol version 1, compiled into the client and exit; an operator and a four-entry provider advertisement cannot choose different budgets. A future command or budget change requires a new protocol version. The advertisement's signed provider-service entries independently describe which services that node accepts: zero, the four legacy services, the five private-record services, or all nine according to its capability bits.

The payload-parameters digest is `cryptoSuite.hash([domain, encoding])`, where domain is `hyperdht-private-routes/final-exit/payload-parameters/v1` and encoding is `u16 cellSize || u16 maxCellPayload || u16 contextEnvelopeSize || u16 routeFrameSize || u16 maxRoutePayload || u16 datagramReplayWindow || u32 maxQueuedBytes || u32 idleTimeoutMs`. M3 fixes the inherited values to `cellSize = 1200`, `maxCellPayload = 1146`, `contextEnvelopeSize = 1101`, `routeFrameSize = 1100`, and `maxRoutePayload = 1073`; a mismatch fails activation rather than negotiating alternate framing.

Using the same keyed-BLAKE2b construction defined above, with the retained index-2 X25519 shared secret and `FINAL_EXIT_TRANSCRIPT_V1`, M3 derives twelve outputs under these labels:

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

Each key is the full 32-byte output; each XChaCha20 nonce prefix is the first 16 bytes of its nonce output. Payload and terminal-control directions each start independent counters at zero and use the M2 exact-next/replay rules. The four payload values are installed into the existing M2 `RoutePayloadCodec`; the four control values protect post-ready exit control, rotation, and destroy messages. The four final-exit/finalize values use independent forward/reverse M2 datagram replay-window counters starting at zero with window size 64 and carry only READY_ACK and OPEN.

### On-wire context selection

Every source↔tail or source↔exit frame uses a fixed 1,101-byte M3 context envelope inside the existing 1,200-byte routed cell:

```text
u8     contextClass
1100B  context-specific encrypted frame
```

Context classes are exact:

```text
0 = TAIL_CONTROL_ORDERED
1 = TAIL_FINALIZE_DATAGRAM
2 = FINAL_EXIT_FINALIZE_DATAGRAM
3 = ROUTE_PAYLOAD
4 = TERMINAL_CONTROL_ORDERED
```

The class byte is public to forwarding relays but reveals only setup/control/payload phase. Every M3 context uses exactly this 54-byte AEAD associated data and no other bytes:

```text
M3ContextAD =
  u8 contextClass ||
  u32be M3ProtocolVersion ||
  16B branchId ||
  16B circuitId ||
  u64be generation ||
  u8 direction ||
  u64be innerCounter
```

`M3ContextAD` replaces, rather than prefixes, M2 `RoutePayloadCodec` associated data for every M3 context envelope. There is no M2 descriptor ID in M3 associated data and no duplicated circuit, direction, or counter field. `innerCounter` is the unsigned big-endian 8-byte clear counter at offset `0` of the 1,100-byte inner frame and is exactly the counter supplied to nonce construction and the selected ordered or replay-window validator. A mismatch is impossible to reinterpret under another context and fails authentication. The 1,100-byte inner frame and inherited 1,073-byte maximum route payload remain unchanged. Class substitution therefore fails authentication before semantic decoding.

The receiver selects exactly one key and replay/counter state from the public class and current circuit state; it never trial-opens across keys. Unknown classes, classes not permitted in the current actor/state/direction, wrong-size envelopes, and more than one logical interpretation fail closed. The registry's actor-specific matrix is normative: the client accepts READY only while `ACTIVATING`; while `ACKING` it accepts duplicate READY, OPEN, and the single bounded early-seed quarantine exception; after `OPEN` it accepts the READY/OPEN grace handlers and normal terminal control. The exit accepts ACTIVATE only when tail-ready, duplicate ACTIVATE and ACK while `FINALIZING`, and only ACTIVATE/ACK grace handlers after `OPEN`. A context class never authorizes the peer's message or another setup message carried under the same class.

### Finalization acknowledgement

Finalization is a bounded idempotent state machine:

```text
TAIL_READY → ACTIVATING → FINALIZING → ACKING → OPEN
     └──────────────── any failure/timeout ─────────→ DESTROYED
```

1. The client sends `DHT_EXIT_ACTIVATE_V1` under the tail-finalize forward datagram key and enters `ACTIVATING` while retaining the tail shared secret and keys. Until READY arrives, the client explicitly retransmits the identical semantic ACTIVATE body under a fresh tail-finalize datagram counter on the bounded timer.
2. The exit validates the exact activation tuple, derives all final outputs, enters half-open `FINALIZING`, caches the signed semantic `DHT_EXIT_READY_V1` body, and sends it under a fresh tail-finalize reverse datagram counter. An identical activation nonce and tuple is idempotent and causes the same cached body to be sent under another fresh datagram counter; a conflicting tuple tears down the circuit.
3. The client verifies READY, derives the same final outputs, enters `ACKING`, and sends `DHT_EXIT_READY_ACK_V1` under the final-exit/finalize forward datagram key. ACK binds the READY digest, activation nonce, branch and circuit IDs, and generation. The client retains all tail contexts and sends no DHT payload before `OPEN`.
4. The exit verifies ACK, enters `OPEN`, creates the fresh 32-byte branch handle secret and empty destination table, erases its tail shared secret and ordered tail-control keys, installs the retired receive/send grace state below, and sends `DHT_EXIT_OPEN_V1` first under the final-exit/finalize reverse datagram key. OPEN binds the ACK digest and the same activation tuple. No destination handle or signed seed object exists before this transition.
5. The client verifies OPEN, enters `OPEN`, erases its tail shared secret and ordered tail-control keys, and installs the retired receive grace state below. Only then may it send routed DHT payload.

The activation nonce and message kind identify semantic duplicates across the two dedicated finalization datagram domains. Retransmission uses a fresh datagram counter but the identical cached semantic body. Gaps and reordering are accepted within the 64-counter replay window; repeated counters are discarded, while a new counter carrying the same authenticated semantic tuple triggers only the cached idempotent response. Before ACK, the exit retransmits READY on an identical ACTIVATE or its bounded timer. After ACK, an identical final-key-authenticated ACK makes an already-open exit retransmit OPEN. The client retransmits ACK on duplicate valid READY or its bounded timer. Duplicate semantic messages never derive keys again or advance state twice.

After sending OPEN first, the exit may send the completed seed object on the
independent reverse terminal-control context. No cross-context arrival order is
assumed. While the client remains `ACKING`, it may authenticate and buffer at
most one `DHT_EXIT_SEEDS_V1` object, directly or in at most five core fragments
and 4,337 bytes, but cannot expose, install, use, or treat it as readiness before
valid OPEN. The exact deadlines and fatal rejection rules are normative in the
registry. Finalization failure or absence of OPEN erases this quarantine.

The finalization deadline is five seconds. Each pending semantic message has one initial send plus at most four retries after 250 ms, 500 ms, 1,000 ms, and 2,000 ms, for at most five sends total.

On entering `OPEN`, both sides install a five-second retired-context grace:

- the exit retains the tail-finalize forward receive key/window, final-exit/finalize forward receive key/window, final-exit/finalize reverse send key/counter, activation semantic cache, and cached OPEN;
- the client retains the tail-finalize reverse receive key/window and final-exit/finalize reverse receive key/window as receive-only tombstones;
- an authenticated delayed ACTIVATE at the exit or duplicate ACK causes only cached OPEN retransmission under a fresh final-exit/finalize reverse counter;
- an authenticated delayed READY or OPEN at the client is consumed and discarded without state change;
- grace handlers cannot derive keys, reopen transitions, accept payload, reset circuit lifetime, or advance any state except the retained finalize send counter used to retransmit cached OPEN.

At grace expiry both sides erase all retained finalization keys, windows, counters, and semantic caches. Until expiry, authenticated delayed setup frames are never treated as invalid OPEN-state transitions. Deadline before OPEN, conflicting semantic duplicate, authentication failure, or transport close destroys both tail and final contexts and erases all partial state. Replay-window duplicate/too-old counters and the explicit retired-context handlers are the sole non-fatal setup-counter cases. Lost/duplicate ACTIVATE, READY, ACK, OPEN, and delayed arrival of each after OPEN are mandatory tests.

Fixed vectors must cover the four tail-finalize outputs, all twelve final outputs, nonce prefixes, transcript, enum or policy substitution, and proof that no tail-control, tail-finalize, payload, terminal-control, or final-exit/finalize key/nonce output is equal.

The terminal key schedule binds no client address, guard identity, guard advertisement, address-bearing link transcript, or complete-route digest. The exit already knows its directly observed middle; it learns nothing about earlier relays from terminal confirmation.

### Shared guard meaning

Lookup and announce share a guard **identity and transport endpoint**, not cryptographic circuit state. Each branch has independent circuit IDs, bilateral link acceptances, link keys, counters, replay windows, queues, limits, and teardown. An implementation may multiplex those independently authenticated link contexts over one guard UDX socket. It must not reuse a link context across branches or generations.

Make-before-break creates a complete independent branch generation alongside the draining generation. The guard identity may be reused, but every link acceptance, ephemeral key, counter, handle, and token is fresh.

Reusing that pinned guard after readiness never reopens bootstrap or ordinary
DHT authority. For rotation, rebuild, or resume, `GuardRevalidationIO` may
overlap an existing `RoutedDHTIO` branch while it owns one narrow guard-bound
handshake channel, possibly carried by a shared physical UDX multiplexer. It is
pinned to the exact guard endpoint and can send or receive only the five
CAPS/challenge messages plus `LINK_OFFER_V1` and `LINK_ACCEPT_V1`, along with
transport framing and destroy. Its `CAPS_QUERY_V1.maximumResults` is exactly
one, and it accepts only one unfragmented `CAPS_RESPONSE_V1` containing exactly
the matching pinned-guard self-advertisement, at most 695 wire bytes. Zero,
additional, or referral advertisements and every `CORE_FRAGMENT_V1` are
rejected. It internally issues and consumes the one-time admission capability
when sending OFFER and remains alive through ACCEPT.

On a valid `LINK_ACCEPT_V1`, `GuardRevalidationIO` atomically transfers only
the accepted per-branch guard link context/channel to `RouteManager`, then
erases all cookie, challenge, admission, and handshake authority. If it opened
a dedicated physical guard transport, that accepted transport is transferred
too; on a shared multiplexer, only the temporary handshake channel closes. On
failure or timeout it closes every channel/transport it owns, erases its state,
and leaves the existing branch untouched. The IO is destroyed only after
successful transfer or failure. Guard replacement runs only through a
separately bounded cold-start policy; revalidation failure never becomes
ordinary DHT IO or an unbounded direct probe.

Defaults are prototype policy values, not a stable wire-format promise:

- guard lease: 24 hours of active foreground/backend use;
- branch lease: 15 active minutes with random jitter;
- suspension destroys live branches and pauses only the locally retained guard-identity lease;
- branch rotation is make-before-break;
- the old branch drains bounded in-flight work, then destroys and erases state;
- a network-interface change invalidates reachability and immediately rebuilds branches;
- a branch failure rebuilds through the current guard when possible;
- sustained guard failure selects a replacement without waiting for lease expiry;
- no permanently warm standby is maintained solely for privacy routing.

Sharing the guard limits how many nodes observe the client IP and reduces mobile radio wakeups. Separate middles and exits prevent one exit from automatically joining lookup and announce metadata.

They do not prevent a closest private-record storage node from observing both operations for the same topic through different exits. That is consistent with the explicit network-location-not-query-privacy claim.

## Native DHT-RPC Transport

The DHT-RPC client retains control of iterative traversal. A routed request represents exactly one typed RPC to one DHT node:

```text
request id
command id and version
opaque exit-issued destination handle
bounded encoded command body
deadline
response and command-cost budget
```

This review adds an explicit exit-to-network carrier boundary. Immutable and
mutable operations remain byte-compatible with existing IPv4 DHT-RPC and are
restricted to the registry's proven one-datagram request/response ceiling.
Private-record operations use a separate registered exit-to-storage carrier:
the exit presents its signed advertisement, proves its observed source
endpoint, establishes a fresh ephemeral-to-advertised-static X25519 session,
and receives an authenticated acceptance before either side sends bounded
fragments. Its KDF, directional keys/nonces, replay rules, deadlines, and
reassembly memory are byte-exact in the registry. This carrier is never exposed
to the client and never contains the client's address or dialing authority.
Its KDF transcript contains the two explicitly named Section 2.1 advertisement
digests and is exactly 308 bytes. Global pre-authentication signature work is
bounded independent of spoofed source addresses; exact OPEN replay reuses one
cached ACCEPT without re-derivation/allocation, while conflicting reuse fails
closed. Storage may return only the registry's closed error subset; exit-local
destination/timeout/upstream errors cannot be forged by storage.

Routed amplification is measured over the complete outer reply—fixed wrapper,
token, closer references, and response body—not only application bytes. The
nine exit-origin command-policy tuples are a closed, immutable M3-v1 constant.
The exit and client bind their digest during finalization; arbitrary subsets,
object/error IDs, and locally chosen budgets are invalid. Separately, an
advertisement's signed provider-service entries describe services that node
accepts: four for `DHT_EXIT_V1`, five for `PRIVATE_RECORDS_V1`, and nine for
both. A DHT exit may therefore originate a private-record command through a
separate storage-only provider without itself advertising storage.

Before READY, the exit may discover, actively validate, and cache only bounded
public-DHT and storage candidate evidence. It has no branch handle secret or
destination table yet and cannot mint a `DESTINATION_REF_V1`, assemble a
semantic seed set, or sign `DHT_EXIT_SEEDS_V1`. After it validates ACK and
enters OPEN, it creates the branch handle secret/table, rechecks candidate
provenance, identity, capability, endpoint, and expiry, and mints the required
handles. Only then does it build, sign, and cache the byte-exact semantic seed
object for retransmission.

After entering OPEN and sending OPEN first, every lookup and announce exit sends a signed
`DHT_EXIT_SEEDS_V1` containing one to three public-DHT references and one to
five actively validated `PRIVATE_RECORDS_V1` storage advertisement/reference
pairs. The independent terminal-control context may deliver it before OPEN; the
client then quarantines it under the bounded ACKING exception above. A
zero-storage set is invalid; storage readiness is not an
unauthenticated per-branch feature. The client cannot declare the branch
private-ready until it validates at least one pair. Missing, invalid, or late
storage seeds, or any candidate recheck, handle mint, object build, or signature
failure, destroy the branch, erase its handle secret/table and partial seed
state, and never enable direct or legacy fallback. A partial seed set is never
sent.

The client never authorizes a raw host, port, or caller-computed DHT node ID. Each exit owns a bounded destination table. It mints an unpredictable opaque handle only for a node learned from:

- the exit's configured bootstrap set;
- its current public DHT routing table;
- its bounded locally validated capability cache;
- a protocol-valid DHT response received by that exit from an already admitted handle; or
- recent protocol-valid traffic received by the exit at the claimed endpoint.

A capability-cache entry is admitted only after the exit itself receives a valid signed advertisement, directly contacts the advertised endpoint under a bounded discovery budget, completes its own CAPS return-routability exchange, and completes the cookie-bound active challenge. A client-supplied address or merely self-signed advertisement never causes an exit probe.

A referral learned in a response is not immediately caller-authorized. The exit records its provenance, applies referral and probing budgets, performs the normal DHT reachability exchange, and only then exposes a handle. The handle maps server-side to the exit identity, branch and circuit IDs, branch generation, address, derived address-based DHT node ID, provenance, expiry, and allowed command classes. It cannot be used at another exit, on another branch, after rotation, or for a different command class.

The exit locally excludes itself and its directly observed predecessor. The client compares every returned public address and signed storage identity against all relays in both of its branches, drops matching handles before attaching a topic-bearing command, and asks for another candidate. This client-side rule prevents path disclosure to the exit while ensuring a multi-capability route relay does not also receive the client's topic.

The exit:

1. authenticates and decodes the routed envelope;
2. verifies the command has a locally enabled `privateRoute` policy;
3. validates sizes, deadline, cost, and outstanding-request limits;
4. resolves the opaque handle and confirms it remains live and authorized for the command;
5. executes one RPC through its own DHT-RPC socket;
6. validates and bounds the response;
7. returns the response under the original circuit request ID.

The client then applies the same mapping, available signature checks, token handling, convergence rules, query fanout, and retry behavior used by direct DHT-RPC.

Client-side iteration preserves routing behavior; it does not make unsigned DHT metadata authentic. An exit may omit, delay, fabricate, or bias closer-node lists, legacy peer results, acknowledgements, and absence. Cryptographic authenticity is claimed only for content-addressed immutable values, signature-verified mutable values, endpoint-signed private records, and signed private-storage receipts. No single exit can prove absence. Timeouts, inconsistent verifiable results, and bounded failure scores trigger other handles or branch rotation, but censorship remains possible.

### Token and address binding

Any DHT token bound to a UDP source address is also bound operationally to the active exit. A lookup that acquires a token and the mutation that consumes it must use the same branch generation, exit, and destination handle. Read-only work uses the lookup branch. The prepare/query and commit phases of private announce, private unannounce, mutable put, and immutable put remain pinned to one announce branch generation. Handles and tokens are discarded when that branch rotates; affected work restarts from prepare rather than reusing state from another exit.

### Command policy

DHT-RPC commands opt in with an exact `privateRoute` policy containing:

- request and response codecs;
- maximum encoded sizes;
- timeout and outstanding-request limits;
- request and response cost;
- maximum response amplification;
- whether the operation mutates remote state;
- destination validation requirements.

M3 initially allows internal single-node operations needed for:

- private lookup and private announce;
- private unannounce;
- mutable and immutable get/put;
- internal node and relay discovery.

It rejects legacy peer announce/unannounce, legacy peer lookup/find-peer at the HyperDHT public API, punch, holepunch, direct connect, raw relay, arbitrary UDP destinations, unknown commands, and commands without an explicit policy. Peer discovery and connection commands are reserved for the native private records and M4.

### Required-mode IO boundary

`required` mode separates three IO authorities:

1. `BootstrapIO` exists only during the separately bounded cold-start policy. It owns the temporary direct socket used for permitted bootstrap/guard discovery and the first guard link establishment.
2. Before private readiness, `BootstrapIO` destroys its ordinary DHT socket, clears its public routing state and direct-discovery scratch state, and transfers only the authenticated guard link, the pinned guard identity/endpoint, and signed provenance-tagged advertisements.
3. `GuardRevalidationIO` may exist after readiness only for rotation, rebuild, or resume. It contacts exactly the pinned guard endpoint and owns a narrow guard-bound handshake channel that can encode, send, receive, and decode only `CAPS_QUERY_V1`, `CAPS_COOKIE_CHALLENGE_V1`, `CAPS_RESPONSE_V1`, `ACTIVE_CHALLENGE_V1`, `ACTIVE_CHALLENGE_RESPONSE_V1`, `LINK_OFFER_V1`, and `LINK_ACCEPT_V1`, plus transport framing/destroy. Its CAPS query requests exactly one result, and it accepts only one unfragmented CAPS response containing exactly the pinned guard's matching self-advertisement; zero, additional, or referral advertisements and every core fragment are rejected. It may overlap `RoutedDHTIO` for make-before-break, internally issues and consumes one admission capability at OFFER, and on valid ACCEPT atomically transfers only the accepted branch link channel/context to `RouteManager` before erasing and destroying itself. A dedicated accepted physical transport transfers with the link; a shared physical multiplexer keeps only the accepted link context while the handshake channel closes. Failure closes only its owned channel/transport and leaves the existing branch intact. It has no generic send, DHT query, referral-probe, hostname-resolution, or other-endpoint authority.
4. `RoutedDHTIO` services DHT-RPC exclusively through ready circuit branches and exit-issued handles. It has no method that can send an ordinary client DHT datagram.

In `RoutedDHTIO` mode, DHT-RPC must not bind a background public DHT socket, perform client NAT sampling, consume exit-observed `to` addresses as the client's address, maintain public direct-dial authority, send background pings or down hints, retry via a direct socket, refresh against bootstrap nodes, or resolve/dial newly learned DHT addresses itself. Routed destination metadata lives in a separate handle table and can never be promoted into the client's public routing table.

The guard UDX transport remains intentionally direct: the guard is the one post-bootstrap endpoint permitted to observe the client address. A runtime assertion and packet oracle enforce that the pinned guard is the only client destination after readiness, including during `GuardRevalidationIO`. Failure to revalidate it fails closed or enters the separately bounded cold-start replacement policy; no direct DHT fallback is available.

## Native Private Presence Records

Legacy HyperDHT announce semantics associate the announcing UDP endpoint with the peer. A proxied legacy announce would therefore publish the exit as the peer address. It would not leak the client address, but it would be incorrect and unusable for a private connection.

M3 introduces versioned native operations:

- `PRIVATE_ANNOUNCE` stores a signed endpoint presence record without deriving any address from the packet source;
- `PRIVATE_UNANNOUNCE` stores a signed tombstone;
- `PRIVATE_LOOKUP` returns bounded endpoint-signed presence records for a topic;
- `PRIVATE_FIND_NODE` locates compatible storage identities in a separate deterministic XOR overlay.

A private presence record binds at least:

- protocol version and capability set;
- topic;
- endpoint public key;
- unsigned 64-bit monotonically increasing sequence within `(topic, endpoint public key)`;
- record kind, `LIVE` or `TOMBSTONE`;
- expiry;
- bounded descriptor bytes and descriptor digest for `LIVE`, or an empty descriptor for `TOMBSTONE`;
- endpoint signature over every field.

Storage nodes validate the signature, exact bounds, sequence, expiry, topic binding, and storage quotas. A higher sequence replaces a lower sequence. The same sequence and digest is idempotent; the same sequence with a different digest is rejected. A tombstone must have a higher sequence than the live value it removes. Readers honor it only through its signed `expiresAtMs`; storage may retain it longer through signed receipt `storedUntilMs` solely for rollback suppression and never returns the expired tombstone.

Storage nodes store no source address in the record and return no observed source address to readers. They can see, copy, and correlate complete descriptor bytes. “Opaque” means only that storage nodes do not interpret those bytes; it is not a confidentiality claim. The M4 descriptor itself will expose its public entry advertisement while encrypting only its nested private-hop material.

In M3 the descriptor is deliberately non-dialable and proves only private discovery. In M4 it becomes the signed destination-selected Private Route descriptor defined by the parent design. Merely retrieving a presence record never grants direct-dial authority.

### Compatible storage overlay

Storage routing does not depend on sparse compatible nodes appearing as ordinary closest address-derived DHT IDs. Every `PRIVATE_RECORDS_V1` identity has a stable overlay ID:

```text
storageId = hash('hyperdht/private-record-storage/v1' || Ed25519 storage public key)
recordTarget = hash('hyperdht/private-record-topic/v1' || topic)
```

Compatible storage nodes maintain a bounded routing cache of signed storage advertisements. `PRIVATE_FIND_NODE` returns at most `K` candidate-signed advertisements closest to `recordTarget`. The client performs iterative lookup through its exit, while the exit converts only protocol-observed and actively validated referrals into branch-bound destination handles. Legacy nodes ignore the unknown commands.

Before READY, the exit obtains one to five actively validated storage candidates from its bounded `PRIVATE_RECORDS_V1` capability cache, running its own bounded capability-discovery walk when necessary. This cache is evidence only, not handle or seed-object authority. After ACK opens the branch and creates the handle secret/table, the exit rechecks that evidence and mints the signed seed set under the lifecycle above. It never probes a client-supplied raw address. Zero valid seeds or a zero storage count is invalid and produces `ERR_PRIVATE_RECORDS_UNAVAILABLE`; the client may rotate the exit, but it cannot make the branch private-ready, start `PRIVATE_FIND_NODE`, receive a partial seed set, or fall back to direct or legacy records.

Seed handles are ordinary branch-bound handles: expiry, rotation, path-identity exclusion, and command-class rules apply. The first `PRIVATE_FIND_NODE` response can introduce closer candidate-signed advertisements; the exit admits handles for them only through the provenance and active-validation process above.

Prototype parameters are `K = 5`, parallelism `alpha = 3`, write quorum `W = 3`, and read-response threshold `R = 3`. They are authenticated protocol parameters but remain experimental. Overlay discovery stops only when the closest `K` signed storage identities remain unchanged for one complete `alpha` query round with no closer identity, or when its bounded deadline fails. Writes target that final set and require `W` receipts. Reads query all reachable members of that set and may return the best verified result after at least `R` signed responses or the deadline; the result carries a completeness count. Fewer than `W` reachable compatible nodes makes a write unavailable. Fewer than `R` responses makes a read incomplete. Reaching `R` does not prove that an absent or newer record does not exist, and neither one exit nor one discovered storage set can provide a cryptographic proof of absence.

### Prepare, commit, and receipts

`PRIVATE_ANNOUNCE` and `PRIVATE_UNANNOUNCE` use the announce branch for their complete transaction:

1. The client locates the current `K` closest compatible storage identities.
2. It sends `PRIVATE_PREPARE` to each through announce-branch destination handles.
3. Each storage node returns an opaque short-lived write token bound to its storage identity, the observed exit endpoint, destination handle, topic, endpoint key, proposed sequence and digest, token expiry, branch generation, and command kind.
4. The client sends the endpoint-signed record and token through the same announce branch generation and exit.
5. A successful storage node returns a storage-identity-signed receipt binding record kind, topic, endpoint key, sequence, record digest, accepted expiry, stored-until time, storage identity, and receipt nonce.
6. The operation succeeds only after `W` distinct valid receipts from the selected storage set.

Tokens, handles, and partial unsigned acknowledgements are not success evidence. Rotation or network change between prepare and commit invalidates the transaction and restarts it with a fresh branch. Receipts are replay-detected by operation and nonce; a receipt for another record, sequence, storage identity, or expiry cannot satisfy quorum.

`PRIVATE_LOOKUP` uses the lookup branch. Every storage response is signed by the advertised storage identity and binds the topic, query nonce, response digest, storage identity, and response time. Returned live records and tombstones must also carry valid endpoint signatures. A signed empty response proves only what that storage node returned at that moment. The client merges records by `(topic, endpoint key)`, selecting the highest valid sequence and honoring a same-or-higher tombstone. Two valid endpoint-signed records with the same sequence but different kind or digest are endpoint equivocation: the client returns `ERR_PRIVATE_RECORD_EQUIVOCATION`, quarantines that endpoint/topic result, and selects neither value.

The extension is wire-compatible but requires enough opt-in storage nodes to be available. Insufficient compatible density is an availability failure, not permission to use legacy announce semantics.

## Mobile Liveness and Suspension

M2's sub-second integration-test heartbeat and failure timers are not M3 production defaults. M3 introduces a negotiated mobile liveness profile:

- the predecessor, meaning the participant closer to the client, is the sole heartbeat initiator on every adjacent link;
- after 25 seconds with deterministic per-link jitter bounded to 20–30 seconds, only that initiator sends `HEARTBEAT`; the successor sends exactly one authenticated `HEARTBEAT_ACK` and never starts a competing timer;
- any valid authenticated inbound cell resets the initiator's silence timer, and ordinary authenticated traffic may satisfy liveness without an extra heartbeat;
- three missed heartbeat rounds mark a link failed;
- the successor maintains a receive-only deadline of three maximum heartbeat intervals, exactly 90 seconds, since its last valid authenticated predecessor cell; expiry tears down and erases the link and dependent circuit state without transmitting its own heartbeat;
- a branch is destroyed after 60 seconds without an application-routed operation, required record refresh, or route setup/repair event; liveness heartbeat traffic never resets this idle timer;
- after idle destruction, the client emits zero route cells until new work arrives;
- no more than six heartbeat cells total in both directions may cross each branch's client↔guard link per minute while otherwise idle; the two branches therefore permit at most twelve such cells per minute, and shared-transport batching must limit client radio wakeups to three per minute across both branches;
- guard identity, unexpired signed advertisement, selection history, and the remaining active-use lease may be retained locally without retaining link or circuit secrets.

Destroying idle links does not force immediate relay reselection. If the 15-active-minute branch-selection lease and advertisements remain valid, new work may reselect the same middle and exit, but it still creates a fresh circuit generation and fresh bilateral links.

On suspension the client cancels outstanding operations, destroys both branches, invalidates all destination handles and DHT/storage tokens, erases link and route secrets, and closes temporary IO. Old storage receipts never count toward a new transaction's `W`. A value already stored idempotently may return a fresh receipt only after a new prepare on the new branch. On resume the client may reuse the pinned guard identity, but `GuardRevalidationIO` must revalidate its exact endpoint, current advertisement, and active challenge before issuing the one-time local admission capability. The resumed branch creates fresh bilateral link acceptances, ephemeral keys, circuit IDs, generations, counters, handles, and tokens. Failure follows the separately bounded cold-start replacement policy and never opens ordinary DHT authority.

A network-interface change performs the same invalidation immediately. Mutating operations interrupted after prepare restart from prepare. Previously issued receipts remain historical evidence only and are never combined with a new transaction quorum.

## Traffic Shaping

M3 retains the fixed 1,200-byte M2 cells and random padding. The mobile-balanced default:

- batches independent DHT work within a small bounded latency window;
- adds jitter that is authenticated into no protocol decision;
- may emit a small bounded number of dummy cells around active bursts;
- emits no continuous cover traffic while idle or suspended;
- does not delay route repair, teardown, or deadline-sensitive control traffic.

This hides individual payload sizes but not timing, packet counts, or total volume. Stronger constant-rate or adaptive cover traffic is a later optional policy with explicit battery and data costs.

## Abuse and Resource Control

M3 remains credential-free. It requires no account, payment, proof-of-work, stable client token, or globally linkable admission credential.

Every relay enforces:

- global, per-neighbor, and per-circuit concurrent-state limits;
- fixed circuit lifetime and idle timeout;
- per-circuit byte, cell, command-cost, and outstanding-request budgets;
- bounded per-circuit and global queues inherited from M2;
- fair scheduling across circuits;
- bounded response amplification;
- exact request and response sizes;
- coarse authenticated `BUSY` responses that reveal no fine-grained load oracle;
- authenticated teardown on malformed cells, policy violations, expiry, or unrecoverable overload.

The guard can additionally rate-limit by its directly observed neighbor and endpoint. Middles and exits rate-limit by authenticated adjacent link and circuit, not by a stable end-user identity. A distributed adversary can still consume volunteer capacity; M3 does not claim otherwise.

## Public API

HyperDHT exposes a fail-closed option:

```js
const dht = new HyperDHT({
  privateRouting: {
    mode: "required",
  },
});
```

Initial modes are:

- `off`: compatibility default; existing behavior is unchanged;
- `required`: every supported operation uses a ready private branch or fails with a structured privacy-unavailable error.

There is no `preferred` mode and no transparent direct fallback.

### M3 required-mode method matrix

| HyperDHT surface                                                                                          | M3 behavior in `required` mode                                                      |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `ready`, `destroy`, `suspend`, `resume`                                                                   | Supported with private lifecycle semantics                                          |
| `lookup(topic)`                                                                                           | Maps exclusively to `PRIVATE_LOOKUP`; returns non-dialable private presence records |
| `announce(topic, keyPair, ...)`                                                                           | Maps exclusively to `PRIVATE_ANNOUNCE`; never emits legacy `ANNOUNCE`               |
| `unannounce(topic, keyPair, ...)`                                                                         | Maps exclusively to `PRIVATE_UNANNOUNCE`; never emits legacy `UNANNOUNCE`           |
| `immutableGet`, `mutableGet`                                                                              | Supported through lookup-branch routed RPC                                          |
| `immutablePut`, `mutablePut`                                                                              | Supported through one announce-branch prepare/commit generation                     |
| `findPeer`, `connect`, `createServer`, `pool`, raw stream, peer handshake, punch, holepunch, direct relay | Synchronously reject with stable `ERR_PRIVATE_ROUTING_M4_REQUIRED`                  |
| direct `query` or raw command registration without policy                                                 | Reject with `ERR_PRIVATE_COMMAND_UNSUPPORTED`                                       |

M3 never returns a legacy public peer address as something a required-mode caller may dial. Connection-related surfaces remain closed until M4 provides a private descriptor and routed Noise transport.

Relay service is separate and explicit. Persistent operators may enable individual advertised capabilities and budgets. Node, Bare desktop, and Bare mobile clients do not relay by default.

DHT-RPC exposes the lower-level routed transport and command-policy hooks. HyperDHT owns the ergonomic option, private record formats, endpoint signatures, and branch selection by operation class. M4 will carry the same `required` policy through Hyperswarm connection establishment.

## Errors and Observability

Private-mode errors must be structured and must not invite callers to retry directly. Required categories include:

- privacy unavailable;
- insufficient diverse relays;
- guard unavailable;
- branch rotating or expired;
- unsupported private command;
- private-record quorum unavailable;
- relay busy or quota exceeded;
- routed request timeout;
- protocol authentication failure;
- network changed.

Metrics and logs may include aggregate state transitions, latency, circuit generation, coarse capacity, and error category. They must not log route keys, complete paths, topics, endpoint addresses learned from private material, raw descriptors, or stable cross-route correlation identifiers.

## Cross-Repository Delivery

M3 is delivered as coordinated upstream-shaped changes:

1. `hyperdht-private-routes`
   - M2 circuit protocol and UDX transport;
   - capability advertisements and active validation;
   - route selection, guard/branch lifecycle, relay service, quotas, and traffic shaping.
2. `ayooooo123/dht-rpc`
   - routed transport hooks;
   - typed single-node request envelopes and command policies;
   - capability propagation and private-record command registration;
   - client-side iterative query preservation.
3. `ayooooo123/hyperdht`
   - `privateRouting.mode` API;
   - private lookup/announce record codecs and signatures;
   - operation-to-branch routing;
   - suspend, resume, network-change, and destroy integration.
4. PearTube
   - pins exact tested commits during development;
   - contains no duplicated routing protocol logic;
   - does not expose the product switch until M4 passes.

Defaults remain backward compatible. Each fork change should be organized so it can become a focused upstream pull request after the protocol proves itself.

## Verification and Acceptance Gates

### Unit and property tests

- exact capability-advertisement codecs, signatures, expiry, replay, and active challenge;
- production `LINK_OFFER_V1`/`LINK_ACCEPT_V1`, role mapping, partial-route extension, and terminal-exit confirmation;
- source↔tail key derivation, counters, replay, replacement, expiry, redacted confirmation, and failure erasure, with fixed test vectors for guard index zero, middle replacement, final exit derivation, and cross-index/transcript substitution;
- context-class encoding, associated-data substitution, state-allowed class matrix, and exact 1,101-byte envelope bounds;
- fixed 54-byte `M3ContextAD` byte vectors and one-field substitution tests, including clear-counter/nonce/replay equality;
- final ACTIVATE/READY/ACK/OPEN loss, counter gaps, reordering, repeated counters, semantic duplication, idempotence, retry bounds, policy-enum substitution, half-open timeout, delayed ACTIVATE/READY/OPEN after OPEN, seeds arriving before/after OPEN across independent contexts, early-seed one-object/byte/fragment/deadline caps, post-open grace erasure, and tail-key erasure timing;
- selection invariants for identity, XOR, prefix, branch, and loop diversity;
- compatible bootstrap, legacy-only bounded cold start, malicious referral, and no-direct-candidate-probe behavior;
- guard and branch active-time lease state machines;
- make-before-break, drain, network-change, suspend, resume, and teardown;
- exact command-policy enforcement and unknown-command rejection;
- required-mode IO matrix, temporary bootstrap-socket destruction, guard-only seven-message `GuardRevalidationIO` allowlist, exact-one query/result and unfragmented pinned-self CAPS profile, internal one-time capability consumption, dedicated/shared-channel ACCEPT handoff, failure isolation, disabled NAT sampling/background DHT IO, and stable M4-required errors;
- arbitrary exit destinations, address substitution, stale handles, cross-exit handles, client-side relay-as-destination exclusion, and handle invalidation;
- DHT and storage token/exit/handle binding across rotation;
- private presence record signatures, bounds, expiry, sequence conflicts, tombstone retention, and source-address exclusion;
- compatible-storage zero/stale/successful candidate behavior, no pre-OPEN handle/seed-object creation, post-OPEN recheck/mint/sign failure, partial-seed suppression and erasure, malicious referrals, overlay convergence, partial quorum, prepare/commit rotation, replayed receipts, cross-exit tokens, and insufficient density;
- same-sequence endpoint equivocation and quarantine;
- quotas, response amplification, fairness, backpressure, and `BUSY` behavior;
- mobile liveness cell/wakeup budgets using the client↔guard definition, sole-initiator simultaneous-timer and jitter bounds, predecessor-missing and successor-missing failure directions, heartbeat-excluded idle timing, and zero traffic after idle destruction;
- malicious buffers, codecs, callbacks, clocks, and transport adapters;
- bounded-memory fuzzing for every new envelope and state transition.

### Real integration testnet

CI launches independent processes and real UDX sockets for:

- one private client;
- its shared guard;
- distinct lookup and announce middles;
- distinct lookup and announce exits;
- several public and private-record-capable DHT nodes;
- a second endpoint that announces or looks up complementary records.

The suite proves:

- cold start succeeds with a compatible bootstrap and pins a guard within the configured bound;
- legacy-only bootstrap either discovers a compatible guard within the three-probe bound or reports privacy unavailable without further direct probes;
- malicious guard referrals can censor construction but cannot cause direct middle/exit probing or bypass candidate signatures;
- the guard can identify its selected middle but receives no exit advertisement, exit identity, exit address, or decryptable exit-selection control cell;
- private announce from one endpoint is discoverable through private lookup from another;
- mutable and immutable records round-trip through routed single-node RPCs;
- iterative lookup remains client-controlled across several DHT nodes;
- forged immutable values, mutable values, private records, and storage receipts cannot satisfy their command-specific cryptographic checks;
- fabricated routing metadata, empty results, and dropped or delayed responses remain censorship/availability failures and never become proof of absence;
- arbitrary UDP targets and caller-computed DHT IDs never receive an exit-issued handle;
- a private write succeeds only with `W` distinct valid storage receipts;
- branch failure rotates without direct fallback;
- insufficient private-record density fails closed;
- zero and stale exit storage seeds report private records unavailable, while a locally validated seed converges to the deterministic closest set;
- branch and guard rotations follow the active-time policy;
- rotation, rebuild, and resume revalidate only the exact pinned guard through the seven-message `GuardRevalidationIO` allowlist, request exactly one CAPS result, reject fragmented, empty, additional, or referral-bearing CAPS responses, atomically hand an accepted link to `RouteManager`, and on failure leave the existing branch intact while replacement uses only the bounded cold-start policy;
- suspension destroys live branches and resume uses fresh generations, keys, counters, handles, tokens, and active challenges;
- an interface change cancels outstanding work and invalidates all branch-bound authority;
- Node and Bare produce the same protocol result.

### Authoritative packet oracle

A Linux network-namespace job captures every relevant interface and fails unless:

- before guard pinning, the client contacts only the at-most-three configured bootstrap addresses plus at most three globally budgeted prospective-guard addresses obtained from permitted `CAPS_QUERY_V1` self/referral responses or the one permitted legacy non-iterative single-node `FIND_NODE` response;
- after pinning, the client contacts only its guard;
- the guard contacts only the two selected middles for circuit traffic;
- each middle contacts only its selected exit;
- exits contact only nodes represented by live, provenance-qualified handles using allowlisted operations;
- private-record nodes observe exit addresses and never the client address;
- lookup and announce middles/exits are distinct;
- guard process projections and captures contain the middle endpoint but no selected exit advertisement, identity, or endpoint;
- no endpoint address from private material enters a public routing table or direct probe;
- all processes, sockets, circuits, queues, and owned secret state are gone after teardown.

A separate authority trap intercepts ordinary DHT socket creation and send capability. It proves the temporary `BootstrapIO` socket is destroyed before readiness, no ordinary DHT socket exists afterward, and no such send authority can be invoked. It separately instruments `GuardRevalidationIO` and proves that it can contact only the exact pinned guard, use only the seven permitted CAPS/challenge/link messages plus framing/destroy, emit CAPS queries with `maximumResults = 1`, accept only one unfragmented CAPS response containing exactly the matching pinned-guard self-advertisement, reject zero/additional/referral advertisements and every core fragment, cannot probe referrals or any other endpoint, internally consumes exactly one admission capability at OFFER, and remains alive through ACCEPT. A successful dedicated/shared-channel case transfers only the accepted link context/transport to `RouteManager`; failure closes only owned state and leaves an existing branch intact. `GuardRevalidationIO` then destroys all residual authority. It may overlap `RoutedDHTIO` during make-before-break, but the pinned guard remains the only permitted post-readiness client network destination.

### CI and packaging

- Node LTS and current Bare test jobs;
- portable multi-process Node and Bare jobs;
- Linux namespace/capture gate;
- deterministic seeded fuzz jobs plus a larger scheduled fuzz budget;
- format, dependency, lockfile, clean-install, and package-content checks;
- exact fork commit pins in the PearTube integration branch.

## M3 Completion Definition

M3 is complete only when a fresh checkout can run the real isolated testnet and demonstrate private presence discovery and routed DHT record operations with the authoritative packet oracle showing no post-guard direct client DHT traffic.

Passing M3 does **not** establish that Hyperswarm works over the route. M4 must add destination-selected route descriptors, private connection establishment, end-to-end Noise streams, Hypercore replication, route rotation during a live stream, and the corresponding capture gate before PearTube may expose an all-Holepunch-traffic private switch.

## Security Review Requirements

Before declaring the wire format stable:

- obtain external review of capability binding, route construction, transcript domains, nonce use, private record signatures, and token/exit binding;
- run adversarial review of Sybil placement, resource exhaustion, amplification, censorship, and route-correlation claims;
- retain the explicit network-location-not-query-privacy language;
- keep experimental notices and prohibit production security claims until M4 and an external audit pass.
