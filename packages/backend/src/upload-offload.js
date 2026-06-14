/**
 * Upload offload durability assessment.
 *
 * The user's own uploaded videos are the *source* copy — if the only local
 * copy is cleared while no one else holds the bytes, the video is permanently
 * lost from the network. So an upload may only be evicted from local disk once
 * we can prove, on-device, that a full copy lives elsewhere.
 *
 * Hypercore exposes each connected peer's remote availability (`remoteBitfield`
 * / `remoteContiguousLength`), so we can verify — without trusting a soft
 * "available" claim — that a peer actually holds every block of the blob's byte
 * range. We then classify each full-copy holder:
 *   - the always-on relay / blind peer (a durable anchor),
 *   - one of the user's own paired devices (a trusted anchor),
 *   - or a generic live peer (transient; only counts toward a redundancy
 *     threshold).
 *
 * Eligibility is satisfied by ANY of: a relay full copy, an own-device full
 * copy, or at least `minFullCopyPeers` independent live full copies.
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
  // Minimum number of independent live peers that must each hold the COMPLETE
  // blob range before generic (untrusted, transient) peers alone can justify an
  // eviction. A relay or own-device full copy is a standalone durable anchor and
  // bypasses this count.
  minFullCopyPeers: 2,
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
 * Decide whether an upload is safe to evict locally, given who holds a full
 * copy and which keys are durable anchors (relay / own devices).
 * @param {{ fullCopyKeys?: string[], fullCopyAnonymous?: number, relayKeys?: any, deviceKeys?: any, policy?: { minFullCopyPeers: number } }} input
 */
export function assessOffloadEligibility({
  fullCopyKeys = [],
  fullCopyAnonymous = 0,
  relayKeys = [],
  deviceKeys = [],
  policy = DEFAULT_OFFLOAD_POLICY,
} = {}) {
  const relaySet = normalizeKeySet(relayKeys)
  const deviceSet = normalizeKeySet(deviceKeys)
  const keys = Array.from(new Set((fullCopyKeys || []).map(toHexKey).filter(Boolean)))

  const relayHasFullCopy = keys.some((k) => relaySet.has(k))
  const ownDeviceHasFullCopy = keys.some((k) => deviceSet.has(k))
  // Distinct full copies = identified peers + anonymous (no-key) holders.
  const fullCopyPeers = keys.length + Math.max(0, Number(fullCopyAnonymous) || 0)

  const minFullCopyPeers = Math.max(1, Number(policy?.minFullCopyPeers) || DEFAULT_OFFLOAD_POLICY.minFullCopyPeers)
  const meetsRedundancy = fullCopyPeers >= minFullCopyPeers

  const eligible = relayHasFullCopy || ownDeviceHasFullCopy || meetsRedundancy

  const reasons = []
  if (relayHasFullCopy) reasons.push('relay-full-copy')
  if (ownDeviceHasFullCopy) reasons.push('own-device-full-copy')
  if (meetsRedundancy) reasons.push(`peer-redundancy:${fullCopyPeers}`)

  return {
    eligible,
    fullCopyPeers,
    relayHasFullCopy,
    ownDeviceHasFullCopy,
    minFullCopyPeers,
    reasons,
  }
}
