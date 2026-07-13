# Threat Model

## Security claims

For an authenticated compiled route with independently operated, non-colluding relays:

- The destination does not learn the source IP; it sees only its final private relay.
- The source does not learn the destination IP; it receives only authenticated descriptor and route material without destination dial information.
- A forwarding relay learns only its adjacent circuit hops and cannot read or modify authenticated application plaintext.
- Existing end-to-end Hyperswarm Noise encryption remains inside the routed transport.
- Replayed, duplicated, reordered outside the allowed datagram window, truncated, or mutated cells are rejected.
- Private-only node information cannot authorize direct probes, public routing-table promotion, or direct dialing.
- Relay or route failure fails closed: failure never enables direct dialing or hole punching.

These claims require descriptor authorization, deterministic role validation, fresh circuit keys, hop authentication, bounded replay state, correct key erasure, and enforcement of the allowed flow matrix below.

## Explicit observer visibility

- The guard sees the source IP, its next relay, timing, packet counts, and approximate volume.
- The final private relay sees the destination IP, its previous relay, timing, packet counts, and approximate volume.
- Intermediate relays see their previous and next circuit hops, timing, packet counts, and approximate volume.
- A DHT gateway sees DHT keys/topics, operation type, timing, and size. It does not receive endpoint application plaintext through this role.
- Public relay nodes expose their own dial information and may independently participate in ordinary HyperDHT.

No claim applies across identities operated in concert. Separate identities controlled by one operator count as collusion/Sybil behavior, including identities placed in both deterministic role domains.

## Allowed network flows by role and phase

| Role                 | Bootstrap phase                                     | Established private operation                                                               | Forbidden endpoint flow                                               |
| -------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Source endpoint      | Signed bootstrap candidates until a guard is pinned | Current guard only                                                                          | Destination, private relays, public DHT peers                         |
| Destination endpoint | Signed bootstrap candidates until a guard is pinned | Its source-side guard for outbound control and its final private relay for inbound circuits | Sources, private entries, public DHT peers                            |
| Safety/guard relay   | Public relay discovery and DHT participation        | Previous and next circuit hops plus public control-plane peers                              | Using learned private-only endpoint data for direct probes            |
| Private relay        | Public relay discovery and DHT participation        | Previous and next circuit hops plus public control-plane peers                              | Using learned source/destination data outside installed circuit state |
| DHT gateway          | Public HyperDHT peers                               | Final safety hop plus public HyperDHT peers                                                 | Direct source contact or returning its address to the public DHT      |

Circuit packet tests distinguish installed circuit edges from a relay's independently permitted public control-plane traffic. Every endpoint packet MUST follow its endpoint row, and every circuit data packet MUST follow an installed adjacent edge. Private endpoints MUST NOT create an ordinary public DHT socket.

## Out of scope

- Global timing correlation and a global passive observer are out of scope.
- Ordinary HTTP/HTTPS, DNS, external media, telemetry, casting, mDNS, and LAN discovery are out of scope.
- Tor-level anonymity is out of scope; the protocol is not Tor and does not hide a source from its guard.
- Endpoint compromise, malicious application code, endpoint logging, post-quantum security, relay incentives, payments, and abuse adjudication are out of scope.
- Sybil resistance beyond identity diversity rules, guard stability, local reputation, and signed identity is out of scope.

## Fail-closed boundary

Private mode treats route provenance as a restriction, never as public-dial authorization. Invalid or expired descriptors, unavailable relays or gateways, authentication failures, replay violations, queue exhaustion, setup timeout, transport loss, route expiry, and counter exhaustion result in route replacement or structured offline state. Failure never enables direct dialing or hole punching. No descriptor field, private-only address, or route material may be returned to ordinary HyperDHT or Hyperswarm as a direct destination.
