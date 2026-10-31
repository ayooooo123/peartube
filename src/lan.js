import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { isIPv4 } from 'node:net'
import HyperDHT from 'hyperdht'
import { Bonjour } from 'bonjour-service'
import b4a from 'b4a'

const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/
const SERVICE_TYPE = 'hyperdht-mdns'
const SERVICE_PROTOCOL = 'udp'
const TOPIC_PREFIX = b4a.from('hyperdht-mdns:')
const TOPICS_PER_TXT = 5
const MAX_SHARD_TOPICS = 32
const MAX_TXT_BYTES = 900
const SOCKET_BUFS = [8388608, 4194304, 2097152]

// Stretches UDX kernel socket buffers wide so 512 KiB LAN bursts never gag on Android's 208 KiB rmem_default.
export function tuneUdxSocket (sock) {
  if (!sock || sock._peartubeTuned || sock.closing) return
  sock._peartubeTuned = true
  for (const sz of SOCKET_BUFS) {
    try { sock.setRecvBufferSize?.(sz); break } catch {}
  }
  for (const sz of SOCKET_BUFS) {
    try { sock.setSendBufferSize?.(sz); break } catch {}
  }
}

function toBase64Url (buf) {
  return b4a.toString(buf, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function topicToken (topic) {
  return toBase64Url(createHash('sha256').update(TOPIC_PREFIX).update(topic).digest())
}

function txtStr (v) {
  if (b4a.isBuffer(v)) return b4a.toString(v)
  return typeof v === 'string' || typeof v === 'number' ? String(v) : ''
}

function buildTxt (peerKeyHex, port, tokens) {
  const txt = { v: '1', peerKey: peerKeyHex, port: String(port), tc: String(tokens.length) }
  for (let i = 0; i < tokens.length; i += TOPICS_PER_TXT) {
    txt[`t${i / TOPICS_PER_TXT}`] = tokens.slice(i, i + TOPICS_PER_TXT).join(',')
  }
  return txt
}

function encodedTxtBytes (txt) {
  let sum = 0
  for (const [k, v] of Object.entries(txt)) sum += b4a.byteLength(k) + b4a.byteLength(String(v)) + 2
  return sum
}

// Three random characters in every advertisement's name. bonjour-service does not throw when a name is taken: it
// logs "Service name is already in use" and silently stops the advertisement. A name used once (by this or an earlier
// run) can still be answered for by a cache or a reflector, so no advertisement ever reuses one.
const adNonce = () => Math.random().toString(36).slice(2, 5).padEnd(3, '0')

function createRecords (peerKeyHex, port, tokens, nonce = adNonce()) {
  const sorted = tokens.slice().sort()
  const shards = []
  if (sorted.length === 0) {
    shards.push([])
  } else {
    let cur = []
    for (const tok of sorted) {
      const next = [...cur, tok]
      if (next.length > MAX_SHARD_TOPICS || encodedTxtBytes(buildTxt(peerKeyHex, port, next)) > MAX_TXT_BYTES) {
        shards.push(cur)
        cur = [tok]
      } else {
        cur = next
      }
    }
    shards.push(cur)
  }
  const genHash = createHash('sha256')
  for (const tok of sorted) genHash.update(tok).update('\0')
  const gen = (toBase64Url(genHash.digest()).slice(0, 8) + nonce).slice(0, 11)
  return shards.map((shard, idx) => ({
    name: `hyperdht-mdns-${peerKeyHex.slice(0, 12)}-${gen}-${idx}-${shards.length}`,
    type: SERVICE_TYPE,
    protocol: SERVICE_PROTOCOL,
    port,
    txt: buildTxt(peerKeyHex, port, shard)
  }))
}

function parseRecord (service) {
  const txt = service?.txt
  if (!txt || txtStr(txt.v) !== '1') return null
  const peerKeyHex = txtStr(txt.peerKey).toLowerCase()
  const port = Number(service.port || txtStr(txt.port))
  const tc = Number(txtStr(txt.tc) || 0)
  if (!/^[0-9a-f]{64}$/.test(peerKeyHex)) return null
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  if (!Number.isInteger(tc) || tc < 0 || tc > MAX_SHARD_TOPICS) return null
  const tokens = []
  for (let i = 0; tokens.length < tc; i++) {
    const chunk = txtStr(txt[`t${i}`])
    if (!chunk) return null
    tokens.push(...chunk.split(','))
  }
  if (tokens.length !== tc || tokens.some(t => !/^[A-Za-z0-9_-]{43}$/.test(t))) return null
  let generation = null
  let shard = 0
  const prefix = `hyperdht-mdns-${peerKeyHex.slice(0, 12)}-`
  if (typeof service.name === 'string' && service.name.startsWith(prefix)) {
    const m = /^([A-Za-z0-9_-]{11})-(\d+)-(\d+)$/.exec(service.name.slice(prefix.length))
    if (m) {
      generation = m[1]
      shard = Number(m[2])
    }
  }
  return { peerKeyHex, peerKey: b4a.from(peerKeyHex, 'hex'), port, tokens, generation, shard }
}

function serviceIPv4 (service) {
  if (Array.isArray(service?.addresses)) {
    const addr = service.addresses.find(a => typeof a === 'string' && isIPv4(a))
    if (addr) return addr
  }
  const ref = service?.referer?.address
  return typeof ref === 'string' && isIPv4(ref) ? ref : null
}

// Refcounted bonjour-service wrapper so overlapping rebrowses share one open multicast socket.
export class BonjourAdapter {
  constructor ({ bonjour = null, createBonjour = onError => new Bonjour(undefined, onError) } = {}) {
    this._bonjour = bonjour
    this._owns = !bonjour
    this._create = createBonjour
    this._refs = 0
    this._errors = new Map()
  }

  advertise (record, handlers = {}) {
    const bonjour = this._acquire(handlers.onError)
    let svc
    try {
      svc = bonjour.publish(record)
    } catch (err) {
      this._release(handlers.onError)
      throw err
    }
    let stopped = false
    return {
      stop: async () => {
        if (stopped) return
        stopped = true
        try {
          await new Promise(resolve => svc.stop(resolve))
        } finally {
          this._release(handlers.onError)
        }
      }
    }
  }

  browse (query, handlers = {}) {
    const bonjour = this._acquire(handlers.onError)
    let browser
    try {
      browser = bonjour.find(query)
    } catch (err) {
      this._release(handlers.onError)
      throw err
    }
    const onUp = handlers.onService || (() => {})
    const onDown = handlers.onServiceDown || (() => {})
    browser.on('up', onUp)
    browser.on('down', onDown)
    let stopped = false
    return {
      stop: async () => {
        if (stopped) return
        stopped = true
        browser.removeListener('up', onUp)
        browser.removeListener('down', onDown)
        browser.stop()
        this._release(handlers.onError)
      }
    }
  }

  _acquire (onError) {
    if (typeof onError === 'function') this._errors.set(onError, (this._errors.get(onError) || 0) + 1)
    this._refs++
    if (!this._bonjour) {
      this._bonjour = this._create(err => {
        for (const fn of this._errors.keys()) fn(err)
      })
    }
    return this._bonjour
  }

  _release (onError) {
    if (typeof onError === 'function') {
      const n = this._errors.get(onError) || 0
      if (n <= 1) this._errors.delete(onError)
      else this._errors.set(onError, n - 1)
    }
    if (this._refs > 0) this._refs--
    if (this._refs === 0 && this._owns && this._bonjour) {
      this._bonjour.destroy()
      this._bonjour = null
    }
  }
}

// Picks the first private IPv4 on Wi-Fi (wlan*), else Ethernet (en*/eth*), ignoring VPN/cellular tunnels.
export function lanAddress (interfaces) {
  const names = Object.keys(interfaces).filter(name => /^(wl|en|eth)/.test(name))
  for (const name of names.sort((a, b) => b.startsWith('wl') - a.startsWith('wl'))) {
    for (const { family, address, internal } of interfaces[name]) {
      if ((family === 'IPv4' || family === 4) && !internal && PRIVATE.test(address)) return address
    }
  }
  return null
}

// Stamps our real LAN address into TXT `h` so peers dial us directly instead of an mDNS reflector,
// and restarts browse every `rebrowse` ms while keeping the shared multicast socket open.
export function selfAddressAdapter (host, inner = new BonjourAdapter(), { rebrowse = 10_000 } = {}) {
  return {
    advertise (record, handlers) {
      return inner.advertise({ ...record, txt: { ...record.txt, h: host } }, handlers)
    },
    browse (query, handlers) {
      const onService = service => {
        const h = txtStr(service?.txt?.h)
        handlers.onService(isIPv4(h) ? { ...service, referer: null, addresses: [h] } : service)
      }
      const wrapped = { ...handlers, onService }
      let current = inner.browse(query, wrapped)
      const timer = setInterval(async () => {
        try {
          const previous = current
          current = inner.browse(query, wrapped)
          await (await previous).stop()
        } catch (err) {
          handlers.onError?.(err)
        }
      }, rebrowse)
      timer.unref?.()
      return {
        async stop () {
          clearInterval(timer)
          await (await current).stop()
        }
      }
    }
  }
}

export function interfaceAdapter (host) {
  const createBonjour = onError => new Bonjour({ interface: host, bind: '0.0.0.0' }, onError)
  return selfAddressAdapter(host, new BonjourAdapter({ createBonjour }))
}

// Zero-dependency LAN discovery directly over an isolated ephemeral HyperDHT + mDNS:
// smaller public key dials first; if blocked one-way by a host firewall, the larger key dials after `dialAfter` ms.
class LanDiscovery extends EventEmitter {
  constructor ({ host, port = 0, keyPair, adapter, dialAfter = 3000 }) {
    super()
    this.host = host
    this.port = port
    this.keyPair = keyPair || HyperDHT.keyPair()
    this.peerKeyHex = b4a.toString(this.keyPair.publicKey, 'hex')
    this.adapter = adapter
    this.dialAfter = dialAfter
    this.destroyed = false
    this.suspended = false
    this.connections = new Set()
    this.dht = new HyperDHT({ host, port: port ? [port, port + 1] : [0, 0], bootstrap: [], ephemeral: false, firewalled: false, anyPort: !port, keyPair: this.keyPair })
    this.server = null
    this._ready = false
    this._topics = new Map()
    this._peerShards = new Map()
    this._peers = new Map()
    this._active = new Map()
    this._directPeers = new Set()
    this._pending = new Map()
    this._timers = new Map()
    this._ads = []
    this._adSig = ''
    this._adQueue = Promise.resolve()
    this._browse = null
    this._opening = this._open()
  }

  async _open () {
    await this.dht.fullyBootstrapped()
    if (this.destroyed) return
    tuneUdxSocket(this.dht.io?.serverSocket)
    tuneUdxSocket(this.dht.io?.clientSocket)
    this.server = this.dht.createServer(conn => this._onIncoming(conn))
    await this.server.listen(this.keyPair)
    if (this.destroyed) return
    const addr = this.dht.address() || this.dht.localAddress()
    if (addr?.port) this.port = addr.port
    this._browse = await this.adapter.browse(
      { type: SERVICE_TYPE, protocol: SERVICE_PROTOCOL },
      {
        onService: s => this._onService(s),
        onServiceDown: s => this._onServiceDown(s),
        onError: err => this.emit('error', err)
      }
    )
    if (this.destroyed) {
      await this._browse?.stop?.().catch(() => {})
      return
    }
    this._ready = true
    await this._syncAds()
  }

  ready () {
    return this._opening
  }

  join (topic) {
    const buf = b4a.from(topic)
    const hex = b4a.toString(buf, 'hex')
    if (!this._topics.has(hex)) {
      this._topics.set(hex, topicToken(buf))
      this._queueAds()
      for (const peer of this._peers.values()) this._consider(peer)
    }
    return { topic: buf, destroy: () => this.leave(buf) }
  }

  leave (topic) {
    const hex = b4a.toString(b4a.from(topic), 'hex')
    if (!this._topics.delete(hex)) return
    this._queueAds()
    for (const peer of this._peers.values()) {
      if (!this._sharesTopic(peer.tokens)) this._clearPeerDial(peer.id)
    }
  }

  _queueAds () {
    if (!this._ready || this.destroyed) return
    this._adQueue = this._adQueue.then(() => this._syncAds()).catch(err => this.emit('error', err))
  }

  async _syncAds () {
    if (!this._ready || this.destroyed || this.suspended) return
    const tokens = [...this._topics.values()]
    // The signature leaves out the name, so only a change of port or topics re-advertises (under a fresh name).
    const sig = JSON.stringify([this.port, createRecords(this.peerKeyHex, this.port, tokens, '').map(r => r.txt)])
    if (sig === this._adSig) return
    const records = createRecords(this.peerKeyHex, this.port, tokens)
    const prev = this._ads
    const next = []
    try {
      for (const rec of records) next.push(await this.adapter.advertise(rec, { onError: err => this.emit('error', err) }))
    } catch (err) {
      await Promise.allSettled(next.map(h => h?.stop?.()))
      throw err
    }
    if (this.destroyed) {
      await Promise.allSettled(next.map(h => h?.stop?.()))
      return
    }
    this._ads = next
    this._adSig = sig
    await Promise.allSettled(prev.map(h => h?.stop?.()))
  }

  _sharesTopic (tokens) {
    if (!tokens.length || !this._topics.size) return false
    const local = new Set(this._topics.values())
    return tokens.some(t => local.has(t))
  }

  _onService (service) {
    if (this.destroyed || this.suspended) return
    const rec = parseRecord(service)
    const host = serviceIPv4(service)
    if (!rec || !host || rec.peerKeyHex === this.peerKeyHex) return
    const id = rec.peerKeyHex
    let state = this._peerShards.get(id)
    if (!state || state.generation !== rec.generation) {
      state = { generation: rec.generation, shards: new Map() }
      this._peerShards.set(id, state)
    }
    state.shards.set(rec.shard, rec.tokens)
    const tokens = [...new Set([...state.shards.values()].flat())]
    const peer = { id, publicKey: rec.peerKey, host, port: rec.port, tokens }
    this._peers.set(id, peer)
    this._consider(peer)
  }

  _onServiceDown (service) {
    const rec = parseRecord(service)
    if (!rec || rec.peerKeyHex === this.peerKeyHex) return
    const id = rec.peerKeyHex
    this._peerShards.delete(id)
    this._peers.delete(id)
    this._clearPeerDial(id)
  }

  _clearPeerDial (id) {
    const timer = this._timers.get(id)
    if (timer) {
      clearTimeout(timer)
      this._timers.delete(id)
    }
    const pending = this._pending.get(id)
    if (pending) {
      this._pending.delete(id)
      pending.socket.destroy()
    }
  }

  _consider (peer) {
    if (this.destroyed || this.suspended) return
    if (!this._sharesTopic(peer.tokens)) {
      this._clearPeerDial(peer.id)
      return
    }
    const open = this._active.get(peer.id)
    if (open && !open.destroyed) return
    const pending = this._pending.get(peer.id)
    if (pending) {
      if (pending.host === peer.host && pending.port === peer.port) return
      this._pending.delete(peer.id)
      pending.socket.destroy()
    }
    if (b4a.compare(this.keyPair.publicKey, peer.publicKey) < 0) {
      this._dial(peer)
    } else if (!this._timers.has(peer.id)) {
      const t = setTimeout(() => {
        this._timers.delete(peer.id)
        const latest = this._peers.get(peer.id)
        if (!latest || this.destroyed || this.suspended || !this._sharesTopic(latest.tokens)) return
        const cur = this._active.get(peer.id)
        if ((cur && !cur.destroyed) || this._pending.has(peer.id)) return
        this._dial(latest)
      }, this.dialAfter)
      t.unref?.()
      this._timers.set(peer.id, t)
    }
  }

  stats () {
    return { peers: this._peers.size, connections: this.connections.size, topics: this._topics.size, direct: this._directPeers.size }
  }

  // Mounts a known LAN peer straight by IP:port when Wi-Fi multicast gags on mDNS.
  dialDirect (publicKey, host, port) {
    if (this.destroyed || this.suspended || !isIPv4(String(host || '')) || !(port > 0)) return
    const pubBuf = typeof publicKey === 'string' ? b4a.from(publicKey, 'hex') : publicKey
    if (!pubBuf || pubBuf.byteLength !== 32) return
    const id = b4a.toString(pubBuf, 'hex')
    if (id === this.peerKeyHex) return
    this._directPeers.add(id)
    const open = this._active.get(id)
    if ((open && !open.destroyed) || this._pending.has(id)) return
    this._dial({ id, publicKey: pubBuf, host, port: Number(port), tokens: [] })
  }

  _dial (peer) {
    // `connect` takes close DHT `nodes` to reach the peer (announce's `relayAddresses` is a different
    // thing, for nodes that forward to us). Passing both keeps older behaviour and adds the documented path.
    const address = { host: peer.host, port: peer.port }
    const socket = this.dht.connect(peer.publicKey, { keyPair: this.keyPair, nodes: [address], relayAddresses: [address] })
    const entry = { socket, host: peer.host, port: peer.port }
    this._pending.set(peer.id, entry)
    socket.on('error', () => {})
    socket.once('open', () => {
      if (this._pending.get(peer.id) === entry) this._pending.delete(peer.id)
      if (this.destroyed) {
        socket.destroy()
        return
      }
      this._acceptSocket(peer.id, socket)
    })
    socket.once('close', () => {
      if (this._pending.get(peer.id) === entry) this._pending.delete(peer.id)
      this._onSocketClosed(peer.id, socket)
    })
  }

  _onIncoming (socket) {
    socket.on('error', () => {})
    const pub = socket.remotePublicKey
    if (this.destroyed || !pub) {
      socket.destroy()
      return
    }
    const id = b4a.toString(pub, 'hex')
    if (!this._topics.size && !this._directPeers.has(id)) {
      socket.destroy()
      return
    }
    const peer = this._peers.get(id)
    if (peer && !this._directPeers.has(id) && !this._sharesTopic(peer.tokens)) {
      socket.destroy()
      return
    }
    this._acceptSocket(id, socket)
  }

  _acceptSocket (id, socket) {
    const timer = this._timers.get(id)
    if (timer) {
      clearTimeout(timer)
      this._timers.delete(id)
    }
    const pending = this._pending.get(id)
    if (pending && pending.socket !== socket) {
      this._pending.delete(id)
      pending.socket.destroy()
    }
    const existing = this._active.get(id)
    if (existing && existing !== socket && !existing.destroyed) {
      socket.destroy()
      return
    }
    tuneUdxSocket(socket.rawStream?.socket)
    this._active.set(id, socket)
    this.connections.add(socket)
    socket.once('close', () => this._onSocketClosed(id, socket))
    this.emit('connection', socket, { publicKey: socket.remotePublicKey, lan: true })
  }

  _onSocketClosed (id, socket) {
    this.connections.delete(socket)
    if (this._active.get(id) === socket) this._active.delete(id)
    if (this.destroyed || this.suspended) return
    const peer = this._peers.get(id)
    if (!peer || !this._sharesTopic(peer.tokens) || this._timers.has(id)) return
    const wait = b4a.compare(this.keyPair.publicKey, peer.publicKey) < 0 ? 500 : this.dialAfter
    const t = setTimeout(() => {
      this._timers.delete(id)
      const latest = this._peers.get(id)
      if (latest && !this.destroyed && !this.suspended) this._consider(latest)
    }, wait)
    t.unref?.()
    this._timers.set(id, t)
  }

  async destroy () {
    if (this.destroyed) return
    this.destroyed = true
    for (const t of this._timers.values()) clearTimeout(t)
    this._timers.clear()
    for (const p of this._pending.values()) p.socket.destroy()
    this._pending.clear()
    for (const s of this.connections) s.destroy()
    this.connections.clear()
    this._active.clear()
    await this._opening.catch(() => {})
    await Promise.allSettled([
      this._browse?.stop?.(),
      ...this._ads.map(h => h?.stop?.())
    ])
    this._ads = []
    await this.server?.close().catch(() => {})
    await this.dht.destroy({ force: true }).catch(() => {})
  }
}

export function createLan ({ host, port = 0, keyPair, adapter = selfAddressAdapter(host), dialAfter = 3000 }) {
  const lan = new LanDiscovery({ host, port, keyPair, adapter, dialAfter })
  lan.on('error', err => console.error(JSON.stringify({ msg: 'lan discovery error', error: err?.message || String(err) })))
  return lan
}
