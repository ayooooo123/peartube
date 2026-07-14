# Holepunch Private Routing Milestone 2 Live-UDX Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents are available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Milestones 0–1 in-memory actor boundary with an independently testable, seven-process UDX relay graph that carries fixed-size authenticated cells between two private endpoints and proves exact network adjacency with a Linux packet-capture gate.

**Architecture:** Keep `udx-native` generic and inject it behind `UdxCellEndpoint`. Establish one circuit-scoped UDX link per adjacent pair using bilateral signed topology grants and a signed fixed-size bootstrap envelope. Multiplex link control and fragmented remote-actor control inside authenticated CONTROL cells, then expose a bounded `CompiledRouteDuplex`. Portable Node/Bare coordinators launch source, five relays, and destination with role-scoped configurations; a Linux namespace harness independently audits every IP packet.

**Tech Stack:** ESM JavaScript, Node 22, Bare 1.30.3, `udx-native` 1.20.7, `bare-process` 4.5.1, Brittle, `b4a`, existing private-route cryptography/codecs, Linux `ip netns`, `tcpdump`, GitHub Actions.

**Specs:**

- `docs/superpowers/specs/2026-07-13-holepunch-private-routing-m2-udx-design.md`
- `docs/superpowers/specs/2026-07-12-holepunch-private-routing-design.md`

**Starting evidence:** Node and Bare each pass 405 tests / 5,253 assertions; the cell fuzz gate passes 10,000 iterations with seed 1. Preserve these as regression gates.

---

## Scope Guard

This plan implements only Milestone 2. Do not modify PearTube backend/UI code, HyperDHT, DHT-RPC, Hyperswarm, Hypercore, or `udx-native`. Do not add DHT gateways, relay discovery, NAT traversal, mobile lifecycle handling, public testnet behavior, or direct fallback. The package remains private and experimental.

## File Map

| Path                                                         | Responsibility                                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `packages/private-routes/lib/topology-grant.js`              | Canonical bilateral grants, signatures, expiry, revocation, and role-scoped `LinkDirectory` |
| `packages/private-routes/lib/bootstrap-envelope.js`          | Exact signed 1,200-byte link bootstrap envelope and request tombstones                      |
| `packages/private-routes/lib/link-bootstrap-session.js`      | Async LinkCreate/LinkCreated handshake, deadline, cancellation, and ticket installation     |
| `packages/private-routes/lib/udx-adapter.js`                 | Narrow adapter over the exact `udx-native` socket API                                       |
| `packages/private-routes/lib/udx-cell-endpoint.js`           | One explicitly bound socket, adjacent-only sends, queues, dispatch, and close               |
| `packages/private-routes/lib/remote-control.js`              | Established control mux, transport fragment codec, actor/link control codecs                |
| `packages/private-routes/lib/remote-actor-host.js`           | Opaque local actor dispatch, request/reply ownership, and error mapping                     |
| `packages/private-routes/lib/async-route-control-session.js` | Async registration/activation state machine, deadlines, cancellation, rollback              |
| `packages/private-routes/lib/link-control-session.js`        | Ping/pong liveness and hop-by-hop STREAM acknowledgements                                   |
| `packages/private-routes/lib/compiled-route-duplex.js`       | Bounded stream/datagram API and generation-scoped drain semantics                           |
| `packages/private-routes/lib/live-route-node.js`             | Runtime-neutral composition for one source, relay, or destination role                      |
| `packages/private-routes/test/fake-udx.js`                   | Exact fake adapter with fault injection and resource accounting                             |
| `packages/private-routes/test/live-route-fixture.js`         | Deterministic identities, grants, descriptors, seven-role configurations                    |
| `packages/private-routes/test/process/**`                    | Framed stdio adapters, config auditor, role runner, and coordinator                         |
| `packages/private-routes/test/namespace/**`                  | Namespace lifecycle, PCAP parser/oracle, and negative-control dialer                        |
| `packages/private-routes/test/*udx*.test.js`                 | Unit and same-process live UDX coverage                                                     |
| `packages/private-routes/test/integration/*.test.js`         | Seven-process Node/Bare suites                                                              |
| `packages/private-routes/docs/protocol.md`                   | Experimental M2 transport and control formats                                               |
| `packages/private-routes/docs/threat-model.md`               | M2 claims, role views, capture oracle, and exclusions                                       |
| `packages/private-routes/README.md`                          | Commands and explicit “not Hyperswarm/PearTube yet” status                                  |
| `.github/workflows/private-routes.yml`                       | Unit, portable Node/Bare, and required namespace jobs                                       |

## Chunk 1: Reproducible Transport Foundation

### Task 1: Pin the native/runtime dependencies and preserve the baseline

**Files:**

- Modify: `packages/private-routes/package.json`
- Modify: `packages/private-routes/package-lock.json`
- Create: `packages/private-routes/scripts/check-dependencies.mjs`
- Create: `packages/private-routes/test/udx-dependency.test.js`

- [ ] **Step 1: Write a failing Node manifest/lock check and portable runtime test**

The Node-only script reads JSON with `node:fs` and asserts that `udx-native` is a direct exact dependency at `1.20.7` and `bare-process` is a direct exact dev dependency at `4.5.1`. The Brittle test imports only `udx-native`, runs in Node and Bare, and asserts that `new UDX().createSocket()` exposes `bind`, `send`, `trySend`, `address`, and `close`.

```js
assert.equal(manifest.dependencies["udx-native"], "1.20.7");
assert.equal(manifest.devDependencies["bare-process"], "4.5.1");
assert.equal(lock.packages["node_modules/udx-native"].version, "1.20.7");
assert.equal(lock.packages["node_modules/bare-process"].version, "4.5.1");

test("UDX exposes the pinned datagram socket surface", async (t) => {
  const socket = new UDX().createSocket();
  for (const name of ["bind", "send", "trySend", "address", "close"])
    t.is(typeof socket[name], "function");
  await socket.close();
});
```

- [ ] **Step 2: Run both checks and verify RED**

Run: `node packages/private-routes/scripts/check-dependencies.mjs`

Run: `npm run test:one --prefix packages/private-routes -- test/udx-dependency.test.js`

Expected: both FAIL because the direct declarations/native module are absent. Do not import Node built-ins or package JSON from the portable Brittle test.

- [ ] **Step 3: Install exact versions without changing the root lockfile**

```bash
npm install --prefix packages/private-routes --save-exact udx-native@1.20.7
npm install --prefix packages/private-routes --save-dev --save-exact bare-process@4.5.1
```

Add scripts:

```json
"check:dependencies": "node scripts/check-dependencies.mjs",
"test:portable:node": "brittle-node test/integration/live-udx-node.test.js",
"test:portable:bare": "brittle-node test/integration/live-udx-bare.test.js",
"test:namespace": "node test/namespace/run.js",
"test:m2": "npm run test:node && npm run test:bare && npm run test:portable:node && npm run test:portable:bare"
```

- [ ] **Step 4: Verify GREEN and the inherited baseline**

Run `npm run check:dependencies --prefix packages/private-routes`, the focused UDX test under Node and Bare, `npm run test:node --prefix packages/private-routes`, `npm run test:bare --prefix packages/private-routes`, and the 10,000-iteration fuzz command.

Expected: dependency test passes; inherited totals do not decrease; fuzz reports zero unexpected outcomes.

- [ ] **Step 5: Commit**

```bash
git add packages/private-routes/package.json packages/private-routes/package-lock.json packages/private-routes/scripts/check-dependencies.mjs packages/private-routes/test/udx-dependency.test.js
git commit -m "build: pin live UDX route dependencies"
```

### Task 2: Implement bilateral signed topology grants and `LinkDirectory`

**Files:**

- Modify: `packages/private-routes/lib/protocol.js`
- Create: `packages/private-routes/lib/topology-grant.js`
- Create: `packages/private-routes/test/topology-grant.test.js`
- Modify: `packages/private-routes/index.js`

- [ ] **Step 1: Write RED known-answer tests for the canonical grant**

Cover lexicographic endpoint ordering, exact encoding, domain-separated signature, identical signed bytes at both peers, operation bits, run ID, epoch/times, digest, and every one-byte mutation.

```js
const signed = signTopologyGrant(grant, authority.secretKey);
const atA = verifyTopologyGrant(signed, authority.publicKey, {
  localIdentity: a.publicKey,
});
const atB = verifyTopologyGrant(signed, authority.publicKey, {
  localIdentity: b.publicKey,
});
t.alike(atA.digest, atB.digest);
t.alike(atA.peerAddress, { host: "127.0.0.2", port: 41002 });
```

- [ ] **Step 2: Add failing `LinkDirectory` authority tests**

Require exact local identity/role/operation/epoch/run binding, numeric IPv4/IPv6 only, no enumeration API, one opaque link handle per digest, expiry close callback, same-epoch revocation tombstone, and zero state after destroy.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `npm run test:one --prefix packages/private-routes -- test/topology-grant.test.js`

Expected: FAIL on missing exports.

- [ ] **Step 4: Implement the minimum canonical codec and directory**

Add `DOMAIN.TOPOLOGY_GRANT = 'hyperdht-private-routes/topology-grant/v0'`. Reuse `cryptoSuite.sign`, `verify`, and `hash`; copy all retained buffers; accept an injected monotonic/wall clock; expose lookup by digest + operation only. Do not expose `entries()`, raw address lookup, or arbitrary host/port dialing.

- [ ] **Step 5: Verify Node and Bare, then commit**

Run the focused test under `brittle-node` and `brittle-bare`, format, and commit:

```bash
git add packages/private-routes/lib/protocol.js packages/private-routes/lib/topology-grant.js packages/private-routes/test/topology-grant.test.js packages/private-routes/index.js
git commit -m "feat: authorize bilateral UDX links"
```

### Task 3: Lock the signed fixed-size bootstrap envelope

**Files:**

- Create: `packages/private-routes/lib/bootstrap-envelope.js`
- Create: `packages/private-routes/test/bootstrap-envelope.test.js`
- Modify: `packages/private-routes/lib/protocol.js`
- Modify: `packages/private-routes/index.js`

- [ ] **Step 1: Write RED layout and known-answer tests**

Assert exactly 1,200 bytes, offsets 0/1/2/3/4/12/20/22/54/86/118/150/1136, class `0x80`, maximum body 986, big-endian integers, random authenticated padding, and a 64-byte signature over bytes 0–1135.

- [ ] **Step 2: Write RED correlation/adversarial tests**

Cover all four types, zero request digest only for `LINK_CREATE`, reversed identities on replies, shared grant digest, duplicate-same-body cached reply, duplicate-different-body rejection, timeout/cancel tombstones, signed reject amplification bound, silent unauthenticated input, all 1,200 single-byte mutations, truncation, extension, replay, and cross-class input.

- [ ] **Step 3: Run RED**

Run: `npm run test:one --prefix packages/private-routes -- test/bootstrap-envelope.test.js`

- [ ] **Step 4: Implement `BootstrapEnvelopeCodec` and `BootstrapRequestTable`**

Add `DOMAIN.UDX_BOOTSTRAP`. Parse total size/version/class/type before body allocation. Verify source address grant, recipient identity, grant digest, signature, request digest, and inner `LinkCreate`/`LinkCreated` before retaining state. Bound pending and tombstone maps and deeply clear owned request material.

- [ ] **Step 5: Verify both runtimes and commit**

```bash
git add packages/private-routes/lib/bootstrap-envelope.js packages/private-routes/lib/protocol.js packages/private-routes/test/bootstrap-envelope.test.js packages/private-routes/index.js
git commit -m "feat: authenticate fixed-size UDX bootstrap"
```

### Task 4: Build the fake/real UDX adapter and adjacent-only endpoint

**Files:**

- Create: `packages/private-routes/lib/udx-adapter.js`
- Create: `packages/private-routes/lib/udx-cell-endpoint.js`
- Create: `packages/private-routes/lib/link-bootstrap-session.js`
- Create: `packages/private-routes/test/fake-udx.js`
- Create: `packages/private-routes/test/udx-cell-endpoint.test.js`
- Create: `packages/private-routes/test/link-bootstrap-session.test.js`
- Create: `packages/private-routes/test/udx-loopback.test.js`
- Modify: `packages/private-routes/index.js`

- [ ] **Step 1: Write RED fake-adapter boundary tests**

Require one UDX instance/socket, explicit numeric bind, exactly 1,200 bytes, grant-derived opaque send handles, exact source host/port pinning, bounded packets/bytes, copied ownership, short/failed sends, sync throw/async rejection, reentrancy, cancellation, close order, and zero final resources.

- [ ] **Step 2: Prove arbitrary dialing is absent**

Assert the public endpoint surface contains only `bind`, `openLink`, `send`, `close`, and resource getters; `send(handle, packet)` must be impossible with a host/port object or unknown handle.

- [ ] **Step 3: Write RED async bootstrap-session tests**

Lock `IDLE → CREATING → OPEN` and every failure to a bounded tombstone. The initiator must create a canonical `LinkCreate`, send it in `BootstrapEnvelope`, correlate only the exact `LinkCreated`, call the existing link-setup authority to authenticate/complete the ticket, and install established `CellCodec` state only after success. The responder verifies envelope + bilateral grant before `respond()`. Cover the 5,000 ms deadline, pre-dispatch cancellation, signed cancel after dispatch, duplicate identical request/cached response, different-body reuse, late response, close, and zero pending/ticket/secret state.

- [ ] **Step 4: Implement `LinkBootstrapSession` and the narrow real adapter against 1.20.7**

The bootstrap session owns request correlation, link-setup tickets, and the transition into established dispatch. `UdxCellEndpoint.openLink()` delegates to this session. Liveness starts only after the authenticated ticket and per-class codecs are installed; no actor or route state opens during bootstrap.

Use only:

```js
const udx = new UDX();
const socket = udx.createSocket();
socket.bind(port, host);
socket.on("message", (packet, from) => receive(packet, from));
const sent = await socket.send(packet, peer.port, peer.host);
if (sent !== true) throw PrivateRouteError.ROUTE_UNAVAILABLE();
await socket.close();
```

`udx-native@1.20.7` has no native cancellation handle. A queued send may be removed before dispatch; after `socket.send()` begins, cancellation only tombstones its completion and prevents callbacks/state transfer. `close()` rejects new/queued sends, awaits every native in-flight promise, ignores their tombstoned late callbacks, then awaits `socket.close()`. Treat throw, rejection, or any result other than exact `true` (including `false` while closing) as failed. Lock each case in the fake-adapter suite and verify exact `true`/`false` behavior with the real adapter.

Do not use UDX streams, DNS lookup, wildcard binds, or `trySend` in production.

- [ ] **Step 5: Add real two-socket loopback smoke tests**

Bind two distinct numeric loopback addresses, complete a real `LinkCreate`/`LinkCreated` exchange, then exchange one authenticated established cell, verify `from`, then close. Run the identical file in Node and Bare.

- [ ] **Step 6: Verify and commit**

```bash
git add packages/private-routes/lib/udx-adapter.js packages/private-routes/lib/udx-cell-endpoint.js packages/private-routes/lib/link-bootstrap-session.js packages/private-routes/test/fake-udx.js packages/private-routes/test/udx-cell-endpoint.test.js packages/private-routes/test/link-bootstrap-session.test.js packages/private-routes/test/udx-loopback.test.js packages/private-routes/index.js
git commit -m "feat: add adjacent-only UDX cell endpoint"
```

## Chunk 2: Asynchronous Remote Route Control

### Task 5: Implement the established control mux and bounded codecs

**Files:**

- Create: `packages/private-routes/lib/remote-control.js`
- Create: `packages/private-routes/test/remote-control.test.js`
- Modify: `packages/private-routes/index.js`

- [ ] **Step 1: Write RED control-mux tests**

Lock namespace `0x00` for the exact 44-byte link-control body and `0x01` for actor fragments. Reject every other namespace, trailing bytes, field mismatch with the outer authenticated cell, and link control routed into actor reassembly.

- [ ] **Step 2: Write RED transport-fragment tests**

Lock a 22-byte header, maximum 1,123 data bytes, 8,192 logical bytes, at most eight ordered fragments, one active request per reassembler, 5,000 ms expiry, completed-ID replay bound, cross-request splice rejection, and zero buffered bytes after every failure.

- [ ] **Step 3: Write RED actor/link codec tests**

Actor header is exactly 54 bytes and body maximum 8,138. Test every request/reply pair, recipient-local actor IDs, zero registration circuit/generation, exact error body, and response correlation. Link control must test ping/pong challenge, generation zero, opposite-direction STREAM ACK, counter value + eight zero bytes, and circuit/header binding.

- [ ] **Step 4: Implement without changing the virtual fragment wire format**

Factor shared validation only. Keep `activation-fragments.js` at 1,124 bytes; the new `RemoteControlFragmentCodec` owns the 1,123-byte transport limit.

- [ ] **Step 5: Verify Node/Bare and commit**

```bash
git add packages/private-routes/lib/remote-control.js packages/private-routes/test/remote-control.test.js packages/private-routes/index.js
git commit -m "feat: encode remote route control cells"
```

### Task 6: Convert opaque actors into an async remote command boundary

**Files:**

- Modify: `packages/private-routes/lib/activation.js`
- Create: `packages/private-routes/lib/remote-actor-host.js`
- Create: `packages/private-routes/test/remote-actor-host.test.js`
- Modify: `packages/private-routes/index.js`

- [ ] **Step 1: Write RED dispatch and capability-isolation tests**

Register opaque local IDs for a relay/destination actor, dispatch canonical stage/prepare/finalize/abort/activate/destroy messages, and assert no actor object, callback, secret, route array, or destination address appears in encoded messages or returned handles.

- [ ] **Step 2: Write RED ownership/error tests**

Cover private copies, clear-after-handler, allowlisted remote errors, unknown error mapping to `ROUTE_UNAVAILABLE`, handler throw, malformed reply, duplicate ID/different digest, late response, queue refusal, and destroy with zero pending requests/bodies.

- [ ] **Step 3: Add the narrow internal actor command adapter**

Inside `activation.js`, expose a package-internal factory that can call the existing WeakMap-backed actor state but returns only canonical byte-in/byte-out operations. Do not export actor state or add public methods to the frozen actor capability.

- [ ] **Step 4: Implement `RemoteActorHost` request/notify**

Use injected `sendControl`, clock, randomness, and scheduler. Require a nonzero random request ID for replies, zero only for allowlisted one-way notifications, exact reply type, one completion, bounded pending map, and deep cleanup.

- [ ] **Step 5: Verify inherited actor tests and commit**

Run `activation.test.js`, `compiled-route.test.js`, the new focused suite under Node/Bare, then commit:

```bash
git add packages/private-routes/lib/activation.js packages/private-routes/lib/remote-actor-host.js packages/private-routes/test/remote-actor-host.test.js packages/private-routes/index.js
git commit -m "feat: dispatch private actors across links"
```

### Task 7: Implement async registration/activation with rollback

**Files:**

- Create: `packages/private-routes/lib/async-route-control-session.js`
- Create: `packages/private-routes/test/async-route-control-session.test.js`
- Modify: `packages/private-routes/lib/activation.js`
- Modify: `packages/private-routes/index.js`

- [ ] **Step 1: Write RED state-table tests**

Exercise `NEW → STAGED → PREPARED → FINALIZED`, abort from staged/prepared, expiry/revoke after finalized, and `NEW → ACTIVATING → OPEN → DESTROYING → DESTROYED`. Repeated abort/destroy is idempotent; every skipped/repeated other transition is `CIRCUIT_STATE`.

- [ ] **Step 2: Write real-fault timeout tests**

Drop each actual remote response, delay it to exactly/after 5,000 ms, cancel before/after remote stage, duplicate callback, kill transport, and reject send. Assert remote abort attempt, expiry backstop, late tombstone behavior, zero secrets/fragments/waits/timers, and stable error mapping.

- [ ] **Step 3: Implement the Promise-based session**

Use one monotonic deadline propagated through every subrequest; never reset the 5,000 ms budget per hop. Track cancellation handles before initiating the send. Transfer ownership only after `REGISTER_STAGED` and authenticated `ACTIVATE_CREATED` as specified.

- [ ] **Step 4: Share validation with the synchronous virtual path**

Factor validation/state helpers from `activation.js`; do not make real transport call the synchronous callback path. Rerun all 405 inherited tests to prove no rule fork.

- [ ] **Step 5: Verify and commit**

```bash
git add packages/private-routes/lib/async-route-control-session.js packages/private-routes/lib/activation.js packages/private-routes/test/async-route-control-session.test.js packages/private-routes/index.js
git commit -m "feat: activate private routes asynchronously"
```

### Task 8: Add replay-safe liveness and hop-by-hop stream backpressure

**Files:**

- Create: `packages/private-routes/lib/link-control-session.js`
- Create: `packages/private-routes/test/link-control-session.test.js`
- Modify: `packages/private-routes/lib/udx-cell-endpoint.js`
- Modify: `packages/private-routes/index.js`

- [ ] **Step 1: Write RED liveness tests with a fake clock**

Only a cell passing source, AEAD, direction, epoch, circuit, counter order, and replay checks may refresh activity. Test ping at 500 ms, close at 1,500 ms, wrong challenge, lost pong, UDP sends that keep succeeding after peer death, and authenticated replays every 100 ms that still cannot postpone expiry.

- [ ] **Step 2: Write RED ACK/accounting tests**

Use independent counter spaces per link/direction/generation. A relay ACKs only after the entire plaintext enters its bounded next-hop queue. Test cumulative release, regression, unsent counter, wrong direction/generation, endpoint read-queue pressure, 5,000 ms ACK timeout, and DATAGRAM no-ACK semantics.

- [ ] **Step 3: Implement link-scoped control before actor dispatch**

Start liveness immediately after authenticated `LinkCreated`, with circuit ID already allocated and generation zero. Consume link namespace locally. On close, tombstone the link, cancel sends/waits, notify every still-live circuit direction, then stop heartbeat timers before socket close.

- [ ] **Step 4: Verify bounded failure propagation**

Simulate a dead middle process. Both adjacent links must expire independently; all surviving route state reaches zero within 6,500 ms; no new grant, link, direct socket, or decoy event occurs.

- [ ] **Step 5: Verify and commit**

```bash
git add packages/private-routes/lib/link-control-session.js packages/private-routes/lib/udx-cell-endpoint.js packages/private-routes/test/link-control-session.test.js packages/private-routes/index.js
git commit -m "feat: bound live link failure and flow control"
```

### Task 9: Expose the bounded compiled duplex over live links

**Files:**

- Create: `packages/private-routes/lib/compiled-route-duplex.js`
- Create: `packages/private-routes/test/compiled-route-duplex.test.js`
- Modify: `packages/private-routes/lib/route-manager.js`
- Modify: `packages/private-routes/index.js`

- [ ] **Step 1: Write RED public-surface tests**

The object exposes bounded stream write/read, atomic datagram send/receive, `drain`, and idempotent `destroy`; it exposes no host, port, UDX socket, link grant, actor, direct dial, or fallback method.

- [ ] **Step 2: Lock generation-scoped drain semantics**

Capture the highest first-hop STREAM counter present at `drain()`. Resolve only after the same-generation cumulative ACK covers it and the local queue is below low water. Reject on replacement/failure first. State explicitly in tests that this is not an end-to-end read receipt.

- [ ] **Step 3: Test fragmentation, backpressure, and teardown**

Cover bidirectional stream ordering, maximum fragments, oversize datagram rejection, queue boundaries, reentrant read/destroy, counter exhaustion, replacement generation isolation, ACK timeout, and zero plaintext/queue accounting after close.

- [ ] **Step 4: Integrate only after authenticated `CREATED`**

`RouteManager` may return the live duplex only after the async source verifies the full `CREATED` transcript. No half-open session is writable.

- [ ] **Step 5: Verify and commit**

```bash
git add packages/private-routes/lib/compiled-route-duplex.js packages/private-routes/lib/route-manager.js packages/private-routes/test/compiled-route-duplex.test.js packages/private-routes/index.js
git commit -m "feat: expose compiled live private routes"
```

## Chunk 3: Seven-Process Portable Graph

### Task 10: Compose one role and prove a same-process real-UDX graph

**Files:**

- Create: `packages/private-routes/lib/live-route-node.js`
- Create: `packages/private-routes/test/live-route-fixture.js`
- Create: `packages/private-routes/test/live-udx-graph.test.js`
- Modify: `packages/private-routes/index.js`

- [ ] **Step 1: Build exact deterministic role projections in the fixture**

Create source, two safety relays, three private relays, destination, bilateral grants, signed advertisements/descriptor, opaque actor IDs, epochs, ports, and the exact `may know`/`may directly contact` matrices. Do not give a role the full topology object.

- [ ] **Step 2: Write a RED seven-role same-process test**

Use seven real UDX instances/sockets on distinct `127.0.0.x` addresses. Register the private segment, construct the safety segment, authenticate `CREATED`, and exchange multiple stream/datagram payloads both ways.

- [ ] **Step 3: Implement `createLiveRouteNode(roleProjection, adapters)`**

Compose directory, UDX endpoint, bootstrap, control mux, liveness, remote actor, and role-specific registration/activation. Accept injected clock/random/scheduler/observer; emit redacted role/state/counter/fingerprint/resource events only.

- [ ] **Step 4: Assert exact observed adjacency and cleanup**

Require all six adjacent undirected links in both required directions, no other edge, exact 1,200-byte datagrams, and zero bindings/waits/timers/queued bytes/open sockets after shutdown.

- [ ] **Step 5: Run Node/Bare and commit**

```bash
git add packages/private-routes/lib/live-route-node.js packages/private-routes/test/live-route-fixture.js packages/private-routes/test/live-udx-graph.test.js packages/private-routes/index.js
git commit -m "feat: compose the live private relay graph"
```

### Task 11: Implement framed process control and the independent configuration oracle

**Files:**

- Create: `packages/private-routes/test/process/control-channel.js`
- Create: `packages/private-routes/test/process/runtime-node.js`
- Create: `packages/private-routes/test/process/runtime-bare.js`
- Create: `packages/private-routes/test/process/config-auditor.js`
- Create: `packages/private-routes/test/process/role-runner.js`
- Create: `packages/private-routes/test/process-control.test.js`
- Create: `packages/private-routes/test/config-auditor.test.js`
- Modify: `packages/private-routes/package.json`

- [ ] **Step 1: Write RED framing tests**

Lock four-byte big-endian length + canonical UTF-8 JSON, 64 KiB maximum, exact command/event enums, configure-once-before-start, commands-after-stop rejection, and exactly one legal terminal `closed` event. Test split/coalesced frames and malformed/noncanonical input.

- [ ] **Step 2: Write RED independent projection tests**

For every role, compare semantic configuration and serialized bytes against exact allowed fields, identities/advertisements, and bilateral grants. Assert no value outside the role's knowledge row, no grant outside direct-contact row, no path array, and no raw address in events/stderr. Include negative fixtures leaking each forbidden address.

- [ ] **Step 3: Add runtime-conditioned process adapters**

Add package imports:

```json
"#private-route-process": {
  "bare": "./test/process/runtime-bare.js",
  "default": "./test/process/runtime-node.js"
}
```

The Bare adapter imports exact `bare-process`; the Node adapter uses global `process`. Both expose only stdin/stdout/stderr byte channels and exit.

- [ ] **Step 4: Implement the role runner**

Accept one audited projection, instantiate one `LiveRouteNode`, respond to `configure/start/fault/revoke/snapshot/stop`, and emit only audited records. Do not log payloads, keys, full configs, or paths.

- [ ] **Step 5: Verify Node/Bare control tests and commit**

```bash
git add packages/private-routes/package.json packages/private-routes/test/process packages/private-routes/test/process-control.test.js packages/private-routes/test/config-auditor.test.js
git commit -m "test: isolate live route role processes"
```

### Task 12: Launch and verify seven Node processes

**Files:**

- Create: `packages/private-routes/test/process/coordinator.js`
- Create: `packages/private-routes/test/integration/live-udx-node.test.js`

- [ ] **Step 1: Write RED coordinator lifecycle tests**

Launch exactly seven Node children with inherited pipes, send only their audited projections, wait for seven `ready` records, and enforce bounded startup/teardown. Unexpected exit, stdout junk, stderr leak, or timeout fails with redacted diagnostics.

- [ ] **Step 2: Write the live success test**

Require registration, activation, bidirectional stream/datagram bytes, non-vacuous per-edge counters, exact endpoint peer observations, and all-zero snapshots after ordered shutdown.

- [ ] **Step 3: Add real fault rows**

Kill a relay, close a socket, delay `CREATED`, spoof source address, replay an authenticated packet, overflow a queue, revoke a grant, and stop during setup. Assert stable failure, 6,500 ms bounded cleanup, and no direct/fallback handle creation.

- [ ] **Step 4: Run independently and repeat for flake detection**

Run `npm run test:portable:node --prefix packages/private-routes` three consecutive times.

Expected: all runs pass with exactly seven children and zero survivors.

- [ ] **Step 5: Commit**

```bash
git add packages/private-routes/test/process/coordinator.js packages/private-routes/test/integration/live-udx-node.test.js
git commit -m "test: route bytes across seven Node processes"
```

### Task 13: Launch and verify seven Bare processes

**Files:**

- Create: `packages/private-routes/test/integration/live-udx-bare.test.js`
- Modify: `packages/private-routes/test/process/coordinator.js`

- [ ] **Step 1: Write RED all-Bare child assertions**

The Node coordinator must launch every role with the lockfile's `bare` executable and require each child to report runtime `v1.30.3`, `udx-native` `1.20.7`, and the Bare process adapter.

- [ ] **Step 2: Reuse the exact success/fault oracle**

Parameterize only the child command. Do not duplicate or weaken adjacency, payload, error, timeout, or cleanup assertions.

- [ ] **Step 3: Verify exact runtime parity**

Run `npm run test:portable:bare --prefix packages/private-routes` three times, followed by the all-Node suite once.

- [ ] **Step 4: Add mixed-codec known answers**

Have one Node helper encode bootstrap/control vectors and every Bare child decode/re-encode them; reverse the direction for Bare-produced vectors. Require byte equality.

- [ ] **Step 5: Commit**

```bash
git add packages/private-routes/test/process/coordinator.js packages/private-routes/test/integration/live-udx-bare.test.js
git commit -m "test: route bytes across seven Bare processes"
```

## Chunk 4: Authoritative Linux Privacy Gate

### Task 14: Build and unit-test the PCAP adjacency oracle

**Files:**

- Create: `packages/private-routes/test/namespace/pcap.js`
- Create: `packages/private-routes/test/namespace/capture-oracle.js`
- Create: `packages/private-routes/test/capture-oracle.test.js`

- [ ] **Step 1: Write RED parser fixtures**

Hand-build little/big-endian PCAP records with Ethernet, optional VLAN, IPv4, IPv6, UDP, TCP, ICMP, truncation, malformed lengths, and unknown link types. Do not add a parsing dependency.

- [ ] **Step 2: Write RED exact-matrix tests**

Require every role-originated IP packet to be UDP in the reserved range with payload length 1,200; every directed edge must be adjacent; source only guard; destination only private final; no decoy/external/source-destination edge; required setup/data edges must exist; no packets after closed timestamp.

- [ ] **Step 3: Add non-vacuity/false-positive tests**

Prove the oracle fails on an empty capture, a missing required edge, DNS, TCP, ICMP, another UDP port, IPv6 autoconfiguration, one decoy packet, one direct packet, post-close traffic, and malformed capture. Report packet index + synthetic roles only.

- [ ] **Step 4: Implement deterministic parsing and checking**

Return structured records, never shell-text parsing. The checker consumes an explicit address/role/port matrix and phase timestamps from the coordinator.

- [ ] **Step 5: Verify Node/Bare unit compatibility and commit**

```bash
git add packages/private-routes/test/namespace/pcap.js packages/private-routes/test/namespace/capture-oracle.js packages/private-routes/test/capture-oracle.test.js
git commit -m "test: audit private route packet captures"
```

### Task 15: Run the graph in fully reachable Linux network namespaces

**Files:**

- Create: `packages/private-routes/test/namespace/run.js`
- Create: `packages/private-routes/test/namespace/netns.js`
- Create: `packages/private-routes/test/namespace/negative-control.js`
- Modify: `packages/private-routes/test/process/coordinator.js`
- Modify: `packages/private-routes/package.json`

- [ ] **Step 1: Write lifecycle tests for command construction and cleanup**

Use a unique run suffix. Create source, five relay, destination, and decoy namespaces; one bridge; one veth per namespace; unique `/24` addresses; and no adjacency firewall. Track every created resource for reverse-order cleanup on success, failure, or signal.

- [ ] **Step 2: Disable only kernel noise**

Before capture, disable IPv6 autoconfiguration and drop only kernel ICMP port-unreachable output in each namespace. Do not block UDP/TCP between any namespace or external address. Prove all namespace addresses can reach the decoy before the authoritative run.

- [ ] **Step 3: Calibrate the negative control**

In a separate preflight capture, invoke `NegativeControlDialer` once and require the decoy to receive it. Reset count and capture. During the real run, inject relay failure + retry with the same capability present; require `ROUTE_UNAVAILABLE`, invocation count zero, and no decoy packet.

- [ ] **Step 4: Capture the authoritative run**

Launch `tcpdump -U -s 0 -w <artifact> -i <bridge> 'ip or ip6'` and wait for both its explicit listening/readiness record and a valid PCAP header before starting any role. Send a run-unique capture-start sentinel from the auditor/decoy namespace to an auditor listener outside the route-role address set; require both listener receipt and the sentinel in the live capture. Only then launch the seven processes through `ip netns exec`. Exercise setup, bidirectional stream/datagram data, relay death, retry, and shutdown. Record coordinator wall timestamps alongside capture timestamps for every phase and terminal `closed` event.

- [ ] **Step 5: Apply both state and PCAP oracles**

After all seven `closed` events, keep tcpdump running for a 1,750 ms grace interval (longer than the 1,500 ms link-liveness deadline). Then send a distinct run-unique capture-stop sentinel over the same auditor-only edge, require listener receipt, and stop tcpdump only after that packet is flushed. The PCAP oracle must find both ordered sentinels, align them with coordinator timestamps, and reject every role-attributed packet after the final `closed` timestamp through the stop sentinel. Sentinels are outside role attribution and cannot satisfy any required route edge.

Require exact serialized configs/events, required edge observations, all-IP capture rules, zero negative-control use, liveness cleanup, and zero process/socket/state survivors. Add lifecycle unit rows for missing readiness, missing/reordered sentinels, early tcpdump exit, a role packet during the grace interval, and a stop sentinel not flushed into PCAP. Preserve capture only on failure.

- [ ] **Step 6: Verify on Linux and commit**

Run as root on Linux: `npm run test:namespace --prefix packages/private-routes`

On non-Linux local hosts, unit-test command construction/oracles but do not mark the gate passed. The GitHub namespace job is authoritative.

```bash
git add packages/private-routes/test/namespace packages/private-routes/test/process/coordinator.js packages/private-routes/package.json
git commit -m "test: prove live route adjacency in namespaces"
```

## Chunk 5: CI, Documentation, and Completion Gate

### Task 16: Make all Milestone 2 gates GitHub-native

**Files:**

- Modify: `.github/workflows/private-routes.yml`

- [ ] **Step 1: Add portable jobs after unit jobs**

Keep `permissions: contents: read`, checkout SHA `34e114876b0b11c390a56381ad16ebd13914f8d5`, setup-node SHA `49933ea5288caeca8642d1e84afbd3f7d6820020`, Node 22, and `npm ci`. Assert exact Node major, Bare `v1.30.3`, and UDX `1.20.7` before tests.

- [ ] **Step 2: Add the required privileged namespace job**

Install/verify `iproute2`, `tcpdump`, and `iptables`; fail if namespace creation is unavailable. Run the unit oracle first, then the real namespace command with only the required elevation. Never silently skip.

- [ ] **Step 3: Upload failure captures with an immutable action**

Use official `actions/upload-artifact` v4 SHA `ea165f8d65b6e75b540449e92b4886f43607fa02`, `if: failure()`, a short retention, and only synthetic PCAP/redacted coordinator output.

- [ ] **Step 4: Validate YAML and action trust**

Check that every `uses:` ref is a 40-character SHA, permissions remain read-only, no secrets are used, package install is `npm ci`, and test processes receive no public DHT bootstrap.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/private-routes.yml
git commit -m "ci: require live private route gates"
```

### Task 17: Document the implemented boundary without overstating anonymity

**Files:**

- Modify: `packages/private-routes/README.md`
- Modify: `packages/private-routes/docs/protocol.md`
- Modify: `packages/private-routes/docs/threat-model.md`

- [ ] **Step 1: Add exact independent commands and architecture**

Document unit Node/Bare, portable Node/Bare, namespace, format, and fuzz commands. Describe fixed-size bootstrap/established cells, bilateral grants, remote actors, liveness, and hop-by-hop backpressure.

- [ ] **Step 2: Preserve the experimental/non-production warnings**

State prominently: this is a controlled static relay graph, not routed HyperDHT, Hyperswarm, PearTube, mobile privacy, NAT traversal, public discovery, production anonymity, or a stable audited wire format.

- [ ] **Step 3: Document privacy views and failure behavior**

Include the exact `may know`/`may directly contact` matrices, guard/final visibility, coordinator exception, no fallback, decoy negative control, and packet-capture limitations.

- [ ] **Step 4: Format/check links and commit**

```bash
npm run format --prefix packages/private-routes
git diff --check
git add packages/private-routes/README.md packages/private-routes/docs
git commit -m "docs: describe the live private route milestone"
```

### Task 18: Run the completion matrix and independent reviews

**Files:**

- Modify only if a verified issue requires a scoped fix.

- [ ] **Step 1: Prove a clean install and package isolation**

From a fresh clone/worktree, run `npm ci --prefix packages/private-routes`. Confirm no root lockfile change and no untracked native build output.

- [ ] **Step 2: Run the complete local matrix**

```bash
npm run format:check --prefix packages/private-routes
npm run test:node --prefix packages/private-routes
npm run test:bare --prefix packages/private-routes
npm run fuzz:cell --prefix packages/private-routes -- --seed 1 --iterations 10000
npm run test:portable:node --prefix packages/private-routes
npm run test:portable:bare --prefix packages/private-routes
npm pack --prefix packages/private-routes --dry-run
git diff --check
```

Expected: all pass, inherited test/assertion totals do not decrease, fuzz unexpected count is zero, package remains private, and no unrelated/root files changed.

- [ ] **Step 3: Run the authoritative GitHub namespace gate**

Push the feature branch, wait for all private-route jobs, and inspect the full logs. Do not call Milestone 2 complete until the real namespace job passes; a skipped/missing-capability job is failure.

- [ ] **Step 4: Request independent code/security review**

Review exact wire layouts, grant authority, request correlation, replay/liveness ordering, ownership/zeroization, queue bounds, process isolation, and no-fallback behavior. Resolve all findings and rerun affected/full matrices.

- [ ] **Step 5: Request an independent capture-oracle false-positive review**

The reviewer must try empty/missing-edge, DNS/TCP/ICMP/IPv6, alternate UDP port, direct/decoy/external edge, post-close packet, malformed PCAP, disabled negative control, and leaked configuration cases. Milestone 3 remains blocked until approved.

- [ ] **Step 6: Record final evidence**

Report commit, exact dependency/runtime versions, Node/Bare test/assertion totals, fuzz result, portable process counts, namespace packet/edge totals, CI run URL/status, reviewers, TODOs, and the explicit statement that HyperDHT/Hyperswarm/PearTube integration is still Milestone 3.

---

## Execution Order and Review Checkpoints

1. Complete and review Chunk 1 before remote actor work.
2. Complete and review Chunk 2 before multi-process work.
3. Complete portable Node before Bare; both must use the same oracle.
4. Complete and independently challenge the capture oracle before trusting the namespace result.
5. Land CI/docs only after the corresponding commands exist and pass.
6. Do not begin Milestone 3 until every Task 18 gate is green and independently reviewed.
