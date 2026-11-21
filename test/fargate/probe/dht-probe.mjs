import { createHash } from 'node:crypto'
import DHT from 'hyperdht'
import Hyperswarm from 'hyperswarm'

const MIB = 1024 * 1024
const short = key => Buffer.from(key).toString('hex').slice(0, 8)
const hexKey = value => typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)

function waitForStream (socket, event, ms) {
  if (socket.destroyed) return Promise.reject(new Error('STREAM_CLOSED'))
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      socket.off(event, onEvent)
      socket.off('close', onClose)
      socket.off('error', onError)
    }
    const onEvent = () => { cleanup(); resolve() }
    const onClose = () => { cleanup(); reject(new Error('STREAM_CLOSED')) }
    const onError = err => { cleanup(); reject(err) }
    const timer = setTimeout(() => { cleanup(); reject(new Error('STREAM_TIMEOUT')) }, ms)
    socket.once(event, onEvent)
    socket.once('close', onClose)
    socket.once('error', onError)
  })
}

class Protocol {
  constructor (socket, onHello) {
    this.socket = socket
    this.onHello = onHello
    this.line = Buffer.alloc(0)
    this.remaining = 0
    this.received = 0
    this.nextAck = MIB
    this.sequence = 0
    this.waiters = new Map()
    this.acks = []
    this.ackWaiters = []
    socket.on('data', chunk => this.receive(chunk))
    socket.on('error', () => {})
    socket.on('close', () => this.fail(new Error('STREAM_CLOSED')))
  }

  send (message) {
    this.socket.write(Buffer.from(JSON.stringify(message) + '\n'))
  }

  fail (err) {
    for (const pending of this.waiters.values()) pending.reject(err)
    this.waiters.clear()
    for (const pending of this.ackWaiters.splice(0)) pending.reject(err)
  }

  receive (chunk) {
    let offset = 0
    while (offset < chunk.length) {
      if (this.remaining > 0) {
        const consumed = Math.min(this.remaining, chunk.length - offset, this.nextAck - this.received)
        this.remaining -= consumed
        this.received += consumed
        offset += consumed
        if (this.received === this.nextAck) {
          this.send({ t: 'ack', bytes: this.received })
          this.nextAck += MIB
        }
        continue
      }
      const newline = chunk.indexOf(10, offset)
      if (newline === -1) {
        this.line = Buffer.concat([this.line, chunk.subarray(offset)])
        if (this.line.length > 16384) this.socket.destroy()
        break
      }
      const line = Buffer.concat([this.line, chunk.subarray(offset, newline)])
      this.line = Buffer.alloc(0)
      offset = newline + 1
      let message
      try { message = JSON.parse(line.toString()) } catch { this.socket.destroy(); return }
      if (!message || typeof message !== 'object') { this.socket.destroy(); return }
      if (message.t === 'hello' || message.t === 'gossip') this.onHello(message)
      else if (message.t === 'xfer') {
        if (!Number.isSafeInteger(message.bytes) || message.bytes < 1 || message.bytes > 16 * MIB) { this.socket.destroy(); return }
        this.remaining = message.bytes
        this.received = 0
        this.nextAck = MIB
      } else if (message.t === 'ack') {
        const waiter = this.ackWaiters.shift()
        if (waiter) waiter.resolve(message.bytes)
        else this.acks.push(message.bytes)
      } else if (message.t === 'ping') this.send({ t: 'pong', id: message.id, ts: message.ts })
      else if (message.t === 'pong') {
        const waiter = this.waiters.get(message.id)
        if (waiter) { this.waiters.delete(message.id); waiter.resolve() }
      }
    }
  }

  wait (list, ms = 30000) {
    return new Promise((resolve, reject) => {
      const item = { resolve: value => { clearTimeout(timer); resolve(value) }, reject: err => { clearTimeout(timer); reject(err) } }
      const timer = setTimeout(() => {
        const index = list.indexOf(item)
        if (index !== -1) list.splice(index, 1)
        reject(new Error('PROTOCOL_TIMEOUT'))
      }, ms)
      list.push(item)
    })
  }

  async ping () {
    const id = ++this.sequence
    const start = performance.now()
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(id); reject(new Error('PING_TIMEOUT')) }, 15000)
      this.waiters.set(id, {
        resolve: () => { clearTimeout(timer); resolve() },
        reject: err => { clearTimeout(timer); reject(err) }
      })
    })
    this.send({ t: 'ping', id, ts: Date.now() })
    await response
    return performance.now() - start
  }

  async ack () {
    if (this.acks.length) return this.acks.shift()
    if (this.socket.destroyed) throw new Error('STREAM_CLOSED')
    return this.wait(this.ackWaiters)
  }

  async write (bytes) {
    if (this.socket.destroyed) throw new Error('STREAM_CLOSED')
    if (!this.socket.write(bytes)) await waitForStream(this.socket, 'drain', 30000)
  }

  async transfer () {
    const chunk = Buffer.alloc(64 * 1024)
    this.send({ t: 'xfer', bytes: 16 * MIB })
    const start = performance.now()
    for (let m = 1; m <= 16; m++) {
      for (let i = 0; i < 16; i++) await this.write(chunk)
      if (await this.ack() !== m * MIB) throw new Error('BAD_ACK')
    }
    return performance.now() - start
  }
}

async function meanRtt (protocol) {
  let sum = 0
  for (let i = 0; i < 10; i++) sum += await protocol.ping()
  return sum / 10
}

export function startConnectivity ({ role, topicSeed, relayKeys, onEvent, bootstrap }) {
  const dht = bootstrap ? new DHT({ bootstrap }) : new DHT()
  const swarm = new Hyperswarm({ dht })
  const testPair = DHT.keyPair()
  const server = dht.createServer()
  const knownRelays = new Map()
  const controls = new Map()
  const direct = new Map()
  const tests = new Map()
  const incoming = new Set()
  let closed = false
  dht.on('error', err => { if (!closed) onEvent('error', { where: 'probe-dht', message: err.message }) })

  function keys () { return [...knownRelays.values()] }
  function relayAddress (key) {
    const control = controls.get(Buffer.from(key).toString('hex'))
    const raw = control?.open && control.socket.rawStream
    return raw?.remoteHost ? { host: raw.remoteHost, port: raw.remotePort } : null
  }
  // A relay forwards on a pooled UDX socket, not on the DHT socket the control connection uses, so only the
  // host can be compared; every Fargate task has its own public address, so the host identifies the relay.
  function throughRelay (socket, key) {
    const address = relayAddress(key)
    const raw = socket.rawStream
    return Boolean(address && raw && raw.remoteHost === address.host)
  }
  function hello () {
    return { t: 'hello', role, relayKeys: [...knownRelays.keys()], server: testPair.publicKey.toString('hex') }
  }
  function learn (items) {
    let changed = false
    if (!Array.isArray(items)) return
    for (const value of items) {
      if (!hexKey(value) || knownRelays.size >= 128) continue
      const hex = value.toLowerCase()
      if (!knownRelays.has(hex)) { knownRelays.set(hex, Buffer.from(hex, 'hex')); changed = true }
    }
    if (changed) {
      for (const item of direct.values()) item.protocol.send({ t: 'gossip', relayKeys: [...knownRelays.keys()] })
      maintain()
    }
  }
  learn(relayKeys.map(key => Buffer.from(key).toString('hex')))

  function accept (socket) {
    incoming.add(socket)
    const protocol = new Protocol(socket, message => learn(message.relayKeys))
    protocol.send(hello())
    socket.on('close', () => incoming.delete(socket))
  }
  server.on('connection', accept)
  server.on('error', err => { if (!closed) onEvent('error', { where: 'probe-server', message: err.message }) })
  server.listen(testPair).catch(err => { if (!closed) onEvent('error', { where: 'probe-listen', message: err.message }) })

  swarm.on('connection', (socket, info) => {
    const id = socket.remotePublicKey.toString('hex')
    const item = { socket, info, started: Date.now(), serverKey: null, protocol: null }
    item.protocol = new Protocol(socket, message => {
      learn(message.relayKeys)
      if (message.t === 'hello' && hexKey(message.server)) item.serverKey = Buffer.from(message.server, 'hex')
      maintain()
    })
    direct.set(id, item)
    item.protocol.send(hello())
    socket.on('close', () => { if (direct.get(id) === item) direct.delete(id) })
    maintain()
  })
  swarm.on('error', err => { if (!closed) onEvent('error', { where: 'probe-swarm', message: err.message }) })
  swarm.join(createHash('sha256').update('peartube-fargate-swarm/' + topicSeed).digest(), { server: true, client: true })

  function connectRelay (key) {
    const id = key.toString('hex')
    const socket = dht.connect(key, { keyPair: swarm.keyPair })
    const item = { socket, open: false }
    controls.set(id, item)
    const timeout = setTimeout(() => { if (!item.open) socket.destroy() }, 60000)
    socket.on('error', () => {})
    socket.on('open', () => { item.open = true; clearTimeout(timeout); maintain() })
    socket.on('close', () => {
      clearTimeout(timeout)
      if (controls.get(id) === item) controls.delete(id)
    })
  }

  async function runTest (relay, peer, result) {
    const started = Date.now()
    let socket
    try {
      socket = dht.connect(peer.serverKey, {
        keyPair: swarm.keyPair,
        relayThrough: relay,
        holepunch: () => false
      })
      result.socket = socket
      socket.on('error', () => {})
      await waitForStream(socket, 'open', 60000)
      result.pairMs = Date.now() - started
      result.remote = socket.rawStream?.remoteHost ? `${socket.rawStream.remoteHost}:${socket.rawStream.remotePort}` : null
      if (!throughRelay(socket, relay)) throw new Error('DIRECT_ROUTE')
      if (throughRelay(peer.socket, relay)) throw new Error('NO_DIRECT_BASELINE')
      socket.rawStream.on('remote-changed', () => {
        if (!throughRelay(socket, relay)) {
          result.ok = false
          result.err = 'DIRECT_ROUTE'
          socket.destroy()
        }
      })
      const protocol = new Protocol(socket, message => learn(message.relayKeys))
      result.protocol = protocol
      protocol.send(hello())
      result.directRttMs = await meanRtt(peer.protocol)
      result.rttMs = await meanRtt(protocol)
      result.ms = await protocol.transfer()
      if (!throughRelay(socket, relay)) throw new Error('DIRECT_ROUTE')
      result.bytes = 16 * MIB
      result.mbps = result.bytes * 8 / (result.ms * 1000)
      result.ok = true
      onEvent('relay-pair', { relay: short(relay), peer: short(peer.socket.remotePublicKey), pairMs: result.pairMs })
      const chunk = Buffer.alloc(64 * 1024)
      let sending = false
      result.timer = setInterval(async () => {
        if (socket.destroyed || sending) return
        sending = true
        try {
          protocol.send({ t: 'xfer', bytes: chunk.length })
          await protocol.write(chunk)
        } catch {
          socket.destroy()
        } finally {
          sending = false
        }
      }, 1000)
      socket.on('close', () => {
        clearInterval(result.timer)
        result.ok = false
        result.err ||= 'CLOSED'
        result.retryAt = Date.now() + 15000
      })
    } catch (err) {
      result.ok = false
      result.err ||= err.code || err.message
      result.retryAt = Date.now() + 15000
      socket?.destroy()
    }
  }

  function maintain () {
    if (closed) return
    for (const [id, relay] of knownRelays) {
      if (!controls.has(id)) connectRelay(relay)
      if (!relayAddress(relay)) continue
      const previous = tests.get(id)
      if (previous && (previous.ok || (!previous.err && previous.socket && !previous.socket.destroyed) || previous.retryAt > Date.now())) continue
      const peer = [...direct.values()].find(item => item.serverKey && !item.socket.destroyed)
      if (!peer) continue
      const result = {
        relay: short(relay), peer: short(peer.socket.remotePublicKey), pairMs: null,
        bytes: 0, ms: null, mbps: null, rttMs: null, directRttMs: null, ok: false, err: null
      }
      tests.set(id, result)
      runTest(relay, peer, result)
    }
  }
  const timer = setInterval(maintain, 5000)
  maintain()

  function sample () {
    const relayHosts = new Map()
    for (const [key, item] of controls) {
      const host = item.open && item.socket.rawStream?.remoteHost
      if (host) relayHosts.set(host, key.slice(0, 8))
    }
    const conns = [...direct.values()].map(item => {
      const raw = item.socket.rawStream
      const relay = relayHosts.get(raw?.remoteHost) || null
      return {
        peer: short(item.socket.remotePublicKey),
        remote: raw?.remoteHost ? `${raw.remoteHost}:${raw.remotePort}` : null,
        relayed: relay !== null, relay,
        dir: item.socket.isInitiator ? 'out' : 'in',
        rtt: raw?.rtt ?? null, ageMs: Date.now() - item.started
      }
    })
    const connects = swarm.stats.connects
    return {
      key: swarm.keyPair.publicKey.toString('hex'),
      nat: { firewalled: dht.firewalled, randomized: dht.randomized, host: dht.host || null, port: dht.port || 0 },
      connects: {
        client: { attempted: connects.client.attempted, opened: connects.client.opened },
        server: { attempted: connects.server.attempted ?? null, opened: connects.server.opened }
      },
      conns,
      relayTests: [...tests.values()].map(({ relay, peer, pairMs, bytes, ms, mbps, rttMs, directRttMs, ok, err, remote }) =>
        ({ relay, peer, pairMs, bytes, ms, mbps, rttMs, directRttMs, ok, err, remote: remote || null }))
    }
  }

  async function close () {
    closed = true
    clearInterval(timer)
    for (const item of tests.values()) { clearInterval(item.timer); item.socket?.destroy() }
    for (const item of controls.values()) item.socket.destroy()
    for (const socket of incoming) socket.destroy()
    await server.close().catch(() => {})
    await swarm.destroy().catch(() => {})
    await dht.destroy({ force: true }).catch(() => {})
  }

  return { sample, close, relayKeys: keys, relayAddress }
}
