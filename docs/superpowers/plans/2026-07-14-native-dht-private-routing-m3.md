# Native DHT Private Routing M3 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents are available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver private HyperDHT discovery and record storage over three-relay UDX circuits without exposing a required-mode client's endpoint to DHT peers, while leaving all peer-connection surfaces closed until M4.

**Architecture:** `hyperdht-private-routes` owns circuit construction, relay capability discovery, opaque destination handles, fixed-size cells, leases, and mobile lifecycle. `dht-rpc` gains a transport-neutral routed mode whose iterative query engine works with cryptographic destination references instead of IP-derived peers. `hyperdht` owns the public `privateRouting: { mode: 'required' }` API and signed private presence/storage records. PearTube pins the tested commits but does not expose the user switch before M4.

**Tech Stack:** JavaScript (ESM and CommonJS), UDX, DHT-RPC, HyperDHT, compact-encoding, sodium-universal, brittle, Node.js, Bare, Linux network namespaces, tcpdump, and GitHub Actions.

**Authoritative design:** `docs/superpowers/specs/2026-07-14-native-dht-private-routing-m3-design.md`

**Review status:** Independently approved chunk by chunk on 2026-07-14.

---

## Repository Map and Delivery Order

| Name                                 | Working tree                                                                                                      | Delivery branch                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| PearTube / `hyperdht-private-routes` | `/Users/jd/Documents/Codex/2026-07-10/task-extract-three-packages-into-standalone/peartube-private-routing`       | `feature/hyperswarm-private-routing-implementation`    |
| Standalone `hyperdht-private-routes` | create `/Users/jd/Documents/Codex/2026-07-10/task-extract-three-packages-into-standalone/hyperdht-private-routes` | `main`, then `feature/native-private-routing-m3`       |
| `dht-rpc` fork                       | `/Users/jd/Documents/Codex/2026-07-10/task-extract-three-packages-into-standalone/dht-rpc-private-routing`        | create `feature/native-private-routing-m3` from `main` |
| `hyperdht` fork                      | `/Users/jd/Documents/Codex/2026-07-10/task-extract-three-packages-into-standalone/hyperdht-private-routing`       | create `feature/native-private-routing-m3` from `main` |

Implement and land in this order:

1. `hyperdht-private-routes`: protocol primitives, dynamic circuits, exit service, lifecycle.
2. `dht-rpc`: routed IO and destination-reference query seam; no dependency on the other repositories.
3. `hyperdht`: private record semantics and required-mode API using exact commits from 1 and 2.
4. PearTube integration: exact tested pins, real-process testnet, packet-capture leak oracle, and GitHub CI.

Do not publish any package during M3. Use exact Git commit dependencies in integration branches, record the SHAs in the acceptance report, and leave npm publishing for a separately approved release task.

## Chunk 1: `hyperdht-private-routes` M3 Protocol and Lifecycle

### Task 0: Amend the approved design with a canonical M3 wire registry

**Files:**

- Create: `docs/superpowers/specs/2026-07-14-native-dht-private-routing-m3-wire-registry.md`
- Modify: `docs/superpowers/specs/2026-07-14-native-dht-private-routing-m3-design.md`

- [x] Before writing M3 implementation code, define one canonical wire registry containing numeric message IDs, fixed field order, integer endian/width, length-prefix width, signature domain and covered bytes, exact maximum body/collection sizes, and rejection rules for: signed capability advertisements; `CAPS_QUERY_V1`/response; active challenge/response; `RELAY_DISCOVER_V1`/response; `LINK_OFFER_V1`; `LINK_ACCEPT_V1`; redacted responder proof; `EXTENDED_V1`; `TAIL_READY_V1`; `DHT_EXIT_ACTIVATE_V1`; `DHT_EXIT_READY_V1`; `DHT_EXIT_READY_ACK_V1`; `DHT_EXIT_OPEN_V1`; destination references; typed routed request/reply; every storage command, token, receipt, and signed response used in Chunk 3.
- [x] Pin `M3_PROTOCOL_VERSION = 1`, `LOOKUP = 0`, `ANNOUNCE = 1`, the five context-class values from the approved design, advertisement count at eight, replay window at 64, and every inherited 1,200/1,101/1,100/1,073-byte framing bound. No “implementation defined” field is permitted.
- [x] Add size arithmetic tables proving each bounded message fits its selected fixed-cell fragmentation or direct-bootstrap transport. Specify fragment count/byte/time limits for any body larger than one route payload.
- [x] Cross-link the registry from the design and state that the registry is normative for bytes while the design is normative for behavior.
- [x] Obtain independent protocol review and explicit owner approval of the registry amendment. **Stop here** if either is missing; Task 1 must not choose wire layouts during implementation.
- [x] Commit: `docs: freeze native private routing m3 wire registry`

### Task 1: Freeze M3 protocol identifiers and byte-exact codecs

**Files:**

- Modify: `packages/private-routes/lib/protocol.js`
- Create: `packages/private-routes/lib/m3-context.js`
- Create: `packages/private-routes/lib/tail-control.js`
- Create: `packages/private-routes/lib/final-exit.js`
- Modify: `packages/private-routes/lib/errors.js`
- Modify: `packages/private-routes/index.js`
- Create: `packages/private-routes/test/m3-protocol.test.js`
- Create: `packages/private-routes/test/m3-vectors.test.js`
- Create: `packages/private-routes/test/m3-errors.test.js`

- [ ] Write failing codec tests against the owner-approved wire registry for every M3 enum and envelope. Include byte vectors for the 54-byte `M3ContextAD`, the 1,101-byte context envelope, tail transcript, final-exit transcript, service-policy digest, and payload-parameters digest.
- [ ] Assert exact rejection for unknown enum values, duplicate service-policy entries, non-canonical ordering, length mismatch, integer overflow, trailing bytes, and one-field associated-data substitution.
- [ ] Run `npm run test:one -- test/m3-protocol.test.js test/m3-vectors.test.js test/m3-errors.test.js` from `packages/private-routes`; expect failures for missing exports and error constructors.
- [ ] Add versioned constants without changing M2 v0 domains. The new public shape must include:

```js
export const RELAY_CAPABILITY = Object.freeze({
  CIRCUIT_RELAY_V1: 1,
  DHT_EXIT_V1: 2,
  PRIVATE_RECORDS_V1: 4,
});

export const CONTEXT_CLASS = Object.freeze({
  TAIL_CONTROL_ORDERED: 0,
  TAIL_FINALIZE_DATAGRAM: 1,
  FINAL_EXIT_FINALIZE_DATAGRAM: 2,
  ROUTE_PAYLOAD: 3,
  TERMINAL_CONTROL_ORDERED: 4,
});

export const M3_PROTOCOL_VERSION = 1;
export const BRANCH_CLASS = Object.freeze({ LOOKUP: 0, ANNOUNCE: 1 });
```

- [ ] Implement strict encode/decode functions with explicit maximum sizes from the spec; copy decoded buffers before retention and zero temporary key material on every terminal path.
- [ ] Add stable error constructors and exact-code tests for privacy unavailable, branch rotation, incompatible relay, authentication, replay, quota/busy, records unavailable, and destroyed state.
- [ ] Export only the protocol-level constants/codecs needed by consumers from `index.js`; keep key-schedule helpers internal unless tests require a named test-vector function.
- [ ] Run `npm run test:one -- test/m3-protocol.test.js test/m3-vectors.test.js test/m3-errors.test.js`, then `npm run test:node`; expect all focused tests and all existing M2 tests to pass.
- [ ] Run `npm run format:check` and `git diff --check`.
- [ ] Commit: `feat(private-routes): define m3 circuit protocol`

### Task 2: Add signed relay advertisements and bounded compatible discovery

**Files:**

- Create: `packages/private-routes/lib/relay-capability.js`
- Create: `packages/private-routes/lib/compatible-discovery.js`
- Create: `packages/private-routes/lib/bootstrap-io.js`
- Modify: `packages/private-routes/lib/discovery-evidence.js`
- Modify: `packages/private-routes/lib/errors.js`
- Modify: `packages/private-routes/index.js`
- Create: `packages/private-routes/test/relay-capability.test.js`
- Create: `packages/private-routes/test/compatible-discovery.test.js`
- Create: `packages/private-routes/test/bootstrap-io-authority.test.js`

- [ ] Write failing tests for signed advertisements, expiry, replay, active challenge/response, minimum service-policy constraints, XOR/prefix diversity, and role compatibility.
- [ ] Write the cold-start matrix: compatible bootstrap succeeds; legacy-only mode sends exactly one non-iterative legacy `FIND_NODE` to one configured bootstrap; all referral sources share one global three-challenge budget; malicious referral cannot force an extra direct probe; the option disabling legacy discovery performs zero legacy requests; exhaustion returns `ERR_PRIVACY_UNAVAILABLE`.
- [ ] In `bootstrap-io-authority.test.js`, wrap socket construction/send/bind and the normal DHT iterative API in authority traps. Assert bounded direct discovery is the only authority before guard pinning; discovery stops immediately after pinning, destroys the socket, clears address/referral state, and performs no direct IO after pinning or after private readiness resolves.
- [ ] Run `npm run test:one -- test/relay-capability.test.js test/compatible-discovery.test.js test/bootstrap-io-authority.test.js`; expect missing-module failures and authority-trap failures.
- [ ] Implement a `RelayCapabilityDirectory` that accepts only signature-valid, unexpired advertisements and promotes a relay only after an active challenge succeeds over the address already authorized by discovery evidence.
- [ ] Implement `CompatibleDiscovery` with explicit counters (`publicProbeCount`, `candidateRejectCount`, `activeValidationCount`) and an injectable clock/random source. It must never return an unvalidated relay as a route candidate.
- [ ] Implement `BootstrapIO` as the sole direct cold-start authority. It supports compatible `CAPS_QUERY_V1`, one optional single-node legacy `FIND_NODE`, and active guard challenges only. It exposes no generic request/query method and transfers an authenticated, single-use guard-link capability plus provenance-tagged signed advertisements—not a raw endpoint—to the controller before destroying itself.
- [ ] Ensure logs/diagnostics contain capability bits, coarse capacity, and error category only—never complete routes, topics, route keys, or stable path correlation IDs.
- [ ] Run `npm run test:one -- test/relay-capability.test.js test/compatible-discovery.test.js test/bootstrap-io-authority.test.js`; expect all focused tests to pass, then run `npm run test:node`; expect green.
- [ ] Commit: `feat(private-routes): discover compatible relays safely`

### Task 3: Implement production bilateral link authorization and dynamic extension

**Files:**

- Modify: `packages/private-routes/lib/link-setup.js`
- Modify: `packages/private-routes/lib/link-bootstrap-session.js`
- Modify: `packages/private-routes/lib/async-route-control-session.js`
- Create: `packages/private-routes/lib/route-extension.js`
- Modify: `packages/private-routes/lib/route-manager.js`
- Modify: `packages/private-routes/lib/errors.js`
- Create: `packages/private-routes/test/route-extension.test.js`
- Create: `packages/private-routes/test/route-extension-adversarial.test.js`

- [ ] Write failing tests for `LINK_OFFER_V1`/`LINK_ACCEPT_V1`, shared guard at index 0, separate lookup and announce branches, middle replacement, terminal exit confirmation, and exact M2 role mapping: guard/middle use `ROLE.SAFETY`; exit uses `ROLE.PRIVATE`.
- [ ] Cover replay, expired offers, self-loop, repeated identities, wrong branch, wrong index, wrong transcript, cross-route substitution, omitted bilateral consent, and partial-extension teardown. Reject coordinator topology grants specifically on every production M3 entry point.
- [ ] Assert the guard never receives the exit advertisement, exit identity, exit address, or an address-bearing later-link acceptance. The two branches may share guard identity/transport only; circuit IDs, bilateral acceptances, keys, counters, replay windows, generations, queues, and teardown must be pairwise distinct.
- [ ] Run `npm run test:one -- test/route-extension.test.js test/route-extension-adversarial.test.js`; expect failures showing v1 setup and production grant rejection are not implemented.
- [ ] Add `RouteExtensionSession` with explicit states `OFFER`, `ACCEPTED`, `ACTIVE`, `FAILED`, `DESTROYED`. Every transition must be idempotent or fail closed; no callback may re-enter after terminal state.
- [ ] Make `RouteManager` build `client → guard → middle → exit` from validated capability objects rather than static topology grants. Preserve the M2 static constructor for M2 tests.
- [ ] Add bounded setup deadlines and per-identity/per-epoch replay caches. On failure, send a generic destroy reason, erase partial keys, and leave no live circuit entry.
- [ ] Run `npm run test:one -- test/route-extension.test.js test/route-extension-adversarial.test.js`; expect focused tests to pass. Run `npm run test:node` and `npm run test:bare`; expect green in both runtimes.
- [ ] Commit: `feat(private-routes): extend routes with bilateral authorization`

### Task 4: Add tail control, final-exit activation, and opaque destination handles

**Files:**

- Create: `packages/private-routes/lib/tail-control-session.js`
- Create: `packages/private-routes/lib/final-exit-session.js`
- Create: `packages/private-routes/lib/destination-handle.js`
- Create: `packages/private-routes/lib/routed-rpc-endpoint.js`
- Modify: `packages/private-routes/lib/errors.js`
- Modify: `packages/private-routes/lib/live-route-node.js`
- Modify: `packages/private-routes/lib/remote-actor-host.js`
- Modify: `packages/private-routes/index.js`
- Create: `packages/private-routes/test/tail-control-session.test.js`
- Create: `packages/private-routes/test/final-exit-session.test.js`
- Create: `packages/private-routes/test/destination-handle.test.js`

- [ ] Write failing fixed-vector tests for index-0/index-1/index-2 and transcript substitution; four tail-control outputs; four tail-finalize outputs; all twelve final-exit outputs; full 32-byte key and first-16-byte nonce-prefix rules; pairwise inequality across every key/nonce domain; exact context state/class matrix; counters; replay windows; the five sends at `0/250/750/1750/3750ms`; five-second retired-context grace; erasure; and redacted confirmation.
- [ ] Write failure tests for dropped/reordered/duplicated finalization datagrams, counter gaps, post-open delayed controls, half-open timeout, policy substitution, stale/cross-exit/cross-branch handles, and address substitution.
- [ ] Define the client-facing endpoint contract in tests before implementation:

```js
const endpoint = await branch.openRpcEndpoint();
const [seed] = await endpoint.bootstrap(target, {
  destinationValidationClass: SIGNED_CAPABILITY_HANDLE,
  capability: PRIVATE_RECORDS_V1,
});
const reply = await endpoint.request(seed, {
  commandId,
  commandVersion,
  token,
  payload,
  timeout,
});
```

`bootstrap(target, opts)` aligns with DHT-RPC's routed transport contract. It supports exit-local public DHT seeds under `DHT_NODE_HANDLE` and actively validated private-storage seeds under `SIGNED_CAPABILITY_HANDLE`. `target` may order handles the exit already authorizes; it never authorizes a dial. `seed` and every later `reply.closerNodes[]` entry are exit-issued destination references. The client can reuse a reference only on its issuing branch; it has no `resolve(nodeId)` or address-to-handle API. References are opaque, exit-bound, expiring, and non-serializable to public `{ host, port }` nodes.

- [ ] Run `npm run test:one -- test/tail-control-session.test.js test/final-exit-session.test.js test/destination-handle.test.js`; expect missing-module and unimplemented-context failures before adding implementation.

- [ ] Implement five fully independent key/state domains: ordered tail control, tail-finalize datagram, final-exit-finalize datagram, ordered route payload, and ordered terminal control. No key, counter, replay window, or semantic replay state is shared between domains. Bind every frame to the exact `M3ContextAD` and applicable transcript.
- [ ] Implement `DestinationHandleTable` with random capabilities, explicit exit/branch/generation binding, provenance (`EXIT_LOCAL_SEED` or `OBSERVED_REFERRAL`), TTL, maximum entries, LRU eviction, and total invalidation on branch rotation or network change. Arbitrary node IDs, raw addresses, client/self-signed referrals, and unvalidated referrals cannot trigger probes or receive handles.
- [ ] Inject a `singleNodeExecutor` into the exit service with only `request(executorHandle, typedRequest, limits)` and `validateReferral(executorOwnedEvidence, budget)` methods. `request()` creates unforgeable executor-owned referral evidence bound to issuing handle, request nonce, response digest, observed address, and executor generation; only that evidence is accepted by `validateReferral()`. This keeps Chunk 1 independent of `dht-rpc`; the exit never receives an address selected by the client. Test active-validation budgets, command-class binding, forged/cross-request/cross-generation evidence, and exclusion of every relay identity/address from both branches.
- [ ] Run `npm run test:one -- test/tail-control-session.test.js test/final-exit-session.test.js test/destination-handle.test.js`; expect focused tests to pass. Run `npm run test:node` and `npm run test:bare`; expect green.
- [ ] Commit: `feat(private-routes): activate authenticated dht exits`

### Task 5: Implement guard/branch leases, mobile liveness, and fail-closed lifecycle

**Files:**

- Create: `packages/private-routes/lib/private-route-controller.js`
- Create: `packages/private-routes/lib/active-time-lease.js`
- Create: `packages/private-routes/lib/mobile-liveness.js`
- Create: `packages/private-routes/lib/traffic-scheduler.js`
- Modify: `packages/private-routes/lib/route-manager.js`
- Modify: `packages/private-routes/lib/link-control-session.js`
- Modify: `packages/private-routes/index.js`
- Modify: `packages/private-routes/lib/errors.js`
- Create: `packages/private-routes/test/private-route-controller.test.js`
- Create: `packages/private-routes/test/mobile-liveness.test.js`
- Create: `packages/private-routes/test/network-lifecycle.test.js`

- [ ] Write failing fake-clock tests for a 24-active-hour guard lease; separate branch leases drawn once per generation from uniform `[13.5, 16.5]` active minutes using the injected random source; make-before-break; 60-second application-idle destruction; predecessor-only heartbeat epochs drawn uniformly from `[20, 30]` seconds; successor 90-second passive timeout; and heartbeat-excluded application-idle accounting.
- [ ] Add suspend/resume tests: suspend destroys all circuits and retains only guard identity/lease metadata; resume revalidates the guard and creates fresh branches; network change invalidates handles and circuits before any new application request is accepted.
- [ ] For suspend, network change, branch rotation, and destroy, assert all outstanding endpoint requests are cancelled, late replies are rejected, exposed token/generation state is invalidated, and a monotonic generation-abort hook fires before replacement. Later storage transactions must use this hook to prevent tokens or partial receipts crossing generations.
- [ ] Add simultaneous-timer and missing-predecessor/successor direction tests. A shared scheduler initiates both branch heartbeats in one wake epoch: at most six heartbeat cells per branch and twelve total cells in any half-open 60-second interval, with at most three client radio wakeups. It may batch ordinary active work for at most 10ms, adds no continuous cover, and never delays repair, teardown, authentication failure, or protocol-deadline control.
- [ ] Run `npm run test:one -- test/private-route-controller.test.js test/mobile-liveness.test.js test/network-lifecycle.test.js`; expect missing controller/scheduler failures.
- [ ] Implement `PrivateRouteController` as the sole owner of guard selection, lookup/announce branch generations, draining, handle invalidation, and lifecycle transitions. Public methods: `ready()`, `endpoint(operationClass)`, `suspend()`, `resume()`, `networkChanged()`, `destroy()`.
- [ ] Require `endpoint()` to return `ERR_PRIVATE_BRANCH_ROTATING` or `ERR_PRIVACY_UNAVAILABLE`; it must never expose or trigger a direct fallback.
- [ ] Add aggregate/redacted diagnostics and deterministic clock/random injection. Ensure all timers are `unref()`-safe where supported and fully cleared on suspend/destroy.
- [ ] Run `npm run test:one -- test/private-route-controller.test.js test/mobile-liveness.test.js test/network-lifecycle.test.js`; expect focused tests to pass. Run `npm run test:m2`, `npm run test:namespace`, and `npm run format:check`; expect green with no M2 regression.
- [ ] Commit: `feat(private-routes): manage mobile private route lifecycle`

### Task 5A: Extract the protocol package into a standalone GitHub repository

**Files:**

- Create in standalone repo: `LICENSE`
- Modify in standalone repo: `package.json`
- Modify in standalone repo: `README.md`
- Create in standalone repo: `.github/workflows/test.yml`
- Create in standalone repo: `docs/specs/2026-07-14-native-dht-private-routing-m3-design.md`
- Create in standalone repo: `docs/specs/2026-07-14-native-dht-private-routing-m3-wire-registry.md`
- Modify in PearTube: `.github/workflows/private-routes.yml`
- Modify in PearTube: `docs/superpowers/reports/2026-07-14-native-dht-private-routing-m3.md`

- [ ] At the accepted Chunk 1 commit in PearTube, run `git subtree split --prefix packages/private-routes -b split/private-routes-m3`; expect a new split commit whose tree has `package.json` at its root. Record `git rev-parse split/private-routes-m3` in the acceptance report.
- [ ] Run `/opt/homebrew/bin/gh repo create ayooooo123/hyperdht-private-routes --public`; expect an empty public repository with no generated README, license, or gitignore. Run `git push https://github.com/ayooooo123/hyperdht-private-routes.git split/private-routes-m3:main`; expect that exact split SHA on remote `main`.
- [ ] Run `git clone https://github.com/ayooooo123/hyperdht-private-routes.git ../hyperdht-private-routes` and `git switch -c feature/native-private-routing-m3` in that clone; expect `HEAD` to equal the recorded split SHA before integration-only edits.
- [ ] Add the MIT license (copyright `ayooooo123`), repository/homepage/bugs metadata, experimental notice, contributing instructions, and the normative M3 design/wire-registry docs. Keep the package `private: true` during M3 so no accidental npm publish can occur.
- [ ] Adapt the existing Node, Bare, portable, namespace, and packet-oracle workflow paths to the standalone root. Set default permissions to `contents: read`; pin third-party Actions by immutable commit SHA.
- [ ] Push the reviewed feature commit with `git push -u origin feature/native-private-routing-m3`. Fresh-clone that exact branch using `git clone --branch feature/native-private-routing-m3 --single-branch https://github.com/ayooooo123/hyperdht-private-routes.git /private/tmp/hyperdht-private-routes-m3-verify`; assert `git rev-parse HEAD` equals the acceptance-report SHA, then run `npm ci`, all package tests, and `npm pack --dry-run`; expect the same green counts and no omitted runtime files.
- [ ] Replace the PearTube workflow with either a documented exact-Git dependency integration job or remove it only after equivalent standalone branch protection is green. Do not retain two independently editable protocol copies.
- [ ] Commit in standalone repo: `chore: establish standalone private routes package`
- [ ] Commit in PearTube: `chore: consume standalone private routes package`

### Chunk 1 Acceptance Gate

- [ ] From a fresh standalone clone, run `npm ci` followed by `npm run test:m2`, `npm run test:namespace`, and `npm run format:check`.
- [ ] Run `npm pack --dry-run`; confirm only intended source/docs/tests metadata ship and no secrets, captures, `node_modules`, or local artifacts are included.
- [ ] Record test counts and the final PearTube commit SHA in `docs/superpowers/reports/2026-07-14-native-dht-private-routing-m3.md` under “Chunk 1.”
- [ ] Ask a plan/code reviewer to verify the implementation against every Chunk 1 checkbox and the authoritative spec before starting Chunk 2.

## Chunk 2: `dht-rpc` Routed Transport and Query Seam

### Task 6: Establish the fork branch and routed transport contract

**Files:**

- Modify: `package.json`
- Create: `lib/routed-transport.js`
- Create: `lib/destination-ref.js`
- Modify: `lib/errors.js`
- Create: `test/routed-transport.test.js`

- [ ] In the `dht-rpc` working tree, run `git switch -c feature/native-private-routing-m3`; expect a new branch from fork `main` with a clean status.
- [ ] Update Node/Bare test scripts to include `test/*.test.js` while retaining the legacy `test.js` suite. Run the unchanged suite once before edits and record the baseline counts.
- [ ] Write a failing contract test using an in-memory fake. The narrow adapter accepted by DHT-RPC must be:

```js
const transport = {
  async ready() {},
  bootstrap(target, opts) {}, // returns RoutedOperation<DestinationRef[]>
  request(destination, request, opts) {}, // returns RoutedOperation<NormalizedReply>
  async suspend() {},
  async resume() {},
  async destroy() {},
  on(event, listener) {},
  removeListener(event, listener) {},
};

// Portable Node/Bare cancellation; cancel must reach the underlying route.
const operation = {
  promise: Promise.resolve(value),
  cancel(reason) {},
};
```

`DestinationRef` contains `{ id: b4a Buffer(32), handle }`, with `handle` using the exact fixed/bounded owner-approved wire-registry representation; both are defensively copied. It must contain neither `host` nor `port`, including nested fields. A normalized reply contains `from`, `token`, `closerNodes`, `value`, `error`, and `rtt`, with every destination expressed as a `DestinationRef`. `reply.from.id` and `reply.from.handle` must byte-equal the exact requested reference before token retention, mapping, closer-node admission, or commit.

- [ ] Test `validateDestinationRef`, b4a-only defensive buffer copying, fixed/bounded handles, fake/malformed handles, nested/raw `{ host, port }` rejection, adapter callback throws, cancellation, and adapter replies after destroy. Add cross-handle, cross-ID, and cross-generation `reply.from` substitution tests. Within one query the first valid handle for an ID wins; a later handle for the same ID is ignored even after failure. A later query/generation may accept a fresh exit-issued handle.
- [ ] Run `npm run test:node -- --filter routed`; expect missing-module failures.
- [ ] Implement validation helpers and stable errors: `ERR_ROUTED_DESTINATION_INVALID`, `ERR_ROUTED_TRANSPORT_REQUIRED`, `ERR_PRIVATE_COMMAND_UNSUPPORTED`, `ERR_ROUTED_REQUEST_TIMEOUT`, and `ERR_ROUTED_TRANSPORT_DESTROYED`.
- [ ] Keep `dht-rpc` transport-neutral: do not add dependencies on HyperDHT, `hyperdht-private-routes`, UDX circuit types, or private-record codecs.
- [ ] Run the focused test, full `npm run test:node`, `npm run test:bare`, and `npm run lint`; expect green and unchanged public-mode behavior.
- [ ] Commit: `feat: define routed dht transport contract`

### Task 7: Add a promise-backed request facade and explicit command policy

**Files:**

- Create: `lib/routed-io.js`
- Create: `lib/command-policy.js`
- Modify: `lib/session.js`
- Modify: `index.js`
- Create: `test/routed-io.test.js`
- Create: `test/command-policy.test.js`

- [ ] Write failing tests that exercise the existing `request()` and `session().request()` ergonomics over the fake routed transport, including cancellation, retry, timeout, suspend, destroy, and late completion.
- [ ] Write a deny-by-default policy matrix. Define registrations exactly as:

```js
new CommandPolicy([
  {
    commandId,
    commandVersion,
    requestCodec,
    responseCodec,
    maxRequestBytes,
    maxResponseBytes,
    timeoutMs,
    maxOutstanding,
    requestCost,
    responseCost,
    maxAmplificationBytes,
    mutationFlag,
    destinationValidationClass,
  },
]);
```

The policy defensively encodes/decodes with the registered codecs; rejects trailing/oversized request or reply bytes; derives timeout/cost/amplification metadata itself; reserves `maxOutstanding` before adapter IO; and releases the slot exactly once on reply, error, timeout, or cancellation. Registration freezes at `ready()`.

- [ ] Require routed calls to use the typed shape:

```js
dht.request({ command, commandVersion, target, token, value }, destinationRef, {
  operationClass: "lookup",
  generationLease,
});
```

- [ ] Define `generationLease` as an opaque transport-issued object with immutable `generation`, `active`, `onabort(listener)`, and `removeAbortListener(listener)`. Write tests that session destroy, suspend, network change, generation rotation, timeout, and DHT destroy call `RoutedOperation.cancel(reason)`, release policy capacity, and reject every late completion.
- [ ] Freeze the internal adapter envelope from the wire registry: `{ requestId, commandId, commandVersion, encodedBody, absoluteDeadline, maxResponseBytes, maxAmplificationBytes, requestCost, responseCost, mutationFlag, destinationValidationClass }`. A logical request gets one random registry-sized request ID reused by its bounded retries. Reject when `encodedResponse.byteLength > maxResponseBytes` or `encodedResponse.byteLength > encodedBody.byteLength + maxAmplificationBytes`. Concurrent reply, timeout, lease abort, session cancellation, suspend, and destroy race through one settle-once gate that cancels remaining retries and releases capacity once.
- [ ] Run `npm run test:node -- --filter routed-io` and `npm run test:node -- --filter command-policy`; expect failures because public `IO` still assumes UDX sockets/host-port destinations and no policy exists.
- [ ] Implement `RoutedIO` as a small compatibility facade with `createRequest`, stats, congestion no-op metrics, lifecycle, and promise settlement semantics required by current `DHT`/`Session`. Do not copy packet framing, NAT behavior, or socket binding into it.
- [ ] Implement `CommandPolicy`; freeze registrations at `ready()`, enforce request/response byte limits and mutation flag, and return structured failures without suggesting direct retry.
- [ ] Export the supported policy constructor as `DHT.CommandPolicy = CommandPolicy` from `index.js`. Add Node and Bare tests that consumers can use this public export and never need `require('dht-rpc/lib/command-policy')`.
- [ ] In `DHT` construction, accept `{ routedTransport, commandPolicy }` together or neither. Select `RoutedIO` only for this explicit mode; retain `IO` unchanged for the default.
- [ ] Run `npm run test:node -- --filter routed-io`, `npm run test:node -- --filter command-policy`, `npm run test:node`, and `npm run test:bare`; expect green.
- [ ] Commit: `feat: send typed requests over routed io`

### Task 8: Preserve client-side iterative queries using destination references

**Files:**

- Create: `lib/routed-query.js`
- Modify: `lib/query.js`
- Modify: `index.js`
- Create: `test/routed-query.test.js`
- Create: `test/routed-query-adversarial.test.js`

- [ ] Write failing reusable convergence tests over at least 20 fake identities with caller-provided bounded `k` and concurrency. Assert that the client—not the exit—chooses each next destination, and each adapter call targets exactly one opaque handle. Do not encode private-storage `K=5`, `alpha=3`, or its convergence rule in DHT-RPC; Chunk 3 owns those policy values.
- [ ] Cover bootstrap seeds, closer-node ordering, first-handle-wins ID dedupe, loops, malicious non-closer referrals, repeated identities with different handles, stale handles, timeout/retry bounds, partial success, commit hooks, session teardown, backpressure, and map callback throws.
- [ ] Prove `commandVersion`, `operationClass`, policy-derived deadline, and one frozen `generationLease` propagate through bootstrap, every visit, retry, and auto-commit. Auto-commit must reuse the exact reply destination handle and token on the same lease; lease abort cancels the query instead of bootstrapping/retrying on a new generation.
- [ ] Assert the fake exit receives no “perform an entire lookup” instruction. Every request must contain one typed DHT command and one destination handle.
- [ ] Run `npm run test:node -- --filter routed-query`; expect failures because `Query` derives keys with `host + ':' + port`, seeds from the public routing table, and hashes IP endpoints.
- [ ] Implement `RoutedQuery` by extracting only reusable query bookkeeping from `lib/query.js`. Its routing key is the 32-byte cryptographic `id`; its seeds come from `routedTransport.bootstrap(target)` or explicit refs; closer nodes are already normalized by the transport.
- [ ] Select `RoutedQuery` in routed mode for `findNode()`/`query()` without changing public `Query`. Preserve streamx iteration, `finished()`, `closestReplies`, map, commit, retries, and session semantics.
- [ ] In routed mode, never invoke `peer.id(host, port)`, `table.closest()` on public endpoint nodes, `_resolveBootstrapNodes()`, `_downHint()`, or raw `request()` with an address.
- [ ] Run `npm run test:node -- --filter routed-query`, `npm run test:node`, `npm run test:bare`, and `npm run lint`; expect green.
- [ ] Commit: `feat: iterate dht queries over opaque destinations`

### Task 9: Make routed mode IO-isolated and lifecycle-complete

**Files:**

- Modify: `index.js`
- Modify: `lib/health.js`
- Modify: `lib/errors.js`
- Create: `lib/public-runtime.js`
- Create: `test/routed-isolation.test.js`
- Create: `test/routed-lifecycle.test.js`

- [ ] Write failing tests with a per-instance `testOnlyPublicRuntimeFactory` throwing sentinel for `new UDX()`, socket creation/bind/send, network-interface watching, `NatSampler`, public bootstrap resolution, public table promotion, background refresh, ping, delayed ping, down hints, NAT updates, and reping/swap. The factory is never documented/exported and public mode alone may call it.
- [ ] Assert routed `ready()` awaits adapter readiness; `suspend()` destroys inflight requests and awaits adapter suspension; `resume()` awaits a fresh adapter generation; `network-change` is forwarded from the adapter; and `destroy()` is idempotent.
- [ ] Accept only `routedTransport`, `commandPolicy`, integer `k` in `[1, 64]`, and integer `concurrency` in `[1, k]` (plus the internal test factory) for routed construction. Reject `bootstrap`, `nodes`, `udx`, `port`, `host`, `firewalled`, `anyPort`, `ephemeral`, `adaptive`, `quickFirewall`, `maxWindow`, `maxPingDelay`, `sendDownHints`, `downHintsRateLimit`, `filterNode`, deprecated `addNode`, `adaptiveTimeout`, and every unknown routed option. Freeze the routed public-surface matrix: getters `socket/host/port/id/address()/localAddress()/remoteAddress()` return `null`; `toArray()` returns `[]`; `config` returns frozen `{ mode: 'routed', concurrency, k }`; `udx` is `null`; `firewalled` and `ephemeral` are `true`; `bind/onmessage/addNode/ping/delayedPing/refresh/rttStats/bootstrapper` synchronously throw `ERR_ROUTED_PUBLIC_IO_UNAVAILABLE`; incoming `onrequest` service is unreachable. Only `ready/fullyBootstrapped/query/request/session/suspend/resume/destroy` are supported.
- [ ] Run `npm run test:node -- --filter routed-isolation` and `npm run test:node -- --filter routed-lifecycle`; expect sentinel and surface-matrix failures from current constructor/tick/bootstrap paths.
- [ ] Split constructor/bootstrap/tick/lifecycle setup by explicit mode. Routed mode must not instantiate UDX/NAT/watchers, start public DHT ticks, populate the endpoint table, or send background packets. Its `bootstrapped` state means only that the routed adapter is ready.
- [ ] Keep public-mode branches byte-for-byte behaviorally compatible, verified by all legacy tests in Node and Bare.
- [ ] Add a test-only `ioAudit` counter object recording every attempted public primitive; the routed isolation test must finish with all counters zero.
- [ ] Run `npm run test:node -- --filter routed-isolation`, `npm run test:node -- --filter routed-lifecycle`, `npm test`, `npm run lint`, and `git diff --check`; expect green.
- [ ] Commit: `feat: isolate routed mode from public dht io`

### Task 10: Add routed-mode CI and integration fixture API

**Files:**

- Create: `test/helpers/memory-routed-transport.js`
- Modify: `.github/workflows/ci.yml`
- Delete: `.github/workflows/publish.yml`
- Modify: `README.md`

- [ ] Extract the deterministic fake transport used above into a documented test helper with fault injection for loss, reordering, timeout, malicious referrals, and generation rotation.
- [ ] Add README documentation for `routedTransport`, `commandPolicy`, supported/unsupported methods, and the invariant that DHT-RPC never receives a raw peer endpoint in this mode.
- [ ] Replace the fork's floating `holepunchto/actions/node-base@v1` CI steps with immutable official Action SHAs, `npm ci`, Node tests, Bare tests, lint, isolation sentinel, and `npm pack --dry-run`. Set `permissions: contents: read`, timeouts, and concurrency cancellation. Remove inherited `trigger_canary` and its PAT dispatch.
- [ ] Delete the inherited npm publish workflow during M3; the fork must have no tag-triggered publish or npm-token path until a separately approved release plan.
- [ ] Run a local `npm ci && npm test && npm run lint && npm pack --dry-run`; expect all jobs to match CI and no local artifacts in the tarball.
- [ ] Commit: `ci: verify routed dht mode on node and bare`

### Chunk 2 Acceptance Gate

- [ ] Fresh-clone the branch, run `npm ci`, `npm test`, `npm run lint`, and inspect `npm pack --dry-run`.
- [ ] Run a minimal standalone program with a throwing public-IO sentinel and the in-memory routed adapter; complete a multi-hop iterative query and assert zero public-IO audit events.
- [ ] Record test counts, package tarball contents, GitHub Actions run URL, and final `dht-rpc` commit SHA in the M3 acceptance report.
- [ ] Ask a plan/code reviewer to verify every Chunk 2 checkbox, the no-dependency boundary, and all required-mode isolation invariants before starting Chunk 3.

## Chunk 3: HyperDHT Private Records and Required-Mode API

### Task 11: Establish exact dependencies and the lazy private-routing adapter

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `lib/private-routing.js`
- Modify: `lib/errors.js`
- Modify: `index.js`
- Create: `test/private-routing-options.js`
- Modify: `test/all.js`

- [ ] In the HyperDHT working tree, run `git switch -c feature/native-private-routing-m3`; expect a new clean branch from fork `main`.
- [ ] Record baseline results for `npm test` and `npm run test:bare` before dependency edits.
- [ ] Pin exact 40-character commits, not floating branches or SSH shorthands: `dht-rpc` from `git+https://github.com/ayooooo123/dht-rpc.git#<reviewed-sha>` and `hyperdht-private-routes` from `git+https://github.com/ayooooo123/hyperdht-private-routes.git#<reviewed-sha>`. Regenerate and commit the lockfile; verify its resolved Git URLs contain those commits.
- [ ] Write failing option tests for default/off compatibility, the only accepted private value `{ mode: 'required' }`, unknown modes/keys, missing private-route dependency, and lazy initialization failure.
- [ ] Define the CommonJS-to-ESM boundary in `lib/private-routing.js`: a synchronous `LazyPrivateTransport` object satisfies DHT-RPC's adapter contract, while its `ready()` performs `import('hyperdht-private-routes')`, creates `PrivateRouteController`, and forwards lifecycle/events. All concurrent `ready()` calls share one promise. Import/construction failure is terminal for that instance. Suspend/destroy while pending marks the desired terminal state; a late controller is immediately suspended/destroyed before exposure. Test listener cleanup and Node/Bare parity.
- [ ] Run `node test/all.js --filter private-routing-options`; expect option/adapter failures.
- [ ] Implement strict option normalization before `super()`, pass `{ routedTransport, commandPolicy }` only in required mode, and retain current constructor arguments byte-for-byte for off/default mode.
- [ ] Require DHT-RPC to export `CommandPolicy` publicly as `DHT.CommandPolicy`; never import `dht-rpc/lib/*`. Build and register every policy synchronously before `super()` can call `ready()` and freeze it. Use this complete table, with numeric IDs, exact codecs, and byte bounds imported from the owner-approved wire registry:

| Command/version        | Allowed branch                                 | Mutation  | Codec/bounds                                           | Destination class          | Authority continuity                        |
| ---------------------- | ---------------------------------------------- | --------- | ------------------------------------------------------ | -------------------------- | ------------------------------------------- |
| `PRIVATE_FIND_NODE/1`  | lookup or announce                             | read-only | registry private-find request/reply and exact limits   | `SIGNED_CAPABILITY_HANDLE` | handle + generation lease                   |
| `PRIVATE_LOOKUP/1`     | lookup                                         | read-only | registry private-lookup request/reply and exact limits | `SIGNED_CAPABILITY_HANDLE` | query nonce + handle + generation           |
| `PRIVATE_PREPARE/1`    | announce                                       | mutating  | registry prepare request/token and exact limits        | `SIGNED_CAPABILITY_HANDLE` | handle + exit + generation                  |
| `PRIVATE_ANNOUNCE/1`   | announce                                       | mutating  | registry announce/receipt and exact limits             | `SIGNED_CAPABILITY_HANDLE` | prepare token + same handle/exit/generation |
| `PRIVATE_UNANNOUNCE/1` | announce                                       | mutating  | registry unannounce/receipt and exact limits           | `SIGNED_CAPABILITY_HANDLE` | prepare token + same handle/exit/generation |
| `IMMUTABLE_GET/1`      | `lookup` for get; `announce` for put preflight | read-only | existing immutable codecs under registry routed bounds | `DHT_NODE_HANDLE`          | handle + exit + generation                  |
| `IMMUTABLE_PUT/1`      | announce                                       | mutating  | existing immutable codecs under registry routed bounds | `DHT_NODE_HANDLE`          | DHT token + same handle/exit/generation     |
| `MUTABLE_GET/1`        | `lookup` for get; `announce` for put preflight | read-only | existing mutable codecs under registry routed bounds   | `DHT_NODE_HANDLE`          | handle + exit + generation                  |
| `MUTABLE_PUT/1`        | announce                                       | mutating  | existing mutable codecs under registry routed bounds   | `DHT_NODE_HANDLE`          | DHT token + same handle/exit/generation     |

- [ ] Add stable HyperDHT errors `ERR_PRIVATE_ROUTING_M4_REQUIRED`, `ERR_PRIVATE_COMMAND_UNSUPPORTED`, `ERR_PRIVACY_UNAVAILABLE`, `ERR_PRIVATE_ROUTED_TIMEOUT`, `ERR_PRIVATE_BRANCH_ROTATING`, `ERR_PRIVATE_RECORDS_UNAVAILABLE`, `ERR_PRIVATE_RECORD_INCOMPLETE`, `ERR_PRIVATE_RECORD_QUORUM`, and `ERR_PRIVATE_RECORD_EQUIVOCATION`.
- [ ] Run the focused test, `npm test`, and `npm run test:bare`; expect green.
- [ ] Commit: `feat: initialize required private routing lazily`

### Task 12: Close every M4 connection and raw-command surface in required mode

**Files:**

- Modify: `index.js`
- Modify: `lib/private-routing.js`
- Modify: `lib/errors.js`
- Create: `test/private-routing-surface.js`

- [ ] Write a table-driven failing test for `findPeer`, `connect`, `createServer`, `pool`, `register`, registered `Plugin.request/query`, inherited `query/request/onrequest`, `createRawStream`, `_requestAnnounce`, `_requestUnannounce`, peer handshake, holepunch, punch helpers, direct relay, raw stream/socket/UDX getters, `validateLocalAddresses`, and any constructor path that allocates `Router`, `SocketPool`, `RawStreamSet`, `Server`, or `ConnectionPool`.
- [ ] `HyperDHT.connectRawStream` is static and has no owning instance, so leave it unchanged. Prove required mode can produce neither an encrypted stream nor a raw stream eligible to pass to it; do not claim the static helper can detect required mode.
- [ ] Assert synchronous `ERR_PRIVATE_ROUTING_M4_REQUIRED` for connection surfaces and synchronous `ERR_PRIVATE_COMMAND_UNSUPPORTED` for raw command surfaces. Assert no route controller, public UDX, router, socket pool, server, or raw stream side effect occurs.
- [ ] Run `node test/all.js --filter private-routing-surface`; expect failures because current methods construct direct networking objects.
- [ ] Guard each surface at its public entry point and install private-mode null owners for constructor/destroy accounting. Do not catch these errors and fall back to the legacy implementation.
- [ ] Keep only `ready`, `fullyBootstrapped`, `destroy`, `suspend`, `resume`, `lookup`, private `lookupAndUnannounce`, `announce`, `unannounce`, immutable get/put, and mutable get/put open for later tasks. Rejected calls allocate no public or private controller work.
- [ ] Run the focused test, `npm test`, and `npm run test:bare`; expect green with default-mode connection tests unchanged.
- [ ] Commit: `feat: close direct hyperdht surfaces in required mode`

### Task 13: Implement private-record codecs, signatures, and storage service

**Files:**

- Modify: `lib/constants.js`
- Create: `lib/private-messages.js`
- Create: `lib/private-record.js`
- Create: `lib/private-record-service.js`
- Create: `lib/private-storage-table.js`
- Create: `lib/private-record-storage.js`
- Create: `lib/private-exit-executor.js`
- Create: `lib/private-route-service.js`
- Modify: `index.js`
- Create: `test/private-messages.js`
- Create: `test/private-records.js`
- Create: `test/private-record-service.js`
- Create: `test/private-storage-table.js`
- Create: `test/private-record-storage.js`
- Create: `test/private-route-service.js`
- Modify: `test/all.js`

- [ ] Write byte-vector tests for every codec from the owner-approved wire registry: storage advertisement/referral, presence, tombstone, prepare token, commit, receipt, lookup response, and signed empty response. Reject trailing bytes, oversized descriptor/value, invalid expiry, wrong topic, and unknown flags.
- [ ] Write signature/domain tests and use exactly:

```text
storageId   = hash('hyperdht/private-record-storage/v1' || storagePublicKey)
recordTarget = hash('hyperdht/private-record-topic/v1' || topic)
K = 5, alpha = 3, W = 3, R = 3
```

- [ ] Define provider mode separately: only public/off-mode persistent nodes may set `privateRecordService: { identityKeyPair, storage, limits }`; required-mode clients reject it. `identityKeyPair` is operator-supplied long-term Ed25519. `storage` is a durable adapter with `ready()`, `get(key)`, atomic `batch(operations)`, prefix `iterator(prefix)`, and `close()`. There is no enabled-by-default in-memory provider.
- [ ] Define the public/off-mode operator API: `privateRouteService: { identityKeyPair, capabilities, advertisement, limits }`, where `capabilities` is an explicit mask of `CIRCUIT_RELAY_V1`, `DHT_EXIT_V1`, and `PRIVATE_RECORDS_V1`. `DHT_EXIT_V1` constructs/injects `PrivateExitExecutor`; `PRIVATE_RECORDS_V1` additionally requires matching `privateRecordService` identity/storage; relay-only and exit-only require no record storage. Reject unknown masks, identity mismatch, required-client combination, and non-persistent operators.
- [ ] Add lifecycle tests for relay-only, exit-only, storage-only, and combined services: `ready()` advertises only configured capabilities; suspend withdraws admission and cancels service work; resume issues/revalidates a fresh advertisement epoch; destroy withdraws, cancels, closes durable storage, erases route keys, and is idempotent.
- [ ] Write storage-state tests: higher sequence wins; same sequence/same digest is idempotent; same sequence/different digest is rejected; tombstone sequence must exceed live sequence; tombstone retention lasts at least the maximum live-record lifetime from acceptance; quotas and expiry are enforced; no stored/returned object contains observed source address. Recreate the service over the same storage and prove tombstones/sequences survive restart and reject stale live replay.
- [ ] Run `node test/all.js --filter private`; expect missing codec/service failures.
- [ ] Add versioned private commands without changing legacy numeric values: `PRIVATE_FIND_NODE`, `PRIVATE_LOOKUP`, `PRIVATE_PREPARE`, `PRIVATE_ANNOUNCE`, and `PRIVATE_UNANNOUNCE`. Register their exact policies with the routed adapter.
- [ ] Implement opt-in `PrivateRecordService` record codecs/state, durable records/tombstones/sequences, token table, quotas, and receipt nonce replay cache. Compose—do not reimplement—the capability advertisement/directory/active-validation service exported by `hyperdht-private-routes`; that package remains the sole owner of capability discovery and signed-advertisement cache behavior.
- [ ] Implement `PrivateExitExecutor` on public/off-mode exits. It wraps this node's public single-node DHT-RPC request, creates executor-owned referral evidence from protocol-observed replies, and is injected into the private-routes relay/exit service. Client required mode obtains only controller endpoints from `LazyPrivateTransport`; it never receives this executor. Dependency direction is HyperDHT → private-routes and DHT-RPC, with no reverse import or cycle.
- [ ] Implement `PrivateRouteService` as the lifecycle owner that dynamically imports/composes the private-routes relay/capability service, injects the exit executor only when configured, and composes `PrivateRecordService` only for storage capability. Public HyperDHT readiness/destruction must await this service without changing default/off nodes that omit it.
- [ ] Wire all five private commands through public `onrequest` only when provider mode and the matching advertised capability are active. A required-mode client has no incoming request service.
- [ ] Bind prepare tokens to storage identity, observed exit endpoint, exit-issued destination handle, topic, endpoint key, sequence, digest, expiry, branch generation, and command kind. Bind signed receipts to every field required by the design. Never use the packet source as presence data.
- [ ] Run focused private tests, `npm test`, and `npm run test:bare`; expect green.
- [ ] Commit: `feat: serve signed private dht records`

### Task 14: Implement compatible storage overlay iteration and quorum transactions

**Files:**

- Create: `lib/private-storage-query.js`
- Create: `lib/private-record-transaction.js`
- Modify: `lib/private-routing.js`
- Modify: `index.js`
- Create: `test/private-storage-query.js`
- Create: `test/private-record-transaction.js`
- Create: `test/private-record-adversarial.js`
- Modify: `test/all.js`

- [ ] Write failing deterministic-network tests for zero/stale/live exit seeds; K-closest convergence; alpha parallelism; the “unchanged closest K for one full alpha round” stop rule; loops; malicious referrals; insufficient density; and strict relay-path identity/address exclusion before topic attachment.
- [ ] Write lookup tests that query all reachable final-K nodes and return only after at least `R=3` valid signed responses or deadline. Merge by `(topic, endpoint key)`, select highest sequence, honor same-or-higher tombstones, expose completeness count, and never claim proof of absence.
- [ ] Add stale/replayed/cross-query/cross-topic lookup and empty responses, wrong response time/digest, duplicate storage identities, non-final-set responses, and forged records. Below `R` returns `ERR_PRIVATE_RECORD_INCOMPLETE` with redacted `{ received, required }` and no records/absence result; only distinct validated identities in the final K set count.
- [ ] Write announce/unannounce tests for one announce branch generation: discover K, prepare each, commit, require `W=3` distinct valid receipts. Cover partial quorum, receipt replay, token/handle/exit/generation rotation, cross-exit token, network change, duplicate identity, wrong record/sequence/expiry, and restart-from-prepare.
- [ ] Add forged/reused/expired prepare tokens, concurrent/double commit, response after abort, and receipt identities outside the final K. Only distinct validated final-set storage identities count toward W.
- [ ] Write equivocation tests: two endpoint-valid records for the same topic/key/sequence with different kind or digest yield `ERR_PRIVATE_RECORD_EQUIVOCATION`, quarantine that endpoint/topic, and select neither value.
- [ ] Run `node test/all.js --filter private-storage`; expect missing query/transaction failures.
- [ ] Implement `PrivateStorageQuery` on the lookup or announce endpoint using only exit-provided seed/referral references. The client performs XOR ordering and alpha scheduling; each exit call remains a one-handle typed request.
- [ ] Implement `PrivateRecordTransaction` with a frozen branch-generation lease. Prepare/query, token, commit, destination handle, exit, and generation remain identical. Rotation, suspend, network change, timeout, or destroy cancels inflight IO, aborts, discards tokens/partial receipts, and restarts from discovery/prepare only when the public API operation's own deadline permits.
- [ ] Enforce client-side validation of storage identity signatures, overlay IDs, referral provenance, records, tombstones, responses, tokens, and receipts before any item can count toward R/W.
- [ ] Run focused tests, `npm test`, and `npm run test:bare`; expect green.
- [ ] Commit: `feat: query private storage with signed quorums`

### Task 15: Map the supported HyperDHT API to private operation branches

**Files:**

- Modify: `index.js`
- Create: `lib/private-api.js`
- Create: `test/private-api.js`
- Create: `test/private-storing.js`
- Create: `test/private-lifecycle.js`
- Modify: `test/all.js`

- [ ] Write failing API-matrix tests proving `lookup` emits only `PRIVATE_LOOKUP`; `announce` only performs private prepare/`PRIVATE_ANNOUNCE`; `unannounce` only performs private prepare/`PRIVATE_UNANNOUNCE`; no call emits legacy `LOOKUP`, `ANNOUNCE`, or `UNANNOUNCE`.
- [ ] Freeze required-mode inputs: `announce(topic, keyPair, relayAddresses, { seq, expires, capabilities, descriptor, timeout })` requires positive integer `seq`, bounded absolute `expires`, bounded integer `capabilities`, and registry-bounded b4a `descriptor`; non-empty `relayAddresses` reject. `unannounce` and `lookupAndUnannounce` require `{ seq, timeout }` and create a higher-sequence tombstone; both are private-only and never call legacy lookup/unannounce. Unknown options reject.
- [ ] `lookup(topic, { timeout })` accepts only a bounded timeout and rejects legacy/raw `map`, `commit`, `nodes`, `closestNodes`, `replies`, `session`, `force`, `retries`, and unknown options. `immutableGet(target, { timeout })`, `immutablePut(value, { timeout })`, `mutableGet(publicKey, { seq, latest, timeout })`, and `mutablePut(keyPair, value, { seq, timeout })` accept only those listed values with strict types/bounds.
- [ ] Freeze result shapes. `lookup()` returns a stream-like `PrivateLookup` that emits exactly one `{ records, completeness: { received, required: 3, selected }, absenceProven: false }` batch after R and whose `finished()` resolves that batch; below R it emits nothing and rejects with `ERR_PRIVATE_RECORD_INCOMPLETE`. Records are signed/non-dialable and contain no address. `announce()`/private `lookupAndUnannounce()` return `PrivateMutation`, emit one `{ storageIdentity, receipt }` per distinct accepted final-set receipt, and `finished()` resolves `{ receipts, required: 3 }` only at W. `unannounce()` awaits that `finished()` result. These are explicit private-mode shapes, not legacy peer-result shapes.
- [ ] Freeze routed storage results: `immutableGet` returns `null` or `{ value }`; `immutablePut` returns `{ hash }`; `mutableGet` returns `null` or `{ seq, value, signature }`; `mutablePut` returns `{ publicKey, seq, signature }`. No required-mode result or error exposes destination handles, DHT/storage tokens, `from`/`to`, exit identity/address, branch/generation identifiers, or routed `closestNodes`.
- [ ] Write immutable/mutable tests over routed single-node legacy DHT commands. Reads use the lookup branch. Puts keep query/prepare, DHT token, commit, destination handle, exit, and generation lease identical on one announce branch and restart from the beginning after rotation; forged immutable/mutable values never satisfy verification.
- [ ] Run `node test/all.js --filter private-api`; expect failures because current methods emit legacy commands.
- [ ] Implement a private dispatch object so public methods do exactly one early mode branch. Internal private code receives controller endpoints by operation class and can call the policy-authorized DHT-RPC seam without opening public `query()`.
- [ ] Preserve default/off method behavior and return types. Required mode has no “preferred” or direct fallback path.
- [ ] Wire lifecycle: `ready()` waits for private controller readiness and temporary-bootstrap destruction; suspend cancels operations and destroys branches/tokens; resume establishes new generations; network change invalidates before emitting readiness; destroy is idempotent and erases private state.
- [ ] Map transport timeout, lease rotation, missing storage seeds, below-R read, and below-W write to exact HyperDHT errors `ERR_PRIVATE_ROUTED_TIMEOUT`, `ERR_PRIVATE_BRANCH_ROTATING`, `ERR_PRIVATE_RECORDS_UNAVAILABLE`, `ERR_PRIVATE_RECORD_INCOMPLETE`, and `ERR_PRIVATE_RECORD_QUORUM`. Error fields are redacted and never recommend direct retry/fallback.
- [ ] Run focused tests, `npm test`, and `npm run test:bare`; expect green.
- [ ] Commit: `feat: route hyperdht records through private branches`

### Task 16: Harden package boundaries, documentation, and HyperDHT CI

**Files:**

- Modify: `README.md`
- Create: `docs/private-routing.md`
- Modify: `.github/workflows/test-node.yml`
- Delete: `.github/workflows/publish.yml`
- Create: `.github/workflows/private-routing.yml`
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `test/private-package-boundary.js`
- Create: `scripts/check-private-routing-pins.js`
- Create: `private-routing-pins.json`

- [ ] Add a package-boundary test that installs the two exact Git dependencies in a clean temp project, constructs default and required HyperDHT instances under Node and Bare, and checks the CommonJS/ESM import boundary.
- [ ] Document the exact M3 guarantee (client IP hidden from exits/storage/other endpoints after guard readiness), explicit non-goals (query-key privacy, traffic-analysis resistance, Sybil resistance), M4-required connection error, persistent relay/storage opt-in, and mobile lifecycle.
- [ ] Replace floating/old inherited workflow steps with least-privilege permissions and immutable official Action SHAs. Remove tag triggers, canary PAT dispatch, and the inherited publish workflow. Existing regression jobs must run `npm test`, `npm run integration`, and `npm run test:bare`; private jobs run package-boundary install, pin audit, lint/format, and `npm pack --dry-run`.
- [ ] Add `private-routing-pins.json` with the accepted private-routes and DHT-RPC 40-character SHAs. Add a lockfile check that fails if either Git dependency resolves to a branch/tag, unexpected owner/repo, or anything other than this committed manifest (which the downstream acceptance report also copies).
- [ ] Implement `scripts/check-private-routing-pins.js` using Node built-ins only so it can parse the manifest, `package.json`, and `package-lock.json` and validate exact HTTPS repositories/40-character SHAs before `npm ci` can run Git lifecycle scripts.
- [ ] Run `npm ci`, `npm test`, `npm run integration`, `npm run test:bare`, and `npm pack --dry-run`; expect green and both runtime dependencies present in the tarball metadata.
- [ ] Commit: `ci: verify native private hyperdht integration`

### Chunk 3 Acceptance Gate

- [ ] Fresh-clone HyperDHT and run all Node/Bare tests, `npm run integration`, package-boundary install, format check, pin audit, and pack dry-run.
- [ ] Run the deterministic private-storage network with at least seven storage-capable nodes; prove convergence, R/W quorum behavior, tombstones, and lifecycle rotation without raw client endpoints in any record.
- [ ] Record test counts, exact dependency SHAs, tarball contents, and GitHub Actions run URL in the M3 acceptance report.
- [ ] Ask a plan/code reviewer to verify every Chunk 3 checkbox, public compatibility, cryptographic record validation, and the complete required-mode API matrix before starting Chunk 4.

## Chunk 4: Real Testnet, Packet Oracle, PearTube Pin, and GitHub-Native CI

### Task 17: Build a real multi-process UDX/HyperDHT testnet

**Files (HyperDHT repo):**

- Create: `test/private-integration/process-codec.js`
- Create: `test/private-integration/role-runner.js`
- Create: `test/private-integration/coordinator.js`
- Create: `test/private-integration/topology.js`
- Create: `test/private-integration/operations.js`
- Create: `test/integration/private-routing.js`
- Modify: `package.json`

- [ ] Write a failing coordinator test that launches independent OS processes for one private client, one shared guard, distinct lookup/announce middles, distinct lookup/announce exits, at least seven `PRIVATE_RECORDS_V1` storage nodes, ordinary DHT nodes, and a second endpoint.
- [ ] Use real UDX sockets and the actual three repository packages. Fakes may control clocks/faults but may not replace route cells, DHT-RPC iteration, destination handles, HyperDHT codecs, signatures, or process boundaries.
- [ ] Define a length-prefixed control codec with run ID, role, public fixture address, readiness phase, operation ID, result digest, and redacted metrics. Validate every field and cap coordinator queues/timeouts.
- [ ] Run `npm run test:private:integration`; expect failure because role runners and orchestration are missing.
- [ ] Implement deterministic topology allocation and explicit readiness phases: public infrastructure, bounded bootstrap, guard pinned/direct socket destroyed, lookup branch open, announce branch open, private records ready.
- [ ] Execute and verify private presence announce→lookup, unannounce/tombstone, immutable put/get, and mutable put/get. Assert both client-side iterative traces and exit traces contain only one destination handle per RPC.
- [ ] Add real-process cases for compatible-bootstrap and bounded legacy cold start; malicious bootstrap/guard referrals; guard projection secrecy; arbitrary target/ID handle denial; zero/stale storage seeds; insufficient storage density; forged immutable/mutable values, private records, and receipts; fabricated closer-node metadata and false signed-empty claims; and active-time guard/branch rotation. Every case must end in verified success or its exact fail-closed error without direct fallback.
- [ ] Collect bounded audit snapshots over inherited stdio pipes (not fixture networking): direct-IO counters, route projection identities, public-table size, handle provenance/generation, command class, storage response membership, record field scan, live timers/sockets/circuits/queues, and secret-owner zeroization attestations. Stdio control traffic is excluded from namespace interfaces and pcaps.
- [ ] On every failure, terminate children, destroy DHTs/routes, close sockets, erase temp state, and report the last redacted state transition without route secrets or topics.
- [ ] Run `npm run test:private:integration`; expect all operations green.
- [ ] Commit: `test: add real native private dht testnet`

### Task 18: Extend the namespace packet oracle to the routed DHT threat model

**Files (HyperDHT repo):**

- Create: `test/private-integration/namespace/netns.js`
- Create: `test/private-integration/namespace/pcap.js`
- Create: `test/private-integration/namespace/capture-oracle.js`
- Create: `test/private-integration/namespace/topology.js`
- Create: `test/private-integration/namespace/negative-control.js`
- Create: `test/private-integration/namespace/run.js`
- Create: `test/private-integration/namespace/run.test.js`
- Modify: `package.json`

- [ ] Write failing oracle unit tests for the M3 topology. Before guard pinning, derive allowances from static configured bootstrap candidates plus cryptographically validated referral-provenance audit events—not a client readiness declaration. Enforce at most three sequential bootstrap contacts, one optional legacy single-node `FIND_NODE`, and one global maximum of three guard challenges. After authenticated guard-link handoff and BootstrapIO destruction, the client namespace may exchange UDX only with the shared guard endpoint.
- [ ] Assert exit/storage pcaps see the applicable previous-hop/exit address and never the client's address. Separately, assert bounded stdio audit snapshots show private records/returned values contain no serialized client IP/port; packet captures are not content/state proof.
- [ ] Enforce the complete static-role/provenance flow matrix: client→shared guard; guard→distinct lookup/announce middles; each middle→only its distinct branch exit; each exit→only executor-provenance-qualified destinations for its allowlisted command class. Reject cross-branch roles, guard→exit shortcuts, exit→client, and any destination whose audit evidence was not bound to the observed issuing handle/request/response.
- [ ] Add a negative-control runner that deliberately sends one post-guard client datagram to a DHT node. Run `npm run test:namespace:m3:negative`; expect the oracle to fail and identify the forbidden flow.
- [ ] Reuse the HyperDHT process coordinator from Task 17 directly and adapt the already-proven M2 oracle rules without copying routing protocol logic. Launch one Linux network namespace per role using veth links and explicit fixture subnets. Capture every namespace with `tcpdump -U -n -i any -w ...` from before bootstrap through teardown.
- [ ] Run `sudo env "PATH=$PATH" "PRIVATE_ROUTE_ARTIFACT_DIR=$PWD/artifacts" "$(command -v npm)" run test:namespace:m3`; expect presence and immutable/mutable operations to pass with zero forbidden flows.
- [ ] Keep evidence classes separate: the packet oracle proves flows only; coordinator audit snapshots prove record-content exclusion, handle provenance, empty client public tables, cancellation, erasure, and zero-resource teardown. The test passes only if both evidence classes pass. Always delete namespaces/veths/processes in traps; retain real pcaps locally only and upload synthetic pcaps or redacted flow manifests with three-day retention.
- [ ] Commit: `test: prove routed dht packets stop at the guard`

### Task 19: Exercise faults, rotations, and the simulated mobile Bare policy

**Files (HyperDHT repo):**

- Create: `test/integration/private-routing-faults.js`
- Create: `test/integration/private-routing-mobile.js`
- Modify: `test/private-integration/coordinator.js`
- Modify: `test/private-integration/operations.js`
- Modify: `package.json`
- Modify: `.github/workflows/private-routing.yml`

- [ ] Write failing process tests for lost/reordered finalization, exit loss, malicious referral, stale handle, partial storage quorum, guard failure, branch expiry, suspend/resume, network-change injection, and mutation interrupted between prepare/commit.
- [ ] Assert every interruption fails or restarts on a fresh generation, never reuses a token/receipt/handle, never opens direct IO, and never crosses lookup/announce branches.
- [ ] Add Node-client and Bare-client variants. Label the Bare job a deterministic simulation of the mobile policy—not iOS/Android validation. It verifies shared heartbeat epochs, <=12 total heartbeat cells and <=3 simulated client wakeups per half-open minute, 60-second application-idle branch destruction, zero post-destruction traffic, and fresh circuits after resume.
- [ ] Cover malicious guard referrals, fabricated routing metadata, false absence, arbitrary-handle requests, zero/stale seeds, insufficient density, active-time rotations, forged values/records/receipts, and branch projection secrecy under fault injection if the real-process happy-path case cannot deterministically trigger the condition.
- [ ] Run `npm run test:private:faults`; expect failures until coordinator fault injection and generation aborts are connected.
- [ ] Implement bounded deterministic fault injection at route/process boundaries. Keep Tor/Arti, Hyperswarm Noise, peer streams, and mobile native shells out of M3.
- [ ] Run `npm run test:private:faults` and `npm run test:private:mobile`; expect Node and Bare green.
- [ ] Finalize `.github/workflows/private-routing.yml` here, after all HyperDHT test scripts exist. Use Node 22 and a lockfile-pinned `bare-runtime`, include integration/fault/simulated-mobile/namespace jobs, then commit. This is the last HyperDHT commit before PearTube pins it.
- [ ] Commit: `test: harden private dht lifecycle under faults`

### Task 20: Add a PearTube exact-pin integration harness without exposing the switch

**Files (PearTube repo):**

- Create: `packages/private-routing-integration/package.json`
- Create: `packages/private-routing-integration/package-lock.json`
- Create: `packages/private-routing-integration/test/smoke.js`
- Create: `packages/private-routing-integration/scripts/check-pins.js`
- Create: `packages/private-routing-integration/scripts/run-smoke.js`
- Modify: `package.json`
- Create: `.github/workflows/private-routing-m3.yml`

- [ ] Create a private, non-publishable harness package with exact Git-SHA dependency `hyperdht: git+https://github.com/ayooooo123/hyperdht.git#<accepted-sha>`. Assert its lockfile transitively resolves only the accepted `dht-rpc` and `hyperdht-private-routes` SHAs. Define scripts `test:node`, `test:bare`, and `test` (both); use Node 22 and lockfile-pinned `bare-runtime`.
- [ ] Write a failing smoke test that constructs required-mode HyperDHT under Node/Bare, awaits private readiness against the isolated fixture, performs private announce/lookup, and confirms every M4 connection method returns `ERR_PRIVATE_ROUTING_M4_REQUIRED`. `run-smoke.js` requires `HYPERDHT_FIXTURE_DIR` pointing at a detached checkout whose HEAD equals the pinned HyperDHT SHA and launches that checkout's Task 17 coordinator through an explicit length-prefixed stdio contract; installed npm contents are never expected to contain `test/**`.
- [ ] Run `npm ci && npm test` in `packages/private-routing-integration`; expect failure before the exact HyperDHT pin and fixture configuration are present.
- [ ] Add only test/integration wiring. Do not change `packages/backend` production Hyperswarm construction, product settings, mobile UI, or Electrobun behavior, and do not expose a “private traffic” switch: M3 cannot carry Hyperswarm peer connections.
- [ ] Add root scripts `test:private-routing:m3` and `check:private-routing:pins` that delegate to the harness.
- [ ] For local verification, clone/check out the accepted HyperDHT SHA into a sibling fixture directory and export `HYPERDHT_FIXTURE_DIR`. In CI, use a second `actions/checkout` with `repository: ayooooo123/hyperdht`, exact `ref: <accepted-sha>`, `path: hyperdht-fixture`, and `persist-credentials: false`.
- [ ] Run the harness in Node and Bare; expect private DHT records green and every peer connection surface closed.
- [ ] Commit: `test: pin native private hyperdht milestone`

### Task 21: Make all acceptance gates GitHub-native and auditable

**Files (PearTube repo):**

- Modify: `.github/workflows/private-routing-m3.yml`
- Create: `docs/superpowers/reports/2026-07-14-native-dht-private-routing-m3.md`

- [ ] Freeze the upstream-to-downstream cascade before editing PearTube: final private-routes SHA (Task 5A, no later commits) → final DHT-RPC SHA (Task 10 in `.github/workflows/ci.yml`, no later commits) → HyperDHT repins those SHAs and finishes Tasks 11–19 (no later commits) → PearTube pins that final HyperDHT SHA. If any upstream commit changes, repeat every downstream pin, lockfile, test, and report step.
- [ ] Use `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5` with `persist-credentials: false`, `actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020`, and `actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02` (or newer official SHAs re-resolved and recorded before implementation). Workflows trigger on `pull_request`, never `pull_request_target`; set job timeouts, `permissions: contents: read`, npm cache paths, and concurrency cancellation.
- [ ] Verify standalone private-routes required checks: format, Node, Bare, portable Node/Bare, codec fuzz, and M2 namespace oracle. Verify final DHT-RPC `.github/workflows/ci.yml`: legacy/routed Node/Bare, lint, isolation sentinel, and pack dry-run. Verify final HyperDHT workflow: legacy Node/Bare, private unit suites, package-boundary install, real testnet, fault matrix, simulated mobile Bare policy, M3 namespace oracle/negative control, and pack dry-run.
- [ ] PearTube required checks: exact-pin audit and Node/Bare M3 smoke only. Configure path filters to include its workflow, harness, M3 spec/plan/report, and dependency metadata.
- [ ] Run namespace jobs only on fresh GitHub-hosted `ubuntu-latest`; install `iproute2`, `iptables`, and `tcpdump`; use Node 22 and lockfile-pinned Bare. Give every check a unique stable name. Use no secrets, npm tokens, OIDC, write permissions, self-hosted runners, or publish steps.
- [ ] For every workflow, run the closest local command first, push its repository branch, watch the GitHub run to completion, and record repository, branch, commit SHA, run URL, job names, conclusion, and test counts in the acceptance report.
- [ ] Configure each GitHub repository's branch protection so those exact stable check names are required before merge. Do not add npm tokens, release permissions, or publishing jobs in M3.
- [ ] Commit in PearTube: `ci: gate native private dht milestone`

### Task 22: Perform final fresh-clone verification and security review

**Files (PearTube repo):**

- Modify: `docs/superpowers/reports/2026-07-14-native-dht-private-routing-m3.md`
- Modify: `docs/superpowers/specs/2026-07-14-native-dht-private-routing-m3-design.md`

- [ ] In four empty temporary directories, clone the exact candidate branches for private-routes, DHT-RPC, HyperDHT, and PearTube and check out the externally recorded candidate SHAs detached. Before any install, run dependency-free pin checks: `node scripts/check-private-routing-pins.js` in HyperDHT and `node packages/private-routing-integration/scripts/check-pins.js` in PearTube. Expect exact HTTPS repositories and 40-character accepted upstream SHAs; do not run Git dependency lifecycle scripts before this gate.
- [ ] Check out every accepted SHA detached, then run this exact table. Every command must exit 0 except the labeled negative control, which must exit nonzero for the expected forbidden flow:

| Repository       | Commands                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| private-routes   | `npm ci`; `npm run format:check`; `npm run test:node`; `npm run test:bare`; `npm run test:portable:node`; `npm run test:portable:bare`; `npm run test:namespace:unit`; `sudo env "PATH=$PATH" "PRIVATE_ROUTE_ARTIFACT_DIR=$PWD/artifacts" "$(command -v npm)" run test:namespace`; `npm run fuzz:cell -- --seed 1 --iterations 10000`; `npm pack --dry-run`                                                                                                          |
| DHT-RPC          | `npm ci`; `npm run lint`; `npm run test:node`; `npm run test:bare`; `npm pack --dry-run`                                                                                                                                                                                                                                                                                                                                                                             |
| HyperDHT         | `node scripts/check-private-routing-pins.js`; `npm ci`; `npm test`; `npm run integration`; `npm run test:bare`; `npm run test:private:integration`; `npm run test:private:faults`; `npm run test:private:mobile`; `npm run test:namespace:m3:unit`; `npm run test:namespace:m3:negative` (expected nonzero with forbidden flow); `sudo env "PATH=$PATH" "PRIVATE_ROUTE_ARTIFACT_DIR=$PWD/artifacts" "$(command -v npm)" run test:namespace:m3`; `npm pack --dry-run` |
| PearTube harness | `node packages/private-routing-integration/scripts/check-pins.js`; `npm ci --prefix packages/private-routing-integration`; `HYPERDHT_FIXTURE_DIR=<detached-hyperdht-checkout> npm run test:node --prefix packages/private-routing-integration`; `HYPERDHT_FIXTURE_DIR=<detached-hyperdht-checkout> npm run test:bare --prefix packages/private-routing-integration`                                                                                                  |

- [ ] Before each install, run the repository's pin checker (where applicable) against the report; expect exact HTTPS Git URLs and 40-character SHAs. Preserve failing local captures/logs; record only redacted aggregate results for passing runs.
- [ ] Search tracked files and npm dry-run manifests for `node_modules`, build output, pcaps, route keys, private fixture secrets, temp data, and absolute developer paths; expect none.
- [ ] Audit required mode with an application-DHT request matrix and packet capture. The only client network exception after guard readiness is the authenticated guard transport. There is no direct fallback on timeout, insufficient relay/storage density, rotation, suspend, or network change.
- [ ] Obtain independent code/security review of all four accepted commits against the design, wire registry, and this plan. Resolve every blocking/important finding and rerun affected gates. This does not substitute for external cryptographic review: keep the wire and package explicitly experimental/unstable and block production/publishing claims until an external cryptographer reviews the transcript, KDF, AEAD context, replay, and finalization design.
- [ ] Mark M3 complete in the design/report only when private presence plus immutable/mutable operations pass the real isolated testnet and authoritative packet oracle. State prominently that Hyperswarm/Noise/PearTube all-traffic privacy remains M4 and the product switch is intentionally unavailable.
- [ ] Commit the acceptance docs as the final PearTube candidate: `docs: record native private dht m3 acceptance`. Make no later tree changes. Rerun PearTube pin/Node/Bare required checks on that commit, obtain independent review of the final docs diff, push it, and record its resulting SHA and final GitHub run URL externally in the PR description and final handoff (a commit cannot truthfully embed its own SHA).

## Final Deliverables

- [ ] Public GitHub URLs and exact accepted commits for `hyperdht-private-routes`, `ayooooo123/dht-rpc`, `ayooooo123/hyperdht`, and the PearTube integration branch.
- [ ] Green Node/Bare/unit/integration/fault/simulated-mobile-Bare-policy/namespace job table with GitHub Actions URLs.
- [ ] Packet-oracle evidence that post-guard client DHT traffic reaches only the guard.
- [ ] Exact Git dependencies still awaiting npm publication.
- [ ] Explicit M4 handoff: private peer descriptors, routed Noise/UDX streams, Hyperswarm integration, actual mobile/desktop app switch, and all-traffic enforcement.
