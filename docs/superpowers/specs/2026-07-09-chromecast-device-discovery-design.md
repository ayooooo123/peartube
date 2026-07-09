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

The discoverer has explicit `idle`, `starting`, `running`, and `stopping`
states. A monotonically increasing lifecycle generation identifies each start
attempt. Listening, error, and timer callbacks act only when their captured
generation is still current. This prevents a late listening callback from
installing a timer after `stop()` has invalidated that start attempt.

Calling `start()` while starting returns the in-flight start promise; calling
it while running is a no-op. Calling `stop()` invalidates the generation first,
then clears the query timer, drops membership when it was acquired, closes the
socket, and returns the discoverer to `idle`. Repeated stops are harmless.

If socket creation, binding, or group membership fails, discovery startup
logs the concrete failure, closes partial resources, resets state to `idle`,
and leaves manual devices available. A later `start()` therefore makes a fresh
attempt instead of remaining stuck in a nominally running state.

The discoverer sends a standard multicast PTR query for
`_googlecast._tcp.local.` immediately and every five seconds. A duplicate
unicast-response query is unnecessary once the listener receives multicast
responses on port 5353.

### DNS record accumulation

The DNS packet parser remains responsible only for decoding valid response
records. The discoverer owns a small in-memory record cache keyed by normalized
DNS names and record data:

- Chromecast PTR records map the service name to a set of instance names.
- SRV records map an instance name to its latest target hostname and port.
  SRV priority and weight are retained by the parser but are not used because
  Chromecast normally advertises one unique SRV record per instance.
- TXT records map an instance name to its latest metadata such as `fn` and
  `md`.
- A records map target hostnames to a set of IPv4 addresses. When a host has
  multiple addresses, resolution chooses the numerically lowest IPv4 address
  so the result is stable regardless of packet order. IPv6 and interface-aware
  address ranking remain outside this repair.

Names are compared case-insensitively and without a trailing dot. Incoming
records update the cache before device resolution runs, so packet order and
packet boundaries do not matter.

For every cached Chromecast instance, resolution follows the complete chain:

`_googlecast._tcp.local.` PTR -> instance SRV -> SRV target A

The device ID remains `<ipv4-address>:<port>`. The display name prefers TXT
`fn`, then TXT `md`, then the instance label. A new resolved device emits
`deviceFound`. A name or metadata change that preserves the endpoint emits
`deviceChanged`. If the selected address or port changes, the discoverer emits
`deviceLost(oldId)` followed by `deviceFound(newDevice)` so `CastContext` does
not retain the stale endpoint-derived ID.

This repair does not add a general TTL scheduler. A TTL-zero goodbye removes
only the matching record data: the named PTR instance, the matching SRV
target/port, the matching TXT value, or the matching A address. Other members
of the same record set remain cached. Resolution then runs again; it emits
`deviceLost` only if an existing discovered device can no longer resolve, or
performs the endpoint-change sequence if another address becomes selected.
Broader TTL expiry behavior is outside scope.

### Manual and discovered device ownership

Manual and discovered devices are stored separately even though both use
endpoint-derived IDs. The public device view merges the two maps with a manual
device taking precedence on an ID collision. A discovered goodbye removes only
the discovered entry and never removes a manual fallback. Adding a manual
device over an existing discovered ID emits `deviceChanged` with the manual
representation; removing it emits `deviceChanged` with the still-resolved
discovered representation, or `deviceLost` if no discovered entry remains.

### Public interfaces and integration

No schema or RPC change is required. `CastContext` continues forwarding
`deviceFound`, `deviceChanged`, and `deviceLost`; mobile and desktop handlers
continue returning the current `castGetDevices` shape.

Android keeps its application-lifecycle `WifiManager.MulticastLock`. The lock
allows multicast reception while the app is active; the backend socket remains
responsible for binding and joining the mDNS group. Existing Nearby Wi-Fi
permission reporting is unchanged.

### Test seams

`DeviceDiscoverer` accepts an optional dependency object while retaining a
zero-argument production constructor. The dependencies are a `loadDgram`
function (defaulting to the lazy `import('bare-dgram')`) and timer functions
(defaulting to global `setInterval` and `clearInterval`). Tests inject a fake
socket module and deterministic timers. Packet decoding and record application
are exposed as narrow named exports for direct synthetic-packet tests; they do
not become package-level public API exports.

## Error Handling

- Malformed DNS packets and individual malformed records are ignored without
  terminating discovery.
- A record that cannot yet resolve a full device is retained for a later
  packet rather than treated as an error.
- A failed mDNS startup reports its reason and preserves manual-device mode.
- Stop tolerates partially initialized or already-closed sockets.
- Stop during an in-flight start invalidates all late callbacks and leaves the
  discoverer idle; a subsequent start retries normally.
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
5. Updated metadata emits `deviceChanged`; endpoint changes emit
   `deviceLost(oldId)` followed by `deviceFound(newDevice)`.
6. TTL-zero goodbyes remove only the matching record-set member and resolve to
   another cached address when one remains.
7. A discovered goodbye cannot remove a colliding manual device.
8. Stop clears timers, leaves the multicast group, and closes the socket,
   including when stop occurs while start is pending; a later start retries.
9. Malformed compression pointers, truncated records, and unrelated services
   do not create devices or terminate discovery.
10. Existing backend tests and app cast-handler regression tests remain green.

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
