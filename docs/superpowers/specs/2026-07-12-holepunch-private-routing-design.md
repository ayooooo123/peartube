# Holepunch-Native Private Routing Design

**Status:** Experimental protocol design  
**Date:** 2026-07-12  
**First consumer:** PearTube  
**Working package name:** `hyperdht-private-routes`

## Summary

PearTube needs an optional private P2P mode in which a destination peer does not learn a source peer's IP address and private endpoints never silently fall back to direct HyperDHT or Hyperswarm connections. The protocol should be native to the Holepunch stack rather than tunneling all clients through a single project-operated gateway or embedding a second networking stack.

The design introduces a private-routing layer above UDX and below DHT-RPC, HyperDHT, and Hyperswarm. A source selects a **Safety Route**. A destination selects and publishes a **Private Route**. Those independently selected segments compile into a multi-hop route. Each relay learns only its adjacent hops. Existing Hyperswarm Noise streams remain end-to-end encrypted inside the routed transport.

The first phase protects Holepunch P2P traffic only. It does not use Arti or Tor, and it does not claim that ordinary HTTP, HTTPS, external media, casting, telemetry, or DNS traffic is anonymous.

## Motivation and Current Evidence

Running the current Electrobun app with `ALL_PROXY`, `HTTP_PROXY`, and `HTTPS_PROXY` set to an isolated Tor SOCKS listener did not protect HyperDHT. The Bare backend opened multiple UDP sockets on `en0`, transferred roughly two megabytes, bootstrapped HyperDHT, and connected directly to three peers. No Electrobun, WebKit, or Bare process connected to the SOCKS listener.

This establishes two requirements:

1. Process proxy settings cannot provide P2P privacy for UDX/HyperDHT.
2. Privacy must be an explicit routing property below Hyperswarm, with a fail-closed prohibition on direct dialing.

Veilid is a behavioral and security reference, not an implementation dependency. Its public design combines a source-controlled Safety Route and destination-controlled Private Route so neither side delegates complete path selection to an untrusted relay. See [Veilid Private Routing](https://veilid.com/how-it-works/private-routing/).

## Goals

- Hide the source endpoint IP from the destination endpoint.
- Hide the destination endpoint IP from the source endpoint.
- Ensure no non-colluding relay knows the complete route.
- Preserve Hypercore and Hyperswarm end-to-end Noise encryption.
- Route HyperDHT lookup, announce, connect, and server traffic through private routes.
- Prevent private-only nodes from leaking into direct routing tables or liveness probes.
- Preserve existing direct HyperDHT behavior when private mode is disabled.
- Provide a runtime-agnostic design suitable for Node, Bare desktop, and Bare mobile.
- Make failure observable and fail closed without direct-network downgrade.

## Non-Goals for the First Protocol

- Anonymizing ordinary HTTP/HTTPS, external media URLs, DNS, telemetry, casting, mDNS, or LAN discovery.
- Hiding the source IP from its first-hop guard. This is impossible without another access network such as Tor, a VPN, or a bridge.
- Defending against a global passive observer that can correlate timing and volume across every link.
- Solving relay incentives, payments, or abuse adjudication.
- Modifying UDX wire semantics in the first milestone.
- Providing post-quantum cryptography in the first wire version.
- Enabling the PearTube UI switch before the routed Hypercore proof and packet-capture gate pass.

## Threat Model

### Protected against

- A destination peer attempting to learn the source's IP.
- A source peer attempting to learn the destination's IP.
- One malicious intermediate relay observing or modifying application plaintext.
- A relay replaying, duplicating, truncating, reordering, or mutating routed cells.
- A malicious route descriptor attempting to make a private client dial the destination directly.
- Route-only node information escaping into public DHT lookup or direct ping behavior.
- Relay failure causing an automatic downgrade to direct HyperDHT or hole punching.

### Explicitly visible

- The first-hop guard sees the source IP and the next relay.
- The final private-route relay sees the previous relay and destination IP.
- Public relay nodes expose their own dial information and participate in ordinary HyperDHT.
- Timing, packet counts, and approximate volume are visible to adjacent hops, subject to padding and batching.

### Out of scope initially

- Collusion between the guard and final private-route relay.
- A global passive network adversary.
- Host compromise, malicious application code, or endpoint logging.
- Sybil resistance beyond diversity rules, guard stability, local reputation, and signed node identity.
- One operator participating under multiple relay identities or controlling relays in both route-role domains. Such an operator is treated as a colluding adversary even when the identities are presented as separate nodes.

## Architectural Boundary

The protocol begins as a standalone package with narrow integration hooks:

```text
Hypercore / Corestore replication
              │
        Hyperswarm + Noise
              │
     Routed HyperDHT adapter
              │
  Private route manager / relay
              │
          DHT-RPC hooks
              │
             UDX
```

UDX remains responsible for efficient datagrams and streams. It should not initially understand routes, privacy domains, DHT identities, or path-selection policy. Once the protocol and API are stable, minimal generic hooks can be proposed upstream to DHT-RPC, HyperDHT, and Hyperswarm. Onion-routing logic should not be embedded directly into UDX without a demonstrated transport-level need.

## Node Roles

### Private endpoint

- Publishes no direct IP or ordinary dial information.
- Maintains a stable first-hop guard for a bounded epoch.
- Builds Safety Routes for outbound traffic.
- Builds and publishes one or more destination-controlled Private Routes.
- Never accepts direct HyperDHT, UDX, or hole-punched connections in private mode.

### Relay-capable node

- Is publicly reachable through ordinary HyperDHT/UDX.
- Advertises signed relay capabilities and capacity hints.
- Forwards opaque fixed-size cells between route-local identifiers.
- Enforces expiry, replay windows, quotas, flow control, and abuse limits.
- Does not decode DHT-RPC, Hyperswarm, Noise, Hypercore, or PearTube payloads.

### Direct endpoint

- Uses existing HyperDHT/Hyperswarm behavior.
- Is available only when privacy mode is disabled.
- Cannot be selected as a silent fallback by a private endpoint.

## Core Components

### `RouteManager`

- Selects and pins guards.
- Selects diverse safety and private-route relays.
- Rejects loops, duplicate identities, and disallowed privacy-domain transitions.
- Constructs, tests, rotates, drains, and destroys routes.
- Exposes structured readiness and failure state.

### `PrivateRouteDescriptor`

A signed, expiring DHT record containing:

- wire protocol version;
- route and descriptor identifiers;
- destination route signing key;
- an ephemeral destination route-encryption key and its binding to the requested endpoint identity;
- public entry relay identity and dial information;
- route capabilities and cell parameters;
- expiration and route epoch;
- an encrypted nested hop description;
- a descriptor signature.

The descriptor must not contain the destination IP, destination direct dial information, or an unencrypted complete relay list.

The descriptor is authorized either by a signature from the destination endpoint identity key itself or by an endpoint-signed delegation certificate naming the route-signing key. A delegation is scoped to the private-routing protocol, endpoint identity, route epoch range, permitted descriptor capabilities, and a short expiry; it cannot authorize DHT or application signatures. The descriptor signature binds that authorization, the route-encryption key, entry relay, route epoch, expiry, and protocol parameters. Merely naming an endpoint identity, or retrieving a descriptor under its rendezvous key, proves no authorization and never makes embedded data directly dialable.

### `RelayService`

- Allocates bounded route-local forwarding state.
- Maps an incoming route/circuit identifier to one next-hop link.
- Removes exactly one authenticated routing layer.
- Rejects invalid epochs, counters, directions, sizes, and capabilities.
- Applies per-source, per-route, and global resource limits.
- Removes all state on expiry or transport close.

### `CellCodec`

- Produces fixed-size padded cells below the selected UDX fragmentation threshold.
- Authenticates headers and payload at every hop.
- Uses monotonic direction-specific counters and replay windows.
- Fragments and reassembles routed messages without exposing application framing.
- Uses domain-separated, audited Holepunch/libsodium primitives.

The prototype must not freeze an unaudited wire format. Exact cell size, key schedule, nonce construction, and padding policy become normative only after property tests, fuzzing, and an external cryptographic review.

### `RoutedTransport`

- Presents datagram and duplex-stream semantics to DHT-RPC/HyperDHT.
- Multiplexes DHT control messages and end-to-end Noise streams over route cells.
- Implements bounded queues, credits, backpressure, cancellation, and teardown.
- Never exposes a direct destination address to private-mode consumers.

### `PrivacyDomainRegistry`

Tracks provenance and dial authorization as separate fields. Provenance is an accumulated set, not a last-write-wins enum:

- `public`: learned through ordinary public DHT behavior;
- `route-entry`: safe to contact only as the selected entry for a route;
- `private-only`: learned exclusively inside private-route material;
- `local`: the current endpoint.

A record may therefore be both independently `public` and referenced as a `route-entry`. Allowed operations are evaluated from the requested operation, accumulated provenance, authenticated capability, route epoch, and current route role. Importing route material can only remove permissions; it cannot grant public-dial permission.

A `private-only` node must never be directly pinged, dialed, returned from public lookup, or promoted to the public routing table without an independent authenticated public discovery event. Matching only an IP address, route identifier, or self-asserted key is not independent discovery. Conflicting identity or capability data quarantines the record and invalidates affected route construction. These are protocol invariants, not best-effort filters.

## Circuit Establishment and Key Binding

Route setup has its own authenticated cryptographic state and does not depend on the later Hyperswarm Noise handshake.

1. Each relay advertisement carries a signed, epoch-scoped route-encryption key bound to its relay identity, deterministic role, capabilities, and expiry.
2. The source creates a fresh circuit key pair and route identifier. It establishes its Safety Route hop by hop with nested authenticated `CREATE` cells. Each hop derives independent forward and reverse cell keys from an ephemeral key agreement plus transcript-bound identity, role, route ID, direction, epoch, and protocol version.
3. The source imports the destination descriptor only after verifying its endpoint signature or scoped delegation chain, descriptor signature, expiry, endpoint-identity binding, entry role, and protocol parameters. It creates a fresh end-to-end route key agreement with the descriptor's destination route-encryption key.
4. The source sends a nested private-segment activation object to the public entry. Each private relay can decrypt exactly its own instruction, authenticate the previous/next route-local binding, install bounded reverse state, and forward the remaining opaque object.
5. The destination authenticates the complete activation transcript and returns an end-to-end `CREATED` confirmation over the installed reverse path. The confirmation binds both segment transcripts, endpoint identity, route epoch, and negotiated parameters.
6. Only after the source verifies `CREATED` may the circuit carry DHT or Noise traffic. Hyperswarm then performs its existing end-to-end Noise handshake inside the circuit, giving application authentication and secrecy independently of the routing layer.

Every installed hop has separate forward/reverse keys, counters, and replay windows. A route-local incoming identifier maps to one authenticated outgoing binding and one reverse binding. `DESTROY` is authenticated in each direction; close, expiry, counter exhaustion, failed confirmation, or transport loss removes both bindings and zeroizes route secrets. Half-installed circuits time out quickly and cannot carry data.

The normative primitive suite, transcript encoding, KDF labels, nonce construction, and key-erasure requirements are a Milestone 0 output and must be externally reviewed before wire-format stability. Milestone 1 uses the same state machine with injected cryptographic adapters so every authorization and transition is executable in tests.

## Route Construction

### Destination Private Route

1. The destination selects a diverse ordered relay chain.
2. It establishes and tests the chain from the destination outward.
3. It builds nested encrypted hop instructions from the destination toward the public entry relay.
4. It signs and publishes an expiring `PrivateRouteDescriptor` through routed DHT-RPC.
5. It retains the previous descriptor briefly for connection draining.

### Source Safety Route

1. The source selects or reuses its stable guard.
2. It selects additional diverse relays from the `safety` role domain. The destination selects only from the disjoint `private` role domain. A relay's role is deterministically derived from its long-term public identity key, protocol version, and a fixed domain-separated hash; advertisements cannot choose or override it. Route setup recomputes the role and rejects a mismatch.
3. It establishes and tests the route from source to its final safety relay.
4. It imports the destination descriptor and attaches the descriptor's public entry relay.
5. It sends a compiled-route test before carrying DHT or application traffic.

### Compiled Route

```text
source -> guard -> safety relay(s) -> private entry -> private relay(s) -> destination
```

- The source controls the safety segment.
- The destination controls the private segment.
- The first guard learns the source IP but not the destination.
- The final relay learns the destination IP but not the source.
- Intermediate relays learn only adjacent hops.
- The destination sees only its final private relay.

Role-domain separation prevents the same relay identity from occupying both segments without revealing the destination's hidden relay list. Because role derivation is deterministic, the identity cannot equivocate by presenting different signed advertisements to each endpoint. It does not prevent an operator from grinding or creating multiple identities across roles; that is collusion/Sybil behavior and remains outside the first threat model. Accordingly, “a relay learns only adjacent hops” applies to one protocol identity operated independently, not to an operator correlating multiple identities.

## Bootstrap and Relay Discovery

A new private endpoint requires a small signed bootstrap set of public relay-capable nodes. Bootstrap nodes are discovery seeds, not mandatory traffic gateways.

1. The endpoint directly contacts candidate bootstrap/guard nodes.
2. It validates signed relay identity, capabilities, protocol version, and observed reachability.
3. It pins a guard and moves subsequent DHT-RPC discovery behind the Safety Route.
4. It discovers additional relays through routed queries and maintains a bounded candidate pool.

Guard stability reduces exposure to many first-hop relays. Guards rotate on a long epoch, explicit compromise/quarantine, or sustained failure—not per connection.

Initial path diversity rules should reject:

- duplicate node identities;
- repeated IP addresses;
- obvious same-subnet concentration where address information is public;
- relays with incompatible protocol/cell versions;
- identities whose advertised role differs from deterministic role derivation;
- locally quarantined or repeatedly failing relays.

ASN and geographic diversity can be added when trustworthy metadata is available; self-asserted diversity metadata is insufficient.

### Allowed network flows by role and phase

| Role | Bootstrap phase | Established private operation | Forbidden endpoint flow |
| --- | --- | --- | --- |
| Source endpoint | Signed bootstrap candidates until a guard is pinned | Current guard only | Destination, private relays, public DHT peers |
| Destination endpoint | Signed bootstrap candidates until a guard is pinned | Its source-side guard for outbound control and its final private relay for inbound circuits | Sources, private entries, public DHT peers |
| Safety/guard relay | Public relay discovery and DHT participation | Previous and next circuit hops plus public control-plane peers | Using learned private-only endpoint data for direct probes |
| Private relay | Public relay discovery and DHT participation | Previous and next circuit hops plus public control-plane peers | Using learned source/destination data outside installed circuit state |
| DHT gateway | Public HyperDHT peers | Final safety hop plus public HyperDHT peers | Direct source contact or returning its address to the public DHT |

Packet-capture assertions distinguish circuit edges from a relay's independently allowed public control-plane traffic. They verify that every circuit data packet follows an installed adjacent edge and that endpoint packets follow the endpoint rows above; they do not require public relays to stop ordinary HyperDHT participation.

## DHT-RPC and HyperDHT Integration

Private endpoints must not create an ordinary public DHT socket and then route only payload connections. Lookup, announce, unannounce, token/signature exchange, server signaling, and connection establishment must all use `RoutedTransport`.

Ordinary HyperDHT nodes do not speak `RoutedTransport`. The first interoperable design therefore uses cooperative public **DHT gateway** nodes as an explicit relay capability. A private endpoint sends DHT-RPC requests through its Safety Route to a selected gateway. The gateway terminates the routed control request, performs the corresponding ordinary HyperDHT operation using its own public socket, and returns the result through the route. Public DHT nodes see the gateway IP, never the private endpoint IP.

A gateway necessarily learns requested DHT keys/topics, operation type, timing, and response size. It does not learn the endpoint IP unless it is also that endpoint's guard, a combination rejected by route selection. Requests retain endpoint-level DHT signatures where required, while gateway envelopes are separately authenticated so the gateway cannot silently substitute an endpoint identity. Multiple gateways and query minimization are later metadata-hardening work; the first privacy claim is endpoint-IP separation, not DHT-topic secrecy.

Private route descriptors are opaque signed values stored and retrieved under versioned rendezvous keys through gateways. A gateway validates size, expiry envelope, and storage policy but does not decrypt the descriptor. Connection establishment then leaves the gateway path and joins the descriptor's private entry through the compiled route. Relay-only forwarding nodes continue not to decode DHT-RPC; gateway behavior is a separate advertised service.

The first adapter should implement the subset of the HyperDHT interface required by Hyperswarm:

```js
const routes = new PrivateRoutes({
  bootstrap,
  relay: true,
  safetyHops: 2,
  privateHops: 1
})

await routes.ready()

const dht = routes.createDHT()
const swarm = new Hyperswarm({ dht })
```

The exact API will be driven by tests against real HyperDHT/Hyperswarm behavior. The adapter must preserve:

- DHT key pairs and signatures;
- server firewall semantics;
- connection cancellation and teardown;
- Noise key agreement and SecretStream identity;
- lookup/announce lifecycle;
- suspend/resume behavior;
- deterministic error propagation.

Private route descriptors may be associated with a peer's Noise public key, but route keys and route IDs must rotate independently so the wire route cannot be used as a long-term endpoint identifier.

## Hyperswarm and Hypercore Data Flow

1. Hyperswarm requests a connection through the routed DHT adapter.
2. Routed DHT discovery returns an opaque private route descriptor, not destination dial information.
3. `RoutedTransport` opens a bidirectional compiled route.
4. Hyperswarm performs the existing end-to-end Noise handshake inside that route.
5. Corestore replication runs over the resulting SecretStream without application changes.

Relay cells contain only encrypted routed bytes. Forwarding-only relays cannot identify Hypercore keys, Protomux channels, PearTube topics, or application messages from plaintext protocol fields. A DHT gateway can see the DHT metadata explicitly disclosed above, but it cannot decrypt the later end-to-end Noise stream.

## Lifecycle and Failure Semantics

### Startup

1. Read device-wide private P2P configuration before creating HyperDHT.
2. Bootstrap relay candidates.
3. Establish and test a Safety Route.
4. Establish and publish a Private Route.
5. Pass a compiled-route loopback test.
6. Create routed DHT and Hyperswarm instances.
7. Report P2P online only after routed lookup/announce succeeds.

### Route rotation

- Private routes rotate more frequently than guards.
- Old private routes remain receive-only for a short drain period.
- New connections use only the newest valid descriptor.
- Route keys, identifiers, counters, and forwarding state are never reused across epochs.

### Failure

- Relay failure triggers route replacement or structured P2P-offline state.
- Exhausted route candidates do not enable direct networking.
- Queue overflow fails the affected stream with a stable error.
- Malformed descriptors and cells fail closed without partial route installation.
- Shutdown destroys Hyperswarm/DHT state before routes and guards.
- Switching back to direct mode first proves all private routed sockets and relay state are closed.

## PearTube Integration Scope

PearTube is the first consumer only after the standalone transport passes its protocol gates.

The device-wide UI setting will be labeled **Private P2P routing (experimental)**. Toggling it triggers a controlled backend restart:

- stop existing Hyperswarm, DHT, relay, and discovery sockets;
- start the selected direct or private transport;
- keep P2P offline on private-route failure;
- expose structured route status in diagnostics.

The setting does not claim to anonymize ordinary HTTP/HTTPS or external application traffic in this phase.

## Security and Privacy Invariants

1. A private endpoint has no direct peer or public DHT connection. During bootstrap it may contact signed guard candidates; in established operation a source contacts only its guard, while a destination additionally accepts its final private-relay link.
2. The destination never receives source dial information.
3. The source never receives destination dial information.
4. No relay receives the complete path in plaintext.
5. Every hop instruction and cell is authenticated.
6. Replay, mutation, truncation, wrong direction, and expired epoch fail closed.
7. Hypercore/Hyperswarm payloads remain end-to-end Noise encrypted.
8. Private-only peer information never enters direct routing or liveness logic.
9. Route failure never downgrades to direct dialing or hole punching.
10. Diagnostics do not log complete routes, route secrets, or private endpoint addresses.
11. Private mode is not reported online until a routed end-to-end test succeeds.
12. Protocol version/capability mismatch fails before forwarding state is installed.

## Verification Strategy

### Deterministic virtual network

Build a clock- and transport-injected simulator with endpoints and relay nodes. Cover:

- safety/private/compiled route construction;
- forward and reverse traffic;
- route rotation and draining;
- relay loss and replacement;
- fragmentation and backpressure;
- bounded resource cleanup;
- privacy-domain transitions.

### Codec, property, and fuzz tests

- malformed/truncated/oversized cells;
- replayed, skipped, and wrapped counters;
- wrong direction and epoch;
- padding boundaries;
- duplicate hops and route loops;
- descriptor signature and expiry;
- mutation of every authenticated field;
- arbitrary fragmentation and reassembly sequences.

The counter oracle is normative by cell class:

- ordered stream and control cells accept only the next counter; a gap is buffered only within a bounded reorder window and timeout, then fails the affected circuit;
- unordered datagram cells may arrive in any order inside a sliding replay window, are delivered at most once, and permanently reject counters below the committed window floor;
- authentication is checked before a counter changes state;
- duplicate counters are always rejected, including byte-identical duplicates;
- counter wrap is forbidden; approaching exhaustion starts route rotation and exhaustion closes the circuit;
- control cells that change lifecycle state are ordered and idempotent only where the wire definition explicitly says so.

Property tests assert exact accept, buffer, deliver, reject, timeout, window-advance, and teardown outcomes for gaps, reordering, replay, wrap boundaries, and adversarial fragmentation.

### Adversarial relay tests

Relays will drop, delay, duplicate, reorder, replay, mutate, and selectively forward cells. Tests must prove deterministic failure, bounded state, route replacement, and no direct fallback.

### Local UDX integration

Run two private endpoints and at least three relay processes. Packet capture must show:

- each endpoint directly contacts only its guard/final relay as appropriate;
- endpoints never contact each other;
- private endpoints do not contact public DHT peers after routed bootstrap;
- circuit data from relay processes contacts only installed adjacent route hops; separately captured public control-plane traffic matches the role matrix;
- route shutdown removes all external sockets.

### HyperDHT/Hyperswarm integration

- routed lookup and announcement;
- routed DHT server signaling;
- end-to-end Hyperswarm Noise connection;
- real Hypercore replication over the routed SecretStream;
- connection churn, suspend/resume, and version skew.

### PearTube Electrobun proof

Run two isolated Electrobun instances with separate storage plus a local relay graph. Exchange PearTube feed metadata and video blocks. Packet capture must prove the Bare workers do not contact each other or public DHT peers directly.

### Performance gates

Measure:

- route establishment latency;
- first DHT lookup and first peer connection latency;
- steady-state throughput and overhead;
- per-route and per-stream memory;
- relay CPU/bandwidth limits;
- route churn under relay loss;
- mobile suspend/resume and network-change recovery.

## Milestones

### Milestone 0: Protocol RFC and threat model

- Freeze terminology, invariants, adversaries, privacy claims, and versioning rules.
- Select audited primitives and define domain separation.
- Obtain external protocol/cryptography review before wire-format stability.

### Milestone 1: Virtual routing core

- Cell codec, descriptors, route manager, relay service, privacy domains.
- Deterministic simulator, property tests, fuzz harnesses.
- No real sockets or PearTube integration.

### Milestone 2: UDX relay graph

- Live relay-capable nodes and private endpoints over localhost/network namespaces.
- Compiled-route bidirectional streams.
- Packet-capture privacy gate.

### Milestone 3: Routed DHT-RPC and HyperDHT

- Lookup/announce/server signaling through routes.
- Private route descriptor storage and retrieval.
- No ordinary DHT socket after bootstrap.

### Milestone 4: Hyperswarm and Hypercore

- Hyperswarm adapter using routed HyperDHT.
- End-to-end Noise and real Hypercore replication.
- Route rotation and connection churn.

### Milestone 5: PearTube experimental integration

- Shared backend network option and diagnostics.
- Device-wide Electrobun setting with controlled restart.
- Two-app local proof and leak harness.
- Mobile integration follows the shared backend contract after desktop proof.

### Milestone 6: Hardening and upstreaming

- Independent security and cryptographic audit.
- Sybil/guard/relay selection hardening.
- Performance and mobile lifecycle work.
- Propose minimal generic hooks upstream to DHT-RPC, HyperDHT, and Hyperswarm.

## Success Criteria for the First Implementation Plan

The initial implementation plan should cover Milestones 0 and 1 only. It is complete when:

- the threat model and wire vocabulary are executable as tests;
- a virtual source, safety segment, private segment, and destination exchange bidirectional fixed-size cells;
- no simulated node learns more than its allowed view;
- replay, mutation, expiry, loops, and resource exhaustion fail closed;
- fuzz/property suites run deterministically in CI;
- there is no PearTube UI, real UDX, or production privacy claim yet.

This deliberate boundary prevents an unaudited prototype from being exposed as a user-facing anonymity feature.

## Existing Baseline Defects

The isolated worktree baseline predates this design and is not fully green:

- `packages/backend/test/holepunch-major-migration.test.mjs` expects `bare-pack` `^2.0.1`, while `packages/app/package.json` currently declares `^2.1.3`.
- Host tests cannot resolve the local `bare-ffmpeg` package from `packages/backend/node_modules` after the documented `install:all` flow.
- Dependency installation reports existing vulnerabilities across root/backend/app dependency trees.

The private-routing implementation must not silently repair or absorb these unrelated defects. Its package-level tests and CI should be independently runnable until the repository baseline is repaired.

## Open Questions for Later Milestones

- Normative cell size and padding distribution.
- Guard epoch and private-route lifetime defaults.
- Default safety/private hop counts after performance measurements.
- Relay capacity advertisement and anti-abuse policy.
- Route descriptor replication/availability policy.
- Multipath and traffic-splitting support.
- Cover traffic and timing-correlation defenses.
- Relay reputation without creating a global tracking identifier.
- Whether the stabilized package should move to a standalone repository before upstream proposals.
