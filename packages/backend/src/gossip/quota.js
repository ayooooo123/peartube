function safeNumber(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

export function computeIdentityWeight(identity = {}, now = Date.now()) {
  const createdAt = safeNumber(identity.createdAt, now)
  const ageMs = Math.max(0, now - createdAt)
  const ageScore = Math.min(40, Math.floor(ageMs / (24 * 60 * 60 * 1000)))
  const proofScore = Math.min(40, safeNumber(identity.validProofCount, 0) * 8)
  const failurePenalty = Math.min(50, safeNumber(identity.failureCount, 0) * 10)
  const activePenalty = identity.quarantined ? 20 : 0
  const base = 20 + ageScore + proofScore - failurePenalty - activePenalty
  return Math.max(0, Math.min(100, base))
}

export function createIdentityQuota(identity = {}, now = Date.now()) {
  const weight = computeIdentityWeight(identity, now)
  const fanout = Math.max(1, Math.floor(1 + weight / 15))
  const requests = Math.max(1, Math.floor(2 + weight / 20))
  const burst = Math.max(1, Math.floor(1 + weight / 10))
  return {
    weight,
    fanout,
    requests,
    burst,
    maxBytes: Math.max(16 * 1024, weight * 8192),
    minIntervalMs: Math.max(1000, 12000 - weight * 80),
  }
}

export function canSpendQuota(quota, amount = 1) {
  return safeNumber(quota?.remaining, 0) >= safeNumber(amount, 0)
}

export function createQuotaTracker(identity = {}, now = Date.now()) {
  const quota = createIdentityQuota(identity, now)
  let remaining = quota.burst
  let lastRefill = now

  const refill = (currentTime = Date.now()) => {
    const elapsed = Math.max(0, currentTime - lastRefill)
    if (elapsed <= 0) return remaining
    const refillCount = Math.floor(elapsed / quota.minIntervalMs)
    if (refillCount > 0) {
      remaining = Math.min(quota.burst, remaining + refillCount)
      lastRefill += refillCount * quota.minIntervalMs
    }
    return remaining
  }

  return {
    ...quota,
    get remaining() {
      return refill()
    },
    consume(amount = 1) {
      refill()
      if (remaining < amount) return false
      remaining -= amount
      return true
    },
    reset(value = quota.burst) {
      remaining = Math.max(0, Math.floor(value))
      lastRefill = Date.now()
    },
    refill,
  }
}

export function rateLimitFanout(peers, quota) {
  const limit = Math.max(1, safeNumber(quota?.fanout, 1))
  return Array.isArray(peers) ? peers.slice(0, limit) : []
}

export function shouldRequestMore(quota, pendingRequests = 0) {
  return pendingRequests < Math.max(1, safeNumber(quota?.requests, 1))
}

export default {
  computeIdentityWeight,
  createIdentityQuota,
  createQuotaTracker,
  canSpendQuota,
  rateLimitFanout,
  shouldRequestMore,
}
