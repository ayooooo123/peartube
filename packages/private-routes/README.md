# hyperdht-private-routes

An experimental, runtime-agnostic private-route protocol core for the Holepunch stack.

This package currently runs only against deterministic virtual transports. It provides protocol primitives and a compiled-route actor model, but it does not put UDX, DHT-RPC, HyperDHT, Hyperswarm, Hypercore, or PearTube traffic on a private route. It is **not production anonymity** and must not be presented as doing so.

## Status

Protocol version 0 is **EXPERIMENTAL**. It has no compatibility promise, has not received an external protocol or cryptographic audit, and remains `private: true`. Its constants, cryptographic construction, observer claims, and wire format may change.

The tested compiled topology is:

```text
source -> safety guard -> safety final -> private entry -> private middle -> private final -> destination
```

The source chooses the Safety Route and the destination chooses the Private Route. Relay roles are deterministically separated by identity. The public compiled-route facade exposes only `sendDatagram()`, `sendStreamFrame()`, `drain()`, and `destroy()`; it exposes no direct-dial or fallback capability.

## What the virtual tests establish

The deterministic actor fixture exchanges stream and datagram payloads in both directions using fixed-size link cells and opaque, fixed-size route frames. Its deep, test-only observers establish this exact model:

- The source's only adjacent virtual peer is its safety guard.
- The destination's only adjacent virtual peer is its private final relay.
- Setup and payload transmissions use only installed adjacent edges; the trace contains no source-to-destination edge.
- A normal virtual-network observer sees only its peer, direction, byte length, virtual time, and an opaque packet ID. It receives neither packet bytes nor a complete path.
- A deep relay test hook observes the same opaque 1,100-byte route frame at each of the five relays for one direction/class. Tests reject application plaintext, fixture secrets, and route-key fields in that hook.
- Authentication, replay, counter, expiry, queue, cancellation, rotation, drain, and teardown cases are exercised with deterministic clocks and faults. Failure removes route-owned virtual state and never asks for a direct fallback.
- Remote-actor tests traverse the Task 5 established-control mux and fragment reassembler and require an opaque authenticated-event capability. They are still same-process tests: the capability is not yet minted by a live UDX cell endpoint. That handoff belongs to Task 7, so these tests do not establish network transport or peer separation.

These are executable protocol invariants in a socket-free model, not measurements from a real network and not evidence against traffic analysis.

## Threat model and limitations

For independently operated, non-colluding relays in the tested model, the destination does not receive the source address, the source does not receive the destination address, and one forwarding relay has only adjacent-hop visibility. Authenticated cells reject modification and disallowed replay, while private-only provenance cannot authorize a direct probe, public routing-table promotion, or direct dial.

The following remain visible or out of scope:

- The guard sees the source address and its next relay.
- The private final relay sees the destination address and its previous relay.
- Adjacent hops see timing, packet counts, and approximate volume.
- Relay collusion, Sybil operators, and a global passive observer are not defeated.
- The model does not anonymize HTTP/HTTPS, DNS, external media, telemetry, casting, mDNS, or LAN discovery.
- It is not Tor and does not hide a source from its guard.
- Endpoint compromise, malicious application code, and endpoint logging are out of scope.

Private routing is fail closed. Invalid or expired descriptors, unavailable routes, authentication or replay failures, transport loss, setup timeout, queue exhaustion, route expiry, and counter exhaustion may replace the route or report it unavailable; they never enable direct dialing, hole punching, or an ordinary public endpoint DHT socket.

See the approved local [private-routing design](../../docs/superpowers/specs/2026-07-12-holepunch-private-routing-design.md), the package [protocol specification](docs/protocol.md), and the detailed [threat model](docs/threat-model.md).

## Local development

Run the package independently from the repository root:

```bash
npm ci --prefix packages/private-routes
npm run format:check --prefix packages/private-routes
npm run test:node --prefix packages/private-routes
npm exec --prefix packages/private-routes -- bare --version
npm run test:bare --prefix packages/private-routes
npm run fuzz:cell --prefix packages/private-routes -- --seed 1 --iterations 10000
```

To format changes, run:

```bash
npm run format --prefix packages/private-routes
```

The standalone fuzz command uses a reproducible seed. Its memory high-water mark measures the
explicitly owned header, body, and associated-data scratch buffers inside `CellCodec`; returned
packets and payloads are caller-owned and are outside that metric. Keep the reported seed and
iteration count when filing a failure.

## Next milestone

The next milestone is real integration at the UDX/DHT-RPC/HyperDHT/Hyperswarm/Hypercore boundary, followed by real socket and packet-capture tests. None of that integration is implemented or claimed here. PearTube's private-mode switch must remain disabled until routed discovery, connection setup, replication, failure behavior, and mobile/desktop packet-capture gates pass without a direct-network downgrade.
