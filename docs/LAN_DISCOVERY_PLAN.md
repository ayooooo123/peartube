# LAN Peer Discovery Enhancement

## Status: FUTURE IMPLEMENTATION
This plan documents a novel approach for LAN peer discovery. Implementation deferred until needed or until holepunch ships native local discovery.

---

## Problem
Android devices cannot establish peer connections on the same LAN but can connect when on different networks (e.g., mobile hotspot). This is counterintuitive - LAN should be easier.

## Root Cause
**HyperDHT/Hyperswarm has no local discovery mechanism.**
- GitHub Issue #194 confirms: "Hyperswarm does NOT support local network discovery without internet connection"
- The DHT requires public bootstrap nodes for peer discovery
- Once discovered via DHT, HyperDHT's `connect.js` (lines 167-180) DOES support direct LAN connections
- **The problem is discovery, not connection**

## Research Findings

### What holepunch provides:
1. **blind-relay** - Token-based peer pairing through a relay server (no DHT needed)
2. **blind-pairing** - Higher-level pairing protocol
3. **hyperswarm-testnet** - Pattern for local DHT bootstrap networks
4. **libudx/udx-native** - Low-level UDP primitives

### What's missing:
- No mDNS/Bonjour
- No UDP broadcast/multicast discovery
- Old `@hyperswarm/discovery` had mDNS but was removed in v4

---

## Recommended Solution: DHT Over Broadcast

### Philosophy
**Don't invent new protocols - extend what exists.**

Key insight: **Discovery doesn't need to be secure. Connection does.**

- The DHT is already "public" - anyone can query it
- LAN discovery is just a local "town square"
- Security comes from Noise protocol handshake AFTER discovery
- Hiding information is moot (code is open source)

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Security Model                          │
├─────────────────────────────────────────────────────────────┤
│  Discovery Layer    │  PUBLIC    │  Broadcast DHT PING     │
│  Connection Layer   │  SECURE    │  Noise protocol         │
│  Topic Layer        │  PRIVATE   │  Revealed after Noise   │
└─────────────────────────────────────────────────────────────┘

Normal DHT:     App ──► Internet ──► Bootstrap Nodes ──► DHT Network

LAN DHT:        App ──► Broadcast ──► Any Local DHT Node ──► Done
                         (same protocol, different transport)
```

### How It Works

1. **Bind DHT to a static port** (shared by all instances)
2. **Send DHT PING to broadcast address** on that port
3. **Other DHT nodes respond normally** (they already handle PING)
4. **Add responders to routing table**
5. **DHT works from there** - topic discovery, connections, everything

### The Static Port Reframe

Instead of "static port = security risk", think:
**"Static port = well-known rendezvous point"**

Like how:
- HTTP is port 80
- HTTPS is port 443
- DNS is port 53
- **HyperDHT LAN could be port 49737**

Security comes from what happens AFTER you knock on the door (Noise handshake), not from hiding the door.

### Implementation

```javascript
const LAN_DHT_PORT = 49737 // Static, shared by all instances

// Option 1: Bind DHT to static port
const dht = new HyperDHT({ port: LAN_DHT_PORT })

// Option 2: Separate LAN discovery socket
const lanSocket = dgram.createSocket('udp4')
lanSocket.bind(LAN_DHT_PORT)

// Broadcast DHT PING
function discoverLAN() {
  const ping = dht.createPingMessage() // Use existing DHT message format
  lanSocket.send(ping, LAN_DHT_PORT, '255.255.255.255')
}

// Handle responses - they're normal DHT PONGs
lanSocket.on('message', (msg, rinfo) => {
  if (isDHTPong(msg)) {
    // Add to DHT routing table
    dht.addNode({ host: rinfo.address, port: rinfo.port })
    // Now standard DHT discovery works locally
  }
})
```

### What Would Need to Change in HyperDHT

Minimal changes to propose to holepunch team:

1. **Option to bind to specific port**: `new DHT({ port: 49737 })`
2. **Method to broadcast PING**: `dht.discoverLAN()`
3. **Handle broadcast responses**: Add to routing table automatically

This extends HyperDHT rather than bolting on a separate system.

### Security Properties

| Concern | Mitigation |
|---------|------------|
| Port scanning | Static port is just a rendezvous point, like port 80 |
| Spoofing | Noise handshake verifies identity |
| Topic leakage | Topics only revealed after encrypted channel established |
| DoS on discovery port | Rate limiting, only handle PING messages |

### Files to Create (When Implementing)

| File | Description |
|------|-------------|
| `packages/backend/src/lan-discovery.js` | LAN bootstrap via DHT broadcast (~80 lines) |
| `packages/backend/src/storage.js` | Initialize LAN discovery after swarm creation |

### Test Plan
1. Start app on two devices on same LAN
2. Disconnect router from internet (keep LAN working)
3. Verify DHT PING broadcast is sent
4. Verify other device responds with PONG
5. Verify both devices add each other to DHT routing table
6. Verify topic-based discovery works locally
7. Re-enable internet, confirm both paths coexist

---

## Alternative Considered: Custom UDP Protocol

A simpler but less elegant approach using custom announcements:

```javascript
// Broadcast announcement (not DHT protocol)
{
  "publicKey": "abc...",
  "port": 49737
}
```

**Rejected because:**
- Invents new protocol instead of extending existing
- Duplicates what DHT already does
- Harder to upstream to holepunch

---

## References
- GitHub Issue: holepunchto/hyperswarm#194 (LAN discovery request)
- HyperDHT connect.js lines 167-180 (existing LAN connection support)
- holepunchto/hyperswarm-testnet (local DHT bootstrap pattern)
