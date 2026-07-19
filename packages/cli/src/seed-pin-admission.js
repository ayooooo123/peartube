const HEX_32 = /^[0-9a-f]{64}$/
const DAY_MS = 24 * 60 * 60 * 1000

export function createRelaySeedPinAdmission ({ config } = {}) {
  const trustedClients = new Set(config?.seedPin?.trustedClients || [])
  const owners = new Set(config?.admission?.owners || [])
  const channels = new Set(config?.admission?.channels || [])

  return async function admitRelaySeedPin ({ verified } = {}) {
    if (!isVerifiedFacts(verified)) return false
    return trustedClients.has(verified.identityPublicKey) ||
      owners.has(verified.identityPublicKey) ||
      channels.has(verified.channelKey)
  }
}

/**
 * durable aggregate usage is read in O(1); only the reserve-to-persist window
 * lives in memory, and serialized deltas prevent concurrent overbooking.
 * A maxBytes value of zero accepts no work. Runtime disabling is controlled by
 * seedPin.enabled, never by an ambiguous unlimited zero.
 */
export function createRelaySeedPinCapacityPolicy ({ pinStore, maxBytes } = {}) {
  if (!pinStore || typeof pinStore.getActiveUsage !== 'function') {
    throw new TypeError('pinStore.getActiveUsage is required')
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxBytes must be a non-negative safe integer')
  }

  const pending = new Map()
  const persistedPending = new Set()
  let durableUsage = null
  let serial = Promise.resolve()

  const runExclusive = operation => {
    const result = serial.then(operation, operation)
    serial = result.then(noop, noop)
    return result
  }

  const initialize = async () => {
    if (durableUsage !== null) return
    durableUsage = normalizeActiveUsage(await pinStore.getActiveUsage())
  }

  const effectiveUsageBytes = () => durableUsage === null
    ? 0
    : [...pending.values()].reduce(
        (total, reservation) => applySignedDelta(total, reservation.delta),
        durableUsage.usedBytes,
      )

  const refreshDurableUsage = async requestId => {
    const entry = pending.get(requestId)
    if (entry) persistedPending.add(entry)
    const nextUsage = normalizeActiveUsage(await pinStore.getActiveUsage())
    durableUsage = nextUsage
    for (const persisted of persistedPending) {
      if (pending.get(persisted.requestId) === persisted) {
        pending.delete(persisted.requestId)
      }
    }
    persistedPending.clear()
  }

  const policy = context => runExclusive(async () => {
    try {
      await initialize()
      if (maxBytes === 0 || !context || typeof context !== 'object') return false
      const requestId = normalizeRequestId(context.requestId)
      const persistedUsageBytes = normalizeBytes(context.persistedUsageBytes ?? 0)
      let requested
      if (context.phase === 'estimate') {
        requested = Math.max(
          persistedUsageBytes,
          normalizeBytes(context.knownBytes ?? context.downloadedBytes ?? 0),
        )
      } else if (context.phase === 'reserve') {
        requested = Math.max(
          normalizeBytes(context.reservedBytes),
          normalizeBytes(context.downloadedBytes ?? 0),
        )
      } else if (context.phase === 'progress') {
        requested = Math.max(
          normalizeBytes(context.persistedReservedBytes ?? 0),
          normalizeBytes(context.downloadedBytes),
        )
      } else {
        return false
      }
      const previousDelta = pending.get(requestId)?.delta || 0
      const nextDelta = requested - persistedUsageBytes
      const withoutPrevious = applySignedDelta(effectiveUsageBytes(), -previousDelta)
      const nextTotal = applySignedDelta(withoutPrevious, nextDelta)
      if (nextTotal > maxBytes) return false
      if (nextDelta === 0) pending.delete(requestId)
      else pending.set(requestId, { requestId, delta: nextDelta })
      return true
    } catch {
      return false
    }
  })

  policy.persisted = requestId => runExclusive(async () => {
    await initialize()
    const id = normalizeRequestId(requestId)
    await refreshDurableUsage(id)
    return true
  })
  policy.release = requestId => runExclusive(async () => {
    await initialize()
    const id = normalizeRequestId(requestId)
    await refreshDurableUsage(id)
    return true
  })
  policy.ready = runExclusive(initialize)
  policy.snapshot = () => ({
    maxBytes,
    reservedBytes: effectiveUsageBytes(),
    reservations: durableUsage?.activeCount || 0,
  })
  return policy
}

export function createRelaySeedPinReleasePolicy ({ retentionDays, now = Date.now } = {}) {
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 0 ||
      retentionDays > Math.floor(Number.MAX_SAFE_INTEGER / DAY_MS)) {
    throw new RangeError('retentionDays must be a bounded non-negative safe integer')
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function')
  const retentionMs = retentionDays * DAY_MS

  return async function releaseRelaySeedPin ({ action, record } = {}) {
    if (action === 'cancel' && record?.status?.state !== 'complete') return true
    if (action !== 'release' && action !== 'cancel') return false
    if (retentionMs === 0) return true
    if (record?.status?.state !== 'complete' || !Number.isSafeInteger(record.status.completedAt) ||
        record.status.completedAt < 0) return false
    const currentTime = now()
    if (!Number.isSafeInteger(currentTime) || currentTime < 0) return false
    if (record.status.completedAt > Number.MAX_SAFE_INTEGER - retentionMs) return false
    return currentTime >= record.status.completedAt + retentionMs
  }
}

function isVerifiedFacts (verified) {
  return verified?.valid === true &&
    typeof verified.identityPublicKey === 'string' && HEX_32.test(verified.identityPublicKey) &&
    typeof verified.requesterDevicePublicKey === 'string' && HEX_32.test(verified.requesterDevicePublicKey) &&
    typeof verified.channelKey === 'string' && HEX_32.test(verified.channelKey)
}

function normalizeRequestId (value) {
  if (typeof value !== 'string' || !HEX_32.test(value)) throw new TypeError('requestId must be a lowercase 32-byte key')
  return value
}

function normalizeBytes (value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('byte reservation must be a non-negative safe integer')
  return value
}

function normalizeActiveUsage (value) {
  if (!value || typeof value !== 'object' || value.version !== 1) {
    throw new Error('active seed pin usage is unavailable')
  }
  const activeCount = normalizeBytes(value.activeCount)
  const reservedBytes = normalizeBytes(value.reservedBytes)
  const downloadedBytes = normalizeBytes(value.downloadedBytes)
  const usedBytes = normalizeBytes(value.usedBytes)
  if (usedBytes < reservedBytes || usedBytes < downloadedBytes) {
    throw new Error('active seed pin usage is inconsistent')
  }
  return { version: 1, activeCount, reservedBytes, downloadedBytes, usedBytes }
}

function applySignedDelta (total, delta) {
  if (!Number.isSafeInteger(delta)) throw new RangeError('byte reservation delta exceeds safe integer range')
  if (delta < 0) {
    if (-delta > total) throw new RangeError('byte reservation underflow')
    return total + delta
  }
  if (total > Number.MAX_SAFE_INTEGER - delta) {
    throw new RangeError('byte reservation exceeds safe integer range')
  }
  return total + delta
}

function noop () {}
