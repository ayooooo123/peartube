import { acquisitionError, normalizePrincipalId } from './contract.js'
import { normalizeAcquisitionPolicy } from './policy.js'

const DAY_MS = 24 * 60 * 60 * 1000
const SECOND_MS = 1000
const MINUTE_MS = 60 * 1000

function fail (code, message, statusCode = 429) {
  throw acquisitionError(code, message, statusCode)
}

function uint (value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`)
  return value
}

export function createAcquisitionAdmissionLedger ({ now = () => Date.now() } = {}) {
  if (typeof now !== 'function') throw new TypeError('ledger now must be a function')
  const reservations = new Map()
  const byteEvents = []
  const publicRequestEvents = []

  function currentTime () {
    return uint(now(), 'now()')
  }

  function prune (at) {
    while (byteEvents.length && byteEvents[0].at <= at - DAY_MS) byteEvents.shift()
    while (publicRequestEvents.length && publicRequestEvents[0] <= at - MINUTE_MS) publicRequestEvents.shift()
  }

  function counts () {
    let queued = 0
    let active = 0
    let reservedBytes = 0
    let stagingBytes = 0
    const activeByPrincipal = new Map()
    for (const reservation of reservations.values()) {
      if (reservation.phase === 'queued') queued++
      else if (reservation.phase === 'active') {
        active++
        activeByPrincipal.set(reservation.principalId, (activeByPrincipal.get(reservation.principalId) || 0) + 1)
      }
      reservedBytes += Math.max(0, reservation.expectedBytes - reservation.sourceBytesRead)
      stagingBytes += reservation.stagingBytes
    }
    return { queued, active, reservedBytes, stagingBytes, activeByPrincipal }
  }

  function bytesInWindow (after) {
    let total = 0
    for (const event of byteEvents) if (event.at > after) total += event.bytes
    return total
  }

  function assertCanReserve ({ principalId, expectedBytes, policy: input, isRemote = false } = {}) {
    const policy = normalizeAcquisitionPolicy(input)
    const requester = normalizePrincipalId(principalId)
    const expected = uint(expectedBytes, 'expectedBytes')
    const at = currentTime()
    prune(at)
    const state = counts()
    if (state.queued >= policy.maxQueuedJobs) fail('ACQUISITION_QUEUE_FULL', 'queued acquisition limit reached', 503)
    const acquired24h = bytesInWindow(at - DAY_MS)
    if (expected > policy.maxAcquireBytesPer24h - acquired24h - state.reservedBytes) {
      fail('ACQUISITION_DAILY_BUDGET_EXCEEDED', '24-hour acquisition byte budget exceeded')
    }
    if (isRemote && publicRequestEvents.length >= policy.publicRequestsPerMinute) {
      fail('ACQUISITION_REQUEST_RATE_EXCEEDED', 'public acquisition request rate exceeded')
    }
    return { principalId: requester, expectedBytes: expected, at }
  }

  return Object.freeze({
    assertCanReserve,
    reserve ({ acquisitionId, principalId, expectedBytes, policy, isRemote = false } = {}) {
      if (typeof acquisitionId !== 'string' || !acquisitionId) throw new TypeError('acquisitionId is required')
      const existing = reservations.get(acquisitionId)
      if (existing) return { ...existing }
      const checked = assertCanReserve({ principalId, expectedBytes, policy, isRemote })
      const reservation = {
        acquisitionId,
        principalId: checked.principalId,
        expectedBytes: checked.expectedBytes,
        sourceBytesRead: 0,
        sourceBytesAccepted: 0,
        verifiedBytes: 0,
        committedBytes: 0,
        retainedBytes: 0,
        stagingBytes: 0,
        stagingPeakBytes: 0,
        phase: 'queued'
      }
      reservations.set(acquisitionId, reservation)
      if (isRemote) publicRequestEvents.push(checked.at)
      return { ...reservation }
    },
    restore ({ acquisitionId, principalId, expectedBytes, counters = {}, phase = 'queued' } = {}) {
      if (reservations.has(acquisitionId)) return { ...reservations.get(acquisitionId) }
      if (phase !== 'queued' && phase !== 'active') throw new TypeError('restored phase is invalid')
      const reservation = {
        acquisitionId,
        principalId: normalizePrincipalId(principalId),
        expectedBytes: uint(expectedBytes, 'expectedBytes'),
        sourceBytesRead: uint(counters.sourceBytesRead ?? 0, 'sourceBytesRead'),
        sourceBytesAccepted: uint(counters.sourceBytesAccepted ?? 0, 'sourceBytesAccepted'),
        verifiedBytes: uint(counters.verifiedBytes ?? 0, 'verifiedBytes'),
        committedBytes: uint(counters.committedBytes ?? 0, 'committedBytes'),
        retainedBytes: uint(counters.retainedBytes ?? 0, 'retainedBytes'),
        stagingBytes: uint(counters.stagingBytes ?? 0, 'stagingBytes'),
        stagingPeakBytes: uint(counters.stagingPeakBytes ?? 0, 'stagingPeakBytes'),
        phase
      }
      reservations.set(acquisitionId, reservation)
      return { ...reservation }
    },
    restoreUsage ({ at, bytes = 0, publicRequestAt = null } = {}) {
      const current = currentTime()
      const timestamp = uint(at, 'usage at')
      const chargedBytes = uint(bytes, 'usage bytes')
      if (timestamp > current) throw new TypeError('usage timestamp cannot be in the future')
      prune(current)
      if (chargedBytes > 0 && timestamp > current - DAY_MS) byteEvents.push({ at: timestamp, bytes: chargedBytes })
      if (publicRequestAt !== null) {
        const requestedAt = uint(publicRequestAt, 'public request at')
        if (requestedAt > current) throw new TypeError('public request timestamp cannot be in the future')
        if (requestedAt > current - MINUTE_MS) publicRequestEvents.push(requestedAt)
      }
      byteEvents.sort((left, right) => left.at - right.at)
      publicRequestEvents.sort((left, right) => left - right)
    },
    start ({ acquisitionId, policy: input } = {}) {
      const policy = normalizeAcquisitionPolicy(input)
      const reservation = reservations.get(acquisitionId)
      if (!reservation) throw new TypeError('acquisition has no reservation')
      if (reservation.phase === 'active') return { ...reservation }
      const state = counts()
      if (state.active >= policy.maxConcurrentJobs) fail('ACQUISITION_CONCURRENCY_EXCEEDED', 'concurrent acquisition limit reached', 503)
      if ((state.activeByPrincipal.get(reservation.principalId) || 0) >= policy.maxConcurrentPerRequester) {
        fail('ACQUISITION_REQUESTER_CONCURRENCY_EXCEEDED', 'requester concurrency limit reached', 503)
      }
      reservation.phase = 'active'
      return { ...reservation }
    },
    record (acquisitionId, patch, { policy: input } = {}) {
      const policy = normalizeAcquisitionPolicy(input)
      const reservation = reservations.get(acquisitionId)
      if (!reservation) throw new TypeError('acquisition has no reservation')
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('accounting patch must be an object')
      const allowed = new Set(['sourceBytesRead', 'sourceBytesAccepted', 'verifiedBytes', 'committedBytes', 'retainedBytes', 'stagingBytes'])
      for (const key of Object.keys(patch)) if (!allowed.has(key)) throw new TypeError(`unknown accounting field ${key}`)
      const next = { ...reservation }
      for (const [field, value] of Object.entries(patch)) {
        const normalized = uint(value, field)
        if (field !== 'stagingBytes' && normalized < reservation[field]) fail('ACQUISITION_ACCOUNTING_REGRESSION', `${field} must be monotonic`, 409)
        next[field] = normalized
      }
      if (next.sourceBytesAccepted > next.sourceBytesRead || next.verifiedBytes > next.sourceBytesAccepted ||
          next.committedBytes > next.verifiedBytes || next.retainedBytes > next.committedBytes) {
        fail('ACQUISITION_ACCOUNTING_INVALID', 'acquisition counters are inconsistent', 409)
      }
      const sourceDelta = next.sourceBytesRead - reservation.sourceBytesRead
      const at = currentTime()
      prune(at)
      if (sourceDelta > 0) {
        if (sourceDelta > policy.maxAcquireBytesPerSecond - bytesInWindow(at - SECOND_MS)) {
          fail('ACQUISITION_RATE_BUDGET_EXCEEDED', 'acquisition byte rate exceeded')
        }
        if (sourceDelta > policy.maxAcquireBytesPer24h - bytesInWindow(at - DAY_MS)) {
          fail('ACQUISITION_DAILY_BUDGET_EXCEEDED', '24-hour acquisition byte budget exceeded')
        }
      }
      const aggregateStaging = counts().stagingBytes - reservation.stagingBytes + next.stagingBytes
      if (aggregateStaging > policy.maxStagingBytes) fail('ACQUISITION_STAGING_BUDGET_EXCEEDED', 'staging byte budget exceeded', 507)
      next.stagingPeakBytes = Math.max(reservation.stagingPeakBytes, next.stagingBytes)
      reservations.set(acquisitionId, next)
      if (sourceDelta > 0) byteEvents.push({ at, bytes: sourceDelta })
      return { ...next }
    },
    commit (acquisitionId) {
      const reservation = reservations.get(acquisitionId)
      if (!reservation) throw new TypeError('acquisition has no reservation')
      if (reservation.committedBytes !== reservation.verifiedBytes) {
        fail('ACQUISITION_ACCOUNTING_INVALID', 'only fully verified bytes may be committed', 409)
      }
      return { ...reservation }
    },
    release (acquisitionId) {
      const reservation = reservations.get(acquisitionId)
      reservations.delete(acquisitionId)
      return reservation ? { ...reservation } : null
    },
    get (acquisitionId) {
      const value = reservations.get(acquisitionId)
      return value ? { ...value } : null
    },
    snapshot () {
      const at = currentTime()
      prune(at)
      const state = counts()
      return {
        queued: state.queued,
        active: state.active,
        reservedBytes: state.reservedBytes,
        stagingBytes: state.stagingBytes,
        acquiredBytes24h: bytesInWindow(at - DAY_MS),
        tracked: reservations.size
      }
    }
  })
}
