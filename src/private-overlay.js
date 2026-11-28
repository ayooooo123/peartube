// Stateless 2-relay (1 + 1: Peer_A -> Guard_A <-> Guard_B <- Peer_B) UDX-spliced overlay on stock HyperDHT:
//   - Guards open zero Corestore/Hypercore state, touch zero disk files, and splice raw UDX streams (`relayTo`).
//   - Endpoints never expose their E2E Noise identity on the public DHT; every outbound dial, rendezvous
//     lookup, and owner-signed mutable descriptor write exits through an auto-discovered /24-diverse Guard.
//   - Destination guards enforce role separation, advertised-guard membership, and /24 bucket separation on hops.
// Guards and endpoints talk on one `peartube/private-guard/v2` channel per connection (src/control-channel.js, ops in
// spec/protocols.js): an endpoint or a hop opens it and says hello; the guard answers, and asks the endpoint
// (incOpen) and tells it (circuitDead) on the same channel. A peer on another version refuses the channel, so a guard
// on the old version is simply not usable.
import EventEmitter from 'node:events'
import { createHash } from 'node:crypto'
import HyperDHT from 'hyperdht'
import NoiseSecretStream from '@hyperswarm/secret-stream'
import hypercoreCrypto from 'hypercore-crypto'
import c from 'compact-encoding'
import sodium from 'sodium-native'
import b4a from 'b4a'
import { GUARD } from '../spec/protocols.js'
import { openChannel, serveChannel } from './control-channel.js'
import { ipv6Groups } from './protocol.js'

const CARD_DOMAIN = b4a.from('peartube/private-route-card/v1\0')
const GUARD_TOPICS = [0, 1, 2, 3].map(i => HyperDHT.hash(b4a.from(`peartube/private-guard/v2/${i}`)))
const [, , NS_MUTABLE_PUT] = hypercoreCrypto.namespace('hyperswarm/dht', [4, 5, 6, 0, 1, 10])

const ROUTE_TTL_MS = 10 * 60_000
const RV_EPOCH_MS = 3_600_000
const MAX_ROUTES_TOTAL = 4096
const MAX_ROUTES_PER_CONN = 8
const MAX_RV_TOPICS = 1024
const MAX_RV_SLOTS_PER_TOPIC = 64
const MAX_CIRCUITS_TOTAL = 1024
const MAX_CIRCUITS_PER_CONN = 32
const MAX_CARD_BYTES = 512
const MAX_CARDS = 64
const MAX_U32 = 0xffffffff
const MAX_DHT_OPS_PER_10S = 256

// The guard's answers: an ack, and the 0 / 1 / 2 (not diverse) of a dial, hop or incoming circuit.
const ACK_NO = { status: 0 }
const ACK_OK = { status: 1 }
const NOT_READY = { status: 0, udxId: 0 }
const NOT_DIVERSE = { status: 2, udxId: 0 }

const sha256 = (...parts) => {
  const h = createHash('sha256')
  for (const p of parts) h.update(typeof p === 'string' ? b4a.from(p) : p)
  return h.digest()
}
const rand = n => { const b = b4a.allocUnsafe(n); sodium.randombytes_buf(b); return b }
const isU32 = n => Number.isInteger(n) && n >= 0 && n <= MAX_U32
const isCard = b => b4a.isBuffer(b) && b.byteLength >= 1 && b.byteLength <= MAX_CARD_BYTES

// The bytes HyperDHT signs for a mutable put: kept exactly, the guard's channel only carries seq, signature and value.
const mutSignEnc = {
  preencode (s, m) { c.uint.preencode(s, m.seq); c.buffer.preencode(s, m.value) },
  encode (s, m) { c.uint.encode(s, m.seq); c.buffer.encode(s, m.value) }
}

const GUARD_CHANNEL = {
  spec: GUARD,
  label: 'Guard',
  refused: 'Guard refused the private-guard channel',
  duplicate: 'A private-guard channel is already open with this peer',
  timedOut: 'Timed out opening the private-guard channel'
}
// Opens the guard channel on `conn` (an endpoint or a hop asking a guard), with what this side answers on it.
// `onClose` runs when the channel closes after it opened.
const openGuardChannel = (conn, { handlers, events, onClose } = {}, timeoutMs = 4000) => openChannel(conn, { ...GUARD_CHANNEL, handlers, events, onClose }, timeoutMs)
const isClosed = rpc => !rpc || rpc.closed || rpc.conn.destroyed
// A circuit answer: its UDX stream id is checked before its status. Ready is status 1 with a nonzero id; status 2
// (no diverse path) counts only in the answer to a dial.
const ready = rep => isU32(rep.udxId) && rep.status === 1 && rep.udxId > 0
const notDiverse = rep => isU32(rep.udxId) && rep.status === 2

function signDhtMutable (seq, value, secretKey) {
  const signable = b4a.allocUnsafe(64)
  signable.set(NS_MUTABLE_PUT, 0)
  sodium.crypto_generichash(signable.subarray(32), c.encode(mutSignEnc, { seq, value }))
  const sig = b4a.allocUnsafe(64)
  sodium.crypto_sign_detached(sig, signable, secretKey)
  return sig
}

function verifyDhtMutable (sig, seq, value, publicKey) {
  if (!b4a.isBuffer(sig) || sig.byteLength !== 64 || !b4a.isBuffer(publicKey) || publicKey.byteLength !== 32) return false
  const signable = b4a.allocUnsafe(64)
  signable.set(NS_MUTABLE_PUT, 0)
  sodium.crypto_generichash(signable.subarray(32), c.encode(mutSignEnc, { seq, value }))
  return sodium.crypto_sign_verify_detached(sig, signable, publicKey)
}

// A peer's diversity bucket: its IPv4 /24 or IPv6 /48. IPv6 is expanded to eight groups first, so every spelling of
// one address (`2001::1`, `2001:0:0:0:0:0:0:1`) lands in one bucket, and IPv4-mapped IPv6 is its IPv4 address.
export function diversityBucketForAddress (host, port, allowLoopback = false) {
  if (typeof host !== 'string' || !host) return null
  const loopback = label => (allowLoopback && Number.isInteger(port) && port > 0) ? `loopback:${label}:${port}` : null
  const groups = host.includes(':') ? ipv6Groups(host) : null
  const mapped = groups && groups.slice(0, 5).every(g => g === 0) && groups[5] === 0xffff
  const clean = mapped ? `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}` : host
  const v4 = clean.split('.')
  if (v4.length === 4 && v4.every(p => /^\d+$/.test(p) && Number(p) <= 255)) {
    const a = Number(v4[0]), b = Number(v4[1]), d = Number(v4[2])
    if (a === 127) return loopback(clean)
    return a === 0 ? null : `ipv4:${a}.${b}.${d}.0/24`
  }
  if (!groups) return null
  if (groups.slice(0, 7).every(g => g === 0)) return groups[7] === 1 ? loopback('::1') : null
  return `ipv6:${groups.slice(0, 3).map(g => g.toString(16).padStart(4, '0')).join(':')}/48`
}

function sealBox (plain, sealKey) {
  const nonce = rand(sodium.crypto_secretbox_NONCEBYTES)
  const cipher = b4a.allocUnsafe(plain.byteLength + sodium.crypto_secretbox_MACBYTES)
  sodium.crypto_secretbox_easy(cipher, plain, nonce, sealKey)
  return b4a.concat([nonce, cipher])
}

function openBox (sealed, sealKey) {
  const min = sodium.crypto_secretbox_NONCEBYTES + sodium.crypto_secretbox_MACBYTES
  if (!b4a.isBuffer(sealed) || sealed.byteLength <= min || sealed.byteLength > MAX_CARD_BYTES) return null
  const plain = b4a.allocUnsafe(sealed.byteLength - min)
  return sodium.crypto_secretbox_open_easy(plain, sealed.subarray(sodium.crypto_secretbox_NONCEBYTES), sealed.subarray(0, sodium.crypto_secretbox_NONCEBYTES), sealKey) ? plain : null
}

function encodeSignedCard ({ innerKeyPair, guardPublicKey, routeToken, seq, expiresAt }) {
  const body = b4a.allocUnsafe(112)
  innerKeyPair.publicKey.copy(body, 0)
  guardPublicKey.copy(body, 32)
  routeToken.copy(body, 64)
  body.writeBigUInt64BE(BigInt(seq), 96)
  body.writeBigUInt64BE(BigInt(expiresAt), 104)
  const sig = b4a.allocUnsafe(64)
  sodium.crypto_sign_detached(sig, b4a.concat([CARD_DOMAIN, body]), innerKeyPair.secretKey)
  return b4a.concat([body, sig])
}

function decodeAndVerifyCard (buf, now, expectedKey = null) {
  if (!b4a.isBuffer(buf) || buf.byteLength !== 176) return null
  const body = buf.subarray(0, 112), sig = buf.subarray(112)
  const innerPublicKey = b4a.from(body.subarray(0, 32))
  if (expectedKey && !b4a.equals(innerPublicKey, expectedKey)) return null
  const expiresAt = Number(body.readBigUInt64BE(104))
  if (expiresAt <= now || expiresAt > now + 30 * 60_000) return null
  if (!sodium.crypto_sign_verify_detached(sig, b4a.concat([CARD_DOMAIN, body]), innerPublicKey)) return null
  return {
    innerPublicKey,
    guardPublicKey: b4a.from(body.subarray(32, 64)),
    routeToken: b4a.from(body.subarray(64, 96)),
    seq: Number(body.readBigUInt64BE(96)),
    expiresAt
  }
}

function allocRawStream (dht, ctrlConn, framed) {
  const rc = ctrlConn.rawStream
  if (!rc || !rc.connected) throw new Error('Control stream disconnected')
  const { remoteHost, remotePort } = rc
  const firewall = (_s, port, host) => port !== remotePort || host !== remoteHost
  let s = dht.createRawStream({ framed, firewall })
  while (s.id === 0) { s.destroy(); s = dht.createRawStream({ framed, firewall }) }
  s.on('error', () => {})
  return s
}

const isLocalBootstrap = (host, bootstrap) =>
  host === '127.0.0.1' || host === '::1' || (Array.isArray(bootstrap) && bootstrap.some(b => String(b?.host || b).startsWith('127.')))

export async function createPrivateGuard ({
  host,
  port = 0,
  bootstrap,
  seed = null,
  allowLoopback = isLocalBootstrap(host, bootstrap),
  resolveAddress = null,
  announceGuard = true,
  onControlPeer = null
} = {}) {
  const bindHost = host ?? (isLocalBootstrap(host, bootstrap) ? '127.0.0.1' : undefined)
  const keyPair = HyperDHT.keyPair(seed || rand(32))
  // A guard behind a NAT or a firewall with no inbound rule (a cloud task, a home router) must not say it is open:
  // HyperDHT then tells every client to dial it directly and skip the holepunch, and their packets never arrive.
  // Only a loopback testnet has no NAT for certain; everywhere else HyperDHT finds out for itself.
  const open = isLocalBootstrap(host, bootstrap)
  const dht = new HyperDHT({ host: bindHost, bootstrap, port: port || [0, 0], ...(open ? { ephemeral: false, firewalled: false } : {}) })
  await dht.ready()

  const routes = new Map(), rvTopics = new Map(), activeCircuits = new Set(), conns = new Set(), hopPeers = new Map()
  const verifiedGuardCache = new Map()
  let closing = false, putMutableCount = 0, rvRegisterCount = 0, failMutablePutsRemaining = 0

  const bucketOfConn = conn => {
    const raw = conn?.rawStream
    const h = resolveAddress ? resolveAddress(raw?.remoteHost, raw?.remotePort, conn?.remotePublicKey) : raw?.remoteHost
    return diversityBucketForAddress(h, raw?.remotePort, allowLoopback)
  }
  const ownDiversityBucket = () => {
    // A firewalled guard has no remoteAddress(), but HyperDHT still knows the public host it is seen from.
    const ownAddr = dht.remoteAddress() || (dht.host ? { host: dht.host, port: dht.port } : null) || (allowLoopback ? server.address() : null)
    return ownAddr?.host ? diversityBucketForAddress(resolveAddress ? resolveAddress(ownAddr.host, ownAddr.port, keyPair.publicKey) : ownAddr.host, ownAddr.port, allowLoopback) : null
  }

  async function isAdvertisedGuard (pubKey) {
    if (!pubKey || b4a.equals(pubKey, keyPair.publicKey)) return false
    const hex = b4a.toString(pubKey, 'hex')
    if ((verifiedGuardCache.get(hex) || 0) > Date.now()) return true
    await Promise.allSettled(GUARD_TOPICS.map(async t => {
      const q = dht.lookup(t), qt = setTimeout(() => q.destroy(), 3500); qt.unref?.()
      try {
        for await (const rep of q) for (const peer of rep.peers) {
          if (peer?.publicKey) verifiedGuardCache.set(b4a.toString(peer.publicKey, 'hex'), Date.now() + 60_000)
        }
      } catch {} finally { clearTimeout(qt) }
    }))
    return (verifiedGuardCache.get(hex) || 0) > Date.now()
  }

  const announceService = async () => {
    if (announceGuard && !closing) await Promise.allSettled(GUARD_TOPICS.map(t => dht.announce(t, keyPair).finished()))
  }
  const rvQueues = new Map()
  const enqueueRvOp = (tHex, fn) => {
    const next = (rvQueues.get(tHex) || Promise.resolve()).then(fn, fn)
    rvQueues.set(tHex, next)
    next.finally(() => { if (rvQueues.get(tHex) === next) rvQueues.delete(tHex) })
    return next
  }
  const ensureRvAnnounced = (tHex, entry) => enqueueRvOp(tHex, async () => {
    if (closing || rvTopics.get(tHex) !== entry || !entry.slots.size || Date.now() - entry.lastAnnounceAt < 45_000) return
    try { await dht.announce(entry.topicBuf, keyPair).finished(); entry.lastAnnounceAt = Date.now() } catch {}
  })
  // Only the session that registered a slot may remove it (unregister or disconnect).
  const removeRvSlot = (tHex, sHex, session) => {
    const e = rvTopics.get(tHex)
    if (!e || e.slots.get(sHex)?.session !== session) return
    e.slots.delete(sHex)
    if (!e.slots.size) {
      const topicBuf = e.topicBuf
      rvTopics.delete(tHex)
      enqueueRvOp(tHex, async () => {
        if (!closing && !rvTopics.get(tHex)?.slots.size) await dht.unannounce(topicBuf, keyPair).catch(() => {})
      })
    }
  }

  async function getHopPeer (targetGuardKey) {
    const hex = b4a.toString(targetGuardKey, 'hex')
    const cur = hopPeers.get(hex)
    if (cur && !isClosed(cur.rpc)) return cur
    if (cur?.connecting) return cur.connecting
    const entry = { conn: null, rpc: null, connecting: null, drops: new Set() }
    entry.connecting = (async () => {
      const conn = dht.connect(targetGuardKey, { keyPair })
      conn.on('error', () => {}); conn.setKeepAlive(5000)
      const ok = await Promise.race([conn.opened, new Promise(r => { const t = setTimeout(() => r(false), 6000); t.unref?.() })])
      if (!ok || conn.destroyed || closing) { conn.destroy(); throw new Error('Guard unreachable') }
      let rpc
      try {
        // The guard on the other end closed this channel: nothing else runs on this connection.
        rpc = await openGuardChannel(conn, { onClose: () => conn.destroy() })
        if ((await rpc.call('hello', { role: 'hop' }, 4000)).status !== 1) throw new Error('Guard refused the hop')
      } catch (err) { conn.destroy(); throw err }
      conn.once('close', () => {
        if (hopPeers.get(hex) === entry) hopPeers.delete(hex)
        for (const d of [...entry.drops]) d()
      })
      entry.conn = conn; entry.rpc = rpc; entry.connecting = null
      return entry
    })()
    hopPeers.set(hex, entry)
    try { return await entry.connecting } catch (e) { if (hopPeers.get(hex) === entry) hopPeers.delete(hex); throw e }
  }

  const server = dht.createServer({ firewall: () => false }, conn => {
    if (closing) { conn.destroy(); return }
    conn.on('error', () => {}); conn.setKeepAlive(5000)
    conns.add(conn)
    conn.once('close', () => conns.delete(conn))
    // The DHT-operation budget is the connection's: opening the channel again does not reset it.
    const dhtOps = []
    const allowDhtOp = () => {
      const now = Date.now()
      while (dhtOps.length && now - dhtOps[0] > 10_000) dhtOps.shift()
      if (dhtOps.length >= MAX_DHT_OPS_PER_10S) return false
      dhtOps.push(now)
      return true
    }
    // What a guard channel grants is its session's: the role hello set, the routes and rendezvous slots it
    // registered, its circuits. A session starts empty when the channel opens and is released when the channel
    // closes; the connection stays, and a channel opened again on it has no role until a new hello.
    const sessionOf = new WeakMap() // channel -> session
    const openSession = control => { sessionOf.set(control, { conn, rpc: control, role: null, ownedRoutes: new Set(), ownedRvSlots: new Set(), drops: new Set(), circuits: 0 }) }
    const releaseSession = control => {
      const session = sessionOf.get(control)
      for (const d of [...session.drops]) d()
      for (const t of session.ownedRoutes) if (routes.get(t)?.session === session) routes.delete(t)
      for (const pair of session.ownedRvSlots) { const i = pair.indexOf(':'); removeRvSlot(pair.slice(0, i), pair.slice(i + 1), session) }
    }

    // What the guard answers on this connection. Each op checks its session's role, and the bounds of its struct
    // after decode; a refusal is an ack or a ready with status 0, as before. A handler that awaits checks that its
    // channel is still open before it grants anything to the session.
    const handlers = {
      async hello ({ role }, control) {
        const session = sessionOf.get(control)
        if (closing) throw new Error('Guard is closing')
        if (role !== 'hop' && role !== 'endpoint') return ACK_NO
        if (role === 'hop') {
          // A hop claim must come from an advertised guard in a bucket of its own; anything else is cut off.
          if (!bucketOfConn(conn) || !(await isAdvertisedGuard(conn.remotePublicKey))) {
            conn.destroy(); return ACK_NO
          }
          if (control.closed) return ACK_NO
        }
        session.role = role
        onControlPeer?.({ role, remotePublicKey: b4a.toString(conn.remotePublicKey, 'hex'), remoteHost: conn.rawStream?.remoteHost || null, remotePort: conn.rawStream?.remotePort || 0 })
        return ACK_OK
      },
      register ({ routeToken, ttlMs }, control) {
        const session = sessionOf.get(control)
        if (closing || session.role !== 'endpoint' || !isU32(ttlMs)) return ACK_NO
        const tokHex = b4a.toString(routeToken, 'hex')
        // A live token belongs to the session that registered it: another session can neither take it over nor
        // refresh it past the caps. An expired one is free again and counts as a new registration.
        const cur = routes.get(tokHex)
        const mine = cur?.session === session
        if (cur && !mine && cur.expiresAt > Date.now()) return ACK_NO
        if (!mine && (routes.size - (cur ? 1 : 0) >= MAX_ROUTES_TOTAL || session.ownedRoutes.size >= MAX_ROUTES_PER_CONN)) return ACK_NO
        if (cur && !mine) cur.session.ownedRoutes.delete(tokHex)
        routes.set(tokHex, { session, expiresAt: Date.now() + Math.max(15_000, Math.min(ROUTE_TTL_MS, ttlMs)) })
        session.ownedRoutes.add(tokHex)
        return ACK_OK
      },
      async putMutable ({ publicKey, seq, signature, value }, control) {
        const session = sessionOf.get(control)
        // As released: an empty value is refused for free, a value over 512 bytes spends a DHT slot first.
        if (closing || session.role !== 'endpoint' || !isU32(seq) || !value.byteLength || !allowDhtOp() || !isCard(value)) return ACK_NO
        if (!verifyDhtMutable(signature, seq, value, publicKey)) return ACK_NO
        if (failMutablePutsRemaining > 0) { failMutablePutsRemaining--; return ACK_NO }
        try { await dht.mutablePut({ publicKey }, value, { seq, signMutable: () => signature }); putMutableCount++; return ACK_OK } catch { return ACK_NO }
      },
      async getMutable ({ key }, control) {
        if (closing || sessionOf.get(control).role !== 'endpoint' || !allowDhtOp()) return { record: null }
        try {
          const r = await dht.mutableGet(key, { latest: true })
          return r?.value && isU32(r.seq) && isCard(r.value) ? { record: { seq: r.seq, signature: r.signature, value: r.value } } : { record: null }
        } catch { return { record: null } }
      },
      async rvRegister ({ topic, slotId, ttlMs, sealedCard }, control) {
        const session = sessionOf.get(control)
        if (closing || session.role !== 'endpoint' || !isU32(ttlMs) || !isCard(sealedCard)) return ACK_NO
        const tHex = b4a.toString(topic, 'hex'), sHex = b4a.toString(slotId, 'hex')
        let e = rvTopics.get(tHex)
        if (!e) {
          if (rvTopics.size >= MAX_RV_TOPICS) return ACK_NO
          e = { topicBuf: b4a.from(topic), slots: new Map(), announcing: false, lastAnnounceAt: 0 }
          rvTopics.set(tHex, e)
        }
        // Same rule for rendezvous slots: a live slot is its registering session's alone.
        const slot = e.slots.get(sHex)
        if (slot && slot.session !== session && slot.expiresAt > Date.now()) return ACK_NO
        if (!slot && e.slots.size >= MAX_RV_SLOTS_PER_TOPIC) return ACK_NO
        if (slot && slot.session !== session) slot.session.ownedRvSlots.delete(`${tHex}:${sHex}`)
        e.slots.set(sHex, { sealedCard: b4a.from(sealedCard), session, expiresAt: Date.now() + Math.max(15_000, Math.min(ROUTE_TTL_MS, ttlMs)) })
        session.ownedRvSlots.add(`${tHex}:${sHex}`)
        await ensureRvAnnounced(tHex, e)
        rvRegisterCount++
        return ACK_OK
      },
      rvFetch ({ key }, control) {
        if (closing || sessionOf.get(control).role !== 'hop') return { cards: [] }
        const e = rvTopics.get(b4a.toString(key, 'hex'))
        const now = Date.now(), cards = []
        if (e) for (const [k, v] of e.slots) { if (v.expiresAt <= now) e.slots.delete(k); else if (cards.length < MAX_CARDS) cards.push(v.sealedCard) }
        return { cards }
      },
      async rvLookup ({ key }, control) {
        if (closing || sessionOf.get(control).role !== 'endpoint' || !allowDhtOp()) return { cards: [] }
        const seen = new Map(), now = Date.now(), local = rvTopics.get(b4a.toString(key, 'hex'))
        if (local) for (const [k, v] of local.slots) { if (v.expiresAt <= now) local.slots.delete(k); else if (seen.size < MAX_CARDS) seen.set(b4a.toString(v.sealedCard, 'hex'), v.sealedCard) }
        const rGuards = new Map(), q = dht.lookup(key), qt = setTimeout(() => q.destroy(), 4000); qt.unref?.()
        try {
          for await (const rep of q) for (const peer of rep.peers) {
            if (peer?.publicKey && !b4a.equals(peer.publicKey, keyPair.publicKey) && rGuards.size < 8) rGuards.set(b4a.toString(peer.publicKey, 'hex'), peer.publicKey)
          }
        } catch {} finally { clearTimeout(qt) }
        await Promise.allSettled([...rGuards.values()].map(async gk => {
          const hop = await getHopPeer(gk)
          const { cards } = await hop.rpc.call('rvFetch', { key }, 4000)
          for (const card of cards) if (seen.size < MAX_CARDS && isCard(card)) seen.set(b4a.toString(card, 'hex'), card)
        }))
        return { cards: [...seen.values()] }
      },
      async dialOpen ({ guardKey, routeToken, udxId: callerUdxId, bucket: callerObservedSelfBucket }, control) {
        const session = sessionOf.get(control)
        if (closing || session.role !== 'endpoint' || !isU32(callerUdxId)) return NOT_READY
        if (!callerUdxId || b4a.equals(guardKey, keyPair.publicKey) || activeCircuits.size >= MAX_CIRCUITS_TOTAL || session.circuits >= MAX_CIRCUITS_PER_CONN) return NOT_READY
        let gaLeft = null, gaRight = null
        try {
          const hop = await getHopPeer(guardKey)
          const nextBucket = bucketOfConn(hop.conn)
          const ownB = ownDiversityBucket()
          if (!nextBucket || (callerObservedSelfBucket && callerObservedSelfBucket === nextBucket) || (ownB && ownB === nextBucket)) return NOT_DIVERSE
          gaLeft = allocRawStream(dht, conn, false)
          gaRight = allocRawStream(dht, hop.conn, false)
          HyperDHT.connectRawStream(conn, gaLeft, callerUdxId)
          const rep = await hop.rpc.call('hopOpen', { routeToken, udxId: gaRight.id }, 8000)
          if (!ready(rep) || control.closed) throw new Error('Hop rejected, or this channel closed')
          HyperDHT.connectRawStream(hop.conn, gaRight, rep.udxId)
          gaLeft.relayTo(gaRight); gaRight.relayTo(gaLeft)
          const left = gaLeft, right = gaRight
          const rec = { left, right }
          activeCircuits.add(rec); session.circuits++
          const drop = () => {
            if (!activeCircuits.delete(rec)) return
            session.drops.delete(drop); hop.drops.delete(drop)
            left.off('close', drop); right.off('close', drop)
            session.circuits = Math.max(0, session.circuits - 1)
            session.rpc?.emit('circuitDead', { udxId: callerUdxId })
            left.destroy(); right.destroy()
          }
          session.drops.add(drop); hop.drops.add(drop)
          left.once('close', drop); right.once('close', drop)
          gaLeft = null; gaRight = null
          return { status: 1, udxId: left.id }
        } catch {
          gaLeft?.destroy(); gaRight?.destroy()
          return NOT_READY
        }
      },
      async hopOpen ({ routeToken, udxId: callerUdxId }, control) {
        const session = sessionOf.get(control)
        if (closing || session.role !== 'hop' || !isU32(callerUdxId)) return NOT_READY
        const route = routes.get(b4a.toString(routeToken, 'hex'))
        if (!callerUdxId || !route || route.expiresAt <= Date.now() || route.session.conn === conn || isClosed(route.session.rpc) || activeCircuits.size >= MAX_CIRCUITS_TOTAL || route.session.circuits >= MAX_CIRCUITS_PER_CONN) {
          return NOT_READY
        }
        let gbLeft = null, gbRight = null
        try {
          const hopBucket = bucketOfConn(conn)
          const ownB = ownDiversityBucket()
          const endpointBucket = bucketOfConn(route.session.conn)
          if (!hopBucket || (ownB && hopBucket === ownB) || (!allowLoopback && endpointBucket && hopBucket === endpointBucket)) throw new Error('Non-diverse hop')
          gbLeft = allocRawStream(dht, conn, false)
          gbRight = allocRawStream(dht, route.session.conn, false)
          HyperDHT.connectRawStream(conn, gbLeft, callerUdxId)
          const rep = await route.session.rpc.call('incOpen', { routeToken, udxId: gbRight.id }, 8000)
          if (!ready(rep) || control.closed || isClosed(route.session.rpc)) throw new Error('Endpoint rejected, or a channel closed')
          const bUdx = rep.udxId
          HyperDHT.connectRawStream(route.session.conn, gbRight, bUdx)
          gbLeft.relayTo(gbRight); gbRight.relayTo(gbLeft)
          const left = gbLeft, right = gbRight
          const rec = { left, right }
          activeCircuits.add(rec); session.circuits++; route.session.circuits++
          const drop = () => {
            if (!activeCircuits.delete(rec)) return
            session.drops.delete(drop); route.session.drops.delete(drop)
            left.off('close', drop); right.off('close', drop)
            session.circuits = Math.max(0, session.circuits - 1)
            route.session.circuits = Math.max(0, route.session.circuits - 1)
            route.session.rpc?.emit('circuitDead', { udxId: bUdx })
            left.destroy(); right.destroy()
          }
          session.drops.add(drop); route.session.drops.add(drop)
          left.once('close', drop); right.once('close', drop)
          gbLeft = null; gbRight = null
          return { status: 1, udxId: left.id }
        } catch {
          gbLeft?.destroy(); gbRight?.destroy()
          return NOT_READY
        }
      }
    }
    const events = {
      rvUnregister ({ topic, slotId }, control) {
        const session = sessionOf.get(control)
        if (session.role !== 'endpoint') return
        const tHex = b4a.toString(topic, 'hex'), sHex = b4a.toString(slotId, 'hex')
        session.ownedRvSlots.delete(`${tHex}:${sHex}`); removeRvSlot(tHex, sHex, session)
      }
    }
    serveChannel(conn, { ...GUARD_CHANNEL, handlers, events, onOpen: openSession, onClose: releaseSession })
  })

  await server.listen(keyPair)
  await announceService()

  const refreshTimer = setInterval(() => {
    if (closing) return
    announceService().catch(() => {})
    const now = Date.now()
    for (const [k, r] of routes) if (r.expiresAt <= now) { routes.delete(k); r.session.ownedRoutes.delete(k) }
    for (const [tHex, e] of rvTopics) {
      for (const [sHex, s] of e.slots) if (s.expiresAt <= now) { e.slots.delete(sHex); s.session.ownedRvSlots.delete(`${tHex}:${sHex}`) }
      if (!e.slots.size) {
        const topicBuf = e.topicBuf
        rvTopics.delete(tHex)
        enqueueRvOp(tHex, async () => {
          if (!closing && !rvTopics.get(tHex)?.slots.size) await dht.unannounce(topicBuf, keyPair).catch(() => {})
        })
      } else ensureRvAnnounced(tHex, e)
    }
  }, 60_000)
  refreshTimer.unref?.()

  return {
    publicKey: keyPair.publicKey,
    dht,
    address: () => server.address(),
    boundPorts: () => [...new Set([server.address()?.port, dht.address()?.port, dht.localAddress()?.port].filter(p => Number.isInteger(p) && p > 0))],
    stats: () => ({ registeredRoutes: routes.size, activeCircuits: activeCircuits.size, rendezvousTopics: rvTopics.size, putMutableCount, rvRegisterCount }),
    failNextMutablePut: (n = 1) => { failMutablePutsRemaining += n },
    async suspend () { await server.suspend(); await dht.suspend() },
    async resume () { await dht.resume(); await server.resume(); await announceService() },
    async close () {
      if (closing) return
      closing = true; clearInterval(refreshTimer)
      for (const r of [...activeCircuits]) { r.left.destroy(); r.right.destroy() }
      activeCircuits.clear()
      for (const conn of [...conns]) conn.destroy()
      for (const h of hopPeers.values()) h.conn?.destroy()
      hopPeers.clear()
      if (announceGuard) {
        await Promise.race([
          Promise.allSettled(GUARD_TOPICS.map(t => dht.unannounce(t, keyPair))),
          new Promise(r => { const t = setTimeout(r, 1500); t.unref?.() })
        ])
      }
      await server.close().catch(() => {})
      await dht.destroy({ force: true })
    }
  }
}

// Both ends keep the stream the lower key dialled, whatever order simultaneous dials arrive in.
export function keepDuplicateInnerStream (localPublicKey, remotePublicKey, incomingIsInitiator) {
  return incomingIsInitiator === (b4a.compare(remotePublicKey, localPublicKey) > 0)
}

export async function createPrivateSwarm ({
  host,
  bootstrap,
  port,
  allowLoopback = isLocalBootstrap(host, bootstrap),
  resolveAddress = null,
  keyPair = NoiseSecretStream.keyPair(),
  firewall = () => false
} = {}) {
  const bindHost = host ?? (isLocalBootstrap(host, bootstrap) ? '127.0.0.1' : undefined)
  const transportKeyPair = HyperDHT.keyPair(rand(32))
  const transportDht = new HyperDHT({ host: bindHost, bootstrap, port: port || [0, 0] })
  await transportDht.ready()

  const swarm = new EventEmitter()
  const connections = new Set(), activeByPeer = new Map(), dialingPeers = new Set()
  const explicitPeers = new Map(), joinedSources = new Map(), highestSeqByPeer = new Map()
  const guards = []
  let state = 'BOOTSTRAPPING', suspended = false, closing = false, listeningPromise = null
  let routeToken = rand(32), cardSeq = 1
  let lastPublishedGuardHex = null, lastPublishedTokenHex = null, lastPublishedEpoch = null, nextRenewalAt = 0, cachedCardBytes = null

  const bucketOf = conn => diversityBucketForAddress(resolveAddress ? resolveAddress(conn?.rawStream?.remoteHost, conn?.rawStream?.remotePort, conn?.remotePublicKey) : conn?.rawStream?.remoteHost, conn?.rawStream?.remotePort, allowLoopback)
  const acceptValidCard = card => {
    const hex = b4a.toString(card.innerPublicKey, 'hex')
    if (card.seq < (highestSeqByPeer.get(hex) || 0)) return null
    highestSeqByPeer.set(hex, card.seq)
    return card
  }

  function admitInnerStream (enc, expectedRemoteKey = null, topic = null) {
    enc.on('error', () => {})
    enc.opened.then(ok => {
      const rk = enc.remotePublicKey
      if (!ok || closing || suspended || enc.destroyed || !rk || rk.byteLength !== 32 ||
          (expectedRemoteKey && !b4a.equals(rk, expectedRemoteKey)) || b4a.equals(rk, keyPair.publicKey) || firewall(rk)) {
        enc.destroy(); return
      }
      const hex = b4a.toString(rk, 'hex'), prev = activeByPeer.get(hex)
      if (prev && !prev.destroyed) {
        if (!keepDuplicateInnerStream(keyPair.publicKey, rk, enc.isInitiator)) { enc.destroy(); return }
        prev.destroy()
      }
      activeByPeer.set(hex, enc); connections.add(enc)
      enc.once('close', () => { connections.delete(enc); if (activeByPeer.get(hex) === enc) activeByPeer.delete(hex); swarm.emit('update') })
      swarm.emit('connection', enc, { publicKey: rk, topics: topic ? [topic] : [] }); swarm.emit('update')
    }).catch(() => enc.destroy())
  }

  async function connectCandidateGuard (pubKey) {
    const conn = transportDht.connect(pubKey, { keyPair: transportKeyPair })
    conn.on('error', () => {}); conn.setKeepAlive(5000)
    const ok = await Promise.race([conn.opened, new Promise(r => { const t = setTimeout(() => r(false), 5000); t.unref?.() })])
    const bucket = ok && !conn.destroyed && !closing && !suspended ? bucketOf(conn) : null
    if (!bucket) { conn.destroy(); return null }
    const g = { publicKey: b4a.from(pubKey), hex: b4a.toString(pubKey, 'hex'), bucket, conn, rpc: null, streamsByUdxId: new Map() }
    // The guard asks this endpoint to take an incoming circuit for its route, and tells it when a circuit dies.
    const handlers = {
      incOpen ({ routeToken: token, udxId: callerUdxId }) {
        if (closing || suspended || !b4a.equals(token, routeToken) || !isU32(callerUdxId) || !callerUdxId) return NOT_READY
        let rawB = null
        try {
          rawB = allocRawStream(transportDht, conn, true)
          HyperDHT.connectRawStream(conn, rawB, callerUdxId)
          const streamB = rawB, udxId = streamB.id
          const enc = new NoiseSecretStream(false, streamB, { keyPair, keepAlive: 2500 })
          enc.setTimeout(8000)
          g.streamsByUdxId.set(udxId, enc)
          enc.once('close', () => { g.streamsByUdxId.delete(udxId); if (!streamB.destroyed) streamB.destroy() })
          admitInnerStream(enc, null)
          rawB = null
          return { status: 1, udxId }
        } catch { rawB?.destroy(); return NOT_READY }
      }
    }
    const events = { circuitDead: ({ udxId }) => { if (isU32(udxId)) g.streamsByUdxId.get(udxId)?.destroy() } }
    // A guard on another version refuses the channel: it is not usable, and this endpoint never goes around it. One
    // that closes the channel later is not usable either: its connection closes at once, and stops counting.
    try {
      g.rpc = await openGuardChannel(conn, { handlers, events, onClose: () => conn.destroy() })
      if ((await g.rpc.call('hello', { role: 'endpoint' }, 4000)).status !== 1) throw new Error('Guard refused the endpoint')
    } catch { conn.destroy(); return null }
    conn.once('close', () => {
      for (const s of [...g.streamsByUdxId.values()]) s.destroy()
      g.streamsByUdxId.clear()
      const i = guards.indexOf(g); if (i !== -1) guards.splice(i, 1)
      if (!closing && !suspended) {
        if (usableGuards() < 2) state = 'BOOTSTRAPPING'
        pollAll().catch(() => {})
      }
    })
    return g
  }

  // Guards this client can use now: in the list, channel open, connection not destroyed. Every "two guards" gate
  // counts these: a guard whose channel or connection just closed may still be in the list.
  const usableGuards = () => guards.filter(g => !isClosed(g.rpc)).length

  async function discoverGuards () {
    for (let i = guards.length - 1; i >= 0; i--) if (isClosed(guards[i].rpc)) guards.splice(i, 1)
    if (usableGuards() >= 2) return true
    const candidates = new Map()
    await Promise.allSettled(GUARD_TOPICS.map(async t => {
      const q = transportDht.lookup(t), qt = setTimeout(() => q.destroy(), 4000); qt.unref?.()
      try { for await (const rep of q) for (const p of rep.peers) if (p?.publicKey && !guards.some(g => g.hex === b4a.toString(p.publicKey, 'hex'))) candidates.set(b4a.toString(p.publicKey, 'hex'), p.publicKey) } catch {} finally { clearTimeout(qt) }
    }))
    const list = [...candidates.values()]
    for (let i = list.length - 1; i > 0; i--) { const j = rand(4).readUInt32BE(0) % (i + 1); [list[i], list[j]] = [list[j], list[i]] }
    const used = new Set(guards.map(g => g.bucket))
    for (const pk of list) {
      if (usableGuards() >= 2 || closing || suspended) break
      const g = await connectCandidateGuard(pk)
      if (!g) continue
      if (used.has(g.bucket)) { g.conn.destroy(); continue }
      used.add(g.bucket); guards.push(g)
    }
    return usableGuards() >= 2
  }

  async function publishPresence () {
    if (closing || suspended || usableGuards() < 2) return false
    const primary = guards[0]
    const now = Date.now()
    const tokHex = b4a.toString(routeToken, 'hex')
    const epoch = String(Math.floor(now / RV_EPOCH_MS))
    const needCardRenewal =
      !cachedCardBytes ||
      primary.hex !== lastPublishedGuardHex ||
      tokHex !== lastPublishedTokenHex ||
      epoch !== lastPublishedEpoch ||
      now >= nextRenewalAt

    if (needCardRenewal) {
      const ack = await primary.rpc.call('register', { routeToken, ttlMs: ROUTE_TTL_MS }, 5000)
      if (ack.status !== 1) throw new Error('Guard rejected route')
      const seq = cardSeq++
      const candidateCardBytes = encodeSignedCard({ innerKeyPair: keyPair, guardPublicKey: primary.publicKey, routeToken, seq, expiresAt: now + ROUTE_TTL_MS })
      const sealedPeer = sealBox(candidateCardBytes, sha256('peartube/private-peer-seal/v1/', keyPair.publicKey))
      const mutSig = signDhtMutable(seq, sealedPeer, keyPair.secretKey)
      const mutAck = await primary.rpc.call('putMutable', { publicKey: keyPair.publicKey, seq, signature: mutSig, value: sealedPeer }, 8000)
      if (mutAck.status !== 1) throw new Error('Guard failed to publish mutable card')
      cachedCardBytes = candidateCardBytes
      lastPublishedGuardHex = primary.hex
      lastPublishedTokenHex = tokHex
      lastPublishedEpoch = epoch
      nextRenewalAt = now + Math.floor(ROUTE_TTL_MS / 2)
    }

    for (const src of joinedSources.values()) {
      if (!needCardRenewal && src.lastGuard === primary && src.lastEpoch === epoch && src.lastTokenHex === tokHex && now < src.nextRvRenewalAt) continue
      const rvTopic = sha256('peartube/private-rv/v1/', src.sourceKeyBuf, epoch)
      const sealedCard = sealBox(cachedCardBytes, sha256('peartube/private-rv-seal/v1/', src.sourceKeyBuf))
      const ok = await primary.rpc.call('rvRegister', { topic: rvTopic, slotId: src.slotId, ttlMs: ROUTE_TTL_MS, sealedCard }, 6000).then(r => r.status === 1, () => false)
      if (ok) {
        src.lastEpoch = epoch; src.lastGuard = primary; src.lastTokenHex = tokHex
        src.nextRvRenewalAt = now + Math.floor(ROUTE_TTL_MS / 2)
      }
    }
    // A guard may have gone during the awaits above: READY only with two still usable; else the state stays what
    // that guard's close set.
    if (usableGuards() < 2) return false
    state = 'READY'
    return true
  }

  let ensuring = null, ensureDirty = false
  function ensureGuardsAndPublish () {
    if (closing || suspended) return Promise.resolve(false)
    if (ensuring) { ensureDirty = true; return ensuring }
    ensuring = (async () => {
      let ok = false
      try {
        do {
          ensureDirty = false
          if (!(await discoverGuards())) { state = 'UNAVAILABLE'; return false }
          ok = await publishPresence()
        } while (ensureDirty && !closing && !suspended)
        return ok
      } catch { state = 'UNAVAILABLE'; return false } finally { ensuring = null }
    })()
    return ensuring
  }

  async function dialCard (card, topic = null) {
    if (closing || suspended) return
    const hex = b4a.toString(card.innerPublicKey, 'hex')
    const existing = activeByPeer.get(hex)
    if (existing && !existing.destroyed) {
      if (topic) swarm.emit('peer-topic', existing, topic)
      return
    }
    if (b4a.equals(card.innerPublicKey, keyPair.publicKey) || dialingPeers.has(hex) || firewall(card.innerPublicKey)) return
    if (usableGuards() < 2 && !(await ensureGuardsAndPublish())) return
    const candidates = guards.filter(g => !isClosed(g.rpc) && !b4a.equals(g.publicKey, card.guardPublicKey))
    if (!candidates.length) return
    dialingPeers.add(hex)
    try {
      for (const sourceGuard of candidates) {
        let rawA = null
        // A guard may have gone while an earlier candidate was asked: no dial with fewer than two usable.
        if (usableGuards() < 2) return
        try {
          rawA = allocRawStream(transportDht, sourceGuard.conn, true)
          const rep = await sourceGuard.rpc.call('dialOpen', { guardKey: card.guardPublicKey, routeToken: card.routeToken, udxId: rawA.id, bucket: sourceGuard.bucket }, 10_000)
          if (!ready(rep)) {
            rawA.destroy()
            if (notDiverse(rep)) continue
            return
          }
          HyperDHT.connectRawStream(sourceGuard.conn, rawA, rep.udxId)
          const streamA = rawA, udxId = streamA.id
          const enc = new NoiseSecretStream(true, streamA, { keyPair, remotePublicKey: card.innerPublicKey, keepAlive: 2500 })
          enc.setTimeout(8000)
          sourceGuard.streamsByUdxId.set(udxId, enc)
          enc.once('close', () => { sourceGuard.streamsByUdxId.delete(udxId); if (!streamA.destroyed) streamA.destroy() })
          admitInnerStream(enc, card.innerPublicKey, topic)
          rawA = null
          return
        } catch { rawA?.destroy() }
      }
    } finally { dialingPeers.delete(hex) }
  }

  async function lookupAndDialPeer (pk) {
    const hex = b4a.toString(pk, 'hex')
    if (closing || suspended || activeByPeer.has(hex) || dialingPeers.has(hex)) return
    if (usableGuards() < 2 && !(await ensureGuardsAndPublish())) return
    const g = guards[0]; if (!g || isClosed(g.rpc)) return
    try {
      const { record } = await g.rpc.call('getMutable', { key: pk }, 6000)
      if (!record || !isU32(record.seq) || !isCard(record.value)) return
      if (!verifyDhtMutable(record.signature, record.seq, record.value, pk)) return
      const val = record.value
      const plain = openBox(val, sha256('peartube/private-peer-seal/v1/', pk))
      const card = plain && decodeAndVerifyCard(plain, Date.now(), pk)
      if (card && acceptValidCard(card)) await dialCard(card)
    } catch {}
  }

  async function refreshSourceDiscovery (src) {
    if (closing || suspended || (usableGuards() < 2 && !(await ensureGuardsAndPublish()))) return
    const g = guards[0]; if (!g || isClosed(g.rpc)) return
    const epNow = Math.floor(Date.now() / RV_EPOCH_MS), sealKey = sha256('peartube/private-rv-seal/v1/', src.sourceKeyBuf)
    const sourceTopic = hypercoreCrypto.discoveryKey(src.sourceKeyBuf)
    for (const ep of [String(epNow), String(epNow - 1)]) {
      try {
        const { cards } = await g.rpc.call('rvLookup', { key: sha256('peartube/private-rv/v1/', src.sourceKeyBuf, ep) }, 6000)
        const now = Date.now()
        for (const s of cards) {
          const plain = openBox(s, sealKey), card = plain && decodeAndVerifyCard(plain, now, null)
          if (card && acceptValidCard(card)) dialCard(card, sourceTopic).catch(() => {})
        }
      } catch {}
    }
  }

  async function pollAll () {
    if (closing || suspended) return
    await ensureGuardsAndPublish()
    if (usableGuards() < 2) return
    await Promise.allSettled([
      ...[...joinedSources.values()].map(s => refreshSourceDiscovery(s)),
      ...[...explicitPeers.values()].map(pk => lookupAndDialPeer(pk))
    ])
  }

  const pollTimer = setInterval(() => { pollAll().catch(() => {}) }, 4000); pollTimer.unref?.()
  listeningPromise = ensureGuardsAndPublish()

  const dhtFacade = {
    privateRouting: Object.freeze({
      status: () => closing ? 'DESTROYED' : (suspended ? 'SUSPENDED' : state),
      exposureReport: () => Object.freeze({
        hops: 2,
        directDestinationSends: 0,
        guards: usableGuards(),
        transportPort: transportDht.address()?.port || transportDht.localAddress()?.port || 0
      })
    })
  }

  return Object.assign(swarm, {
    keyPair,
    connections,
    dht: dhtFacade,
    get listening () { return listeningPromise },
    listen () { if (!listeningPromise) listeningPromise = ensureGuardsAndPublish(); return listeningPromise },
    joinSource (id, sourceKeyBuf) {
      if (joinedSources.has(id)) return joinedSources.get(id).handle
      const src = { id, sourceKeyBuf: b4a.from(sourceKeyBuf), slotId: rand(16), lastEpoch: null, lastGuard: null, lastTokenHex: null, nextRvRenewalAt: 0, handle: null }
      src.handle = { topic: sha256('peartube/private-rv/v1/', src.sourceKeyBuf, String(Math.floor(Date.now() / RV_EPOCH_MS))), isServer: false, isClient: true, refresh: () => pollAll(), destroy: () => swarm.leaveSource(id) }
      joinedSources.set(id, src); pollAll().catch(() => {})
      return src.handle
    },
    async leaveSource (id) {
      const src = joinedSources.get(id); if (!src) return
      joinedSources.delete(id)
      if (src.lastGuard && !isClosed(src.lastGuard.rpc) && src.lastEpoch) {
        src.lastGuard.rpc.emit('rvUnregister', { topic: sha256('peartube/private-rv/v1/', src.sourceKeyBuf, src.lastEpoch), slotId: src.slotId })
      }
    },
    join: topic => ({ topic, isServer: false, isClient: true, refresh: () => pollAll(), destroy: () => Promise.resolve() }),
    leave: () => Promise.resolve(),
    joinPeer (pk) { if (b4a.isBuffer(pk) && pk.byteLength === 32 && !b4a.equals(pk, keyPair.publicKey)) { explicitPeers.set(b4a.toString(pk, 'hex'), b4a.from(pk)); lookupAndDialPeer(pk).catch(() => {}) } },
    leavePeer (pk) { if (b4a.isBuffer(pk)) explicitPeers.delete(b4a.toString(pk, 'hex')) },
    status (topic) { for (const s of joinedSources.values()) if (b4a.equals(s.handle.topic, topic)) return s.handle; return null },
    topics: () => [...joinedSources.values()].map(s => s.handle),
    async suspend () {
      if (suspended || closing) return
      suspended = true; state = 'SUSPENDED'
      lastPublishedGuardHex = null; nextRenewalAt = 0; cachedCardBytes = null
      for (const c of [...connections]) c.destroy(); connections.clear(); activeByPeer.clear()
      for (const g of guards.splice(0)) g.conn.destroy()
      await transportDht.suspend()
    },
    async resume () {
      if (!suspended || closing) return
      await transportDht.resume()
      routeToken = rand(32); suspended = false; state = 'BOOTSTRAPPING'
      listeningPromise = pollAll(); await listeningPromise
    },
    async clear () { for (const id of [...joinedSources.keys()]) await swarm.leaveSource(id); explicitPeers.clear() },
    async destroy () {
      if (closing) return
      closing = true; clearInterval(pollTimer); state = 'DESTROYED'
      for (const c of [...connections]) c.destroy(); connections.clear(); activeByPeer.clear()
      for (const g of guards.splice(0)) g.conn.destroy()
      await transportDht.destroy({ force: true })
    }
  })
}

export async function publishStandaloneRouteCard ({
  host = '127.0.0.1',
  bootstrap,
  guardPublicKey,
  advertisedKeyPair,
  responderKeyPair = advertisedKeyPair,
  onInnerConnection
}) {
  const dht = new HyperDHT({ host, bootstrap, port: [0, 0] })
  await dht.ready()
  const conn = dht.connect(guardPublicKey, { keyPair: HyperDHT.keyPair(rand(32)) })
  conn.on('error', () => {}); conn.setKeepAlive(5000)
  const close = async () => { conn.destroy(); await dht.destroy({ force: true }) }
  const routeToken = rand(32)
  const handlers = {
    incOpen ({ udxId: callerUdxId }) {
      if (!isU32(callerUdxId) || !callerUdxId) return NOT_READY
      let raw = null
      try {
        raw = allocRawStream(dht, conn, true)
        HyperDHT.connectRawStream(conn, raw, callerUdxId)
        const stream = raw
        const enc = new NoiseSecretStream(false, stream, { keyPair: responderKeyPair, keepAlive: 5000 })
        enc.on('error', () => {}); enc.once('close', () => { if (!stream.destroyed) stream.destroy() })
        enc.opened.then(ok => { if (ok && !enc.destroyed) onInnerConnection?.(enc); else enc.destroy() }).catch(() => enc.destroy())
        raw = null
        return { status: 1, udxId: stream.id }
      } catch { raw?.destroy(); return NOT_READY }
    }
  }
  // Each step must be accepted (status 1). On any failure the connection and the DHT close before the error.
  try {
    await conn.opened
    const rpc = await openGuardChannel(conn, { handlers })
    const accepted = async (name, value, ms) => { if ((await rpc.call(name, value, ms)).status !== 1) throw new Error(`Guard refused ${name}`) }
    await accepted('hello', { role: 'endpoint' }, 4000)
    await accepted('register', { routeToken, ttlMs: ROUTE_TTL_MS }, 4000)
    const seq = 1
    const card = encodeSignedCard({ innerKeyPair: advertisedKeyPair, guardPublicKey, routeToken, seq, expiresAt: Date.now() + ROUTE_TTL_MS })
    const sealed = sealBox(card, sha256('peartube/private-peer-seal/v1/', advertisedKeyPair.publicKey))
    await accepted('putMutable', { publicKey: advertisedKeyPair.publicKey, seq, signature: signDhtMutable(seq, sealed, advertisedKeyPair.secretKey), value: sealed }, 6000)
  } catch (err) {
    await close()
    throw err
  }
  return close
}

export async function attemptDirectHopBypass ({ host = '127.0.0.1', bootstrap, targetPeerPublicKey }) {
  const dht = new HyperDHT({ host, bootstrap, port: [0, 0] })
  await dht.ready()
  try {
    const m = await dht.mutableGet(targetPeerPublicKey, { latest: true })
    if (!m?.value) throw new Error('Target mutable card not found')
    const plain = openBox(m.value, sha256('peartube/private-peer-seal/v1/', targetPeerPublicKey))
    const card = plain && decodeAndVerifyCard(plain, Date.now(), targetPeerPublicKey)
    if (!card) throw new Error('Target card invalid')

    // 1. Endpoint session attempting the forbidden hopOpen directly on the destination guard:
    let endpointBypassAccepted = false
    const c1 = dht.connect(card.guardPublicKey, { keyPair: HyperDHT.keyPair(rand(32)) })
    c1.on('error', () => {}); await c1.opened
    const rpc1 = await openGuardChannel(c1, {}, 3000)
    await rpc1.call('hello', { role: 'endpoint' }, 3000)
    const raw1 = allocRawStream(dht, c1, true)
    const rep1 = await rpc1.call('hopOpen', { routeToken: card.routeToken, udxId: raw1.id }, 3000)
    if (rep1.status === 1) endpointBypassAccepted = true
    raw1.destroy(); c1.destroy()

    // 2. Unadvertised keypair claiming the 'hop' role directly on the destination guard:
    let spoofedHopAccepted = false
    const c2 = dht.connect(card.guardPublicKey, { keyPair: HyperDHT.keyPair(rand(32)) })
    c2.on('error', () => {}); await c2.opened
    try {
      const rpc2 = await openGuardChannel(c2, {}, 3000)
      await rpc2.call('hello', { role: 'hop' }, 3000)
      const raw2 = allocRawStream(dht, c2, true)
      const rep2 = await rpc2.call('hopOpen', { routeToken: card.routeToken, udxId: raw2.id }, 3000)
      if (rep2.status === 1) spoofedHopAccepted = true
      raw2.destroy()
    } catch {}
    c2.destroy()

    return { endpointBypassAccepted, spoofedHopAccepted }
  } finally {
    await dht.destroy({ force: true })
  }
}
