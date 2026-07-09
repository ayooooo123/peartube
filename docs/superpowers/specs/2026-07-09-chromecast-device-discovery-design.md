# Chromecast Device Discovery Repair Design

## Problem

PearTube's shared Chromecast discoverer does not reliably find devices. The
failure was observed on Android, but the implementation is shared by mobile
and desktop clients, so the repair must live in the universal backend.

The current discoverer sends DNS-SD queries for `_googlecast._tcp.local.` from
an ephemeral UDP port. Although it joins the IPv4 mDNS multicast group when
the runtime supports membership, normal mDNS responses and unsolicited
announcements are delivered to UDP port 5353. The discoverer therefore depends
on responders honoring its unicast-response request and misses ordinary
multicast traffic.

The response handler also assumes the PTR, SRV, TXT, and A records needed to
describe a Chromecast arrive in one packet. DNS-SD responses may split those
records across packets or deliver them in a different order. When multiple A
records are present, the handler selects the first one instead of the address
whose hostname matches the SRV target.

## Goals

- Reliably discover IPv4 Chromecast devices on the same local network.
- Fix discovery once in `@peartube/backend` for every client runner.
- Preserve the existing cast RPC methods, events, picker UI, and manual-device
  fallback.
- Keep Android's application-owned multicast lock and permission diagnostics.
- Cover the failure with deterministic automated tests that do not require a
  physical Chromecast.

## Non-Goals

- Replacing the sender protocol or playback implementation.
- Adding Google Cast SDK dependencies.
- Creating separate Android, iOS, and desktop discovery implementations.
- Discovering devices across routed networks or VLANs without an mDNS gateway.
- Adding IPv6-only Chromecast discovery in this repair.
- Implementing a complete general-purpose mDNS responder or cache.

## Approaches Considered

### 1. Repair the shared DNS-SD discoverer (selected)

Bind the discovery socket to `0.0.0.0:5353` with address reuse, join
`224.0.0.251`, and accumulate the small set of DNS record types required for
Chromecast resolution. This keeps platform behavior aligned and changes no
public contract.

### 2. Keep ephemeral-port unicast discovery

The existing socket could send more unicast-response queries and issue
follow-up queries for missing records. This remains dependent on responder
behavior and still cannot observe normal multicast announcements, so it does
not provide reliable DNS-SD browsing.

### 3. Use platform-native discovery APIs

Android could use `NsdManager` or the Google Cast SDK, with equivalent native
implementations on Apple and desktop platforms. This would duplicate discovery
and bridge behavior across runners, add dependencies, and violate the
universal-backend architecture for a problem the current runtime can solve.

## Design

### Socket lifecycle

`DeviceDiscoverer._startMdns()` continues to load `bare-dgram` lazily. It
creates an IPv4 socket with address reuse, binds to `0.0.0.0:5353`, and then
joins `224.0.0.251` through the underlying UDX socket's multicast membership
API. Joining happens only after the socket is listening.

If socket creation, binding, or group membership fails, discovery startup
logs the concrete failure, closes partial resources, and leaves manual devices
available. Stopping discovery clears the query timer, drops membership when it
was acquired, closes the socket, and resets socket state. Start and stop remain
idempotent.

The discoverer sends a standard multicast PTR query for
`_googlecast._tcp.local.` immediately and every five seconds. A duplicate
unicast-response query is unnecessary once the listener receives multicast
responses on port 5353.

### DNS record accumulation

The DNS packet parser remains responsible only for decoding valid response
records. The discoverer owns a small in-memory record cache keyed by normalized
DNS names:

- Chromecast PTR records map the service name to instance names.
- SRV records map an instance name to its target hostname and port.
- TXT records map an instance name to Chromecast metadata such as `fn` and
  `md`.
- A records map target hostnames to IPv4 addresses.

Names are compared case-insensitively and without a trailing dot. Incoming
records update the cache before device resolution runs, so packet order and
packet boundaries do not matter.

For every cached Chromecast instance, resolution follows the complete chain:

`_googlecast._tcp.local.` PTR -> instance SRV -> SRV target A

The device ID remains `<ipv4-address>:<port>`. The display name prefers TXT
`fn`, then TXT `md`, then the instance label. A new resolved device emits
`deviceFound`. If later records change its name, address, or port, the cache
updates the device map and emits `deviceChanged` using the existing event.

This repair does not add a general TTL scheduler. A TTL-zero goodbye record
removes the affected cached record and triggers `deviceLost` when an existing
device can no longer resolve. Broader TTL expiry behavior is outside scope.

### Public interfaces and integration

No schema or RPC change is required. `CastContext` continues forwarding
`deviceFound`, `deviceChanged`, and `deviceLost`; mobile and desktop handlers
continue returning the current `castGetDevices` shape.

Android keeps its application-lifecycle `WifiManager.MulticastLock`. The lock
allows multicast reception while the app is active; the backend socket remains
responsible for binding and joining the mDNS group. Existing Nearby Wi-Fi
permission reporting is unchanged.

## Error Handling

- Malformed DNS packets and individual malformed records are ignored without
  terminating discovery.
- A record that cannot yet resolve a full device is retained for a later
  packet rather than treated as an error.
- A failed mDNS startup reports its reason and preserves manual-device mode.
- Stop tolerates partially initialized or already-closed sockets.
- Records for unrelated DNS-SD services never create cast devices.

## Testing

Add focused backend tests around exported testable packet/parser helpers and
`DeviceDiscoverer` behavior:

1. The socket is created with address reuse, binds to port 5353, and joins the
   IPv4 mDNS group after listening.
2. PTR, SRV, TXT, and A records split across multiple packets resolve one
   Chromecast regardless of arrival order.
3. When a packet contains multiple A records, the device uses the address that
   matches the SRV target.
4. Duplicate records do not emit duplicate `deviceFound` events.
5. Updated metadata emits `deviceChanged`.
6. A TTL-zero goodbye makes a previously resolved device unavailable and emits
   `deviceLost`.
7. Stop clears timers, leaves the multicast group, and closes the socket.
8. Existing backend tests and app cast-handler regression tests remain green.

Tests use synthetic DNS response packets and injected/fake socket behavior;
they do not depend on local multicast networking or physical hardware.

## Success Criteria

- A Chromecast on the same Wi-Fi appears in the existing picker on Android and
  other clients using the shared backend.
- Discovery continues to work when DNS-SD records arrive separately or out of
  order.
- Multiple advertised hosts are correlated correctly.
- Manual device entry still works when mDNS is unavailable.
- Focused discovery tests and the relevant backend/app test suites pass.
