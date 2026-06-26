/**
 * Known-Peer Cache
 *
 * Persists noise public keys of peers we've connected to. Primary PearTube peer
 * discovery is topic-owned by Hyperswarm, but at startup the most-recently-seen
 * cached peers are also proactively re-dialed (see storage.js warm reconnect) so
 * a firewalled client with a cold DHT routing table can reach known-good peers
 * immediately instead of waiting out topic rediscovery. Keys are learned
 * dynamically from real connections — this is not a hardcoded relay list.
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

  function evictOldest() {
    if (peers.size <= MAX_KNOWN_PEERS) return
    const sorted = [...peers.entries()].sort((a, b) => a[1] - b[1])
    while (peers.size > MAX_KNOWN_PEERS) {
      const [k] = sorted.shift()
      peers.delete(k)
    }
  }

  function scheduleFlush() {
    if (flushTimer) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      void flush()
    }, FLUSH_DEBOUNCE_MS)
  }

  async function flush() {
    if (!dirty || !metaDb) return
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
    if (!metaDb) return
    const keyHex = toKeyHex(publicKey)
    if (!keyHex || keyHex === selfKeyHex) return
    peers.set(keyHex, Date.now())
    evictOldest()
    dirty = true
    scheduleFlush()
  }

  return { record, flush }
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
