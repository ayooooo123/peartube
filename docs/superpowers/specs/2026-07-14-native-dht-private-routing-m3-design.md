# Native DHT Private Routing — Milestone 3 Design

**Status:** Approved experimental design  
**Date:** 2026-07-14  
**Parent design:** `2026-07-12-holepunch-private-routing-design.md`  
**First consumer:** PearTube  
**Protocol package:** `hyperdht-private-routes`

## Summary

Milestone 3 integrates the verified private-route transport with DHT-RPC and HyperDHT. It replaces the earlier application-level gateway idea with a permissionless, protocol-native relay capability. Persistent DHT nodes may opt into circuit forwarding, typed DHT egress, private-record storage, or any combination. Clients discover those capabilities through ordinary DHT participation and build fixed three-relay circuits without consulting a trusted registry.

The client continues to run the iterative DHT algorithm. An exit executes only one bounded, typed RPC against one validated DHT node at a time and returns the ordinary response through the circuit. It never becomes a trusted query engine or an unrestricted UDP proxy.

M3 proves private DHT discovery and record access. It does not yet claim that a Hyperswarm Noise connection or Hypercore replication runs over the route; that is the M4 gate.

## Relationship to M2

M2 provides the cryptographic and transport substrate:

- fixed 1,200-byte padded, hop-authenticated cells;
- independent forward and reverse keys, counters, and replay state;
- bounded UDX queues and hop-by-hop backpressure;
- authenticated route creation, activation, confirmation, and destruction;
- autonomous teardown and secret erasure;
- a real seven-process UDX topology with a Linux network-namespace packet oracle;
- Node and Bare compatibility.

M3 reuses those primitives. It does not introduce a second cell codec, a parallel circuit state machine, or a generic proxy abstraction.

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
- Private-record storage nodes see record keys and signed storage envelopes, but not opaque route-descriptor contents.
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

Private routing is opt-in. A persistent node may advertise these capabilities independently:

- `CIRCUIT_RELAY_V1`: forward bounded opaque route cells;
- `DHT_EXIT_V1`: execute typed single-node DHT-RPC operations;
- `PRIVATE_RECORDS_V1`: store and return private presence records;
- supported wire versions, command policies, cell parameters, and coarse capacity classes.

A short-lived advertisement contains the relay identity, current DHT identity and reachable address, an epoch-scoped route-encryption key, capabilities, protocol limits, epoch, and expiry. It is signed by the relay identity already used by the M2 protocol. Route construction includes an active challenge that proves current possession of the advertised identity and route-encryption key at the observed endpoint. Replayed or expired advertisements cannot establish a circuit.

Capacity values are hints, not promises. A dishonest advertisement can cause only selection and availability failure; it cannot expand the client's permitted command surface or disable local bounds.

## Permissionless Discovery Without a Registry

Relay discovery uses DHT participation rather than a signed operator list:

1. The client contacts a bounded number of ordinary HyperDHT bootstrap candidates. This unavoidable bootstrap phase is explicitly outside the post-guard IP-exposure guarantee.
2. Compatible responding nodes attach a bounded, signed capability advertisement. The client pins a reachable guard as soon as one passes signature, expiry, role, diversity, and active challenge checks.
3. After guard pinning, all candidate discovery runs through that guard. Random XOR-target walks collect advertisements from responding persistent nodes across distant routing-table regions.
4. The client actively validates a candidate only through the partially constructed circuit. It does not probe prospective middles or exits directly.
5. If the client cannot find enough compatible and diverse nodes, `required` mode remains unavailable. It never downgrades to direct DHT traffic.

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

The shared guard is the only identity that may overlap the lookup and announce branches. Their middle and exit identities must be distinct. A branch must not contain a repeated identity or route loop. Existing M2 privacy-domain and dial-authority rules remain mandatory.

These heuristics raise the cost of simple Sybil placement but do not solve Sybil resistance. Documentation and UI must not imply otherwise.

## Circuit Topology and Lifecycle

M3 uses two fixed three-relay branches:

```text
                  ┌─> lookup middle ─> lookup exit
client ─> guard ──┤
                  └─> announce middle ─> announce exit
```

Defaults are prototype policy values, not a stable wire-format promise:

- guard lease: 24 hours of active foreground/backend use;
- branch lease: 15 active minutes with random jitter;
- lease clocks pause while the owning mobile backend is suspended;
- branch rotation is make-before-break;
- the old branch drains bounded in-flight work, then destroys and erases state;
- a network-interface change invalidates reachability and immediately rebuilds branches;
- a branch failure rebuilds through the current guard when possible;
- sustained guard failure selects a replacement without waiting for lease expiry;
- no permanently warm standby is maintained solely for privacy routing.

Sharing the guard limits how many nodes observe the client IP and reduces mobile radio wakeups. Separate middles and exits prevent one exit from automatically joining lookup and announce metadata.

## Native DHT-RPC Transport

The DHT-RPC client retains control of iterative traversal. A routed request represents exactly one typed RPC to one DHT node:

```text
request id
command id and version
validated destination DHT identity and address
bounded encoded command body
deadline
response and command-cost budget
```

The exit:

1. authenticates and decodes the routed envelope;
2. verifies the command has a locally enabled `privateRoute` policy;
3. validates sizes, deadline, cost, and outstanding-request limits;
4. confirms the destination as a DHT participant through the normal DHT identity/reachability exchange;
5. executes one RPC through its own DHT-RPC socket;
6. validates and bounds the response;
7. returns the response under the original circuit request ID.

The client then applies the same mapping, signature checks, token handling, convergence rules, query fanout, and retry behavior used by direct DHT-RPC.

The exit may omit, delay, or censor a response. The client treats this as a timeout, queries another DHT node, and rotates the branch after bounded failures. The exit is never trusted to report that a complete lookup succeeded.

### Token and address binding

Any DHT token bound to a UDP source address is also bound operationally to the active exit. A lookup that acquires a token and the mutation that consumes it must use the same branch generation and exit. HyperDHT `announce()` performs its internal lookup on the announce branch. Tokens are discarded when that branch rotates; affected work restarts rather than reusing a token from another exit.

### Command policy

DHT-RPC commands opt in with an exact `privateRoute` policy containing:

- request and response codecs;
- maximum encoded sizes;
- timeout and outstanding-request limits;
- request and response cost;
- maximum response amplification;
- whether the operation mutates remote state;
- destination validation requirements.

M3 initially allows single-node operations needed for:

- public DHT lookup and find-peer traversal;
- private lookup and private announce;
- announce/unannounce mechanics used only where their address semantics remain correct;
- mutable and immutable get/put;
- internal node and relay discovery.

It rejects punch, holepunch, direct connect, raw relay, arbitrary UDP destinations, unknown commands, and commands without an explicit policy. Peer-connection commands are reserved for M4.

## Native Private Presence Records

Legacy HyperDHT announce semantics associate the announcing UDP endpoint with the peer. A proxied legacy announce would therefore publish the exit as the peer address. It would not leak the client address, but it would be incorrect and unusable for a private connection.

M3 introduces versioned native operations:

- `PRIVATE_ANNOUNCE` stores a signed endpoint presence record without deriving any address from the packet source;
- `PRIVATE_LOOKUP` returns bounded, verified presence records for a topic.

A private presence record binds at least:

- protocol version and capability set;
- topic;
- endpoint public key;
- monotonically increasing sequence or epoch;
- expiry;
- opaque descriptor bytes and descriptor digest;
- endpoint signature over every field.

Storage nodes validate the signature, exact bounds, sequence/epoch, expiry, topic binding, and storage quotas. They store no source address in the record and return no observed source address to readers. Descriptor bytes remain opaque to storage nodes.

In M3 the descriptor is deliberately non-dialable and proves only private discovery. In M4 it becomes the signed destination-selected Private Route descriptor defined by the parent design. Merely retrieving a presence record never grants direct-dial authority.

`PRIVATE_RECORDS_V1` nodes place and retrieve records using normal XOR routing among compatible nodes. Legacy nodes ignore unknown commands. The extension is wire-compatible but requires enough opt-in storage nodes to be available; insufficient compatible density is an availability failure, not permission to use legacy announce semantics.

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
    mode: 'required'
  }
})
```

Initial modes are:

- `off`: compatibility default; existing behavior is unchanged;
- `required`: every supported operation uses a ready private branch or fails with a structured privacy-unavailable error.

There is no `preferred` mode and no transparent direct fallback.

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
- selection invariants for identity, XOR, prefix, branch, and loop diversity;
- guard and branch active-time lease state machines;
- make-before-break, drain, network-change, suspend, resume, and teardown;
- exact command-policy enforcement and unknown-command rejection;
- DHT token/exit binding across rotation;
- private presence record signatures, bounds, expiry, sequence, and source-address exclusion;
- quotas, response amplification, fairness, backpressure, and `BUSY` behavior;
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

- private announce from one endpoint is discoverable through private lookup from another;
- mutable and immutable records round-trip through routed single-node RPCs;
- iterative lookup remains client-controlled across several DHT nodes;
- dropped, forged, replayed, oversized, and delayed exit responses cannot complete a query falsely;
- branch failure rotates without direct fallback;
- insufficient private-record density fails closed;
- branch and guard rotations follow the active-time policy;
- Node and Bare produce the same protocol result.

### Authoritative packet oracle

A Linux network-namespace job captures every relevant interface and fails unless:

- the client contacts only the bounded bootstrap set before guard pinning;
- after pinning, the client contacts only its guard;
- the guard contacts only the two selected middles for circuit traffic;
- each middle contacts only its selected exit;
- exits contact only validated DHT participants using allowlisted operations;
- private-record nodes observe exit addresses and never the client address;
- lookup and announce middles/exits are distinct;
- no endpoint address from private material enters a public routing table or direct probe;
- all processes, sockets, circuits, queues, and owned secret state are gone after teardown.

A separate direct-send trap instruments the client's ordinary DHT socket. Any post-guard send while `mode: 'required'` fails the suite even if packet capture misses it.

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
