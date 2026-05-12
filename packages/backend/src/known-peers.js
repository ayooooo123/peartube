/**
 * Known-Peer Cache
 *
 * Persists noise public keys of peers we've connected to so subsequent cold
 * starts can call `swarm.joinPeer(pk)` directly. This short-circuits the
 * topic-based DHT lookup that would otherwise have to complete before any
 * peer connection can occur.
 *
 * Pattern follows Hyperswarm's documented `joinPeer` semantics (direct
 * reconnect with auto-reconnect on failure). Storage is a single Hyperbee
 * row keyed by `known-peers-v1`.
 */

import b4a from 'b4a'

const KNOWN_PEERS_KEY = 'known-peers-v1'
const MAX_KNOWN_PEERS = 64
const FLUSH_DEBOUNCE_MS = 5000

function toKeyHex(publicKey) {
  if (!publicKey) return null
  if (typeof publicKey === 'string') {
    return /^[0-9a-f]{64}$/i.test(publicKey) ? publicKey.toLowerCase() : null
  }
  if (b4a.isBuffer(publicKey) || publicKey instanceof Uint8Array) {
    if (publicKey.length !== 32) return null
    return b4a.toString(publicKey, 'hex')
  }
  return null
}

export function createKnownPeerCache(metaDb, { selfKeyHex = null } = {}) {
  const peers = new Map()
  let dirty = false
  let flushTimer = null
  let closed = false

  function evictOldest() {
    if (peers.size <= MAX_KNOWN_PEERS) return
    const sorted = [...peers.entries()].sort((a, b) => a[1] - b[1])
    while (peers.size > MAX_KNOWN_PEERS) {
      const [k] = sorted.shift()
      peers.delete(k)
    }
  }

  function scheduleFlush() {
    if (flushTimer || closed) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      void flush()
    }, FLUSH_DEBOUNCE_MS)
  }

  async function flush() {
    if (!dirty || !metaDb || closed) return
    dirty = false
    const list = [...peers.entries()].map(([key, lastSeen]) => ({ key, lastSeen }))
    try {
      await metaDb.put(KNOWN_PEERS_KEY, list)
    } catch (err) {
      console.log('[KnownPeers] flush failed:', err?.message)
      dirty = true
    }
  }

  function record(publicKey) {
    if (closed || !metaDb) return
    const keyHex = toKeyHex(publicKey)
    if (!keyHex) return
    if (selfKeyHex && keyHex === selfKeyHex) return
    peers.set(keyHex, Date.now())
    evictOldest()
    dirty = true
    scheduleFlush()
  }

  async function close() {
    closed = true
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    await flush()
  }

  return {
    record,
    flush,
    close,
    get size() { return peers.size }
  }
}

export async function loadKnownPeers(metaDb) {
  if (!metaDb) return []
  try {
    const entry = await metaDb.get(KNOWN_PEERS_KEY).catch(() => null)
    const list = Array.isArray(entry?.value) ? entry.value : []
    return list
      .filter((p) => p && typeof p.key === 'string' && /^[0-9a-f]{64}$/i.test(p.key))
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
  } catch (err) {
    console.log('[KnownPeers] load failed:', err?.message)
    return []
  }
}

export function dialKnownPeers(swarm, knownList, { limit = MAX_KNOWN_PEERS, selfKeyHex = null } = {}) {
  if (!swarm || typeof swarm.joinPeer !== 'function') return 0
  if (swarm._peartubeOffline) return 0
  let dialed = 0
  for (const entry of knownList.slice(0, limit)) {
    if (selfKeyHex && entry.key === selfKeyHex) continue
    try {
      const pk = b4a.from(entry.key, 'hex')
      if (pk.length !== 32) continue
      swarm.joinPeer(pk)
      dialed++
    } catch { /* best effort */ }
  }
  return dialed
}
