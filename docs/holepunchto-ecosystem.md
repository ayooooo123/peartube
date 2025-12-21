# Holepunchto Ecosystem Reference

A comprehensive guide to the holepunchto GitHub organization's packages and tools that could be useful for PearTube.

---

## Core Infrastructure (Already Using)

### hyperswarm
**Stars:** 1,183 | **Status:** Active | [GitHub](https://github.com/holepunchto/hyperswarm)

Distributed networking stack for connecting peers. **Handles all connectivity** including:
- DHT-based peer discovery
- Distributed holepunching (NAT traversal)
- Automatic relay through connected peers when both have symmetric NAT
- `suspend()` / `resume()` for mobile lifecycle

```javascript
const swarm = new Hyperswarm()
swarm.join(topic, { server: true, client: true })
swarm.on('connection', (conn, info) => { ... })
await swarm.suspend() // Mobile background
await swarm.resume()  // Mobile foreground
```

### hyperdht
**Stars:** 368 | **Status:** Active | [GitHub](https://github.com/holepunchto/hyperdht)

The DHT powering Hyperswarm. Key features:
- Remote IP / firewall detection
- NAT analysis and holepunching
- `relayThrough` for routing via connected peers
- Secure routing IDs

```javascript
const dht = new DHT({ bootstrap: [...] })
await dht.suspend() // Mobile sleep
await dht.resume()  // Wake up
```

### hypercore
**Stars:** 2,734 | **Status:** Active | [GitHub](https://github.com/holepunchto/hypercore)

Secure, distributed append-only log. Foundation of the entire ecosystem.

### hyperdrive
**Stars:** 1,954 | **Status:** Active | [GitHub](https://github.com/holepunchto/hyperdrive)

Secure, real-time distributed file system built on Hypercore.

### hyperbee
**Stars:** 284 | **Status:** Active | [GitHub](https://github.com/holepunchto/hyperbee)

Append-only B-tree running on Hypercore. Used for metadata storage.

### autobase
**Stars:** 135 | **Status:** Active | [GitHub](https://github.com/holepunchto/autobase)

Multi-writer data structures with Hypercore. Used for channel sync in PearTube.

### protomux
**Stars:** 40 | **Status:** Active | [GitHub](https://github.com/holepunchto/protomux)

Multiplex multiple message-oriented protocols over a stream.

```javascript
const mux = Protomux.from(stream)
const channel = mux.createChannel({ protocol: 'my-protocol', ... })
```

### hypercore-blob-server
**Stars:** 6 | **Status:** Active | [GitHub](https://github.com/holepunchto/hypercore-blob-server)

HTTP server for streaming hypercore blobs with Range support.

```javascript
const server = new BlobServer(swarm, { ... })
server.address() // { port, host }
await server.suspend()
await server.resume()
```

---

## Recommended for PearTube

### hyperswarm-stats
**Stars:** 0 | **Status:** Active | [GitHub](https://github.com/holepunchto/hyperswarm-stats)

Stats for Hyperswarm with Prometheus support. **Perfect for debugging.**

```javascript
const HyperswarmStats = require('hyperswarm-stats')
const stats = new HyperswarmStats(swarm)

stats.toJson()     // Full stats object
stats.toString()   // Human-readable summary
```

### hypercore-byte-stream
**Stars:** 3 | **Status:** Active | [GitHub](https://github.com/holepunchto/hypercore-byte-stream)

Readable stream for Hypercore with byte-range support. **Useful for video streaming.**

```javascript
const ByteStream = require('hypercore-byte-stream')

// Stream with byte range and prefetch
const stream = new ByteStream(core, blobId, {
  start: 0,
  length: 1000000,
  maxPrefetch: 5  // Prefetch up to 5 blocks ahead
})
```

### throwaway-local-cache
**Stars:** 2 | **Status:** Active | [GitHub](https://github.com/holepunchto/throwaway-local-cache)

Fast local cache when persistence isn't 100% required. **Good for metadata caching.**

```javascript
const Cache = require('throwaway-local-cache')
const cache = new Cache('./cache/metadata')

await cache.get(key)
cache.queuePut(key, value)  // Async batched writes
await cache.flush()
```

### activity-queue
**Stars:** 2 | **Status:** Active | [GitHub](https://github.com/holepunchto/activity-queue)

Track when activity drains. **Useful for knowing when prefetch completes.**

```javascript
const ActivityQueue = require('activity-queue')
const queue = new ActivityQueue()

const clock = queue.active()  // Mark as active
await queue.drained()         // Wait for drain
queue.inactive(clock)         // Mark done
```

### protomux-wakeup
**Stars:** 1 | **Status:** Installed in PearTube | [GitHub](https://github.com/holepunchto/protomux-wakeup)

Wakeup protocol over protomux. **For background sync and content announcements.**

```javascript
const Wakeup = require('protomux-wakeup')
const w = new Wakeup()

swarm.on('connection', (stream) => w.addStream(stream))

const session = w.session(core.key, {
  onpeeradd(peer) { /* new peer */ },
  onannounce(wakeup, peer) {
    // Peer has new content: wakeup = [{ key, length }]
  }
})

session.announce(peer, [{ key: core.key, length: core.length }])
session.inactive()  // App backgrounded
session.active()    // App foregrounded
```

### blind-peering
**Stars:** N/A | **Status:** Installed in PearTube | [GitHub](https://github.com/holepunchto/blind-peering)

Keep your hypercores available when you're offline. **For content availability.**

Note: This is for **content availability** (peers replicate your data), NOT for connection reliability.

---

## Networking & RPC

### protomux-rpc
**Stars:** N/A | **Status:** Active | [GitHub](https://github.com/holepunchto/protomux-rpc)

Simple RPC over Protomux channels.

```javascript
const ProtomuxRPC = require('protomux-rpc')

// Server
const rpc = new ProtomuxRPC(stream)
rpc.respond('echo', (req) => req)

// Client
const response = await rpc.request('echo', Buffer.from('hello'))
```

### protomux-rpc-client-pool
**Stars:** 2 | **Status:** Active | [GitHub](https://github.com/holepunchto/protomux-rpc-client-pool)

Reliably connect to one of a pool of protomux-rpc servers with auto-failover.

```javascript
const pool = new ProtomuxRpcClientPool(
  [serverKey1, serverKey2, serverKey3],  // Known server keys
  rpcClient,
  { retries: 3, timeout: 3000 }
)

await pool.makeRequest('methodName', args)
```

**Note:** Requires known server keys upfront. Better for client-server patterns than pure P2P.

### dht-rpc
**Stars:** 208 | **Status:** Active | [GitHub](https://github.com/holepunchto/dht-rpc)

Make RPC calls over a Kademlia-based DHT. Low-level DHT operations.

### hyperbeam
**Stars:** 527 | **Status:** Active | [GitHub](https://github.com/holepunchto/hyperbeam)

1-1 end-to-end encrypted internet pipe powered by Hyperswarm.

```javascript
const Hyperbeam = require('hyperbeam')
const beam = new Hyperbeam('passphrase')
process.stdin.pipe(beam).pipe(process.stdout)
```

---

## Database & Storage

### hyperdb
**Stars:** 61 | **Status:** Active | [GitHub](https://github.com/holepunchto/hyperdb)

P2P-first database with schema definitions. Newer alternative to Hyperbee with:
- Schema-based collections
- Custom indexes with mapping functions
- Works with both RocksDB (local) and Hyperbee (P2P)

```javascript
// Local mode
const db = HyperDB.rocks('./my-rocks.db', definition)

// P2P mode
const db = HyperDB.bee(hypercore, definition)

await db.insert('@example/members', { name: 'Alice', age: 30 })
const result = await db.get('@example/members', { name: 'Alice' })
```

### corestore
**Stars:** 84 | **Status:** Active | [GitHub](https://github.com/holepunchto/corestore)

Simple corestore that wraps a random-access-storage module.

### hyperblobs
**Stars:** 41 | **Status:** Active | [GitHub](https://github.com/holepunchto/hyperblobs)

Blob store for Hypercore.

---

## Discovery & Pairing

### blind-pairing
**Stars:** N/A | **Status:** Active | [GitHub](https://github.com/holepunchto/blind-pairing)

Blind pairing over HyperDHT. Create invites for device pairing.

```javascript
const BlindPairing = require('blind-pairing')
const { invite, publicKey, discoveryKey } = BlindPairing.createInvite(autobaseKey)

// Member receives candidates
const m = pairing.addMember({
  discoveryKey,
  async onadd(candidate) {
    candidate.open(publicKey)
    candidate.confirm({ key: autobaseKey })
  }
})

// Candidate uses invite
const c = pairing.addCandidate({ invite, userData })
await c.pairing
```

### autobase-discovery
**Stars:** 4 | **Status:** Active | [GitHub](https://github.com/holepunchto/autobase-discovery)

Automatic service discovery with self-registering services using autobase.

### hyperswarm-seeders
**Stars:** 18 | **Status:** Active | [GitHub](https://github.com/holepunchto/hyperswarm-seeders)

A seeders-only swarm, verified by a mutable record.

```javascript
const Seeders = require('@hyperswarm/seeders')
const swarm = new Seeders(firstSeedPublicKey, {
  maxClientConnections: 2
})

if (swarm.owner) {
  await swarm.join({ seeds: [publicKey1, publicKey2] })
}
```

---

## Identity & Security

### keypear
**Stars:** 24 | **Status:** Active | [GitHub](https://github.com/holepunchto/keypear)

Keychain that derives deterministic Ed25519 keypairs and attestations.

```javascript
const Keychain = require('keypear')
const keys = new Keychain()

const cur = keys.get()       // Current keypair
const foo = keys.get('foo')  // Tweaked keypair for 'foo'
const sub = keys.sub('bar')  // Sub keychain

// Sign and DH
const sig = cur.sign(message)
const shared = cur.dh(otherPublicKey)

// Persist to disk
const keys = await Keychain.open('./my-keychain')
```

### autopass
**Stars:** 24 | **Status:** Active | [GitHub](https://github.com/holepunchto/autopass)

Distributed notes/password manager using Autobase. Good reference for multi-writer patterns.

```javascript
const Autopass = require('autopass')
const pass = new Autopass(new Corestore('./pass'))

// Create invite for pairing
const inv = await pass.createInvite()

// Add/get entries
await pass.add('note-key', 'note content')
const note = await pass.get('note-key')

// Mobile lifecycle
await pass.suspend()
await pass.resume()
```

---

## File System & Drives

### localdrive
**Stars:** 31 | **Status:** Active | [GitHub](https://github.com/holepunchto/localdrive)

File system API similar to Hyperdrive. Useful for local-first patterns.

### mirror-drive
**Stars:** 26 | **Status:** Active | [GitHub](https://github.com/holepunchto/mirror-drive)

Mirror a Hyperdrive or Localdrive into another.

```javascript
const MirrorDrive = require('mirror-drive')
const mirror = new MirrorDrive(src, dst, {
  prune: true,
  filter: (key) => !key.startsWith('.git')
})

for await (const diff of mirror) {
  console.log(diff.op, diff.key)  // 'add', 'remove', 'change'
}
```

### localwatch
**Stars:** 10 | **Status:** Active | [GitHub](https://github.com/holepunchto/localwatch)

Watch a directory and get a diff of changes.

```javascript
const Localwatch = require('localwatch')
const watch = new Localwatch('./my/dir', {
  hidden: false,
  settle: true  // Wait for 100ms idle before batch
})

for await (const diff of watch) {
  // [{ type: 'update'|'delete', filename }, ...]
}
```

### drives (CLI)
**Stars:** 28 | **Status:** Active | [GitHub](https://github.com/holepunchto/drives)

CLI to seed, mirror, and serve Hyperdrives.

```bash
drives seed <key>
drives mirror <src> <dst> --live
drives serve <key>  # HTTP server
```

---

## Utilities

### ready-resource
**Stars:** 18 | **Status:** Active | [GitHub](https://github.com/holepunchto/ready-resource)

Modern single resource management pattern.

```javascript
class Thing extends ReadyResource {
  async _open() { /* init */ }
  async _close() { /* cleanup */ }
}

const r = new Thing()
await r.ready()  // Calls _open once
await r.close()  // Calls _close after _open
```

### compact-encoding
**Stars:** 25 | **Status:** Active | [GitHub](https://github.com/holepunchto/compact-encoding)

Compact encoding schemes for building small and fast parsers/serializers.

### b4a
**Stars:** 45 | **Status:** Active | [GitHub](https://github.com/holepunchto/b4a)

Bridging the gap between buffers and typed arrays.

### simple-seeder
**Stars:** 23 | **Status:** Active | [GitHub](https://github.com/holepunchto/simple-seeder)

Dead simple Hypercore seeder. CLI and programmatic.

```bash
simple-seeder -c <key> -c <another-key>
simple-seeder --file ./seeds.txt
```

---

## Mobile & Runtime

### bare
**Stars:** 938 | **Status:** Active | [GitHub](https://github.com/holepunchto/bare)

Small and modular JavaScript runtime for desktop and mobile.

### bare-kit
**Stars:** 33 | **Status:** Active | [GitHub](https://github.com/holepunchto/bare-kit)

Bare for native application development.

### react-native-bare-kit
**Stars:** 37 | **Status:** Active | [GitHub](https://github.com/holepunchto/react-native-bare-kit)

Bare-kit for React Native. **Used in PearTube.**

### expo-file-stream
**Stars:** 0 | **Status:** Active | [GitHub](https://github.com/holepunchto/expo-file-stream)

Stream file to Readable with no temp files. **Useful for mobile uploads.**

### bare-media
**Stars:** 11 | **Status:** Active | [GitHub](https://github.com/holepunchto/bare-media)

Media APIs for Bare (preview generation, image processing).

### bare-ffmpeg
**Stars:** 12 | **Status:** Active | [GitHub](https://github.com/holepunchto/bare-ffmpeg)

Low-level FFmpeg bindings for Bare (full video processing).

---

## Not Recommended for PearTube

### hyperswarm-dht-relay
DHT over WebSocket - for web platform support. **Not needed** since PearTube always uses native DHT.

### blind-relay
TURN-like relay requiring infrastructure. **Contradicts pure P2P model.**

---

## Summary: What to Add to PearTube

| Package | Purpose | Priority |
|---------|---------|----------|
| `hyperswarm-stats` | Network debugging | High |
| `hypercore-byte-stream` | Video streaming with prefetch | High |
| `throwaway-local-cache` | Metadata caching | Medium |
| `activity-queue` | Track prefetch completion | Medium |
| `protomux-wakeup` | Background sync (already installed) | Enable |
| `blind-peering` | Content availability (already installed) | Enable |

---

*Last updated: December 2025*
*Total holepunchto repos: 515*
