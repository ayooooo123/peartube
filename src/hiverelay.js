// Supplemental HiveRelay seeder bridge for PearTube (compatible with p2p-hiverelay v0.24.x & v0.26.x):
//   1. Operator / loopback HTTP relays (`PEARTUBE_HIVERELAYS=http://host:9100=TOKEN`): resolves relay pubkey,
//      dials directly via Hyperswarm, and pins channel + 512 KiB Hyperblobs cores via `POST /seed-core`.
//   2. Unauthenticated / open / allowlisted relays (`hiverelay-discovery-v1` DHT + public URLs without API key):
//      maintains a tiny wire-exact 2-core Hyperdrive v11/v13 beacon and broadcasts `hiverelay.seed-request.v3`
//      over the `hiverelay-seed` Protomux channel so existing HiveRelays swallow every PearTube core raw.
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createHash } from 'node:crypto'
import Protomux from 'protomux'
import c from 'compact-encoding'
import sodium from 'sodium-native'
import b4a from 'b4a'

const HEX64 = /^[0-9a-f]{64}$/i
const SEED_PROTOCOL_NAME = 'hiverelay-seed'
const SEED_HANDSHAKE = b4a.from('{"major":1,"minor":0}')
const SEED_SIGNATURE_DOMAIN = b4a.from('hiverelay.seed-request.v3\0')
const DISCOVERY_EPOCH_MS = 60 * 60 * 1000
const MIN_BOUND_BYTES = 16 * 1024 * 1024
const BOUND_STEP_BYTES = 8 * 1024 * 1024
const MAX_SEED_CORES = 64
const P2P_PAGE_SIZE = 16
const P2P_PAGE_INTERVAL_MS = 750

function blake2bTopic (text) {
  const out = b4a.alloc(32)
  sodium.crypto_generichash(out, b4a.from(text))
  return out
}

const RELAY_DISCOVERY_TOPIC = blake2bTopic('hiverelay-discovery-v1')

// Protobuf wire helpers for a tiny, zero-dependency classic Hyperbee v2 / Hyperdrive v11+ beacon:
// Block 0 = Header({ protocol: 'hyperbee', metadata: { contentFeed } }), Block N = 1-key YoloIndex root Node.
function pbVarint (n) {
  const out = []
  let v = n
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80)
    v = Math.floor(v / 128)
  }
  out.push(v & 0x7f)
  return b4a.from(out)
}

function pbBytes (field, data) {
  const buf = typeof data === 'string' ? b4a.from(data) : data
  return b4a.concat([pbVarint((field << 3) | 2), pbVarint(buf.byteLength), buf])
}

function encodeHyperdriveHeader (contentFeedKey) {
  return b4a.concat([pbBytes(1, 'hyperbee'), pbBytes(2, pbBytes(1, contentFeedKey))])
}

function encodeHyperdriveSingleRootNode (seq, path, blobId) {
  const index = pbBytes(1, pbBytes(1, pbVarint(seq)))
  const key = b4a.from(`files\0${path.startsWith('/') ? path : '/' + path}`)
  const value = b4a.from(JSON.stringify({ executable: false, linkname: null, blob: blobId, metadata: null }))
  return b4a.concat([pbBytes(1, index), pbBytes(2, key), pbBytes(3, value)])
}

// Compact-encoding frames matching p2p-hiverelay's `core/protocol/messages.js` byte for byte.
const seedRequestEncoding = {
  preencode (state, msg) {
    c.fixed32.preencode(state, msg.appKey)
    c.uint.preencode(state, msg.discoveryKeys.length)
    for (const dk of msg.discoveryKeys) c.fixed32.preencode(state, dk)
    c.uint.preencode(state, msg.replicationFactor)
    c.string.preencode(state, msg.geoPreference)
    c.uint.preencode(state, msg.maxStorageBytes)
    c.uint.preencode(state, msg.bountyRate)
    c.uint.preencode(state, msg.ttlSeconds)
    c.fixed32.preencode(state, msg.publisherPubkey)
    c.fixed64.preencode(state, msg.publisherSignature)
    c.uint.preencode(state, msg.revocable)
    c.uint.preencode(state, msg.unseedFreezeMs)
    c.uint.preencode(state, msg.durability)
  },
  encode (state, msg) {
    c.fixed32.encode(state, msg.appKey)
    c.uint.encode(state, msg.discoveryKeys.length)
    for (const dk of msg.discoveryKeys) c.fixed32.encode(state, dk)
    c.uint.encode(state, msg.replicationFactor)
    c.string.encode(state, msg.geoPreference)
    c.uint.encode(state, msg.maxStorageBytes)
    c.uint.encode(state, msg.bountyRate)
    c.uint.encode(state, msg.ttlSeconds)
    c.fixed32.encode(state, msg.publisherPubkey)
    c.fixed64.encode(state, msg.publisherSignature)
    c.uint.encode(state, msg.revocable)
    c.uint.encode(state, msg.unseedFreezeMs)
    c.uint.encode(state, msg.durability)
  },
  decode (state) {
    const appKey = c.fixed32.decode(state)
    const count = Math.min(MAX_SEED_CORES, c.uint.decode(state))
    const discoveryKeys = []
    for (let i = 0; i < count; i++) discoveryKeys.push(c.fixed32.decode(state))
    const replicationFactor = c.uint.decode(state)
    const geoPreference = c.string.decode(state)
    const maxStorageBytes = c.uint.decode(state)
    const bountyRate = c.uint.decode(state)
    const ttlSeconds = c.uint.decode(state)
    const publisherPubkey = c.fixed32.decode(state)
    const publisherSignature = c.fixed64.decode(state)
    const revocable = state.start < state.end ? c.uint.decode(state) : 1
    const unseedFreezeMs = state.start < state.end ? c.uint.decode(state) : 0
    const durability = state.start < state.end ? c.uint.decode(state) : 0
    return { appKey, discoveryKeys, replicationFactor, geoPreference, maxStorageBytes, bountyRate, ttlSeconds, publisherPubkey, publisherSignature, revocable, unseedFreezeMs, durability }
  }
}

const seedAcceptEncoding = {
  preencode (state, msg) {
    c.fixed32.preencode(state, msg.appKey)
    c.fixed32.preencode(state, msg.relayPubkey)
    c.string.preencode(state, msg.region)
    c.uint.preencode(state, msg.availableStorageBytes)
    c.fixed64.preencode(state, msg.relaySignature)
  },
  encode (state, msg) {
    c.fixed32.encode(state, msg.appKey)
    c.fixed32.encode(state, msg.relayPubkey)
    c.string.encode(state, msg.region)
    c.uint.encode(state, msg.availableStorageBytes)
    c.fixed64.encode(state, msg.relaySignature)
  },
  decode (state) {
    return {
      appKey: c.fixed32.decode(state),
      relayPubkey: c.fixed32.decode(state),
      region: c.string.decode(state),
      availableStorageBytes: c.uint.decode(state),
      relaySignature: c.fixed64.decode(state)
    }
  }
}

const unseedRequestEncoding = {
  preencode (state, msg) {
    c.fixed32.preencode(state, msg.appKey)
    c.uint.preencode(state, msg.timestamp)
    c.fixed32.preencode(state, msg.publisherPubkey)
    c.fixed64.preencode(state, msg.publisherSignature)
  },
  encode (state, msg) {
    c.fixed32.encode(state, msg.appKey)
    c.uint.encode(state, msg.timestamp)
    c.fixed32.encode(state, msg.publisherPubkey)
    c.fixed64.encode(state, msg.publisherSignature)
  },
  decode (state) {
    return {
      appKey: c.fixed32.decode(state),
      timestamp: c.uint.decode(state),
      publisherPubkey: c.fixed32.decode(state),
      publisherSignature: c.fixed64.decode(state)
    }
  }
}

const seedDenyEncoding = {
  preencode (state, msg) {
    c.fixed32.preencode(state, msg.appKey)
    c.fixed32.preencode(state, msg.relayPubkey)
    c.string.preencode(state, msg.reasonCode)
    c.string.preencode(state, msg.detail)
    c.fixed64.preencode(state, msg.relaySignature)
  },
  encode (state, msg) {
    c.fixed32.encode(state, msg.appKey)
    c.fixed32.encode(state, msg.relayPubkey)
    c.string.encode(state, msg.reasonCode)
    c.string.encode(state, msg.detail)
    c.fixed64.encode(state, msg.relaySignature)
  },
  decode (state) {
    return {
      appKey: c.fixed32.decode(state),
      relayPubkey: c.fixed32.decode(state),
      reasonCode: c.string.decode(state),
      detail: c.string.decode(state),
      relaySignature: c.fixed64.decode(state)
    }
  }
}

function signSeedRequest (msg, keyPair) {
  const dkHash = b4a.alloc(32)
  if (msg.discoveryKeys.length > 0) {
    sodium.crypto_generichash(dkHash, b4a.concat(msg.discoveryKeys))
  }
  const meta = b4a.alloc(40)
  const view = new DataView(meta.buffer, meta.byteOffset, 40)
  view.setUint8(0, msg.replicationFactor)
  view.setUint8(1, msg.revocable ? 1 : 0)
  view.setUint8(2, msg.durability || 0)
  view.setBigUint64(8, BigInt(msg.maxStorageBytes), false)
  view.setBigUint64(16, BigInt(msg.ttlSeconds), false)
  view.setUint32(24, msg.bountyRate || 0, false)
  view.setBigUint64(28, BigInt(msg.unseedFreezeMs || 0), false)
  const preimage = b4a.concat([SEED_SIGNATURE_DOMAIN, msg.appKey, dkHash, meta])
  const sig = b4a.alloc(64)
  sodium.crypto_sign_detached(sig, preimage, keyPair.secretKey)
  return sig
}

function isZeroBuf (buf) {
  if (!buf) return true
  for (let i = 0; i < buf.byteLength; i++) if (buf[i] !== 0) return false
  return true
}

function computeBoundBytes (byteLength) {
  const actual = Math.max(0, Number(byteLength) || 0)
  const headroom = Math.min(128 * 1024 * 1024, Math.max(8 * 1024 * 1024, Math.ceil(actual * 0.1)))
  const padded = Math.max(MIN_BOUND_BYTES, actual + headroom)
  return Math.ceil(padded / BOUND_STEP_BYTES) * BOUND_STEP_BYTES
}

// Parses `http://host:9100=APIKEY,https://relay.example.com,dht` into clean HTTP targets + DHT flag.
function parseHiverelayConfig (rawRelays = [], defaultApiKey = null, defaultDiscover = false) {
  const items = Array.isArray(rawRelays)
    ? rawRelays
    : (typeof rawRelays === 'string' ? rawRelays.split(',') : [])
  const targets = []
  const seen = new Set()
  let discover = Boolean(defaultDiscover)
  for (const item of items) {
    if (!item) continue
    if (typeof item === 'object' && item.url) {
      const url = String(item.url).trim().replace(/\/+$/, '')
      if (/^https?:\/\//i.test(url) && !seen.has(url)) {
        seen.add(url)
        targets.push({ url, apiKey: item.apiKey || defaultApiKey || null })
      }
      continue
    }
    const text = String(item).trim()
    if (!text) continue
    if (text === 'dht' || text === 'auto' || text === '1' || text === 'true') {
      discover = true
      continue
    }
    const eq = text.indexOf('=')
    const url = (eq > 0 ? text.slice(0, eq) : text).trim().replace(/\/+$/, '')
    const apiKey = eq > 0 ? text.slice(eq + 1).trim() : (defaultApiKey || null)
    if (/^https?:\/\//i.test(url) && !seen.has(url)) {
      seen.add(url)
      targets.push({ url, apiKey: apiKey || null })
    }
  }
  return { targets, discover }
}

function requestJson (url, { method = 'GET', headers = {}, body = null, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    let parsed
    try { parsed = new URL(url) } catch (err) { reject(err); return }
    const fn = parsed.protocol === 'https:' ? httpsRequest : httpRequest
    const payload = body == null ? null : b4a.from(JSON.stringify(body))
    const reqHeaders = { accept: 'application/json', ...headers }
    if (payload) {
      reqHeaders['content-type'] = 'application/json'
      reqHeaders['content-length'] = String(payload.byteLength)
    }
    let settled = false
    const done = (err, val) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve(val)
    }
    const timer = setTimeout(() => {
      req.destroy()
      done(new Error(`HiveRelay HTTP timeout (${method} ${url})`))
    }, timeoutMs)
    timer.unref?.()
    const req = fn(parsed, { method, headers: reqHeaders }, res => {
      const chunks = []
      let total = 0
      res.on('data', chunk => {
        const buf = typeof chunk === 'string' ? b4a.from(chunk) : chunk
        total += buf.byteLength
        if (total > 1024 * 1024) { req.destroy(); done(new Error('HiveRelay response exceeded 1 MiB')); return }
        chunks.push(buf)
      })
      res.on('end', () => {
        let json = null
        try { json = chunks.length ? JSON.parse(b4a.toString(b4a.concat(chunks))) : {} } catch {}
        done(null, { status: res.statusCode || 0, data: json })
      })
    })
    req.on('error', err => done(err))
    if (payload) req.write(payload)
    req.end()
  })
}

export function createHiverelaySeeder ({
  node,
  relays = [],
  apiKey = null,
  discover = false,
  replicas = 3,
  ttlDays = 30,
  includeCached = false,
  // The relay's traffic gate (src/traffic.js): HiveRelay connections are bulk, paced while people watch.
  traffic,
  onchange = null
}) {
  const parsed = parseHiverelayConfig(relays, apiKey, discover)
  const targets = [...parsed.targets]
  let dhtDiscover = parsed.discover
  const enabled = () => !node.privateRouting && (targets.length > 0 || dhtDiscover)

  // Dedicated domain-separated Ed25519 publisher keypair so Blindspark allowlists never touch raw channel keys.
  const seedMaterial = createHash('sha256')
    .update('peartube/hiverelay-publisher/v1')
    .update(node.channel.local.keyPair.secretKey)
    .digest()
  const publisherPubkey = b4a.alloc(32)
  const publisherSecret = b4a.alloc(64)
  sodium.crypto_sign_seed_keypair(publisherPubkey, publisherSecret, seedMaterial)
  const publisherKeyPair = { publicKey: publisherPubkey, secretKey: publisherSecret }
  const publisherPubkeyHex = b4a.toString(publisherPubkey, 'hex')

  let closed = false
  let activeRun = null
  let syncRerun = false
  let detachConnections = null
  let discoveryHandle = null
  const epochHandles = new Map()
  let epochTimer = null
  const joinedPeers = new Set()
  const seedChannels = new Map() // remotePubkeyHex -> { channel, sendMsg }
  const acceptedP2P = new Map() // relayPubkeyHex -> { region, availableStorageBytes, acceptedAt, cores: Set<coreKey> }
  const deniedP2P = new Map() // `${relayPubkeyHex}|${coreKey}` -> { pubkey, core, reasonCode, detail, at }
  const httpPinned = new Map() // `${url}|${coreKey}` -> { boundBytes, length, at }
  const urlPubkeys = new Map() // url -> relayPubkeyHex
  let currentSeedRequests = []
  let p2pCursor = 0
  let lastP2PPageAt = 0
  let beaconBlobs = null
  const beaconDbs = new Map() // coreKeyHex -> { key, discKey, byteLength, lastLen }
  const beaconAppToCore = new Map() // beaconAppKeyHex -> coreKeyHex
  function syncEpochTopics () {
    if (closed || !dhtDiscover || node.privateRouting) return
    const bucket = Math.floor(Date.now() / DISCOVERY_EPOCH_MS)
    const wanted = new Map()
    for (const b of [bucket, bucket + 1]) {
      const t = blake2bTopic('hiverelay-discovery-v1-epoch-' + b)
      wanted.set(b4a.toString(t, 'hex'), t)
    }
    for (const [hex, h] of epochHandles) {
      if (!wanted.has(hex)) {
        epochHandles.delete(hex)
        h?.destroy?.().catch?.(() => {})
      }
    }
    for (const [hex, t] of wanted) {
      if (!epochHandles.has(hex)) epochHandles.set(hex, node.swarm.join(t, { server: false, client: true }))
    }
  }

  function attachConnection (conn) {
    if (closed || node.privateRouting || conn.destroyed) return
    const remoteBuf = conn.remotePublicKey
    if (!remoteBuf || remoteBuf.byteLength !== 32) return
    const remoteHex = b4a.toString(remoteBuf, 'hex')
    if (acceptedP2P.has(remoteHex) || [...urlPubkeys.values()].includes(remoteHex)) traffic.markBulk(conn)
    let mux
    try { mux = Protomux.from(conn) } catch { return }
    mux.pair({ protocol: SEED_PROTOCOL_NAME }, () => openSeed(conn, mux, remoteBuf, remoteHex))
    openSeed(conn, mux, remoteBuf, remoteHex)
  }

  function openSeed (conn, mux, remoteBuf, remoteHex) {
    if (closed || conn.destroyed || mux.opened({ protocol: SEED_PROTOCOL_NAME })) return
    let sendMsg = null
    const channel = mux.createChannel({
      protocol: SEED_PROTOCOL_NAME,
      id: null,
      handshake: c.raw,
      onopen () {
        if (closed) { channel.close(); return }
        const peerRec = { channel, sendMsg, lastSentAt: 0 }
        seedChannels.set(remoteHex, peerRec)
        traffic.markBulk(conn)
        if (currentSeedRequests.length && sendMsg) {
          peerRec.lastSentAt = Date.now()
          for (const req of currentSeedRequests.slice(0, P2P_PAGE_SIZE)) {
            try { sendMsg.send(req) } catch {}
          }
        }
        onchange?.()
      },
      onclose () {
        const cur = seedChannels.get(remoteHex)
        if (cur?.channel === channel) seedChannels.delete(remoteHex)
      }
    })
    if (!channel) return
    sendMsg = channel.addMessage({ encoding: seedRequestEncoding, onmessage () { traffic.unmarkBulk(conn) } })
    channel.addMessage({
      encoding: seedAcceptEncoding,
      onmessage (msg) {
        if (!msg?.relayPubkey || !b4a.equals(msg.relayPubkey, remoteBuf)) return
        const payload = b4a.concat([msg.appKey, msg.relayPubkey, b4a.from(msg.region || '')])
        if (!isZeroBuf(msg.relaySignature) && !sodium.crypto_sign_verify_detached(msg.relaySignature, payload, msg.relayPubkey)) return
        const appHex = b4a.toString(msg.appKey, 'hex')
        const coreKey = beaconAppToCore.get(appHex) || appHex
        deniedP2P.delete(`${remoteHex}|${coreKey}`)
        const prev = acceptedP2P.get(remoteHex)
        const cores = prev?.cores || new Set()
        cores.add(coreKey)
        acceptedP2P.set(remoteHex, {
          region: msg.region || 'unknown',
          availableStorageBytes: msg.availableStorageBytes || 0,
          acceptedAt: Date.now(),
          cores
        })
        traffic.markBulk(conn)
        onchange?.()
      }
    })
    channel.addMessage({ encoding: unseedRequestEncoding })
    channel.addMessage({
      encoding: seedDenyEncoding,
      onmessage (msg) {
        if (!msg?.relayPubkey || !b4a.equals(msg.relayPubkey, remoteBuf)) return
        const payload = b4a.concat([msg.appKey, msg.relayPubkey, b4a.from(msg.reasonCode || '')])
        if (!isZeroBuf(msg.relaySignature) && !sodium.crypto_sign_verify_detached(msg.relaySignature, payload, msg.relayPubkey)) return
        const appHex = b4a.toString(msg.appKey, 'hex')
        const coreKey = beaconAppToCore.get(appHex) || appHex
        deniedP2P.set(`${remoteHex}|${coreKey}`, {
          pubkey: remoteHex,
          core: coreKey,
          reasonCode: msg.reasonCode || 'denied',
          detail: msg.detail || '',
          at: Date.now()
        })
        onchange?.()
      }
    })
    try { channel.open(SEED_HANDSHAKE) } catch {}
  }

  function ensureSwarmWiring () {
    if (closed || node.privateRouting) return
    if (!detachConnections) {
      detachConnections = node.onConnection(attachConnection)
      for (const conn of node.peerConnections()) attachConnection(conn)
    }
    if (dhtDiscover && !discoveryHandle) {
      discoveryHandle = node.swarm.join(RELAY_DISCOVERY_TOPIC, { server: false, client: true })
      syncEpochTopics()
      epochTimer = setInterval(syncEpochTopics, 30 * 60_000)
      epochTimer.unref?.()
    }
  }

  async function ensureCoreBeacon (core) {
    if (!beaconBlobs) {
      beaconBlobs = node.store.get({ name: 'hiverelay-beacon-blobs' })
      await beaconBlobs.ready()
      node.swarm.join(beaconBlobs.discoveryKey, { server: true, client: true })
    }
    let entry = beaconDbs.get(core.key)
    if (entry && entry.lastLen === core.length) return entry
    const db = node.store.get({ name: `hiverelay-beacon-${core.key.slice(0, 16)}` })
    await db.ready()
    try {
      if (db.length === 0) {
        await db.append(encodeHyperdriveHeader(beaconBlobs.key))
      }
      if (!entry) {
        node.swarm.join(db.discoveryKey, { server: true, client: true })
        entry = { key: b4a.from(db.key), discKey: b4a.from(db.discoveryKey), byteLength: db.byteLength, lastLen: -1 }
        beaconDbs.set(core.key, entry)
        beaconAppToCore.set(b4a.toString(entry.key, 'hex'), core.key)
      }
      const manifestBytes = b4a.from(JSON.stringify({
        name: `PearTube ${core.kind === 'channel' ? 'Channel' : 'Blob'} Core`,
        version: '1.0.0',
        description: 'PearTube supplemental Hypercore pin',
        entry: '/manifest.json',
        categories: ['media'],
        privacyTier: 'public',
        channel: node.status().channel,
        core: core.key,
        kind: core.kind
      }))
      const blockOffset = beaconBlobs.length
      const byteOffset = beaconBlobs.byteLength
      await beaconBlobs.append(manifestBytes)
      const blobId = { blockOffset, blockLength: 1, byteOffset, byteLength: manifestBytes.byteLength }
      await db.append(encodeHyperdriveSingleRootNode(db.length, '/manifest.json', blobId))
      entry.byteLength = db.byteLength
      entry.lastLen = core.length
      return entry
    } finally {
      await db.close().catch(() => {})
    }
  }

  async function ensureRelayConnected (url) {
    let pubkey = urlPubkeys.get(url) || null
    if (!pubkey) {
      for (const suffix of ['/.well-known/hiverelay.json', '/api/capabilities', '/status']) {
        const res = await requestJson(`${url}${suffix}`, { timeoutMs: 5000 }).catch(() => null)
        const candidate = res?.data?.pubkey || res?.data?.relayPubkey || res?.data?.publicKey
        if (typeof candidate === 'string' && HEX64.test(candidate)) {
          pubkey = candidate.toLowerCase()
          urlPubkeys.set(url, pubkey)
          break
        }
      }
    }
    if (!pubkey) return null
    const pkBuf = b4a.from(pubkey, 'hex')
    if (!joinedPeers.has(pubkey)) {
      joinedPeers.add(pubkey)
      node.swarm.joinPeer(pkBuf)
    }
    const hasPeer = () => [...node.peerConnections()].some(
      conn => !conn.destroyed && conn.remotePublicKey && b4a.toString(conn.remotePublicKey, 'hex') === pubkey
    )
    const started = Date.now()
    let nextRejoin = started + 10_000
    while (!closed && !hasPeer() && Date.now() - started < 45_000) {
      if (Date.now() >= nextRejoin) {
        try { node.swarm.leavePeer(pkBuf); node.swarm.joinPeer(pkBuf) } catch {}
        nextRejoin = Date.now() + 10_000
      }
      await new Promise(resolve => setTimeout(resolve, 150))
    }
    for (const conn of node.peerConnections()) {
      if (conn.remotePublicKey && b4a.toString(conn.remotePublicKey, 'hex') === pubkey) traffic.markBulk(conn)
    }
    return pubkey
  }

  async function syncOnce ({ force = false, relays: extraRelays = null, discover: extraDiscover = null } = {}) {
    if (closed || node.privateRouting) {
      return { skipped: true, reason: node.privateRouting ? 'private_routing_enabled' : 'closed' }
    }
    if (extraRelays) {
      const added = parseHiverelayConfig(extraRelays, apiKey, false)
      for (const t of added.targets) {
        if (!targets.some(existing => existing.url === t.url)) targets.push(t)
      }
      if (added.discover) dhtDiscover = true
    }
    if (extraDiscover === true) dhtDiscover = true
    if (!enabled()) return { skipped: true, reason: 'no_hiverelays_configured' }

    ensureSwarmWiring()
    const cores = node.seedableCores({ includeCached })
    if (cores.length === 0) {
      return { cores: 0, httpPinned: 0, p2pBroadcasts: 0, p2pAccepted: acceptedP2P.size }
    }

    let httpPinnedCount = 0
    let needP2PFallback = dhtDiscover
    const httpErrors = []

    for (const target of targets) {
      if (closed) break
      await ensureRelayConnected(target.url)
      let unauthorized = false
      for (const core of cores) {
        const pinKey = `${target.url}|${core.key}`
        const prev = httpPinned.get(pinKey)
        const boundBytes = computeBoundBytes(core.byteLength)
        if (!force && prev && prev.boundBytes >= Math.ceil(core.byteLength * 1.1)) {
          httpPinnedCount++
          continue
        }
        const headers = target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {}
        const res = await requestJson(`${target.url}/seed-core`, {
          method: 'POST',
          headers,
          body: { coreKey: core.key, maxStorageBytes: boundBytes },
          timeoutMs: 15_000
        }).catch(err => ({ status: 0, error: err.message }))
        if (res.status === 200 && res.data?.ok) {
          httpPinned.set(pinKey, { boundBytes, length: core.length, at: Date.now() })
          httpPinnedCount++
        } else if (res.status === 401 || res.status === 403) {
          unauthorized = true
          break
        } else {
          httpErrors.push({ url: target.url, core: core.key, error: res.data?.error || res.error || `HTTP ${res.status}` })
        }
      }
      if (unauthorized) needP2PFallback = true
    }

    let p2pBroadcasts = 0
    if (needP2PFallback && !closed) {
      const sinceLast = Date.now() - lastP2PPageAt
      if (lastP2PPageAt > 0 && sinceLast < P2P_PAGE_INTERVAL_MS) {
        await new Promise(resolve => setTimeout(resolve, P2P_PAGE_INTERVAL_MS - sinceLast))
        if (closed) return { skipped: true, reason: 'closed' }
      }
      const targetReplicas = Math.max(1, Math.min(32, Number(replicas) || 3))
      const countAccepted = keyHex => {
        let n = 0
        for (const r of acceptedP2P.values()) if (r.cores.has(keyHex)) n++
        return n
      }
      const ordered = [...cores].sort((a, b) => {
        if ((a.kind === 'channel') !== (b.kind === 'channel')) return a.kind === 'channel' ? -1 : 1
        return (a.byteLength || 0) - (b.byteLength || 0)
      })
      const channelList = ordered.filter(c => c.kind === 'channel')
      const blobPool = ordered.filter(c => c.kind !== 'channel')
      const unseeded = blobPool.filter(c => countAccepted(c.key) < targetReplicas)
      const activePool = unseeded.length > 0 ? unseeded : blobPool
      const head = channelList.filter(c => force || countAccepted(c.key) < targetReplicas)
      const budget = Math.max(1, P2P_PAGE_SIZE - head.length)
      const page = [...head]
      if (activePool.length > 0) {
        const start = p2pCursor % activePool.length
        const take = Math.min(budget, activePool.length)
        for (let i = 0; i < take; i++) page.push(activePool[(start + i) % activePool.length])
        p2pCursor = (start + take) % activePool.length
      }
      const reqs = []
      for (const core of page) {
        const drive = await ensureCoreBeacon(core)
        const req = {
          appKey: drive.key,
          discoveryKeys: [b4a.from(core.key, 'hex')],
          replicationFactor: targetReplicas,
          geoPreference: '[]',
          maxStorageBytes: computeBoundBytes((core.byteLength || 0) + drive.byteLength + beaconBlobs.byteLength),
          bountyRate: 0,
          ttlSeconds: Math.max(1, Number(ttlDays) || 30) * 86_400,
          publisherPubkey: publisherKeyPair.publicKey,
          publisherSignature: b4a.alloc(64),
          revocable: 1,
          unseedFreezeMs: 0,
          durability: 0
        }
        req.publisherSignature = signSeedRequest(req, publisherKeyPair)
        reqs.push(req)
      }
      currentSeedRequests = reqs

      if (seedChannels.size === 0 && dhtDiscover) {
        const waitEnd = Date.now() + 3000
        while (!closed && seedChannels.size === 0 && Date.now() < waitEnd) {
          await new Promise(resolve => setTimeout(resolve, 150))
        }
      }
      lastP2PPageAt = Date.now()
      for (const peer of seedChannels.values()) {
        if (peer.channel.opened && peer.sendMsg) {
          const peerDelta = Date.now() - (peer.lastSentAt || 0)
          if (peer.lastSentAt > 0 && peerDelta < P2P_PAGE_INTERVAL_MS) {
            await new Promise(resolve => setTimeout(resolve, P2P_PAGE_INTERVAL_MS - peerDelta))
          }
          peer.lastSentAt = Date.now()
          for (const req of reqs) {
            try {
              peer.sendMsg.send(req)
              p2pBroadcasts++
            } catch {}
          }
        }
      }
    }

    return {
      cores: cores.length,
      coreKeys: cores.map(item => item.key),
      httpRelays: targets.length,
      httpPinned: httpPinnedCount,
      httpErrors,
      p2pPeers: seedChannels.size,
      p2pBroadcasts,
      p2pAccepted: acceptedP2P.size,
      p2pDenied: deniedP2P.size
    }
  }

  function run (payload = {}) {
    if (activeRun) {
      syncRerun = true
      return activeRun
    }
    activeRun = (async () => {
      try {
        let res
        do {
          syncRerun = false
          res = await syncOnce(payload)
        } while (syncRerun && !closed && !payload?.once)
        return res
      } finally {
        activeRun = null
      }
    })()
    return activeRun
  }

  function info () {
    return {
      enabled: enabled(),
      discover: dhtDiscover,
      publisherPubkey: publisherPubkeyHex,
      beaconDriveKey: beaconDbs.size ? b4a.toString(beaconDbs.values().next().value.key, 'hex') : null,
      httpPinnedCores: httpPinned.size,
      // Public status: scheme, host and path only, never credentials or a query string.
      configuredRelays: targets.map(t => ({ url: (u => u.protocol + '//' + u.host + u.pathname.replace(/\/+$/, ''))(new URL(t.url)), hasApiKey: Boolean(t.apiKey), pubkey: urlPubkeys.get(t.url) || null })),
      ...traffic.info(),
      p2pAcceptedRelays: [...acceptedP2P.entries()].map(([pubkey, { cores: _c, ...v }]) => ({ pubkey, ...v })),
      p2pDeniedRelays: [...new Map([...deniedP2P.values()].map(({ core: _c, ...v }) => [v.pubkey, v])).values()]
    }
  }

  async function stop () {
    closed = true
    clearInterval(epochTimer)
    epochTimer = null
    detachConnections?.()
    detachConnections = null
    for (const pubkey of joinedPeers) {
      try { node.swarm.leavePeer(b4a.from(pubkey, 'hex')) } catch {}
    }
    joinedPeers.clear()
    // Shutdown path: start the public leave/destroy calls but don't wait on DHT unannounces;
    // the node's swarm.destroy({ force: true }) right after ends them.
    for (const [, h] of epochHandles) h?.destroy?.().catch?.(() => {})
    epochHandles.clear()
    if (discoveryHandle) {
      discoveryHandle.destroy?.().catch?.(() => {})
      discoveryHandle = null
    }
    for (const peer of seedChannels.values()) {
      try { peer.channel.close() } catch {}
    }
    seedChannels.clear()
    for (const { discKey } of beaconDbs.values()) node.swarm.leave(discKey).catch(() => {})
    beaconDbs.clear()
    beaconAppToCore.clear()
    if (beaconBlobs) {
      node.swarm.leave(beaconBlobs.discoveryKey).catch(() => {})
      await beaconBlobs.close().catch(() => {})
      beaconBlobs = null
    }
  }

  // Wire every relay, not only recruiting ones: HiveRelays pull replicated channels from any seeder, and the
  // busy signal must reach replicas even when the bulk cap is off.
  ensureSwarmWiring()

  return {
    name: 'hiverelay-seed',
    description: 'Recruits existing HiveRelays (HTTP /seed-core + P2P hiverelay-seed DHT) as supplemental seeders for public channels & 512 KiB blobs',
    enabled,
    run,
    poll: () => (enabled() && !activeRun ? run({ once: true }) : null),
    stop,
    info
  }
}
