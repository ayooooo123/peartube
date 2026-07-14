# hyperdht-private-routes

An experimental, runtime-agnostic private-route protocol core for the Holepunch stack.

Milestone 2 runs a fixed seven-role route over real UDX sockets in seven independent Node or Bare
processes. Its authoritative Linux gate places every role in a separate network namespace and
checks the captured packets against the exact allowed adjacency graph.

This is a controlled static relay graph. It is **not** routed DHT-RPC or HyperDHT, Hyperswarm,
Hypercore replication, PearTube traffic routing, mobile privacy, NAT traversal, public relay
discovery, or production anonymity. It has no direct-network fallback, but applications must not
describe or expose it as private mode until those later integration and packet-capture gates pass.

## Status

Protocol version 0 is **EXPERIMENTAL**. It has no compatibility promise, has not received an
external protocol or cryptographic audit, and remains `private: true`. Its constants,
cryptographic construction, observer claims, and wire format may change.

The tested topology is exactly:

```text
source -> safety guard -> safety final -> private entry -> private middle -> private final -> destination
```

The source chooses the Safety Route and the destination chooses the Private Route. Relay roles are
deterministically separated by identity. The public compiled-route facade exposes only
`sendDatagram()`, `sendStreamFrame()`, `drain()`, and `destroy()`; it exposes no address, direct
dial, hole-punch, public DHT socket, or fallback capability.

## What Milestone 2 establishes

- Every private-routing UDP payload is exactly 1,200 bytes. Bootstrap envelopes use reserved class
  `0x80`; established CONTROL, STREAM, and DATAGRAM cells use classes `0..2`. They cannot be
  decoded as one another.
- One signed, expiring bilateral topology grant authorizes each adjacent pair. A verified grant
  digest is required before a role can bootstrap a link or send to that peer.
- Authenticated remote-actor requests perform distributed registration, activation, and teardown
  over UDX. Requests have bounded correlation, cancellation, replay/tombstone, and cleanup state.
- STREAM backpressure is hop-by-hop. An upstream acknowledgement is sent only after the complete
  plaintext fragment enters the bounded next-hop queue. DATAGRAM delivery remains atomic and best
  effort.
- Established links use authenticated ping/pong liveness. A silent peer closes the link and its
  route state instead of falling back to a direct connection.
- The portable integration suite launches seven separate Node processes or seven separate Bare
  processes. Each receives an audited role-scoped configuration, and teardown requires zero
  remaining processes, sockets, circuits, queues, and owned secret state.
- The authoritative Linux namespace gate captures the synthetic test subnet and requires exactly
  the six adjacent bilateral edges. A separately isolated decoy-to-auditor packet proves the
  capture can observe a forbidden-capability packet; the private route never uses the source's
  test-only decoy capability.

The virtual suites additionally exercise authentication, replay, counter, expiry, queue,
cancellation, rotation, drain, and teardown faults with deterministic clocks. Deep test-only hooks
can inspect opaque route frames and owned state; those hooks are not application APIs.

These results prove properties of the implemented static test graph, not resistance to traffic
analysis or behavior on the public Internet.

## Threat model and limitations

For independently operated, non-colluding relays in the tested graph, the destination process is
not configured with the source address, the source process is not configured with the destination
address, and each forwarding process receives direct grants only for adjacent peers. The guard
still sees the source address, the private final still sees the destination address, and every
adjacent hop sees timing, packet counts, and volume.

The coordinator is a test-orchestration exception: it constructs the full synthetic topology, but
an independent configuration auditor rejects any role projection, event, or diagnostic that
contains disallowed identities, addresses, grants, paths, keys, or payloads. Relay collusion,
Sybil operators, a global observer, endpoint compromise, application logging, and traffic
correlation remain out of scope.

The Linux capture covers the isolated synthetic IPv4 subnet, not arbitrary host traffic or a real
mobile/desktop deployment. The oracle fails on unexpected IPv4 protocols, IPv6, alternate UDP
ports, direct/decoy/external edges, post-close packets, malformed or missing capture data, and
missing negative-control evidence. It does not prove NAT traversal, public discovery, Internet
relay diversity, DNS/HTTP/media privacy, or protection from a global passive observer.

Private routing is fail closed. Invalid or expired descriptors or grants, unavailable routes,
authentication or replay failures, transport loss, setup timeout, queue exhaustion, liveness
failure, route expiry, and counter exhaustion may replace the route or report it unavailable; they
never enable direct dialing, hole punching, or an ordinary public endpoint DHT socket.

See the approved local [Milestone 2 design](../../docs/superpowers/specs/2026-07-13-holepunch-private-routing-m2-udx-design.md), the package [protocol specification](docs/protocol.md), and the detailed [threat model](docs/threat-model.md).

## Local development

Install and run every independent package gate from the repository root:

```bash
npm ci --prefix packages/private-routes
npm run format:check --prefix packages/private-routes
npm run test:node --prefix packages/private-routes
npm exec --prefix packages/private-routes -- bare --version
npm run test:bare --prefix packages/private-routes
npm run test:portable:node --prefix packages/private-routes
npm run test:portable:bare --prefix packages/private-routes
npm run fuzz:cell --prefix packages/private-routes -- --seed 1 --iterations 10000
```

The namespace gate requires Linux, root, `iproute2`, `tcpdump`, and `iptables`:

```bash
sudo npm run test:namespace --prefix packages/private-routes
```

On non-Linux hosts, the namespace command construction, PCAP parser, and capture oracle are unit
tested, but only the privileged GitHub Actions Linux job is authoritative.

To format changes, run:

```bash
npm run format --prefix packages/private-routes
```

The fuzz command uses a reproducible seed. Its memory high-water mark measures explicitly owned
header, body, and associated-data scratch buffers inside `CellCodec`; returned packets and payloads
are caller-owned. Keep the reported seed and iteration count when filing a failure.

## Next milestone

Milestone 3 is a routed DHT-RPC/HyperDHT transport adapter that preserves endpoint key custody and
the fail-closed boundary. Hyperswarm and Hypercore integration follows only after that layer passes
its own live socket, process-isolation, and capture gates. PearTube and mobile/desktop integration
remain later milestones; no private-mode switch should be enabled yet.
