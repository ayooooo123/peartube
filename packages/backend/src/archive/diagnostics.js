export const ARCHIVE_OPERATOR_MODES = Object.freeze([
  'local-first',
  'altruistic',
  'friend-family',
  'community',
  'paid',
])

const OPERATOR_MODE_SET = new Set(ARCHIVE_OPERATOR_MODES)
const ARCHIVE_PLEDGE_HEALTH = new Set(['unknown', 'healthy', 'failed', 'expired'])
const CHALLENGE_FAILURE_CODES = new Set([
  'FAILED',
  'EXPIRED',
  'INVALID_PROOF',
  'RESPONSE_INVALID',
  'UNAVAILABLE',
])
const OFFLOAD_REJECTION_REASONS = new Set([
  'assessment-not-found',
  'nonce-used',
  'assessment-not-yet-valid',
  'assessment-expired',
  'irrecoverable-risk-not-confirmed',
  'publication-mismatch',
  'evidence-mismatch',
  'nonce-mismatch',
  'not-eligible',
])
const DEFAULT_MAX_HISTORY = 64
const MAX_HISTORY_LIMIT = 256
const DEFAULT_MAX_PLEDGES = 128
const MAX_PLEDGE_LIMIT = 256
const CAPACITY_FAILURE_CODES = new Set([
  'ARCHIVE_CAPACITY_EXHAUSTED',
  'ARCHIVE_CAPACITY_INVALID_RESERVATION',
  'ARCHIVE_CAPACITY_REJECTED',
])
const STORED_CHALLENGE_FAILURE_CODES = new Set(
  Array.from(CHALLENGE_FAILURE_CODES, code => `ARCHIVE_CHALLENGE_${code}`)
)
const STORED_OFFLOAD_FAILURE_CODES = new Set(
  Array.from(OFFLOAD_REJECTION_REASONS, reason => `ARCHIVE_OFFLOAD_${reason.replace(/-/g, '_').toUpperCase()}`)
)
STORED_OFFLOAD_FAILURE_CODES.add('ARCHIVE_OFFLOAD_REJECTED')

const MAX_COUNTER = Number.MAX_SAFE_INTEGER

function boundedLimit(value, fallback, maximum) {
  if (!Number.isSafeInteger(value) || value < 1) return fallback
  return Math.min(value, maximum)
}

function timestamp(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function increment(value) {
  return value >= MAX_COUNTER ? MAX_COUNTER : value + 1
}
function counter(value) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) return 0
  return Math.min(number, MAX_COUNTER)
}

function storedFailureCode(value) {
  const code = String(value || '')
  if (STORED_CHALLENGE_FAILURE_CODES.has(code)) return code
  if (CAPACITY_FAILURE_CODES.has(code)) return code
  if (STORED_OFFLOAD_FAILURE_CODES.has(code)) return code
  return null
}


function pledgeKey(value) {
  const key = String(value || '')
  if (!key || key.length > 128) throw new Error('pledgeId must be a bounded string')
  return key
}

function challengeFailureCode(value, outcome) {
  if (outcome === 'expired') return 'ARCHIVE_CHALLENGE_EXPIRED'
  const code = String(value || 'FAILED').toUpperCase()
  return `ARCHIVE_CHALLENGE_${CHALLENGE_FAILURE_CODES.has(code) ? code : 'FAILED'}`
}
function offloadFailureCode(reason) {
  const normalized = OFFLOAD_REJECTION_REASONS.has(reason) ? reason : 'rejected'
  return `ARCHIVE_OFFLOAD_${normalized.replace(/-/g, '_').toUpperCase()}`
}

function capacityFailureCode(reason) {
  if (reason === 'capacity-exceeded') return 'ARCHIVE_CAPACITY_EXHAUSTED'
  if (reason === 'invalid-reservation') return 'ARCHIVE_CAPACITY_INVALID_RESERVATION'
  return 'ARCHIVE_CAPACITY_REJECTED'
}

function nonNegativeInteger(value, name) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${name} must be a non-negative integer`)
  return number
}


function pushBounded(list, value, limit) {
  list.push(value)
  while (list.length > limit) list.shift()
}


function normalizeOperatorMode(value) {
  const mode = value === undefined ? 'local-first' : String(value)
  if (!OPERATOR_MODE_SET.has(mode)) throw new Error('invalid archive operator mode')
  return mode
}

export function createArchiveDiagnostics(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const source = options.state?.version === 1 ? options.state : null
  const hasDeclaredMode = Object.prototype.hasOwnProperty.call(options, 'operatorMode')
  const operatorMode = hasDeclaredMode
    ? normalizeOperatorMode(options.operatorMode)
    : OPERATOR_MODE_SET.has(source?.operatorMode)
      ? source.operatorMode
      : 'local-first'
  const maxHistory = boundedLimit(
    options.maxHistory ?? source?.limits?.maxHistory,
    DEFAULT_MAX_HISTORY,
    MAX_HISTORY_LIMIT
  )
  const maxPledges = boundedLimit(
    options.maxPledges ?? source?.limits?.maxPledges,
    DEFAULT_MAX_PLEDGES,
    MAX_PLEDGE_LIMIT
  )
  const persist = typeof options.persist === 'function' ? options.persist : null
  const pledges = new Map()
  const recentFailureCodes = []
  const recentChallenges = []
  const capacityRejectionCounts = Object.create(null)
  const offloadRejectionCounts = Object.create(null)
  let challengeSuccessCount = counter(source?.challengeSuccessCount)
  let challengeFailureCount = counter(source?.challengeFailureCount)
  let capacityRejectionCount = counter(source?.capacityRejectionCount)
  let offloadRejectionCount = counter(source?.offloadRejectionCount)
  let capacity = null
  let updatedAt = source
    ? timestamp(source.updatedAt, timestamp(now()))
    : timestamp(now())
  let persistQueue = Promise.resolve()
  let persistError = null

  function restoreCountMap(target, stored, allowedCodes) {
    if (!stored || typeof stored !== 'object') return
    for (const code of allowedCodes) {
      const value = counter(stored[code])
      if (value > 0) target[code] = value
    }
  }

  function setCapacity(input) {
    capacity = {
      totalBytes: nonNegativeInteger(input.totalBytes, 'capacity totalBytes'),
      reservedBytes: nonNegativeInteger(input.reservedBytes, 'capacity reservedBytes'),
      availableBytes: nonNegativeInteger(input.availableBytes, 'capacity availableBytes'),
    }
  }

  function setPledgeHealth(pledgeId, health, active) {
    pledges.delete(pledgeId)
    pledges.set(pledgeId, { health, active })
    while (pledges.size > maxPledges) pledges.delete(pledges.keys().next().value)
  }

  if (Array.isArray(source?.pledges)) {
    for (const entry of source.pledges.slice(-maxPledges)) {
      try {
        const pledgeId = pledgeKey(entry?.pledgeId)
        const health = String(entry?.health || '')
        if (!ARCHIVE_PLEDGE_HEALTH.has(health)) continue
        setPledgeHealth(
          pledgeId,
          health,
          entry.active === undefined ? health !== 'expired' : Boolean(entry.active)
        )
      } catch {
        // Ignore malformed persisted pledge diagnostics.
      }
    }
  }

  if (Array.isArray(source?.recentChallenges)) {
    for (const entry of source.recentChallenges.slice(-maxHistory)) {
      const outcome = String(entry?.outcome || '')
      if (outcome !== 'passed' && outcome !== 'failed' && outcome !== 'expired') continue
      const event = {
        outcome,
        observedAt: timestamp(entry?.observedAt),
      }
      if (outcome !== 'passed') {
        const failureCode = storedFailureCode(entry?.failureCode)
        event.failureCode = STORED_CHALLENGE_FAILURE_CODES.has(failureCode)
          ? failureCode
          : challengeFailureCode(null, outcome)
      }
      recentChallenges.push(event)
    }
  }

  if (Array.isArray(source?.recentFailureCodes)) {
    for (const value of source.recentFailureCodes.slice(-maxHistory)) {
      const failureCode = storedFailureCode(value)
      if (failureCode) recentFailureCodes.push(failureCode)
    }
  }

  if (source?.capacity && typeof source.capacity === 'object') {
    try {
      setCapacity(source.capacity)
    } catch {
      capacity = null
    }
  }
  restoreCountMap(capacityRejectionCounts, source?.capacityRejectionCounts, CAPACITY_FAILURE_CODES)
  restoreCountMap(offloadRejectionCounts, source?.offloadRejectionCounts, STORED_OFFLOAD_FAILURE_CODES)

  function touch(observedAt) {
    const fallback = timestamp(now())
    updatedAt = Math.max(updatedAt, timestamp(observedAt, fallback))
  }

  function exportCountMap(counts) {
    const copy = {}
    for (const code of Object.keys(counts).sort()) copy[code] = counts[code]
    return copy
  }

  function exportState() {
    return {
      version: 1,
      operatorMode,
      limits: { maxHistory, maxPledges },
      pledges: Array.from(pledges, ([pledgeId, pledge]) => ({ pledgeId, ...pledge })),
      challengeSuccessCount,
      challengeFailureCount,
      capacity: capacity ? { ...capacity } : null,
      capacityRejectionCount,
      capacityRejectionCounts: exportCountMap(capacityRejectionCounts),
      offloadRejectionCount,
      offloadRejectionCounts: exportCountMap(offloadRejectionCounts),
      recentChallenges: recentChallenges.map(event => ({ ...event })),
      recentFailureCodes: recentFailureCodes.slice(),
      updatedAt,
    }
  }

  function schedulePersist() {
    if (!persist) return
    const snapshot = exportState()
    persistQueue = persistQueue
      .then(async () => {
        await persist(snapshot)
        persistError = null
      })
      .catch(error => {
        persistError = error
      })
  }

  function recordPledgeHealth(input = {}) {
    const pledgeId = pledgeKey(input.pledgeId)
    const health = String(input.health || 'unknown')
    if (!ARCHIVE_PLEDGE_HEALTH.has(health)) throw new Error('invalid archive pledge health')
    setPledgeHealth(
      pledgeId,
      health,
      input.active === undefined ? health !== 'expired' : Boolean(input.active)
    )
    touch(input.observedAt)
    schedulePersist()
  }

  function recordChallengeOutcome(input = {}) {
    const outcome = String(input.outcome || '')
    if (outcome !== 'passed' && outcome !== 'failed' && outcome !== 'expired') {
      throw new Error('invalid archive challenge outcome')
    }
    const pledgeId = pledgeKey(input.pledgeId)
    const observedAt = timestamp(input.observedAt, timestamp(now()))
    const event = { outcome, observedAt }
    if (outcome === 'passed') {
      challengeSuccessCount = increment(challengeSuccessCount)
      pushBounded(recentChallenges, event, maxHistory)
      setPledgeHealth(pledgeId, 'healthy', true)
    } else {
      const failureCode = challengeFailureCode(input.failureCode, outcome)
      challengeFailureCount = increment(challengeFailureCount)
      pushBounded(recentFailureCodes, failureCode, maxHistory)
      pushBounded(recentChallenges, { ...event, failureCode }, maxHistory)
      setPledgeHealth(pledgeId, 'failed', true)
    }
    touch(observedAt)
    schedulePersist()
  }

  function recordCapacity(input = {}) {
    setCapacity(input)
    touch(input.observedAt)
    schedulePersist()
  }

  function recordCapacityRejection(input = {}) {
    const failureCode = capacityFailureCode(String(input.reason || ''))
    const nextCapacity = input.totalBytes === undefined
      ? null
      : {
          totalBytes: nonNegativeInteger(input.totalBytes, 'capacity totalBytes'),
          reservedBytes: nonNegativeInteger(input.reservedBytes, 'capacity reservedBytes'),
          availableBytes: nonNegativeInteger(input.availableBytes, 'capacity availableBytes'),
        }
    capacityRejectionCount = increment(capacityRejectionCount)
    capacityRejectionCounts[failureCode] = increment(capacityRejectionCounts[failureCode] || 0)
    pushBounded(recentFailureCodes, failureCode, maxHistory)
    if (nextCapacity) capacity = nextCapacity
    touch(input.observedAt)
    schedulePersist()
  }

  function recordOffloadRejection(input = {}) {
    const failureCode = offloadFailureCode(String(input.reason || ''))
    offloadRejectionCount = increment(offloadRejectionCount)
    offloadRejectionCounts[failureCode] = increment(offloadRejectionCounts[failureCode] || 0)
    pushBounded(recentFailureCodes, failureCode, maxHistory)
    touch(input.observedAt)
    schedulePersist()
  }

  function getArchiveOperatorStatus() {
    let activePledgeCount = 0
    let healthyPledgeCount = 0
    let failedPledgeCount = 0
    for (const pledge of pledges.values()) {
      if (!pledge.active) continue
      activePledgeCount++
      if (pledge.health === 'healthy') healthyPledgeCount++
      if (pledge.health === 'failed') failedPledgeCount++
    }
    return {
      success: true,
      operatorMode,
      activePledgeCount,
      healthyPledgeCount,
      failedPledgeCount,
      challengeSuccessCount,
      challengeFailureCount,
      capacityRejectionCount,
      offloadRejectionCount,
      ...(capacity
        ? {
            capacityTotalBytes: capacity.totalBytes,
            capacityReservedBytes: capacity.reservedBytes,
            capacityAvailableBytes: capacity.availableBytes,
          }
        : {}),
      recentFailureCodes: recentFailureCodes.slice(),
      updatedAt,
    }
  }

  async function flush() {
    await persistQueue
    if (persistError) throw persistError
  }

  return {
    recordPledgeHealth,
    recordChallengeOutcome,
    recordCapacity,
    recordCapacityRejection,
    recordOffloadRejection,
    exportState,
    getArchiveOperatorStatus,
    flush,
  }
}
