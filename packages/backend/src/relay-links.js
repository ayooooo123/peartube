/**
 * Relay Links
 *
 * A small, persisted allow-list of relay blind-peer mirror keys that this
 * device has explicitly linked. Linking a relay tells the blind-peering client
 * to delegate this device's uploads/livestreams to that relay (so they always
 * have a peer), and marks the relay as a durable offload anchor.
 *
 * This is the client-side counterpart to the relay authorizing the device:
 * a creator pastes/scans the relay's mirror key (surfaced by the relay console
 * and `peartube-relay link`) to link it here. Keys are persisted in metaDb so
 * the link survives restarts and is re-applied on boot, mirroring the
 * known-peers persistence pattern.
 */

import b4a from 'b4a'

const RELAY_LINKS_KEY = 'relay-links-v1'

export function normalizeRelayKey(value) {
  if (!value) return null
  if (typeof value === 'string') {
    const hex = value.trim().toLowerCase()
    return /^[0-9a-f]{64}$/.test(hex) ? hex : null
  }
  if (b4a.isBuffer(value) || value instanceof Uint8Array) {
    if (value.length !== 32) return null
    return b4a.toString(value, 'hex')
  }
  return null
}

export async function loadRelayLinks(metaDb) {
  if (!metaDb) return []
  try {
    const entry = await metaDb.get(RELAY_LINKS_KEY).catch(() => null)
    const list = Array.isArray(entry?.value) ? entry.value : []
    return list
      .map((link) => ({
        mirrorKey: normalizeRelayKey(link?.mirrorKey),
        label: typeof link?.label === 'string' ? link.label : null,
        addedAt: Number(link?.addedAt) || 0
      }))
      .filter((link) => link.mirrorKey)
  } catch (err) {
    console.log('[RelayLinks] load failed:', err?.message)
    return []
  }
}

export async function saveRelayLinks(metaDb, list) {
  if (!metaDb) return false
  try {
    await metaDb.put(RELAY_LINKS_KEY, list)
    return true
  } catch (err) {
    console.log('[RelayLinks] save failed:', err?.message)
    return false
  }
}

export async function addRelayLink(metaDb, { mirrorKey, label = null } = {}) {
  const key = normalizeRelayKey(mirrorKey)
  if (!key) throw new Error('relay mirror key must be a 64-char hex string')
  const list = await loadRelayLinks(metaDb)
  const existing = list.find((link) => link.mirrorKey === key)
  if (existing) {
    if (typeof label === 'string' && label.trim()) existing.label = label.trim()
  } else {
    list.push({ mirrorKey: key, label: (typeof label === 'string' && label.trim()) ? label.trim() : null, addedAt: Date.now() })
  }
  await saveRelayLinks(metaDb, list)
  return list.find((link) => link.mirrorKey === key)
}

export async function removeRelayLink(metaDb, mirrorKey) {
  const key = normalizeRelayKey(mirrorKey)
  if (!key) return false
  const list = await loadRelayLinks(metaDb)
  const next = list.filter((link) => link.mirrorKey !== key)
  if (next.length === list.length) return false
  await saveRelayLinks(metaDb, next)
  return true
}

export function relayLinkKeys(list) {
  return (Array.isArray(list) ? list : []).map((link) => link?.mirrorKey).filter(Boolean)
}

export function mergeTrustedRelayKeys(configuredKeys, persistedLinks) {
  const keys = new Set()
  for (const value of Array.isArray(configuredKeys) ? configuredKeys : []) {
    const key = normalizeRelayKey(value)
    if (key) keys.add(key)
  }
  for (const link of Array.isArray(persistedLinks) ? persistedLinks : []) {
    const key = normalizeRelayKey(link?.mirrorKey)
    if (key) keys.add(key)
  }
  return Array.from(keys)
}
