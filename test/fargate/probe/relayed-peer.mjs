import Corestore from 'corestore'
import DHT from 'hyperdht'
import crypto from 'hypercore-crypto'

const FOUR_MIB = 4 * 1024 * 1024
const short = key => key.toString('hex').slice(0, 8)

function streamRecord (item) {
  const raw = item.socket?.rawStream
  return {
    peer: short(item.peer),
    relay: short(item.relay),
    remote: raw?.remoteHost ? `${raw.remoteHost}:${raw.remotePort}` : item.remote,
    pairMs: item.pairMs,
    ageMs: Date.now() - item.started,
    rx: raw?.bytesReceived ?? item.rx ?? 0,
    tx: raw?.bytesTransmitted ?? item.tx ?? 0,
    rtt: raw?.rtt ?? item.rtt ?? null,
    ok: item.ok,
    ...(item.err ? { err: item.err } : {})
  }
}

export async function startRelayedPeer ({ subset, channelKey, maxConns, relayKeys, relayAddress, onEvent, startedAt, storage = '/data/rp', bootstrap }) {
  const store = new Corestore(storage)
  const dht = bootstrap ? new DHT({ bootstrap }) : new DHT()
  let closed = false
  dht.on('error', err => { if (!closed) onEvent('error', { where: 'rp-dht', message: err.message }) })
  const entries = subset.entries.map(entry => ({
    ...entry,
    core: store.get({ key: Buffer.from(entry.blobs, 'hex') })
  }))
  try {
    await Promise.all(entries.map(entry => entry.core.ready()))
  } catch (err) {
    await Promise.allSettled([dht.destroy({ force: true }), store.close()])
    throw err
  }
  const downloads = entries.map(entry => entry.core.download({
    start: entry.blockOffset,
    end: entry.blockOffset + entry.blockLength
  }))
  const peers = new Map()
  const active = new Map()
  const history = []
  const reads = []
  let peerCursor = 0
  let relayCursor = 0
  let looking = false
  let firstByteT = null
  let fullCopyT = null

  async function lookup () {
    if (looking || closed) return
    looking = true
    try {
      for await (const reply of dht.lookup(crypto.discoveryKey(Buffer.from(channelKey, 'hex')))) {
        for (const peer of reply.peers || []) {
          const key = Buffer.from(peer.publicKey)
          peers.set(key.toString('hex'), { key, relayAddresses: peer.relayAddresses || peer.nodes || [] })
        }
      }
    } catch (err) {
      if (!closed) onEvent('error', { where: 'rp-lookup', message: err.message })
    } finally {
      looking = false
      maintain()
    }
  }

  async function timedRead (item) {
    const start = Date.now()
    let bytes = 0
    const limit = start + 30000
    while (!closed && !item.socket.destroyed && bytes < FOUR_MIB && Date.now() < limit) {
      let selected = false
      for (const entry of entries) {
        const peer = entry.core.peers.find(p => p.remotePublicKey?.equals(item.peer))
        if (!peer) continue
        const end = Math.min(entry.blockOffset + entry.blockLength, peer.remoteContiguousLength)
        for (let i = entry.blockOffset; i < end && bytes < FOUR_MIB; i++) {
          if (await entry.core.has(i)) continue
          selected = true
          try {
            const block = await entry.core.get(i, { wait: true, timeout: 10000 })
            if (block) bytes += block.length
          } catch {
            break
          }
          if (closed || item.socket.destroyed) break
        }
        if (closed || item.socket.destroyed || bytes >= FOUR_MIB) break
      }
      if (!selected) await new Promise(resolve => setTimeout(resolve, 500))
    }
    if (bytes > 0) {
      reads.push({ peer: short(item.peer), relay: short(item.relay), bytes, ms: Date.now() - start })
      if (reads.length > 100) reads.shift()
    }
  }

  function connect (peer, relay) {
    const id = peer.key.toString('hex')
    const item = { peer: peer.key, relay, started: Date.now(), pairMs: null, remote: null, ok: false, err: null, socket: null }
    active.set(id, item)
    try {
      const socket = dht.connect(peer.key, {
        relayThrough: relay,
        holepunch: () => false,
        relayAddresses: peer.relayAddresses
      })
      item.socket = socket
      const timeout = setTimeout(() => socket.destroy(new Error('CONNECT_TIMEOUT')), 60000)
      socket.on('error', err => { item.err = err.code || err.message })
      socket.on('open', () => {
        clearTimeout(timeout)
        item.pairMs = Date.now() - item.started
        // Host only: the relay forwards on a pooled UDX socket whose port differs from its DHT socket's.
        const address = relayAddress(relay)
        const raw = socket.rawStream
        if (!address || raw?.remoteHost !== address.host) {
          item.err = 'DIRECT_ROUTE'
          socket.destroy()
          return
        }
        raw.on('remote-changed', () => {
          const current = relayAddress(relay)
          if (!current || raw.remoteHost !== current.host) {
            item.ok = false
            item.err = 'DIRECT_ROUTE'
            socket.destroy()
          }
        })
        item.opened = Date.now()
        item.ok = true
        store.replicate(socket)
        onEvent('conn-open', streamRecord(item))
        timedRead(item).catch(err => onEvent('error', { where: 'rp-read', message: err.message }))
      })
      socket.on('close', () => {
        clearTimeout(timeout)
        const raw = socket.rawStream
        item.remote = raw?.remoteHost ? `${raw.remoteHost}:${raw.remotePort}` : item.remote
        item.rx = raw?.bytesReceived || 0
        item.tx = raw?.bytesTransmitted || 0
        item.rtt = raw?.rtt ?? null
        if (!item.opened || Date.now() - item.opened < 5000) {
          item.ok = false
          item.err ||= 'CLOSED_EARLY'
        }
        active.delete(id)
        history.push(streamRecord(item))
        if (history.length > 100) history.shift()
        peer.retryAt = Date.now() + 10000
        onEvent('conn-close', streamRecord(item))
      })
    } catch (err) {
      active.delete(id)
      item.err = err.code || err.message
      peer.retryAt = Date.now() + 10000
      history.push(streamRecord(item))
      onEvent('conn-close', streamRecord(item))
    }
  }

  function maintain () {
    if (closed) return
    const list = [...peers.values()]
    const relays = relayKeys().filter(key => relayAddress(key))
    if (!list.length || !relays.length) return
    let tried = 0
    while (active.size < maxConns && tried < list.length) {
      const peer = list[peerCursor++ % list.length]
      tried++
      if (active.has(peer.key.toString('hex')) || peer.retryAt > Date.now()) continue
      const relay = relays[relayCursor++ % relays.length]
      connect(peer, relay)
    }
  }

  const lookupTimer = setInterval(lookup, 60000)
  const maintainTimer = setInterval(maintain, 2000)
  lookup()

  async function sample () {
    const cores = {}
    let haveBytes = 0
    let complete = entries.length > 0
    for (const entry of entries) {
      const have = await entry.core.count(entry.blockOffset, entry.blockOffset + entry.blockLength)
      cores[entry.blobs.slice(0, 8)] = { length: entry.blockLength, have }
      haveBytes += Math.round(have * entry.size / entry.blockLength)
      if (have !== entry.blockLength) complete = false
    }
    if (haveBytes > 0 && firstByteT === null) {
      firstByteT = Date.now() - startedAt
      onEvent('first-byte', { haveBytes })
    }
    if (complete && fullCopyT === null) {
      fullCopyT = Date.now() - startedAt
      onEvent('full-copy', { haveBytes })
    }
    return {
      conns: [...active.values()].map(streamRecord).concat(history),
      cores,
      haveBytes,
      targetBytes: subset.totalBytes,
      firstByteT,
      fullCopyT,
      reads: [...reads]
    }
  }

  async function close () {
    closed = true
    clearInterval(lookupTimer)
    clearInterval(maintainTimer)
    for (const item of active.values()) item.socket?.destroy()
    for (const range of downloads) range.destroy()
    await dht.destroy({ force: true })
    await store.close()
  }

  return { sample, close }
}
