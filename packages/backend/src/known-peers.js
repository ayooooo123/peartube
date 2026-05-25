/**
 * Known-Peer Cache
 *
 * Persists noise public keys of peers we've connected to so subsequent cold
 * starts can call `swarm.joinPeer(pk)` them directly. This short-circuits the
 * topic-based DHT lookup that would otherwise have to complete before any
 * peer connection can occur.
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

export function dialKnownPeers(swarm, knownList, options = {}) {
  if (!swarm || typeof swarm.joinPeer !== 'function' || swarm._peartubeOffline) return 0
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : Infinity
  let dialed = 0
  const seen = new Set()
  for (const entry of knownList) {
    if (dialed >= limit) break
    try {
      const key = typeof entry?.key === 'string' ? entry.key.toLowerCase() : null
      if (!key || !/^[0-9a-f]{64}$/.test(key) || seen.has(key)) continue
      seen.add(key)
      const pk = b4a.from(key, 'hex')
      if (pk.length !== 32) continue
      swarm.joinPeer(pk)
      dialed++
    } catch { /* best effort */ }
  }
  return dialed
}

function normalizeExplicitPeerKey(value) {
  const keyHex = toKeyHex(value?.key || value?.publicKey || value)
  return keyHex ? { key: keyHex, lastSeen: Date.now(), source: value?.source || 'explicit' } : null
}

export function getExplicitPeerList(ctx) {
  const configured = [
    ctx?.network?.relayPeers,
    ctx?.network?.knownPeers,
    ctx?.swarmOptions?.relayPeers,
    ctx?.swarmOptions?.knownPeers,
  ]
  const out = []
  for (const value of configured) {
    const list = Array.isArray(value) ? value : (value ? String(value).split(/[\s,]+/) : [])
    for (const item of list) {
      const normalized = normalizeExplicitPeerKey(item)
      if (normalized) out.push(normalized)
    }
  }
  return out
}

export async function getDialableKnownPeers(ctx) {
  const explicit = getExplicitPeerList(ctx)
  const persisted = await loadKnownPeers(ctx?._peartubeMetaDb || ctx?.metaDb)
  return [...explicit, ...persisted]
}
