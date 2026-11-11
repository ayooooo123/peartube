// Stateless 2-relay (1 + 1: Peer_A -> Guard_A <-> Guard_B <- Peer_B) UDX-spliced overlay on stock HyperDHT:
//   - Guards open zero Corestore/Hypercore state, touch zero disk files, and splice raw UDX streams (`relayTo`).
//   - Endpoints never expose their E2E Noise identity on the public DHT; every outbound dial, rendezvous
//     lookup, and owner-signed mutable descriptor write exits through an auto-discovered /24-diverse Guard.
//   - Destination guards enforce role separation, advertised-guard membership, and /24 bucket separation on hops.
import EventEmitter from 'node:events'
import { createHash } from 'node:crypto'
import HyperDHT from 'hyperdht'
import NoiseSecretStream from '@hyperswarm/secret-stream'
import Protomux from 'protomux'
import hypercoreCrypto from 'hypercore-crypto'
import c from 'compact-encoding'
import sodium from 'sodium-native'
import b4a from 'b4a'

const PROTOCOL = 'peartube/private-guard/v1'
const CARD_DOMAIN = b4a.from('peartube/private-route-card/v1\0')
const GUARD_TOPICS = [0, 1, 2, 3].map(i => HyperDHT.hash(b4a.from(`peartube/private-guard/v1/${i}`)))
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

const OP_HELLO = 1
const OP_REGISTER = 2
const OP_REGISTER_ACK = 3
const OP_PUT_MUTABLE = 4
const OP_PUT_MUTABLE_ACK = 5
const OP_GET_MUTABLE = 6
const OP_GET_MUTABLE_REPLY = 7
const OP_RV_REGISTER = 8
const OP_RV_REGISTER_ACK = 9
const OP_RV_UNREGISTER = 10
const OP_RV_LOOKUP = 11
const OP_RV_LOOKUP_REPLY = 12
const OP_RV_FETCH = 13
const OP_RV_FETCH_REPLY = 14
const OP_DIAL_OPEN = 15
const OP_DIAL_READY = 16
const OP_HOP_OPEN = 17
const OP_HOP_READY = 18
const OP_INC_OPEN = 19
const OP_INC_READY = 20
const OP_CIRCUIT_DEAD = 21

const sha256 = (...parts) => {
  const h = createHash('sha256')
  for (const p of parts) h.update(typeof p === 'string' ? b4a.from(p) : p)
  return h.digest()
}
const rand = n => { const b = b4a.allocUnsafe(n); sodium.randombytes_buf(b); return b }
const u32 = n => { const b = b4a.allocUnsafe(4); b.writeUInt32BE(n >>> 0, 0); return b }

const mutSignEnc = {
  preencode (s, m) { c.uint.preencode(s, m.seq); c.buffer.preencode(s, m.value) },
  encode (s, m) { c.uint.encode(s, m.seq); c.buffer.encode(s, m.value) }
}
const frameEnc = {
  preencode (s, m) { c.uint.preencode(s, m.op); c.uint.preencode(s, m.id); c.buffer.preencode(s, m.payload || b4a.alloc(0)) },
  encode (s, m) { c.uint.encode(s, m.op); c.uint.encode(s, m.id); c.buffer.encode(s, m.payload || b4a.alloc(0)) },
  decode (s) { return { op: c.uint.decode(s), id: c.uint.decode(s), payload: c.buffer.decode(s) } }
}
const bufArrEnc = {
  preencode (s, a) { c.uint.preencode(s, a.length); for (const x of a) c.buffer.preencode(s, x) },
  encode (s, a) { c.uint.encode(s, a.length); for (const x of a) c.buffer.encode(s, x) },
  decode (s) { const n = Math.min(128, c.uint.decode(s)), o = []; for (let i = 0; i < n; i++) o.push(c.buffer.decode(s)); return o }
}

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

export function diversityBucketForAddress (host, port, allowLoopback = false) {
  if (typeof host !== 'string' || !host) return null
  const clean = host.startsWith('::ffff:') ? host.slice(7) : host
  const v4 = clean.split('.')
  if (v4.length === 4 && v4.every(p => /^\d+$/.test(p) && Number(p) <= 255)) {
    const a = Number(v4[0]), b = Number(v4[1]), d = Number(v4[2])
    if (a === 127) return (allowLoopback && Number.isInteger(port) && port > 0) ? `loopback:${clean}:${port}` : null
    return a === 0 ? null : `ipv4:${a}.${b}.${d}.0/24`
  }
  if (clean === '::1') return (allowLoopback && Number.isInteger(port) && port > 0) ? `loopback:::1:${port}` : null
  if (clean.includes(':')) return `ipv6:${clean.toLowerCase().split(':').slice(0, 3).map(s => s.padStart(4, '0')).join(':')}/48`
  return null
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

function attachRpcChannel (conn, onRequest) {
  const mux = Protomux.from(conn)
  const pending = new Map()
  let nextId = 1, closed = false, msg = null
  const openChannel = () => {
    if (closed || conn.destroyed || mux.opened({ protocol: PROTOCOL })) return
    const ch = mux.createChannel({
      protocol: PROTOCOL,
      onclose () {
        closed = true
        for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error('Guard channel closed')) }
        pending.clear()
      }
    })
    if (!ch) return
    msg = ch.addMessage({
      encoding: frameEnc,
      onmessage (f) {
        const w = pending.get(f.id)
        if (w && w.replyOp === f.op) { pending.delete(f.id); clearTimeout(w.timer); w.resolve(f.payload); return }
        Promise.resolve(onRequest?.(f, send)).catch(() => {})
      }
    })
    ch.open()
  }
  // Pair before opening so an eager peer frame arriving mid-handshake never hits an unpaired Protomux slot.
  mux.pair({ protocol: PROTOCOL }, openChannel)
  openChannel()
  const send = (op, id, payload = b4a.alloc(0)) => { if (!closed && !conn.destroyed && msg) msg.send({ op, id, payload }) }
  const request = (op, replyOp, payload = b4a.alloc(0), ms = 10_000) => {
    if (closed || conn.destroyed || !msg) return Promise.reject(new Error('Control channel closed'))
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC ${op} timeout`)) }, ms)
      timer.unref?.()
      pending.set(id, { replyOp, timer, resolve, reject })
      msg.send({ op, id, payload })
    })
  }
  return { conn, send, request, isClosed: () => closed || conn.destroyed }
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
  const dht = new HyperDHT({ host: bindHost, bootstrap, port, ephemeral: false, firewalled: false })
  await dht.ready()

  const routes = new Map(), rvTopics = new Map(), activeCircuits = new Set(), sessions = new Set(), hopPeers = new Map()
  const verifiedGuardCache = new Map()
  let closing = false, putMutableCount = 0, rvRegisterCount = 0, failMutablePutsRemaining = 0

  const bucketOfConn = conn => {
    const raw = conn?.rawStream
    const h = resolveAddress ? resolveAddress(raw?.remoteHost, raw?.remotePort, conn?.remotePublicKey) : raw?.remoteHost
    return diversityBucketForAddress(h, raw?.remotePort, allowLoopback)
  }
  const ownDiversityBucket = () => {
    const ownAddr = dht.remoteAddress() || (allowLoopback ? server.address() : null)
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
  const removeRvSlot = (tHex, sHex) => {
    const e = rvTopics.get(tHex)
    if (!e) return
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
    if (cur && !cur.rpc.isClosed()) return cur
    if (cur?.connecting) return cur.connecting
    const entry = { conn: null, rpc: null, connecting: null, drops: new Set() }
    entry.connecting = (async () => {
      const conn = dht.connect(targetGuardKey, { keyPair })
      conn.on('error', () => {}); conn.setKeepAlive(5000)
      const rpc = attachRpcChannel(conn, null)
      const ok = await Promise.race([conn.opened, new Promise(r => { const t = setTimeout(() => r(false), 6000); t.unref?.() })])
      if (!ok || conn.destroyed || closing) { conn.destroy(); throw new Error('Guard unreachable') }
      await rpc.request(OP_HELLO, OP_HELLO, b4a.from('hop'), 4000)
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
    const session = { conn, rpc: null, role: null, ownedRoutes: new Set(), ownedRvSlots: new Set(), drops: new Set(), circuits: 0 }
    sessions.add(session)

    session.rpc = attachRpcChannel(conn, async (f, send) => {
      if (closing) return
      const p = f.payload
      if (f.op === OP_HELLO) {
        const wantedRole = b4a.toString(p) === 'hop' ? 'hop' : 'endpoint'
        if (wantedRole === 'hop') {
          if (!bucketOfConn(conn) || !(await isAdvertisedGuard(conn.remotePublicKey))) {
            conn.destroy(); return
          }
        }
        session.role = wantedRole
        onControlPeer?.({ role: wantedRole, remotePublicKey: b4a.toString(conn.remotePublicKey, 'hex'), remoteHost: conn.rawStream?.remoteHost || null, remotePort: conn.rawStream?.remotePort || 0 })
        send(OP_HELLO, f.id, b4a.from('ok'))
      } else if (f.op === OP_REGISTER) {
        if (session.role !== 'endpoint' || p.byteLength !== 36) return send(OP_REGISTER_ACK, f.id, b4a.from([0]))
        const tokHex = b4a.toString(p.subarray(0, 32), 'hex')
        if (!routes.has(tokHex) && (routes.size >= MAX_ROUTES_TOTAL || session.ownedRoutes.size >= MAX_ROUTES_PER_CONN)) return send(OP_REGISTER_ACK, f.id, b4a.from([0]))
        routes.set(tokHex, { session, expiresAt: Date.now() + Math.max(15_000, Math.min(ROUTE_TTL_MS, p.readUInt32BE(32))) })
        session.ownedRoutes.add(tokHex)
        send(OP_REGISTER_ACK, f.id, b4a.from([1]))
      } else if (f.op === OP_PUT_MUTABLE) {
        if (session.role !== 'endpoint' || p.byteLength <= 100) return send(OP_PUT_MUTABLE_ACK, f.id, b4a.from([0]))
        const publicKey = p.subarray(0, 32), seq = p.readUInt32BE(32), signature = p.subarray(36, 100), value = p.subarray(100)
        if (value.byteLength > MAX_CARD_BYTES || !verifyDhtMutable(signature, seq, value, publicKey)) return send(OP_PUT_MUTABLE_ACK, f.id, b4a.from([0]))
        if (failMutablePutsRemaining > 0) { failMutablePutsRemaining--; return send(OP_PUT_MUTABLE_ACK, f.id, b4a.from([0])) }
        try { await dht.mutablePut({ publicKey }, value, { seq, signMutable: () => signature }); putMutableCount++; send(OP_PUT_MUTABLE_ACK, f.id, b4a.from([1])) } catch { send(OP_PUT_MUTABLE_ACK, f.id, b4a.from([0])) }
      } else if (f.op === OP_GET_MUTABLE) {
        if (session.role !== 'endpoint' || p.byteLength !== 32) return send(OP_GET_MUTABLE_REPLY, f.id, b4a.from([0]))
        try {
          const r = await dht.mutableGet(p, { latest: true })
          send(OP_GET_MUTABLE_REPLY, f.id, r?.value ? b4a.concat([b4a.from([1]), u32(r.seq), r.signature, r.value]) : b4a.from([0]))
        } catch { send(OP_GET_MUTABLE_REPLY, f.id, b4a.from([0])) }
      } else if (f.op === OP_RV_REGISTER) {
        if (session.role !== 'endpoint' || p.byteLength <= 52 || p.byteLength - 52 > MAX_CARD_BYTES) return send(OP_RV_REGISTER_ACK, f.id, b4a.from([0]))
        const rvTopic = p.subarray(0, 32), slotId = p.subarray(32, 48), ttl = p.readUInt32BE(48), sealedCard = b4a.from(p.subarray(52))
        const tHex = b4a.toString(rvTopic, 'hex'), sHex = b4a.toString(slotId, 'hex')
        let e = rvTopics.get(tHex)
        if (!e) {
          if (rvTopics.size >= MAX_RV_TOPICS) return send(OP_RV_REGISTER_ACK, f.id, b4a.from([0]))
          e = { topicBuf: b4a.from(rvTopic), slots: new Map(), announcing: false, lastAnnounceAt: 0 }
          rvTopics.set(tHex, e)
        }
        if (!e.slots.has(sHex) && e.slots.size >= MAX_RV_SLOTS_PER_TOPIC) return send(OP_RV_REGISTER_ACK, f.id, b4a.from([0]))
        e.slots.set(sHex, { sealedCard, expiresAt: Date.now() + Math.max(15_000, Math.min(ROUTE_TTL_MS, ttl)) })
        session.ownedRvSlots.add(`${tHex}:${sHex}`)
        await ensureRvAnnounced(tHex, e)
        rvRegisterCount++; send(OP_RV_REGISTER_ACK, f.id, b4a.from([1]))
      } else if (f.op === OP_RV_UNREGISTER) {
        if (session.role === 'endpoint' && p.byteLength === 48) {
          const tHex = b4a.toString(p.subarray(0, 32), 'hex'), sHex = b4a.toString(p.subarray(32, 48), 'hex')
          session.ownedRvSlots.delete(`${tHex}:${sHex}`); removeRvSlot(tHex, sHex)
        }
      } else if (f.op === OP_RV_FETCH) {
        if (session.role !== 'hop') return send(OP_RV_FETCH_REPLY, f.id, c.encode(bufArrEnc, []))
        const e = p.byteLength === 32 ? rvTopics.get(b4a.toString(p, 'hex')) : null
        const now = Date.now(), cards = []
        if (e) for (const [k, v] of e.slots) { if (v.expiresAt <= now) e.slots.delete(k); else cards.push(v.sealedCard) }
        send(OP_RV_FETCH_REPLY, f.id, c.encode(bufArrEnc, cards))
      } else if (f.op === OP_RV_LOOKUP) {
        if (session.role !== 'endpoint' || p.byteLength !== 32) return send(OP_RV_LOOKUP_REPLY, f.id, c.encode(bufArrEnc, []))
        const seen = new Map(), now = Date.now(), local = rvTopics.get(b4a.toString(p, 'hex'))
        if (local) for (const [k, v] of local.slots) { if (v.expiresAt <= now) local.slots.delete(k); else seen.set(b4a.toString(v.sealedCard, 'hex'), v.sealedCard) }
        const rGuards = new Map(), q = dht.lookup(p), qt = setTimeout(() => q.destroy(), 4000); qt.unref?.()
        try {
          for await (const rep of q) for (const peer of rep.peers) {
            if (peer?.publicKey && !b4a.equals(peer.publicKey, keyPair.publicKey) && rGuards.size < 8) rGuards.set(b4a.toString(peer.publicKey, 'hex'), peer.publicKey)
          }
        } catch {} finally { clearTimeout(qt) }
        await Promise.allSettled([...rGuards.values()].map(async gk => {
          const hop = await getHopPeer(gk)
          const raw = await hop.rpc.request(OP_RV_FETCH, OP_RV_FETCH_REPLY, p, 4000)
          for (const card of c.decode(bufArrEnc, raw)) if (seen.size < 64) seen.set(b4a.toString(card, 'hex'), card)
        }))
        send(OP_RV_LOOKUP_REPLY, f.id, c.encode(bufArrEnc, [...seen.values()]))
      } else if (f.op === OP_DIAL_OPEN) {
        if (session.role !== 'endpoint' || p.byteLength < 68) return send(OP_DIAL_READY, f.id, b4a.alloc(5))
        const targetGuardKey = p.subarray(0, 32), routeToken = p.subarray(32, 64), callerUdxId = p.readUInt32BE(64)
        const callerObservedSelfBucket = p.byteLength > 68 ? b4a.toString(p.subarray(68)) : ''
        if (!callerUdxId || b4a.equals(targetGuardKey, keyPair.publicKey) || activeCircuits.size >= MAX_CIRCUITS_TOTAL || session.circuits >= MAX_CIRCUITS_PER_CONN) {
          return send(OP_DIAL_READY, f.id, b4a.alloc(5))
        }
        let gaLeft = null, gaRight = null
        try {
          const hop = await getHopPeer(targetGuardKey)
          const nextBucket = bucketOfConn(hop.conn)
          const ownB = ownDiversityBucket()
          if (!nextBucket || (callerObservedSelfBucket && callerObservedSelfBucket === nextBucket) || (ownB && ownB === nextBucket)) {
            return send(OP_DIAL_READY, f.id, b4a.from([2, 0, 0, 0, 0]))
          }
          gaLeft = allocRawStream(dht, conn, false)
          gaRight = allocRawStream(dht, hop.conn, false)
          HyperDHT.connectRawStream(conn, gaLeft, callerUdxId)
          const rep = await hop.rpc.request(OP_HOP_OPEN, OP_HOP_READY, b4a.concat([routeToken, u32(gaRight.id)]), 8000)
          if (rep.byteLength !== 5 || rep[0] !== 1) throw new Error('Hop rejected')
          HyperDHT.connectRawStream(hop.conn, gaRight, rep.readUInt32BE(1))
          gaLeft.relayTo(gaRight); gaRight.relayTo(gaLeft)
          const left = gaLeft, right = gaRight
          const rec = { left, right }
          activeCircuits.add(rec); session.circuits++
          const aUdx = callerUdxId
          const drop = () => {
            if (!activeCircuits.delete(rec)) return
            session.drops.delete(drop); hop.drops.delete(drop)
            left.off('close', drop); right.off('close', drop)
            session.circuits = Math.max(0, session.circuits - 1)
            session.rpc.send(OP_CIRCUIT_DEAD, 0, u32(aUdx))
            left.destroy(); right.destroy()
          }
          session.drops.add(drop); hop.drops.add(drop)
          left.once('close', drop); right.once('close', drop)
          send(OP_DIAL_READY, f.id, b4a.concat([b4a.from([1]), u32(left.id)]))
          gaLeft = null; gaRight = null
        } catch {
          gaLeft?.destroy(); gaRight?.destroy()
          send(OP_DIAL_READY, f.id, b4a.alloc(5))
        }
      } else if (f.op === OP_HOP_OPEN) {
        if (session.role !== 'hop' || p.byteLength !== 36) return send(OP_HOP_READY, f.id, b4a.alloc(5))
        const routeToken = p.subarray(0, 32), callerUdxId = p.readUInt32BE(32)
        const route = routes.get(b4a.toString(routeToken, 'hex'))
        if (!callerUdxId || !route || route.expiresAt <= Date.now() || route.session.conn === conn || route.session.rpc.isClosed() || activeCircuits.size >= MAX_CIRCUITS_TOTAL || route.session.circuits >= MAX_CIRCUITS_PER_CONN) {
          return send(OP_HOP_READY, f.id, b4a.alloc(5))
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
          const rep = await route.session.rpc.request(OP_INC_OPEN, OP_INC_READY, b4a.concat([routeToken, u32(gbRight.id)]), 8000)
          if (rep.byteLength !== 5 || rep[0] !== 1) throw new Error('Endpoint rejected')
          const bUdx = rep.readUInt32BE(1)
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
            route.session.rpc.send(OP_CIRCUIT_DEAD, 0, u32(bUdx))
            left.destroy(); right.destroy()
          }
          session.drops.add(drop); route.session.drops.add(drop)
          left.once('close', drop); right.once('close', drop)
          send(OP_HOP_READY, f.id, b4a.concat([b4a.from([1]), u32(left.id)]))
          gbLeft = null; gbRight = null
        } catch {
          gbLeft?.destroy(); gbRight?.destroy()
          send(OP_HOP_READY, f.id, b4a.alloc(5))
        }
      }
    })

    conn.once('close', () => {
      sessions.delete(session)
      for (const d of [...session.drops]) d()
      for (const t of session.ownedRoutes) if (routes.get(t)?.session === session) routes.delete(t)
      for (const pair of session.ownedRvSlots) { const i = pair.indexOf(':'); removeRvSlot(pair.slice(0, i), pair.slice(i + 1)) }
    })
  })

  await server.listen(keyPair)
  await announceService()

  const refreshTimer = setInterval(() => {
    if (closing) return
    announceService().catch(() => {})
    const now = Date.now()
    for (const [k, r] of routes) if (r.expiresAt <= now) routes.delete(k)
    for (const [tHex, e] of rvTopics) {
      for (const [sHex, s] of e.slots) if (s.expiresAt <= now) e.slots.delete(sHex)
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
      for (const s of [...sessions]) s.conn.destroy()
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

  function admitInnerStream (enc, expectedRemoteKey = null) {
    enc.on('error', () => {})
    enc.opened.then(ok => {
      const rk = enc.remotePublicKey
      if (!ok || closing || suspended || enc.destroyed || !rk || rk.byteLength !== 32 ||
          (expectedRemoteKey && !b4a.equals(rk, expectedRemoteKey)) || b4a.equals(rk, keyPair.publicKey) || firewall(rk)) {
        enc.destroy(); return
      }
      const hex = b4a.toString(rk, 'hex'), prev = activeByPeer.get(hex)
      if (prev && !prev.destroyed) {
        if (!(!enc.isInitiator && b4a.compare(rk, keyPair.publicKey) < 0)) { enc.destroy(); return }
        prev.destroy()
      }
      activeByPeer.set(hex, enc); connections.add(enc)
      enc.once('close', () => { connections.delete(enc); if (activeByPeer.get(hex) === enc) activeByPeer.delete(hex); swarm.emit('update') })
      swarm.emit('connection', enc); swarm.emit('update')
    }).catch(() => enc.destroy())
  }

  async function connectCandidateGuard (pubKey) {
    const conn = transportDht.connect(pubKey, { keyPair: transportKeyPair })
    conn.on('error', () => {}); conn.setKeepAlive(5000)
    const ok = await Promise.race([conn.opened, new Promise(r => { const t = setTimeout(() => r(false), 5000); t.unref?.() })])
    const bucket = ok && !conn.destroyed && !closing && !suspended ? bucketOf(conn) : null
    if (!bucket) { conn.destroy(); return null }
    const g = { publicKey: b4a.from(pubKey), hex: b4a.toString(pubKey, 'hex'), bucket, conn, rpc: null, streamsByUdxId: new Map() }
    g.rpc = attachRpcChannel(conn, async (f, send) => {
      if (f.op === OP_CIRCUIT_DEAD) {
        if (f.payload.byteLength === 4) g.streamsByUdxId.get(f.payload.readUInt32BE(0))?.destroy()
        return
      }
      if (f.op !== OP_INC_OPEN) return
      if (closing || suspended || f.payload.byteLength !== 36 || !b4a.equals(f.payload.subarray(0, 32), routeToken)) return send(OP_INC_READY, f.id, b4a.alloc(5))
      const callerUdxId = f.payload.readUInt32BE(32)
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
        send(OP_INC_READY, f.id, b4a.concat([b4a.from([1]), u32(udxId)]))
        rawB = null
      } catch { rawB?.destroy(); send(OP_INC_READY, f.id, b4a.alloc(5)) }
    })
    try { await g.rpc.request(OP_HELLO, OP_HELLO, b4a.from('endpoint'), 4000) } catch { conn.destroy(); return null }
    conn.once('close', () => {
      for (const s of [...g.streamsByUdxId.values()]) s.destroy()
      g.streamsByUdxId.clear()
      const i = guards.indexOf(g); if (i !== -1) guards.splice(i, 1)
      if (!closing && !suspended) {
        if (guards.length < 2) state = 'BOOTSTRAPPING'
        pollAll().catch(() => {})
      }
    })
    return g
  }

  async function discoverGuards () {
    for (let i = guards.length - 1; i >= 0; i--) if (guards[i].rpc.isClosed()) guards.splice(i, 1)
    if (guards.length >= 2) return true
    const candidates = new Map()
    await Promise.allSettled(GUARD_TOPICS.map(async t => {
      const q = transportDht.lookup(t), qt = setTimeout(() => q.destroy(), 4000); qt.unref?.()
      try { for await (const rep of q) for (const p of rep.peers) if (p?.publicKey && !guards.some(g => g.hex === b4a.toString(p.publicKey, 'hex'))) candidates.set(b4a.toString(p.publicKey, 'hex'), p.publicKey) } catch {} finally { clearTimeout(qt) }
    }))
    const list = [...candidates.values()]
    for (let i = list.length - 1; i > 0; i--) { const j = rand(4).readUInt32BE(0) % (i + 1); [list[i], list[j]] = [list[j], list[i]] }
    const used = new Set(guards.map(g => g.bucket))
    for (const pk of list) {
      if (guards.length >= 2 || closing || suspended) break
      const g = await connectCandidateGuard(pk)
      if (!g) continue
      if (used.has(g.bucket)) { g.conn.destroy(); continue }
      used.add(g.bucket); guards.push(g)
    }
    return guards.length >= 2
  }

  async function publishPresence () {
    if (closing || suspended || guards.length < 2) return false
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
      const ack = await primary.rpc.request(OP_REGISTER, OP_REGISTER_ACK, b4a.concat([routeToken, u32(ROUTE_TTL_MS)]), 5000)
      if (!ack[0]) throw new Error('Guard rejected route')
      const seq = cardSeq++
      const candidateCardBytes = encodeSignedCard({ innerKeyPair: keyPair, guardPublicKey: primary.publicKey, routeToken, seq, expiresAt: now + ROUTE_TTL_MS })
      const sealedPeer = sealBox(candidateCardBytes, sha256('peartube/private-peer-seal/v1/', keyPair.publicKey))
      const mutSig = signDhtMutable(seq, sealedPeer, keyPair.secretKey)
      const mutAck = await primary.rpc.request(OP_PUT_MUTABLE, OP_PUT_MUTABLE_ACK, b4a.concat([keyPair.publicKey, u32(seq), mutSig, sealedPeer]), 8000)
      if (!mutAck.byteLength || mutAck[0] !== 1) throw new Error('Guard failed to publish mutable card')
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
      const ok = await primary.rpc.request(OP_RV_REGISTER, OP_RV_REGISTER_ACK, b4a.concat([rvTopic, src.slotId, u32(ROUTE_TTL_MS), sealedCard]), 6000).then(r => Boolean(r[0]), () => false)
      if (ok) {
        src.lastEpoch = epoch; src.lastGuard = primary; src.lastTokenHex = tokHex
        src.nextRvRenewalAt = now + Math.floor(ROUTE_TTL_MS / 2)
      }
    }
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

  async function dialCard (card) {
    if (closing || suspended) return
    const hex = b4a.toString(card.innerPublicKey, 'hex')
    if (b4a.equals(card.innerPublicKey, keyPair.publicKey) || activeByPeer.has(hex) || dialingPeers.has(hex) || firewall(card.innerPublicKey)) return
    if (guards.length < 2 && !(await ensureGuardsAndPublish())) return
    const candidates = guards.filter(g => !g.rpc.isClosed() && !b4a.equals(g.publicKey, card.guardPublicKey))
    if (!candidates.length) return
    dialingPeers.add(hex)
    try {
      for (const sourceGuard of candidates) {
        let rawA = null
        try {
          rawA = allocRawStream(transportDht, sourceGuard.conn, true)
          const rep = await sourceGuard.rpc.request(
            OP_DIAL_OPEN,
            OP_DIAL_READY,
            b4a.concat([card.guardPublicKey, card.routeToken, u32(rawA.id), b4a.from(sourceGuard.bucket)]),
            10_000
          )
          if (rep.byteLength !== 5 || rep[0] !== 1) {
            rawA.destroy()
            if (rep[0] === 2) continue
            return
          }
          HyperDHT.connectRawStream(sourceGuard.conn, rawA, rep.readUInt32BE(1))
          const streamA = rawA, udxId = streamA.id
          const enc = new NoiseSecretStream(true, streamA, { keyPair, remotePublicKey: card.innerPublicKey, keepAlive: 2500 })
          enc.setTimeout(8000)
          sourceGuard.streamsByUdxId.set(udxId, enc)
          enc.once('close', () => { sourceGuard.streamsByUdxId.delete(udxId); if (!streamA.destroyed) streamA.destroy() })
          admitInnerStream(enc, card.innerPublicKey)
          rawA = null
          return
        } catch { rawA?.destroy() }
      }
    } finally { dialingPeers.delete(hex) }
  }

  async function lookupAndDialPeer (pk) {
    const hex = b4a.toString(pk, 'hex')
    if (closing || suspended || activeByPeer.has(hex) || dialingPeers.has(hex)) return
    if (guards.length < 2 && !(await ensureGuardsAndPublish())) return
    const g = guards[0]; if (!g || g.rpc.isClosed()) return
    try {
      const rep = await g.rpc.request(OP_GET_MUTABLE, OP_GET_MUTABLE_REPLY, pk, 6000)
      if (rep.byteLength <= 69 || rep[0] !== 1) return
      const seq = rep.readUInt32BE(1), sig = rep.subarray(5, 69), val = rep.subarray(69)
      if (!verifyDhtMutable(sig, seq, val, pk)) return
      const plain = openBox(val, sha256('peartube/private-peer-seal/v1/', pk))
      const card = plain && decodeAndVerifyCard(plain, Date.now(), pk)
      if (card && acceptValidCard(card)) await dialCard(card)
    } catch {}
  }

  async function refreshSourceDiscovery (src) {
    if (closing || suspended || (guards.length < 2 && !(await ensureGuardsAndPublish()))) return
    const g = guards[0]; if (!g || g.rpc.isClosed()) return
    const epNow = Math.floor(Date.now() / RV_EPOCH_MS), sealKey = sha256('peartube/private-rv-seal/v1/', src.sourceKeyBuf)
    for (const ep of [String(epNow), String(epNow - 1)]) {
      try {
        const raw = await g.rpc.request(OP_RV_LOOKUP, OP_RV_LOOKUP_REPLY, sha256('peartube/private-rv/v1/', src.sourceKeyBuf, ep), 6000)
        const now = Date.now()
        for (const s of c.decode(bufArrEnc, raw)) {
          const plain = openBox(s, sealKey), card = plain && decodeAndVerifyCard(plain, now, null)
          if (card && acceptValidCard(card)) dialCard(card).catch(() => {})
        }
      } catch {}
    }
  }

  async function pollAll () {
    if (closing || suspended) return
    await ensureGuardsAndPublish()
    if (guards.length < 2) return
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
        guards: guards.length,
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
      if (src.lastGuard && !src.lastGuard.rpc.isClosed() && src.lastEpoch) {
        src.lastGuard.rpc.send(OP_RV_UNREGISTER, 0, b4a.concat([sha256('peartube/private-rv/v1/', src.sourceKeyBuf, src.lastEpoch), src.slotId]))
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
  conn.on('error', () => {}); conn.setKeepAlive(5000); await conn.opened
  const routeToken = rand(32)
  const rpc = attachRpcChannel(conn, async (f, send) => {
    if (f.op !== OP_INC_OPEN || f.payload.byteLength !== 36) return
    let raw = null
    try {
      raw = allocRawStream(dht, conn, true)
      HyperDHT.connectRawStream(conn, raw, f.payload.readUInt32BE(32))
      const stream = raw
      const enc = new NoiseSecretStream(false, stream, { keyPair: responderKeyPair, keepAlive: 5000 })
      enc.on('error', () => {}); enc.once('close', () => { if (!stream.destroyed) stream.destroy() })
      enc.opened.then(ok => { if (ok && !enc.destroyed) onInnerConnection?.(enc); else enc.destroy() }).catch(() => enc.destroy())
      send(OP_INC_READY, f.id, b4a.concat([b4a.from([1]), u32(stream.id)])); raw = null
    } catch { raw?.destroy(); send(OP_INC_READY, f.id, b4a.alloc(5)) }
  })
  await rpc.request(OP_HELLO, OP_HELLO, b4a.from('endpoint'), 4000)
  await rpc.request(OP_REGISTER, OP_REGISTER_ACK, b4a.concat([routeToken, u32(ROUTE_TTL_MS)]), 4000)
  const seq = 1
  const card = encodeSignedCard({ innerKeyPair: advertisedKeyPair, guardPublicKey, routeToken, seq, expiresAt: Date.now() + ROUTE_TTL_MS })
  const sealed = sealBox(card, sha256('peartube/private-peer-seal/v1/', advertisedKeyPair.publicKey))
  await rpc.request(OP_PUT_MUTABLE, OP_PUT_MUTABLE_ACK, b4a.concat([advertisedKeyPair.publicKey, u32(seq), signDhtMutable(seq, sealed, advertisedKeyPair.secretKey), sealed]), 6000)
  return async () => { conn.destroy(); await dht.destroy({ force: true }) }
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

    // 1. Endpoint session attempting forbidden OP_HOP_OPEN directly on destination Guard:
    let endpointBypassAccepted = false
    const c1 = dht.connect(card.guardPublicKey, { keyPair: HyperDHT.keyPair(rand(32)) })
    c1.on('error', () => {}); await c1.opened
    const rpc1 = attachRpcChannel(c1, null)
    await rpc1.request(OP_HELLO, OP_HELLO, b4a.from('endpoint'), 3000)
    const raw1 = allocRawStream(dht, c1, true)
    const rep1 = await rpc1.request(OP_HOP_OPEN, OP_HOP_READY, b4a.concat([card.routeToken, u32(raw1.id)]), 3000)
    if (rep1.byteLength === 5 && rep1[0] === 1) endpointBypassAccepted = true
    raw1.destroy(); c1.destroy()

    // 2. Unadvertised keypair claiming 'hop' role directly on destination Guard:
    let spoofedHopAccepted = false
    const c2 = dht.connect(card.guardPublicKey, { keyPair: HyperDHT.keyPair(rand(32)) })
    c2.on('error', () => {}); await c2.opened
    const rpc2 = attachRpcChannel(c2, null)
    try {
      await rpc2.request(OP_HELLO, OP_HELLO, b4a.from('hop'), 3000)
      const raw2 = allocRawStream(dht, c2, true)
      const rep2 = await rpc2.request(OP_HOP_OPEN, OP_HOP_READY, b4a.concat([card.routeToken, u32(raw2.id)]), 3000)
      if (rep2.byteLength === 5 && rep2[0] === 1) spoofedHopAccepted = true
      raw2.destroy()
    } catch {}
    c2.destroy()

    return { endpointBypassAccepted, spoofedHopAccepted }
  } finally {
    await dht.destroy({ force: true })
  }
}
