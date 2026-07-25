/**
 * Legacy Hypercore peer-range inspection helpers.
 *
 * Raw peer availability is useful evidence, but it is never durability proof:
 * viewers disconnect, anonymous Noise identities are cheap, and a configured
 * relay key does not prove an intentional retention commitment. Source deletion
 * is authorized only by the publication-bound archive assessment manager.
 */

function toHexKey(value) {
  if (!value) return null
  if (typeof value === 'string') return /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : null
  if (typeof value.toString === 'function' && (Buffer.isBuffer?.(value) || value instanceof Uint8Array)) {
    return Buffer.from(value).toString('hex')
  }
  return null
}

function normalizeKeySet(keys) {
  const set = new Set()
  for (const key of Array.isArray(keys) ? keys : (keys ? [keys] : [])) {
    const hex = toHexKey(key)
    if (hex) set.add(hex)
  }
  return set
}

export const DEFAULT_OFFLOAD_POLICY = Object.freeze({
  minFullCopyPeers: Number.MAX_SAFE_INTEGER,
})

/**
 * Does this peer hold every block in [blockOffset, blockOffset + blockLength)?
 * Mirrors hypercore's own "remote has range" test (replicator broadcastRange):
 * `remoteBitfield.firstUnset(start) >= end`. Falls back to the peer's contiguous
 * length when a bitfield isn't exposed.
 * @param {{ remoteBitfield?: { firstUnset?: (i: number) => number }, remoteContiguousLength?: number }} peer
 * @param {number} start
 * @param {number} end
 * @returns {boolean}
 */
export function peerHasFullRange(peer, start, end) {
  if (!peer) return false
  const bitfield = peer.remoteBitfield
  if (bitfield && typeof bitfield.firstUnset === 'function') {
    return bitfield.firstUnset(start) >= end
  }
  const contiguous = Number(peer.remoteContiguousLength)
  return Number.isFinite(contiguous) && contiguous >= end
}

/**
 * Inspect a blob core's connected peers and collect those that hold the full
 * blob range.
 * @param {Iterable<object>} peers - core.peers (replicator peer objects)
 * @param {{ blockOffset: number, blockLength: number }} range
 * @returns {{ fullCopyKeys: string[], fullCopyAnonymous: number }}
 */
export function collectFullCopyPeers(peers, range) {
  const start = Number(range?.blockOffset)
  const length = Number(range?.blockLength)
  if (!Number.isInteger(start) || start < 0 || !Number.isInteger(length) || length <= 0) {
    return { fullCopyKeys: [], fullCopyAnonymous: 0 }
  }
  const end = start + length
  const fullCopyKeys = []
  let fullCopyAnonymous = 0
  for (const peer of peers || []) {
    if (!peerHasFullRange(peer, start, end)) continue
    const keyHex = toHexKey(peer?.remotePublicKey)
    if (keyHex) fullCopyKeys.push(keyHex)
    else fullCopyAnonymous += 1
  }
  return { fullCopyKeys, fullCopyAnonymous }
}

/**
 * Classify connected holders without treating transient or anonymous peers as
 * source-deletion authority. This helper remains for diagnostics and legacy
 * callers; new offload decisions use archive/confidence.js.
 */
export function assessOffloadEligibility({
  fullCopyKeys = [],
  fullCopyAnonymous = 0,
  relayKeys = [],
  deviceKeys = [],
} = {}) {
  const relaySet = normalizeKeySet(relayKeys)
  const deviceSet = normalizeKeySet(deviceKeys)
  const keys = Array.from(new Set((fullCopyKeys || []).map(toHexKey).filter(Boolean)))
  const relayHasFullCopy = keys.some((key) => relaySet.has(key))
  const ownDeviceHasFullCopy = keys.some((key) => deviceSet.has(key))
  const fullCopyPeers = keys.length + Math.max(0, Number(fullCopyAnonymous) || 0)
  return {
    eligible: ownDeviceHasFullCopy,
    fullCopyPeers,
    relayHasFullCopy,
    ownDeviceHasFullCopy,
    minFullCopyPeers: Number.MAX_SAFE_INTEGER,
    reasons: ownDeviceHasFullCopy ? ['own-device-full-copy'] : [],
  }
}
