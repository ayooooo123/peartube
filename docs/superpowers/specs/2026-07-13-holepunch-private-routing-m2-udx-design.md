# Holepunch Private Routing Milestone 2: Live UDX Relay Graph

**Status:** Approved design draft

**Date:** 2026-07-13

**Parent design:** [Holepunch-Native Private Routing](2026-07-12-holepunch-private-routing-design.md)

**First implementation:** `packages/private-routes`

**Runtime targets:** Node and Bare

## Summary

Milestone 2 replaces the virtual transport boundary from Milestones 0–1 with a real,
multi-process UDX datagram graph. Both endpoints operate privately. A source contacts only its
safety guard, and a destination accepts route traffic only from its private final relay. Five
relay processes connect the two endpoint processes without any route process receiving the
complete route or a direct endpoint-to-endpoint dial capability. The trusted test coordinator is
the sole exception: it knows the synthetic topology so it can configure and audit the graph.

The portable integration suite runs the seven processes on distinct loopback addresses in Node
and Bare. The authoritative privacy gate runs the same topology in Linux network namespaces on a
shared, fully reachable bridge and validates a packet capture against an exact adjacency matrix.

This milestone proves the real UDX link layer, asynchronous route setup, bidirectional routed
bytes, deterministic failure, and endpoint IP separation in a controlled graph. It does not
implement DHT gateways, public relay discovery, routed HyperDHT, Hyperswarm, Hypercore, PearTube,
mobile lifecycle integration, or production anonymity.

## Decisions

- Both endpoints are private.
- Every adjacent-hop packet is one fixed-size 1,200-byte UDX datagram.
- Each endpoint and relay runs in a separate process.
- The graph contains two safety relays and three private relays.
- Portable localhost tests and a Linux namespace packet-capture gate land together.
- A static, signed test topology is used. DHT-based relay discovery remains Milestone 3.
- UDX remains a generic datagram transport. Route policy and onion state do not move into
  `udx-native`.
- Existing virtual tests remain authoritative for pure protocol invariants and continue running
  on Node and Bare.

## Threat Model for This Milestone

### Protected in the controlled graph

- The destination process does not receive the source address.
- The source process does not receive the destination address.
- One non-colluding relay process sees only its configured adjacent peers.
- A compromised non-adjacent process cannot inject a usable cell by guessing a circuit ID.
- Datagram mutation, replay, truncation, extension, wrong direction, wrong epoch, spoofed source,
  late setup, and transport loss fail closed.
- Route failure cannot open an ordinary UDX, HyperDHT, Hyperswarm, LAN-discovery, or hole-punched
  connection.

### Explicitly visible

- The guard sees the source test address and the safety-final address.
- The private-final relay sees the private-middle and destination test addresses.
- Adjacent processes see timing, packet count, and a constant UDP payload size.
- The test coordinator and packet-capture checker know the complete synthetic topology.

### Out of scope

- Public Internet relay discovery, NAT traversal, or hostile residential NAT behavior.
- Collusion, Sybil resistance, global traffic correlation, cover traffic, and relay incentives.
- DHT topic privacy or DHT gateway metadata.
- HTTP, HTTPS, DNS, telemetry, casting, mDNS, or LAN anonymity.
- Mobile backgrounding and network changes.
- A stable or externally audited wire format.

## Process Topology

```text
source
  -> safety guard
  -> safety final
  -> private entry
  -> private middle
  -> private final
  -> destination
```

The test coordinator owns the complete synthetic topology for orchestration and auditing. It does
not pass the complete topology to a route process. Each process receives a role-scoped projection:

- source: its bind address, safety advertisements, and later the verified destination descriptor;
- safety guard: source and safety-final link grants;
- safety final: safety-guard and private-entry link grants;
- private entry: safety-final and private-middle link grants plus its encrypted route template;
- private middle: private-entry and private-final link grants plus its encrypted route template;
- private final: private-middle and destination link grants plus its encrypted route template;
- destination: its bind address, private-route construction material, and private-final link grant.

The source never receives the destination address or the complete private chain. The destination
never receives the source address or the complete safety chain. Relays receive no endpoint address
outside their adjacent link grant.

Knowledge and dialing authority are distinct. The configuration auditor uses these two exact
matrices:

| Process        | May know identities/advertisements for                         | May receive grants and send directly to |
| -------------- | -------------------------------------------------------------- | --------------------------------------- |
| source         | source, both safety relays, and the descriptor's private entry | safety guard only                       |
| safety guard   | source, safety guard, safety final                             | source and safety final                 |
| safety final   | safety guard, safety final, private entry                      | safety guard and private entry          |
| private entry  | safety final, private entry, private middle                    | safety final and private middle         |
| private middle | private entry, private middle, private final                   | private entry and private final         |
| private final  | private middle, private final, destination                     | private middle and destination          |
| destination    | destination and all three selected private relays              | private final only                      |

Endpoint route construction may therefore contain non-adjacent public advertisements from its own
selected segment. It never supplies those advertisements to `UdxCellEndpoint`; only an exact signed
grant can create a link handle or authorize a send. Relay configurations remain adjacent-only.
The namespace negative-control fixture additionally gives the source a separately named decoy
address; the auditor permits it only inside the exact test-only `negativeControl` field, never in a
route advertisement, actor message, or link grant.

The coordinator uses existing signed relay advertisements and descriptor authorization. For this
test milestone it also owns a separate ephemeral Ed25519 topology-authority key. Every role is
given only the authority public key and its own grants. A grant is the canonical encoding of:

- protocol version and grant format version;
- random 32-byte grant ID;
- endpoint A identity, role, numeric IP address, UDP port, and allowed operations;
- endpoint B identity, role, numeric IP address, UDP port, and allowed operations;
- epoch, not-before time, expiry time, and test-run ID.

The topology authority signs the domain-separated hash of that exact encoding. The grant digest
used on the wire is the hash of the signed encoding and signature. Grant verification happens
before a socket can send to or accept state for the peer. Expiry closes the link and every circuit
using it. A coordinator `revoke` command names one grant digest; the role verifies that the digest
belongs to its original signed configuration, tombstones it, and performs the same close. A
revoked or expired grant cannot authorize a replacement link in the same epoch. Grants are
configuration inputs to the controlled test graph, not a new public discovery mechanism.

Endpoint A/B ordering is the lexicographic order of their identities. The authority creates one
bilateral signed grant per adjacent pair and gives the identical signed bytes to both participants.
The operation bits state what each participant may do. The bootstrap sender includes this shared
grant digest; the recipient must match it byte-for-byte to its own verified local copy before it
may reply.

## Architectural Boundary

### `UdxCellEndpoint`

`UdxCellEndpoint` owns exactly one injected UDX instance and one explicitly bound UDX socket. It:

- accepts and sends only 1,200-byte datagrams;
- binds to a numeric configured address and port;
- maps configured adjacent addresses to opaque link handles;
- rejects unexpected source address/port pairs before cryptographic parsing when a grant is
  already known;
- dispatches bootstrap datagrams separately from established cells;
- owns send queues, cancellation, socket error handling, and close completion;
- exposes no arbitrary host/port send method to route consumers.

Production code depends on a narrow adapter interface matching the required `udx-native` socket
operations. Tests inject a fake adapter for exact failure oracles. The real adapter is runtime
agnostic across Node and Bare.

### `LinkDirectory`

`LinkDirectory` stores only role-scoped adjacent grants. Lookups require the requested operation,
expected identity, role, epoch, and route-local binding. It cannot enumerate a complete route and
cannot translate private-only identities into general dial addresses.

An authenticated link may pin a more specific observed address only when it matches the grant.
Address changes are not supported in Milestone 2; they close the link. Mobile network migration is
deferred until the basic address boundary is independently proven.

### `RemoteActorHost`

`RemoteActorHost` replaces in-memory actor capability passing at the process boundary. It maps
opaque local actor identifiers to relay or destination actor state and accepts only decoded,
authenticated link events from `UdxCellEndpoint`.

No JavaScript actor object, callback, secret, path array, or destination address crosses the wire.
The host dispatches by locally installed route state, not by caller-provided object identity.

After link establishment, a bounded `ActorControlCodec` is carried inside authenticated CONTROL
cells. Its canonical header is: version (1 byte), kind (1), flags (1, zero in v0), reserved (1,
zero), request ID (8), recipient-local actor ID (16), circuit ID (16), route generation (8), and
body length (2), followed by exactly that many body bytes. The complete logical message is capped
at the existing `MAX_ACTIVATION_OBJECT` of 8,192 bytes, so the body maximum is exactly 8,138 bytes.
It is encoded first, then split and reassembled by `RemoteControlFragmentCodec`, which reuses the
existing activation-fragment format and security rules but has transport-specific exact limits.
The Milestone 2 transport reserves one leading physical payload byte for the control mux, so each
actor fragment has its 22-byte header and at most 1,123 data bytes. The logical maximum remains
8,192 bytes and the fragment maximum remains eight. Reassembly completes before actor decoding or
mutation. The existing virtual fragment codec and its 1,124-byte data limit remain unchanged.

The recipient-local ID is an opaque handle published only to its adjacent peer in the signed role
projection. Replies echo the request ID, actor ID, circuit ID, and generation. Registration
messages use the all-zero circuit ID and generation until activation allocates them. Unknown kinds,
nonzero reserved fields, duplicate request IDs with a different digest, unexpected replies,
trailing body bytes, cross-request fragments, and reassembly expiry fail closed.

The remote operations and exact replies are:

| Request             | Success reply        | State effect                                          |
| ------------------- | -------------------- | ----------------------------------------------------- |
| `REGISTER_STAGE`    | `REGISTER_STAGED`    | Install an uncommitted template record.               |
| `REGISTER_PREPARE`  | `REGISTER_PREPARED`  | Prepare the named transaction.                        |
| `REGISTER_FINALIZE` | `REGISTER_FINALIZED` | Commit the prepared transaction.                      |
| `REGISTER_ABORT`    | `REGISTER_ABORTED`   | Remove staged/prepared records idempotently.          |
| `ACTIVATE_CREATE`   | `ACTIVATE_CREATED`   | Traverse/activate and return the authenticated proof. |
| `CIRCUIT_DESTROY`   | `CIRCUIT_DESTROYED`  | Tombstone and clear the local circuit idempotently.   |

Registration request bodies are the existing canonical registration capsules; their replies are
the existing canonical authenticated acknowledgement lists. Activation bodies and replies are the
existing canonical activation request and `CREATED` proof. `CIRCUIT_DESTROY` contains one
allowlisted reason byte; its reply has an empty body. `ERROR` contains an allowlisted numeric error
code and the 32-byte rejected-request digest. A one-way kind uses request ID zero; a request
requiring a reply uses a random nonzero ID.

`request(kind, actorId, circuitId, generation, body, { deadline, signal })` returns a promise for
the one permitted success reply or a stable `PrivateRouteError`. `notify(...)` only accepts
one-way kinds and returns whether the complete cell entered the bounded local queue. A caller
retains its input and may clear it after either call returns; the transport owns a private copy
until send completion/cancellation. A receiver owns a fresh decoded body until the actor handler
settles, then zeroes it. Replies follow the same ownership rule.

An authenticated `ERROR` reply contains only an allowlisted numeric error code and the rejected
request digest. Remote authorization/state errors preserve their stable code; transport loss,
unknown codes, malformed replies, and handler exceptions map to `ROUTE_UNAVAILABLE`. Local
cancellation removes the wait immediately. If a registration may have reached the remote staged
or prepared state, cancellation also attempts `REGISTER_ABORT`; expiry remains the final cleanup
backstop. A late reply can match only a tombstone and cannot transfer ownership or reopen state.

STREAM and DATAGRAM cells are not RPC calls. Their link-level flow control is defined separately
below. Each data cell and each separate acknowledgement is exactly one fixed-size UDX datagram.

### `AsyncRouteControlSession`

The Milestones 0–1 actor fixture can complete setup synchronously because it calls byte-delivery
callbacks in one process. Real UDX delivery is asynchronous. Milestone 2 adds an asynchronous
control state machine rather than pretending a queued UDP send is synchronous success.

`AsyncRouteControlSession` owns:

- setup request identifiers and expected response types;
- a monotonic deadline with a default maximum of 5,000 ms;
- cancellation handles for every queued send and pending response;
- duplicate and late-response suppression;
- partial-binding rollback and secret zeroization;
- structured completion as either an authenticated result or a stable `PrivateRouteError`.

The existing synchronous virtual API remains available for Milestone 1 tests. Shared validation,
codec, authority, cleanup, and state-transition code is factored so the sync and async executors do
not implement separate security rules. Real transport code must never call the synchronous path.

The session uses `RemoteActorHost.request()` for registration and activation rather than invoking
an actor callback. Its state table is linear and explicit:

```text
NEW -> STAGED -> PREPARED -> FINALIZED
       |          |
       +-> ABORTING <-+
              |
           ABORTED

FINALIZED -> EXPIRED/REVOKED

NEW -> ACTIVATING -> OPEN -> DESTROYING -> DESTROYED
          |                    ^
          +--------------------+
```

Only the operation named for the current state is accepted. Ownership of a staged transaction
moves to the receiving actor only after `REGISTER_STAGED`; ownership of an open circuit moves only
after the source authenticates `ACTIVATE_CREATED`. Until then, cancellation/timeout remains the
caller's responsibility and triggers abort/destroy cleanup. Repeated abort/destroy messages are
idempotent; every other repeated or skipped transition is `CIRCUIT_STATE`.

### Established control mux and `LinkControlSession`

An established CONTROL cell's authenticated payload starts with an exact one-byte namespace:
`0x00` for link control and `0x01` for an actor fragment. No other value is valid. The namespace
leaves 1,145 bytes. An actor fragment therefore uses the existing 22-byte fragment header with at
most 1,123 data bytes. A link-control message is never fragmented and has this 44-byte body after
the namespace byte:

| Bytes | Field                                           |
| ----: | ----------------------------------------------- |
|     1 | protocol version (`0`)                          |
|     1 | kind: `LINK_PING`, `LINK_PONG`, or `STREAM_ACK` |
|     1 | flags (`0`)                                     |
|     1 | direction                                       |
|    16 | circuit ID                                      |
|     8 | route generation                                |
|    16 | kind-specific value                             |

The direction and circuit ID must equal the surrounding authenticated `CellCodec` header. A link
is circuit-scoped: `LinkCreate` allocates its circuit ID before any actor circuit is installed, and
the link is not shared by another circuit. `LINK_PING` and `LINK_PONG` require generation zero and
carry the same random 16-byte challenge. `STREAM_ACK` travels opposite the acknowledged data
direction and requires an open nonzero generation; its value is the highest contiguous
authenticated STREAM cell counter from that opposite direction as an unsigned 64-bit integer
followed by eight zero bytes. Link-control messages are consumed by `LinkControlSession` and never
dispatched to `RemoteActorHost`. Destroying the link's final circuit closes that link and stops its
liveness timer atomically.

Stream acknowledgement is hop-by-hop, not an end-to-end delivery receipt. Each link direction and
route generation has an independent STREAM `CellCodec` counter space. A relay terminates the
incoming sequence and reseals the plaintext into the next link's independent counter space. It
sends a cumulative `STREAM_ACK` to the previous hop only after the plaintext has entered the
bounded next-hop queue; the final endpoint acknowledges only after it has entered the bounded read
queue. If the next queue cannot accept the entire fragment, no acknowledgement is sent. DATAGRAM
cells remain atomic and best effort and receive no acknowledgement.

Every sender retains a bounded accounting record from STREAM counter to plaintext-byte count until
that counter is cumulatively acknowledged. It may clear packet/plaintext storage once ownership is
transferred to UDX, but the byte accounting remains charged. An ACK releases only records for its
same link, direction, circuit, and generation, up to the acknowledged counter. Regression, gaps
beyond a sent counter, wrong direction/generation, and duplicate old-generation ACKs fail closed.
An unacknowledged record times out after 5,000 ms and destroys the circuit rather than retrying or
falling back.

`CompiledRouteDuplex.drain()` captures the highest first-hop STREAM counter accepted before that
call. It resolves only when that generation's first-hop ACK covers the captured counter and the
local queue is below its low-water mark. It rejects if the route fails or is replaced first. This
has ordinary bounded-buffer semantics and is not a promise that the destination application read
the bytes; hop-by-hop delayed ACKs propagate downstream pressure without claiming end-to-end
delivery.

### `LinkLiveness`

UDX send completion does not prove that a remote UDP process still exists. Every established link
therefore has authenticated liveness independent of socket errors. Only an inbound cell that passes
AEAD authentication and all expected source, direction, epoch, circuit, counter-order, and replay-
window checks refreshes the receive deadline. A cryptographically valid replay does not. After 500
ms without one, the link sends `LINK_PING`; the peer returns `LINK_PONG`. If no qualifying inbound
cell arrives for 1,500 ms, the link closes even when UDX sends continue to report success.

Closing a link tombstones it, rejects queued sends and pending requests, and sends
`CIRCUIT_DESTROY` toward every still-live adjacent segment for each affected circuit. The two
surviving sides of a crashed process detect the loss independently, so all surviving route state
must reach zero within the 1,500 ms liveness window plus one 5,000 ms circuit cleanup deadline.
Heartbeats stop before socket close and cannot recreate a link or circuit.

### `CompiledRouteDuplex`

After `CREATED` is verified, `CompiledRouteDuplex` exposes a runtime-agnostic bounded duplex byte
stream plus the existing datagram path. It has no direct address or fallback capability.

- stream writes fragment into authenticated route payloads and honor bounded backpressure;
- datagram sends are atomic and fail when the route queue cannot accept a complete message;
- reads deliver only bytes recovered from the authenticated reverse path;
- `drain()` resolves only for the currently owned route generation;
- destroy is idempotent and cancels queued link sends and async control waits;
- route replacement produces a new generation and never reuses counters, keys, or IDs.

Milestone 3 may adapt this duplex to the behavior required by DHT-RPC or
`@hyperswarm/dht-relay`. It must use non-custodial signatures and must not disclose endpoint secret
keys to a gateway. That integration is intentionally absent here.

### Process runner and coordinator

A runtime-agnostic role script hosts one source, relay, or destination. A Node coordinator launches
seven Node processes or seven Bare processes, provides role-scoped configuration over inherited
stdio, and waits for structured readiness and teardown records.

The runner uses a small injected `ProcessControlChannel`, not ambient Node-only process behavior.
The wire framing is a four-byte big-endian length followed by canonical UTF-8 JSON, capped at 64
KiB. Commands are exactly `configure`, `start`, `fault`, `revoke`, `snapshot`, and `stop`; events
are exactly `configured`, `ready`, `snapshot`, `closed`, and `error`. Configuration is accepted
once, before start. Unknown keys, duplicate configuration, malformed framing, commands after
`stop`, and non-canonical values fail the process. The one terminal `closed` event remains required
after `stop`. Protocol frames use stdout only; redacted diagnostics use stderr only. The Node
adapter uses `process.stdin`/`stdout`; the Bare adapter imports the
lock-pinned `bare-process` module and exposes the same byte-channel interface.

The coordinator may see complete synthetic topology because it is the test auditor. Role processes
emit redacted events containing role, state, counters, synthetic link fingerprints, and resource
counts. They never log payloads, keys, full path arrays, or complete remote configurations.

An independent test-only configuration auditor, which production role code does not import,
constructs the exact permitted field schema, knowledge set, and direct-grant set for every role
from the full topology. Before launch it checks both the semantic object and serialized frame:
exact keys, exact allowed identities/advertisements, exact adjacent bilateral grants, no identity
or address outside that role's `may know` row, and no path array or nested grant beyond its
`may directly contact` row. It applies the same exact-schema checks to every emitted event and
stderr record; events may contain only local/adjacent link fingerprints and no raw address. This
makes address-knowledge and dialing separation tested properties, not inferences from capture.

## Fixed-Size UDX Datagram Classes

Every private-routing UDP payload is exactly 1,200 bytes. One socket carries two disjoint datagram
classes:

1. **Bootstrap datagrams** contain padded `LinkCreate`, `LinkCreated`, rejection, or cancellation
   setup messages. Their reserved class byte is outside the established `CellCodec` class range.
2. **Established cells** retain the existing `CellCodec` header, per-class keys, direction,
   counters, replay windows, payload bounds, and authenticated padding.

The decoder checks total size, protocol version, and class before allocation. Bootstrap payload
lengths and message types are bounded and canonical. Existing link-setup signatures and transcript
domains authenticate the embedded message. A bootstrap class cannot be interpreted as an
established cell, and an established class cannot enter setup parsing.

`BootstrapEnvelope` fixes the v0 layout so Node and Bare cannot make different correlation or
authentication choices:

|   Offset |    Bytes | Field                                                                |
| -------: | -------: | -------------------------------------------------------------------- |
|        0 |        1 | protocol version (`0`)                                               |
|        1 |        1 | bootstrap class (`0x80`; established classes remain `0..2`)          |
|        2 |        1 | type: `LINK_CREATE`, `LINK_CREATED`, `LINK_REJECT`, or `LINK_CANCEL` |
|        3 |        1 | flags (`0`)                                                          |
|        4 |        8 | nonzero request ID, big endian                                       |
|       12 |        8 | epoch, big endian                                                    |
|       20 |        2 | body length, big endian                                              |
|       22 |       32 | sender Ed25519 identity                                              |
|       54 |       32 | intended recipient Ed25519 identity                                  |
|       86 |       32 | signed link-grant digest                                             |
|      118 |       32 | request digest                                                       |
|      150 |    0–986 | canonical body                                                       |
| body end | variable | random padding through byte 1135                                     |
|     1136 |       64 | sender signature                                                     |

The signature covers the domain `hyperdht-private-routes/udx-bootstrap/v0` followed by bytes
0–1135, so padding mutation also fails authentication. `LINK_CREATE` and `LINK_CREATED` bodies are
exactly the existing canonical codecs. `LINK_REJECT` is exactly the rejected type (1 byte), an
allowlisted error code (1). `LINK_CANCEL` is exactly the rejected type (1). A `LINK_CREATE` has an
all-zero request digest. Every other type carries the hash of the entire signed 1,200-byte
`LINK_CREATE` it answers or cancels. Established-link teardown never uses the bootstrap class; it
uses authenticated `CIRCUIT_DESTROY` CONTROL cells.

The initiator chooses a cryptographically random, nonzero request ID that is unique for the
peer/epoch until its 5,000 ms tombstone expires. Every reply echoes the request ID, epoch, grant
digest, and signed-request digest, with sender and intended-recipient identities reversed. A
duplicate request with the same digest returns the cached identical result; the same ID with
another digest is rejected. Invalid or
unverifiable input is dropped silently. A responder may send `LINK_REJECT` only after verifying the
request signature, intended identity, and grant, preventing unauthenticated reflection. A signed
`LINK_CANCEL` removes only matching pending state. Replies after completion, cancellation, or the
deadline match only a tombstone and cannot open a binding.

Bootstrap padding is generated through injected randomness and is never returned to the protocol
caller. Exact constants remain experimental. Mutation of any byte, truncation, extension, request
ID reuse, response substitution, or cross-class reinterpretation fails before a binding opens.

## Route Construction and Data Flow

1. The destination process selects the configured private relays, builds encrypted templates, and
   registers them outward from private final to private entry over async UDX control sessions.
2. The source initiates safety construction: the source process establishes only its guard link,
   and the guard process establishes the safety-final link.
3. The destination produces an authorized descriptor containing only the public private-entry
   advertisement and opaque encrypted hops.
4. The source verifies endpoint authorization, descriptor signature, expiry, role, epoch, and
   protocol parameters.
5. The source sends `CREATE` through the safety segment and into the private entry.
6. Each private relay authenticates its layer, installs bounded forward/reverse state, and forwards
   only to its granted next hop.
7. The destination verifies the activation transcript and returns authenticated `CREATED` through
   the reverse path.
8. Only after the source verifies `CREATED` does `CompiledRouteDuplex` become writable.
9. Stream and datagram payloads cross all five relays in both directions as fixed-size cells.
10. Destroy, expiry, transport close, process exit, or failure removes the complete route
    generation.

## Failure and Resource Semantics

- Sockets bind explicitly to numeric addresses. Milestone 2 performs no DNS lookup, public DHT
  bootstrap, multicast, LAN discovery, or hole punching.
- Wrong-size datagrams and configured-address mismatches are rejected before expensive parsing.
- Pre-authentication parsing and pending handshakes have strict per-address and global limits.
- An unauthenticated datagram cannot install persistent state or trigger a response larger than the
  request.
- Setup expires after 5,000 ms. Late responses are rejected and cannot resurrect state.
- Duplicate, replayed, reordered, wrong-direction, wrong-epoch, and unknown-link messages use
  stable errors and leave unrelated circuits unchanged.
- A socket error, authenticated-liveness expiry after remote process exit, queue overflow, counter
  exhaustion, or missed deadline destroys the affected compiled circuit and clears route-owned
  queued plaintext and secrets. UDP send success alone never counts as peer liveness.
- Route replacement may choose another valid configured relay chain. The exact Milestone 2 graph
  has no alternate chain, so its injected failure reports `ROUTE_UNAVAILABLE`; exhaustion never
  enables a direct socket.
- Shutdown closes compiled streams, control sessions, actor bindings, then UDX sockets. Completion
  requires zero bindings, pending waits, queued packets/bytes, timers, and open sockets.
- A crashed process cannot zero inaccessible memory; surviving adjacent processes close on
  transport failure or bounded expiry and clear their owned state.

## Verification Layers

### Unit tests

An injected fake UDX adapter covers both Node and Bare:

- exact 1,200-byte send and receive boundary;
- every signed bootstrap field/padding mutation, request correlation/tombstone rule, and
  bootstrap/established class separation;
- numeric bind validation and adjacent address pinning;
- malformed size, version, class, length, and setup payload;
- async completion, timeout, cancellation, duplicate callback, and late response;
- actor fragment/message maxima and cross-request reassembly rejection;
- control-mux namespace separation and hop-by-hop ACK direction/counter/generation/watermark rules;
- liveness refresh, ping/pong challenge, silent remote death, and bounded failure propagation,
  including authenticated replays that must not postpone the 1,500 ms expiry;
- short/failed sends, socket close, reentrancy, queue overflow, and teardown;
- zeroization and zero retained handles after success and failure.

Every production behavior begins with a focused failing Brittle test. Existing 405-test virtual
Node/Bare suites, property cases, and 10,000-iteration fuzz gate remain green.

### Portable multi-process integration

The coordinator launches the exact seven-role topology on distinct loopback addresses. Separate
runs use all Node role processes and all Bare role processes. The suite verifies:

- exact semantic and serialized role projections before any child starts;
- destination private-route registration;
- source safety-route setup and compiled activation;
- bidirectional stream and datagram bytes;
- exact adjacent socket observations;
- relay process kill with heartbeat expiry, socket close, delayed `CREATED`, spoofed source,
  replay, queue overflow, and orderly shutdown;
- exact emitted-event schemas and absence of forbidden addresses or path arrays;
- no surviving bindings, waits, timers, queue bytes, or UDX sockets.

Portable tests are functional and cross-runtime evidence. Application-level observations are not a
substitute for packet capture.

### Linux namespace privacy gate

The Linux gate creates source, five relay, destination, and attacker/decoy namespaces on one shared
test bridge. Every synthetic address is reachable from every namespace so the network topology
does not itself enforce the expected route. Role control remains inherited stdio and creates no
bridge traffic.

A reachable decoy UDP listener represents a forbidden public-DHT/direct destination. The source
runner constructs a test-only `NegativeControlDialer` from the audited `negativeControl` field; it
is separate from `UdxCellEndpoint` and, if invoked, sends to that decoy. After an injected relay
failure the coordinator explicitly requests a retry while this capability is available. Private
policy must return `ROUTE_UNAVAILABLE` without invoking it. The oracle checks both a zero invocation
count and absence of a decoy packet, so fallback refusal is exercised rather than inferred from an
unused listener. Before the authoritative capture, a separate preflight run invokes the same
capability once and requires the decoy to receive it; the counter and capture are then reset. A
broken no-op test double therefore cannot make the privacy gate pass. This fixture-only field and
dialer are never exported or present in production configuration.

`tcpdump` captures all IPv4 and IPv6 traffic on the bridge during setup, bidirectional payload
exchange, an injected relay failure, retry, and shutdown. A deterministic checker attributes every
IP packet by namespace address. It does not prefilter by protocol or port. It requires:

- every observed directed edge belongs to the exact adjacent-hop matrix;
- source traffic has only the safety guard as its peer;
- destination traffic has only the private final relay as its peer;
- there is no source-to-destination or destination-to-source packet;
- no private endpoint contacts another relay, the decoy DHT listener, or an external address;
- every role-originated IP packet is UDP in the reserved test port range with exactly a 1,200-byte
  UDP payload; DNS, TCP, ICMP, another UDP port, and IPv6 autoconfiguration traffic fail the gate;
- required setup and bidirectional data edges were actually observed, preventing a vacuous pass;
- the failure produces teardown traffic/state without a prohibited replacement edge;
- no private-routing packet appears after all processes report closed.

The checker reports packet indexes and synthetic roles, not production addresses. Capture artifacts
contain only synthetic namespace traffic and are uploaded on failure for diagnosis.

## GitHub Actions

The Milestone 2 workflow is path-filtered to `packages/private-routes/**` and its own workflow and
script paths. It uses:

- read-only repository permissions;
- full immutable action SHAs;
- `npm ci` from the package lock;
- exact runtime assertions for Node, Bare, and the directly locked `udx-native` package;
- separate portable Node, portable Bare, and privileged Linux namespace jobs;
- no public DHT bootstrap and no network request from test processes;
- a capture-artifact upload step that runs only on failure.

The namespace job verifies `ip`, network namespace support, and `tcpdump` before launching. A
missing capability fails explicitly; it does not skip the privacy gate. The harness disables IPv6
autoconfiguration and drops only kernel-generated ICMP port-unreachable responses before capture.
Any later observed role-originated IPv6 or ICMP packet is therefore application behavior and a real
failure. This noise suppression does not filter or block any UDP/TCP attempt to the decoy, another
role, or an external address.

## Compatibility and Migration

- The package remains `private: true` and experimental.
- Milestone 1 virtual APIs and tests remain supported while the async transport boundary is added.
- No PearTube backend or UI file changes in Milestone 2.
- No HyperDHT or Hyperswarm dependency is required for the UDX graph itself.
- `udx-native` becomes a direct, lockfile-pinned dependency of the private-routes package so Node
  and Bare execute the same transport implementation.
- the process-runner fixture declares `bare-process` directly and lock-pins it instead of relying
  on a transitive dependency.
- The async interface is designed for the later HyperDHT adapter, but no compatibility claim is
  made until tested against the exact Hyperswarm-required DHT surface.

## Completion Gate

Milestone 2 is complete only when all of the following are independently reviewed:

- clean install succeeds from the package lock;
- the full virtual Node and Bare suites remain green;
- new UDX unit suites pass independently on Node and Bare;
- seven separate Node processes exchange routed stream and datagram bytes;
- seven separate Bare processes exchange the same bytes;
- Linux network namespaces exchange the same bytes over real UDX sockets;
- packet capture proves the exact adjacency matrix and all required non-events;
- an independent oracle proves exact serialized role configuration/event projections;
- relay loss and setup delay fail closed without any direct or decoy edge;
- authenticated liveness clears all surviving route state after a killed relay even while UDP
  sends still succeed;
- every graceful teardown reports zero owned state and open sockets;
- CI uses exact action SHAs, read-only permissions, and a required namespace job;
- README still says this is not routed HyperDHT, Hyperswarm, PearTube, or production anonymity.

Milestone 3 must not begin until this gate passes and the packet-capture oracle receives an
independent false-positive review.

## Deferred Questions

- Public relay discovery and address changes.
- NAT traversal for the source-to-guard and final-relay-to-destination links.
- DHT gateway selection, metadata minimization, and non-custodial signing.
- Mapping routed discovery and server signaling onto the exact HyperDHT interface Hyperswarm uses.
- Mixed Node/Bare role graphs beyond the all-Node and all-Bare completion matrices.
- Mobile suspend/resume, interface migration, and battery/performance budgets.
- Public testnet deployment, relay abuse controls, reputation, and incentives.
