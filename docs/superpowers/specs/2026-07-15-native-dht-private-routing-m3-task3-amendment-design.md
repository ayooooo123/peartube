# Native DHT Private Routing M3 Task 3 Amendment Design

**Status:** Owner-approved; independent spec review approved

**Amends:**

- `2026-07-14-native-dht-private-routing-m3-design.md`
- `2026-07-14-native-dht-private-routing-m3-wire-registry.md`
- Task 3 of `2026-07-14-native-dht-private-routing-m3.md`

## Purpose

Task 3 turns the authenticated index-zero guard link into two independent dynamic branches:

```text
lookup:   client -> shared guard -> lookup middle   -> lookup exit
announce: client -> shared guard -> announce middle -> announce exit
```

RED tests and a wire-to-code review exposed five details that the approved M3 design did not make
implementable. This amendment closes those details without changing existing M3 message IDs or the
fixed sizes of `LINK_OFFER_V1`, `LINK_ACCEPT_V1`, `REDACTED_RESPONDER_PROOF_V1`,
`EXTEND_REQUEST_V1`, `EXTENDED_V1`, or `TAIL_READY_V1`.

Task 3 ends with two `CONSTRUCTED` branches whose index-two exits have produced valid
`TAIL_READY_V1` confirmations. DHT exit activation, `DHT_EXIT_OPEN_V1`, destination handles, and
routed DHT commands remain Task 4 and later work.

## 1. Paired guard links

The two branches share exactly the pinned guard identity and canonical endpoint. They do not share
an accepted link, client circuit identity, branch ID, circuit ID, generation, keys, counters, replay
state, queues, limits, timers, logical channel, or teardown state.

Before either guard handshake begins, `RouteManager` allocates the two branch classes, branch IDs,
circuit IDs, generations, fresh client circuit identities, client tail keypairs, and construction
deadlines. Its private `BranchConstructionAuthority` issues two distinct one-use capabilities, one
for `LOOKUP` and one for `ANNOUNCE`, binding those exact values plus an initially unset opaque guard
lease. The first capability alone may atomically initialize that lease from a successful BootstrapIO
transfer. The second capability is unusable until initialization and thereafter reads the immutable
identity/endpoint lease. Lifecycle-generation and one-shot checks prevent failure or reentry from
initializing it twice. Neither IO accepts caller-supplied replacements for a capability field.

`RouteManager.openDynamic()` orchestrates the two IO factories. `BootstrapIO` consumes the first
branch-construction capability and transfers the first authenticated index-zero link. After that
handoff, direct authority becomes guard-only: no component may contact an arbitrary DHT endpoint.
A new `GuardRevalidationIO` consumes the other capability and may contact only the exact pinned guard
endpoint.

`GuardRevalidationIO` performs this one-use sequence:

1. Send `CAPS_QUERY_V1` with `maximumResults = 1`.
2. Complete the cookie retry against the same canonical endpoint.
3. Accept exactly one unfragmented `CAPS_RESPONSE_V1` containing only the pinned guard's exact
   advertisement. Reject zero results, referrals, additional advertisements, and every core
   fragment.
4. Complete one active challenge for that advertisement and endpoint.
5. Internally issue and consume one branch-bound guard-admission capability.
6. Exchange one `LINK_OFFER_V1` and one `LINK_ACCEPT_V1` for the other branch.
7. Derive the index-zero client/guard tail contexts from the exact accepted limits and transcript.
8. Receive and verify exactly one guard-signed `TAIL_READY_V1` under the new reverse context by
   `min(offerDeadline, admittedExpiry)`. No routed discovery or other tail command is permitted first.
9. Atomically transfer only the live client-side `M3AdjacencyRuntime`, opaque client tail capability,
   and a dedicated physical channel when one is owned, then erase and destroy all revalidation
   authority.

BootstrapIO applies the same steps 7–9 before its first branch transfer. On the guard, the responder
creates its own live `M3AdjacencyRuntime` and opaque guard tail endpoint before emitting
`TAIL_READY_V1`. A missing, duplicate, early-other-message, invalid, or late ready message revokes
both sides' link and tail material. Routed guard discovery cannot begin until index zero is ACTIVE.

The first advertisement establishes the pinned identity and endpoint. Revalidation accepts either
the byte-identical still-live advertisement or a strictly higher epoch advertisement that has a
valid signature, the same relay identity, and the exact same canonical endpoint. A same-epoch
different advertisement, a lower epoch, expired bytes, endpoint drift, or identity drift fails.
`BranchConstructionAuthority` records the exact advertisement digest and epoch used by each branch;
it does not require the two digests to match after a permitted epoch advance.

If the first acquisition fails, the manager revokes both construction capabilities and erases both
branch allocations. If the second acquisition fails, it destroys the already-transferred first
logical link and any dedicated transport exactly once, revokes both capabilities, and publishes no
guard-ready branch. No caller can retain one half of a failed pair.

The first guard handoff establishes **guard readiness**, which permanently removes arbitrary direct
bootstrap authority. Full route readiness occurs only after both branches reach `CONSTRUCTED`.
Guard readiness permits `GuardRevalidationIO` only for the pinned endpoint. It does not restore
legacy lookup, referral probing, hostname resolution, generic send, or any other endpoint authority.

## 2. Deterministic M3-to-cell binding and live adjacency runtime

M2 forwarding requires a `u64` epoch and two distinct 16-byte adjacency-local circuit identifiers.
M3 supplies a branch generation, one branch circuit ID, and a complete signed bilateral offer. The
mapping is:

```text
cellEpoch = branchGeneration

initiatorCellId = first16(
  digest('hyperdht-private-routes/m3/cell-id/initiator/v1', completeOfferDigest)
)

responderCellId = first16(
  digest('hyperdht-private-routes/m3/cell-id/responder/v1', completeOfferDigest)
)
```

`first16` means digest byte range `[0, 16)`. `completeOfferDigest` is the already-approved digest of
the complete 374-byte signed `LINK_OFFER_V1`. `digest(domain, bytes)` uses the canonical M3 domain
encoding `u16be domainByteLength || UTF8(domain) || bytes`, hashed with `cryptoSuite.hash`.

For the initiator runtime:

```text
circuitId   = branch circuit ID
epoch       = branch generation
localId     = initiatorCellId
peerLocalId = responderCellId
```

The responder runtime reverses `localId` and `peerLocalId`. Both peers derive the same values from
authenticated bytes; no new field or caller-supplied identifier is accepted.

Each node has an `M3AdjacencyAuthority`. Relay nodes associate it with their local `RelayService`;
source/client nodes use the same bounded runtime authority without a forwarding service. Before any
callback it atomically reserves its one local live-binding key `(peerIdentity, localId)`. It rejects all-zero
identifiers, equal initiator/responder identifiers, a local key already live or reserved, mismatched
independent derivation, and capacity exhaustion. It then creates one exclusive
`M3AdjacencyRuntime` containing:

```text
circuitId, epoch, localIdentity, peerIdentity, localId, peerLocalId,
expiresAt, CONTROL contexts, STREAM contexts, DATAGRAM contexts
```

The contexts come from the authenticated M3 adjacency key schedule; they are not M2 topology-grant
contexts. The runtime is the sole owner of its live keys, nonce prefixes, send counters, receive
replay state, expiry, logical channel, and local binding reservation. No ticket or endpoint may copy
those live fields.

In `TAIL_ENDPOINT` mode the runtime opens and seals hop cells, advances its real counters, and
terminates tail-control traffic. When the node becomes an intermediate,
`RelayService.installM3(previousRuntime, nextRuntime)` validates both runtimes and their still-live
reservations before detaching either. It atomically moves—not copies—their current contexts,
counters, replay windows, channels, and reservation ownership into one forwarding record and disables
both tail endpoints. A runtime transfers once and every later method stable-fails.

Unlike unchanged M2 `RelayService.install()`, `installM3()` accepts independently authenticated
adjacent expiries. Its forwarding record expires at `min(previousExpiry, nextExpiry)` and clamps both
owned sides to that value. It rejects an already-expired minimum, identity/branch/circuit/generation
mismatch, same peer, same local ID, wrong direction, or prior transfer. Validation and capacity
reservation complete before ownership moves. Failure before the move leaves the exact live runtimes
and their advanced counters intact; failure after the move destroys the entire branch record and
never restores or rolls counters back. A retry uses a fresh outgoing extension; failure that destroys
the previous runtime rebuilds that branch from its guard link.

The successor emits its redacted proof only after its incoming runtime is live in `TAIL_ENDPOINT`
mode. If either peer fails, authenticated adjacency teardown causes each local authority to revoke
its own runtime; no cross-process object or distributed atomic transaction is assumed.

The authority defaults to 128 live adjacency runtimes and has a hard configurable maximum of 4,096.
For a relay-associated authority, its configured maximum may not exceed the associated relay
service's circuit capacity. It sweeps
expired reservations synchronously on every public entry point. A collision fails the current
construction attempt; it never falls back to a topology grant or raw identifier. A later retry uses
a fresh offer and generation. Fixed vectors cover both labels, `[0,16)` truncation, reciprocal
runtimes, independent expiry clamping, and cross-offer/branch separation.

The directional cell keys remain derived from the authenticated adjacency shared secret and the
complete OFFER/ACCEPT transcript. Coordinator topology grants, M2 link handles, and M2 bootstrap
envelopes are not accepted at an M3 production entry point.

## 3. Redacted responder proof carrier

Index zero is adjacent to the client, so the client directly verifies its guard acceptance. Indices
one and two require the current tail to return a successor-signed redacted proof without forwarding
the address-bearing acceptance.

For extension indices one and two, the adjacency setup sequence is exactly:

```text
current tail -> successor: LINK_OFFER_V1                 (374 bytes)
successor    -> current tail: LINK_ACCEPT_V1             (285 bytes)
successor    -> current tail: REDACTED_RESPONDER_PROOF_V1 (378 bytes)
```

The proof is the only permitted third setup object and travels on the same adjacency-local setup
channel before forwarding becomes active. It must arrive within the original non-extending
five-second extension deadline. The successor signs it only after accepting the exact offer and
deriving admitted limits. The current tail verifies the signature, advertisement digest, identities,
branch, circuit, generation, index, client tail key, nonce, route-encryption key, admitted-limits
digest, expiry, and uniqueness before installing forwarding.

The current tail then nests the complete 378-byte proof in `EXTENDED_V1`. It never forwards
`LINK_ACCEPT_V1`, the observed predecessor endpoint, adjacency ephemeral keys, accept nonce, or
complete offer/accept digests. Missing, additional, reordered, malformed, replayed, or inconsistent
setup objects tear down the partial adjacency and erase all temporary state.

This amendment changes the wire registry's authoritative carrier table: for indices one and two the
byte-identical proof is first carried as the standalone third adjacency setup object and is then
nested unchanged in `EXTENDED_V1`. It is never fragmented in either location. The setup parser
accepts exactly OFFER, ACCEPT, PROOF with no trailing bytes, fourth object, alternate message ID, or
reordering. All three share the original offer/extension deadline.

## 4. Diversity authority and knowledge split

A successor sees only its direct initiator and itself. It cannot prove that its identity was absent
from an earlier hop or the other branch. Full path diversity is therefore enforced before dialing by
a manager-owned opaque `BranchPathAuthority`.

`BranchPathAuthority` owns copied identity and endpoint commitments for both branches. A separate
`RoutedCandidateDirectory` verifies routed discovery evidence and mints candidate capabilities. A
candidate capability is bound to:

- the complete signed advertisement and digest;
- the `RELAY_DISCOVER_V1` request nonce and exact AEAD-authenticated response bytes;
- the current tail identity and advertisement digest that answered the request;
- exact branch class, branch ID, circuit ID, and generation;
- requested extension index and required role;
- the candidate identity, role, canonical endpoint, epoch, and expiry;
- a non-extending deadline no later than the original request deadline or advertisement expiry.

Direct Task 2 active-validation capabilities are a distinct brand and reject here. At most eight
candidate capabilities may be minted from one response and at most sixteen may be live across the
paired construction. Each is one-use and is consumed before `EXTEND_REQUEST_V1` is encoded.

`RELAY_DISCOVER_RESPONSE_V1` is authenticated by the current tail-control AEAD and its nested
advertisement signatures; the response object itself is not signed and has no expiry field. On the
client, `TailControlSession` mints a local `AuthenticatedDiscoveryEvidence` capability only after
AEAD verification and complete bounded reassembly. It binds the exact response bytes, request nonce,
tail-context identity, branch/generation/index/role, and original request deadline.
`RoutedCandidateDirectory` consumes that capability and uses the request deadline, advertisement
expiry, and tail-context expiry to compute each candidate deadline.

Independently, when the current tail constructs its response it stores one-use local digest
admissions for the advertisements actually returned, bound to the same request nonce,
branch/generation/index/role, current-tail context, and request deadline. Its tail adjacency
initiator must consume the matching local admission before dialing. Thus neither a forged client
capability nor a valid advertisement omitted from that tail's response can authorize contact.

`BranchPathAuthority` consumes that routed-candidate capability and issues one single-use extension
authorization bound to:

- exact branch class, branch ID, circuit ID, and generation;
- exact next extension index;
- current tail identity;
- candidate advertisement digest, identity, role, and endpoint;
- the paired branch generation and shared guard lease;
- the current construction deadline.

It enforces:

- lookup index zero equals announce index zero in guard identity and endpoint only;
- the two index-zero accepted links and all cryptographic/runtime state are distinct;
- no middle or exit equals the guard;
- lookup middle, lookup exit, announce middle, and announce exit are pairwise distinct;
- no index is skipped, repeated, or concurrently reserved;
- a candidate is used by at most one live construction reservation.

The authorization exposes no path array, raw identity set, dial function, topology grant, or
address-bearing acceptance. The client coordinator consumes the authorization locally before
encoding `EXTEND_REQUEST_V1`; no capability object or extra bytes cross the network. The
current-tail initiator verifies the authenticated request fields and atomically reserves its own
single-use `(branch, circuit, generation, index, extensionNonce, candidateDigest)` request admission
before invoking its narrow candidate-dial authority.

The successor still enforces everything visible on its adjacency: exact offer signature and
transcript, self-loop, direct-predecessor equality, role/index matrix, advertisement identity and
expiry, local branch/index replay, limits, deadline, X25519 public keys, and local capacity. These
local checks complement rather than replace manager enforcement.

On failed pair acquisition, failed extension, replacement, successful handoff, or manager destroy,
the authorities synchronously clear every no-longer-required endpoint, identity, advertisement
digest, response transcript, nonce, reservation, timer, and checker reference. After construction,
the manager retains only the minimum live per-branch identities and opaque link/tail capabilities
needed for teardown; it does not retain discovery responses or a serializable full path.

## 5. Setup-only ordered tail control

Dynamic extension requires authenticated ordered client-to-current-tail commands before Task 4 can
activate the DHT exit. Task 3 therefore creates `TailControlSession` with the minimum production
surface needed for construction:

- derive the exact index-specific source/tail context from the approved tail transcript;
- maintain independent forward and reverse keys, nonce prefixes, exact-next counters, command/byte
  budgets, and a non-extending deadline;
- carry `RELAY_DISCOVER_V1`, `RELAY_DISCOVER_RESPONSE_V1`, `CORE_FRAGMENT_V1` only when its nested
  object ID is `RELAY_DISCOVER_RESPONSE_V1`, `EXTEND_REQUEST_V1`, `EXTENDED_V1`, and
  `TAIL_READY_V1` during Task 3;
- destroy each actor's prior tail context at the actor-local transitions defined below;
- erase all keys, counters, replay state, queued frames, timers, and partial extension state on any
  failure or route teardown.

Intermediate relays receive only fixed-size authenticated route cells. In particular, the guard
never receives the exit advertisement, exit identity, exit endpoint, address-bearing acceptance, or
decryptable index-two tail-control contents.

Task 4 modifies this session to add index-two finalization and terminal control. It does not redefine
Task 3 derivation, counters, or construction messages.

From the client perspective routed discovery is one bounded tail-control request and never direct or
iterative client IO. The current tail may perform the approved bounded ordinary random-target public
DHT walk. One request may return at most eight signed advertisements. A response object is at most
4,449 bytes, may use at most five canonical core fragments, reserves its full declared byte length
before accepting fragment payload,
and has one non-extending 5,000 ms deadline. Fragments for any other nested message, conflicts,
duplicates with different bytes, gaps at the deadline, extra fragments, or trailing bytes fail the
request and mint no candidate capability.

The construction class/direction matrix is exact:

| Sender       | Receiver                     | Context                              | Permitted Task 3 messages                                                 |
| ------------ | ---------------------------- | ------------------------------------ | ------------------------------------------------------------------------- |
| client       | current tail                 | prior `TAIL_CONTROL_ORDERED` forward | `RELAY_DISCOVER_V1`, `EXTEND_REQUEST_V1`                                  |
| current tail | client                       | prior `TAIL_CONTROL_ORDERED` reverse | `RELAY_DISCOVER_RESPONSE_V1`, permitted response fragments, `EXTENDED_V1` |
| current tail | successor                    | adjacency setup channel              | `LINK_OFFER_V1`                                                           |
| successor    | current tail                 | adjacency setup channel              | `LINK_ACCEPT_V1`, then `REDACTED_RESPONDER_PROOF_V1`                      |
| successor    | client through partial route | new `TAIL_CONTROL_ORDERED` reverse   | exactly one `TAIL_READY_V1` before activation                             |

No Task 3 message is valid in another class, direction, context, or actor state.

The client cannot derive the new tail context until it verifies `EXTENDED_V1`. The current tail uses
the half-open successor runtime to authenticate and open at most one 1,200-byte reverse CONTROL cell,
advancing that runtime's real receive state. It verifies the binding-attributed branch, circuit,
generation, index, direction, and the public context-class byte, then quarantines exactly the
extracted 1,101-byte `M3ContextEnvelope`. The inner 1,100-byte tail frame remains opaque and only the
client can decode it as `TAIL_READY_V1`. No stream, datagram, second cell, wrong-context envelope, or
unauthenticated bytes are buffered.

The current tail first enqueues `EXTENDED_V1` on the prior reverse ordered-control queue. Only after
that enqueue succeeds does it pass both runtimes and the quarantined envelope to `installM3()`.
`installM3()` atomically commits forwarding, then its new forwarding-record capability—not the
former tail session—reseals the envelope as a fresh previous-adjacency CONTROL cell using the moved
runtime's current send counter and releases it behind the same previous-link FIFO barrier. It never
forwards the successor cell bytes unchanged. Failure before ownership moves leaves the runtimes live
and clears the envelope. Failure to reseal or queue after the move destroys the installed forwarding
record and the branch; it never calls a moved runtime. If the delivered payload is not the expected
`TAIL_READY_V1`, the client destroys the partial extension.

`TAIL_READY_V1` must authenticate by the earlier of the original extension deadline and admitted
expiry. After EXTENDED is authenticated and the new context is derived, the client destroys its old
tail context before waiting on the new one. After EXTENDED enqueue and successful `installM3`, the
former tail erases its side of the old end-to-end tail context because it is now only an intermediate.
Neither actor waits for an acknowledgement it cannot observe. Timeout, wrong-context input, early
extra input, or a failed barrier destroys the branch and all new-tail material.

## 6. Production API and ownership

The M2 `RouteManager` constructor and synchronous `open()` remain unchanged for M2 tests. M3 uses a
separate entry point. The manager owns construction from before the first guard offer:

```js
const manager = RouteManager.createDynamic(options);
const branches = await manager.openDynamic();
```

The exact Task 3 option surface is:

```js
const options = {
  bootstrapIOFactory,
  guardRevalidationIOFactory,
  tailControlTransportFactory,
  adjacencyAuthority,
  routedDiscoveryService,
  now,
  schedule,
  cancel,
  randomBytes,
  crypto,
  limits,
};
```

The three factories each receive one frozen zero-key manager-minted request capability.
`bootstrapIOFactory` and `guardRevalidationIOFactory` return the corresponding IO object; the
IO object's one-use `open()` returns only its library-branded transfer. `tailControlTransportFactory`
returns byte-oriented transport authority and never replaces `TailControlSession` or
`RouteExtensionSession`. `adjacencyAuthority` is an `M3AdjacencyAuthority` owned by the local node.
`routedDiscoveryService.request(requestCapability)` performs the bounded routed request used by the
real candidate directory and accepts no endpoint or candidate override. `now`, `schedule`, `cancel`,
`randomBytes`, and `crypto` use the same provider contracts as the existing M3 modules. `limits` is
a frozen object of optional protocol-limit overrides; omitted entries use the approved safe defaults
and no override may exceed an approved hard cap.

The public package index exports `RouteManager`, `RouteExtensionSession`, and
`M3AdjacencyAuthority`. `M3AdjacencyRuntime`, `GuardRevalidationIO`, `RoutedCandidateDirectory`, and
`TailControlSession` are implementation modules, not public construction APIs. For tests only,
`lib/route-manager.js` exports `TEST_ONLY_DYNAMIC_OBSERVER`; the public index must not re-export it.
It receives frozen, copied, redacted lifecycle snapshots and must never expose a raw identifier,
identity, endpoint, advertisement, key, nonce, counter, runtime, capability, or channel.

The public authority constructor is
`new M3AdjacencyAuthority({ now, crypto, maxRuntimes })`; `crypto` defaults to the package crypto
suite, `maxRuntimes` defaults to 128, and the existing hard maximum of 4,096 still applies.

`options` does not contain prebuilt links, candidate capabilities or endpoints, topology grants, M2
link handles, branch IDs, circuit IDs, generations, or path arrays. The manager allocates all branch
state and consumes the opaque guard/candidate/link transfers itself. Unknown option keys reject
before allocation or callbacks. `openDynamic()` accepts no arguments.

`RouteExtensionSession` is the client-side coordinator. The current-tail and successor work occurs
in separate internal actor sessions; no object owns both address-bearing adjacency acceptance and
client tail keys.

The client coordinator states are:

```text
REQUESTED -> EXTENDED -> ACTIVE
    \           \          \
     -> FAILED -------------> DESTROYED
```

- `REQUESTED`: owns the routed candidate, extension authorization, client tail ephemeral, nonces,
  prior tail context, timer, and expected transcript.
- `EXTENDED`: owns a verified redacted proof and admitted limits; it has derived the new context but
  has not accepted `TAIL_READY_V1`.
- `ACTIVE`: owns a verified `TAIL_READY_V1`; the opaque tail capability may transfer once.
- `FAILED`: generic teardown was attempted and every partial key, timer, reservation, channel, and
  forwarding entry is erased.
- `DESTROYED`: terminal and idempotent; no queued or reentrant callback may publish new state.

The current-tail initiator states are `IDLE -> OFFER -> ACCEPTED -> PROVED -> COMMITTED`, plus
terminal `FAILED` and `DESTROYED`. It alone sees `LINK_ACCEPT_V1`, the observed predecessor endpoint,
and adjacency link keys. It returns only `EXTENDED_V1` with the nested redacted proof.

The successor responder states are `IDLE -> OFFER_VERIFIED -> ACCEPTED -> PROOF_SENT -> HALF_OPEN`,
then `ACTIVE`, plus terminal `FAILED` and `DESTROYED`. `HALF_OPEN -> ACTIVE` occurs when its signed
`TAIL_READY_V1` envelope is successfully sealed and admitted to the successor-adjacency send queue;
there is no ready acknowledgement. Client ACTIVE remains a distinct transition on successful ready
verification. The responder owns the replay entry, incoming adjacency runtime, separate new-tail
capability, and one early ready envelope. It never receives earlier path or paired-branch identity
sets.

The session snapshots every external method, reserves capacity/replay authority before callbacks,
checks a lifecycle generation after every callback and inside every queued microtask, and transfers
ownership before calling external close/destroy methods.

`RouteManager` owns paired-branch diversity, shared-guard metadata, construction ordering, active
and draining generations, and whole-branch teardown. The current tail owns candidate direct-dial
authority and adjacency setup. The successor owns its responder replay cache, accepted adjacency,
route-encryption secret, and new tail context. The transport multiplexer owns the physical socket;
each branch owns a distinct authenticated logical channel even when the physical socket is shared.

For every accepted index, the client and successor each derive their own opaque tail-context
capability immediately and clear the raw X25519 shared secret and ephemeral secret after derivation.
The successor actor and `TailControlSession` separately own the opaque tail-context capability; it is
never stored in or moved with `M3AdjacencyRuntime` and never contains the long-term route-encryption
secret. At index two only, each side also creates an opaque one-use
`FinalExitSeed` containing the copied shared secret and exact transcript needed by Task 4; it has no
read API and is cleared on failure, expiry, branch destroy, or after Task 4 consumes it.

## 7. Failure and readiness rules

- Every setup and extension deadline is at most 5,000 ms and never extends.
- `BranchPathAuthority` permits exactly two simultaneous extension reservations total and at most
  one per branch. A consumed authorization remains a tombstone until its extension deadline.
- Each branch/index permits at most three discovery requests, so paired construction permits at most
  twelve requests total. `RoutedCandidateDirectory` permits eight candidates per response, sixteen
  live capabilities, and ninety-six total live-plus-tombstoned candidate states. Tombstones count
  against the total but not the sixteen-live limit and expire at the original request deadline.
  Client evidence and current-tail digest-admission directories use the same request and state caps.
- Current-tail extension-request admissions permit exactly one in progress per branch and two total;
  their consumed compound keys remain tombstoned until the extension deadline.
- `M3AdjacencyAuthority` defaults to 128 and caps at 4,096 live runtimes as specified above.
- Responder OFFER and proof replay caches each default to and cap at 4,096 entries per responder
  authority. Their compound keys bind responder identity, advertisement epoch, branch class,
  branch ID, circuit ID, generation, index, and complete offer or proof digest.
- Reservations are inserted before any callback, random provider, timer provider, property access,
  or queued work. They expire at the applicable non-extending deadline, fail with `ERR_BUSY` at
  capacity without eviction, sweep synchronously on every entry point, and clear on destroy.
- Pre-authentication allocation failure releases an unpublished reservation. Once a signed offer,
  proof, candidate, or authorization is observed or emitted, its replay tombstone remains until the
  deadline even when the operation fails.
- A failure sends only a generic destroy reason where an authenticated adjacency exists.
- Partial extension failure installs no live forwarding entry and leaves no circuit authority.
- A failure before `installM3()` ownership transfer leaves the exact previous tail runtime live and
  may retry a fresh outgoing extension while the branch deadline remains live. A failure after
  transfer destroys that branch and rebuilds it from its independently authenticated guard link.
- Live make-before-break rotation, suspend/resume, and network-change policy remain Task 5.
- `CONSTRUCTED` is not DHT-ready. Task 4 must complete exit activation and `DHT_EXIT_OPEN_V1` before
  routed DHT operations are exposed.
- No M3 error permits ordinary DHT fallback, direct peer fallback, or topology-grant fallback.

## 8. Verification requirements

Task 3 must prove in Node and Bare:

- byte-exact role/index handling for guard, middle, and exit;
- two branch links share only guard identity and endpoint;
- deterministic cell binding is identical at both peers and differs across adjacencies/branches;
- fixed vectors cover both cell-ID labels, `[0,16)` truncation, branch generation as epoch, reciprocal
  runtime fields, collisions, one-use ownership moves, independent expiry clamping, and rollback;
- proof transport is exactly OFFER, ACCEPT, then redacted proof for indices one and two;
- routed candidate discovery is tail-bound, bounded to eight results/five fragments/4,449 bytes, and
  never grants the client direct-dial authority;
- the actor state machines and construction class/direction matrix reject every cross-actor or
  cross-context message;
- `EXTENDED_V1` is queued before the one-cell early `TAIL_READY_V1` quarantine is released;
- replay, expiry boundaries, self-loop, repeated identity, cross-branch substitution, wrong
  role/index/transcript, omitted consent, and address substitution fail closed;
- topology grants and M2 link handles reject at every production M3 entry point;
- guard observation contains no exit advertisement, identity, endpoint, acceptance, or plaintext;
- partial failure, timeout, destroy, reentrant callback, and queued-callback races erase secrets and
  close every owned resource exactly once;
- two constructed branches are cryptographically and operationally independent;
- existing M2 tests remain unchanged and green.
