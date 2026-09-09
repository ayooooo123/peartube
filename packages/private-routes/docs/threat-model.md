# Threat Model

## Milestone 2 evidence boundary

Milestone 2 tests a controlled, static seven-process UDX route:

```text
source -> safety guard -> safety final -> private entry -> private middle -> private final -> destination
```

It does **not** yet carry DHT-RPC, HyperDHT, Hyperswarm, Hypercore, PearTube, HTTP, DNS, or media
traffic. It does not prove public discovery, NAT traversal, mobile behavior, relay diversity, or
production anonymity. The wire format and cryptographic construction are experimental and
unaudited.

For the tested graph, independently operated non-colluding relays, authenticated setup, and honest
endpoints, the implementation establishes:

- The destination process is not configured with the source address; it directly contacts only
  its private final relay.
- The source process is not configured with the destination address; it directly contacts only its
  safety guard.
- A forwarding process receives address and grant material only for adjacent circuit peers.
- Modified cells, disallowed replays, invalid counters, expired/revoked grants, and malformed
  control messages cannot mutate route state or deliver application plaintext.
- Route or relay failure closes or replaces the route and never enables direct endpoint dialing,
  hole punching, or an ordinary endpoint public-DHT socket.

These claims are executable properties of this fixture, not claims against traffic analysis or a
global observer.

## Exact knowledge and contact policy

The test coordinator knows the complete synthetic topology because it constructs, launches, and
audits the fixture. No route process receives that view. Before launch, an independent
configuration auditor checks the semantic object and serialized bytes for exact fields, allowed
identities and advertisements, adjacent grants, and absence of hidden paths or addresses. It also
checks every emitted event and diagnostic for disallowed configuration, keys, payload, and path
data.

| Process        | May know identities/advertisements for                         | May receive grants and send directly to |
| -------------- | -------------------------------------------------------------- | --------------------------------------- |
| source         | source, both safety relays, and the descriptor's private entry | safety guard only                       |
| safety guard   | source, safety guard, safety final                             | source and safety final                 |
| safety final   | safety guard, safety final, private entry                      | safety guard and private entry          |
| private entry  | safety final, private entry, private middle                    | safety final and private middle         |
| private middle | private entry, private middle, private final                   | private entry and private final         |
| private final  | private middle, private final, destination                     | private middle and destination          |
| destination    | destination and all three selected private relays              | private final only                      |

Knowledge does not grant network authority. Only an exact, verified, bilateral signed grant can
create a UDX link handle or authorize a send. A route advertisement or descriptor field is never a
direct-dial capability.

## Observer visibility

- The safety guard sees the source IP, its safety-final peer, timing, packet counts, and volume.
- The private final sees the destination IP, its private-middle peer, timing, packet counts, and
  volume.
- Each intermediate relay sees its previous and next circuit peers, timing, packet counts, and
  volume.
- Link peers see fixed 1,200-byte UDP payloads, but IP/UDP headers, direction, timing, loss, and
  total traffic volume remain visible.
- The test coordinator sees the whole synthetic graph. That trusted orchestration exception is not
  part of the proposed production protocol.

No claim applies across identities operated in concert. Separate identities controlled by one
operator count as collusion/Sybil behavior, including identities in both deterministic role
domains.

## Packet-capture gate and limits

The authoritative gate runs on Linux with seven isolated role namespaces and separate decoy and
auditor namespaces. It captures inbound IPv4 and IPv6, attributes packets by Linux cooked-capture
interface index to the exact managed host veth, and requires IPv4 packets on all six adjacent
bilateral route edges. A decoy-to-auditor sentinel is a negative control proving that the capture
could observe a forbidden-capability packet; the private route must record zero use of the source's
separately named test-only decoy capability.

The oracle fails closed on:

- an empty, truncated, malformed, or missing capture;
- a missing required edge or unexpected direct, decoy, external, or non-adjacent edge;
- DNS, TCP, ICMP, IPv6, UDP on an alternate port, or a source tuple inconsistent with the ingress
  interface;
- any role packet after the authenticated route has closed;
- absent or reordered capture sentinels;
- leaked addresses, grants, paths, secrets, or payloads in role configuration or diagnostics;
- disabled or unobserved negative-control evidence.

This is a managed-interface namespace measurement whose accepted route graph is synthetic IPv4.
It does not observe arbitrary host interfaces, the public Internet, DNS/HTTP/media initiated by an
application, mobile OS networking, or a global passive observer. Timing correlation remains
possible even though payload sizes are fixed.

## Fail-closed boundary

Private provenance is a restriction, never public-dial authorization. Invalid or expired
descriptors or grants, unavailable relays, authentication failures, replay violations, queue
exhaustion, setup timeout, transport loss, liveness failure, route expiry, counter exhaustion, and
process death result in authenticated teardown, cleanup, replacement, or structured offline state.
Failure never enables direct dialing, hole punching, an ordinary public endpoint DHT socket, or a
clear-network application retry.

The public compiled-route interface intentionally has no address or fallback method. Process
teardown requires all routes, links, queues, requests, sockets, and owned secret buffers to reach
zero. This boundary must remain intact when later DHT-RPC, HyperDHT, and Hyperswarm adapters are
introduced.

## Out of scope

- A global passive observer, cross-link timing correlation, relay collusion, and robust Sybil
  resistance.
- Ordinary HTTP/HTTPS, DNS, external media, telemetry, casting, mDNS, and LAN discovery.
- Tor-level anonymity; this protocol is not Tor and does not hide a source from its guard.
- Endpoint compromise, malicious application code, endpoint logging, post-quantum security, relay
  incentives, payments, and abuse adjudication.
- Public routing, NAT traversal, mobile lifecycle behavior, and any PearTube privacy guarantee.
