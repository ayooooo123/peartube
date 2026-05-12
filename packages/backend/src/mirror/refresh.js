const DEFAULT_REFRESH_INTERVAL_MS = 15 * 60 * 1000
const DEFAULT_REFETCH_INTERVAL_MS = 60 * 60 * 1000
const DEFAULT_KEY_ROTATION_INTERVAL_MS = 6 * 60 * 60 * 1000
const DEFAULT_EPOCH_INTERVAL_MS = 10 * 60 * 1000

function safeNumber(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function safeBigInt(value, fallback = 0n) {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.max(0, Math.floor(value)))
  if (typeof value === 'string' && value.trim()) {
    try { return BigInt(value) } catch {}
  }
  return fallback
}

function toEpoch(now, intervalMs) {
  return Number((safeBigInt(now, BigInt(Date.now())) / BigInt(Math.max(1, intervalMs))) & 0xffffffffn)
}

export function computeMirrorRefreshPlan(record = {}, options = {}) {
  const now = safeBigInt(options.now, BigInt(Date.now()))
  const descriptor = record.descriptor || record
  const refreshIntervalMs = Math.max(1000, safeNumber(options.refreshIntervalMs, DEFAULT_REFRESH_INTERVAL_MS))
  const refetchIntervalMs = Math.max(refreshIntervalMs, safeNumber(options.refetchIntervalMs, DEFAULT_REFETCH_INTERVAL_MS))
  const keyRotationIntervalMs = Math.max(refreshIntervalMs, safeNumber(options.keyRotationIntervalMs, DEFAULT_KEY_ROTATION_INTERVAL_MS))
  const epochIntervalMs = Math.max(1000, safeNumber(options.epochIntervalMs, DEFAULT_EPOCH_INTERVAL_MS))
  const lastRefetchAt = safeBigInt(record.lastRefetchAt || record.refetchedAt || 0n, 0n)
  const lastRefreshAt = safeBigInt(record.lastRefreshAt || lastRefetchAt, 0n)
  const lastKeyRotationAt = safeBigInt(record.lastKeyRotationAt || 0n, 0n)
  const lastAvailabilityEpoch = safeNumber(record.lastAvailabilityEpoch ?? descriptor.availabilityEpoch, 0)
  const nextAvailabilityEpoch = toEpoch(now, epochIntervalMs)
  const expiresAt = safeBigInt(descriptor?.expiresAt, 0n)
  const proofAgeMs = safeBigInt(options.proofAgeMs, 10n * 60n * 1000n)
  const proofWindowExpired = expiresAt > 0n && now + BigInt(refreshIntervalMs) >= expiresAt
  const staleRefresh = lastRefreshAt === 0n || now - lastRefreshAt >= BigInt(refreshIntervalMs)
  const staleSource = lastRefetchAt === 0n || now - lastRefetchAt >= BigInt(refetchIntervalMs)
  const keyRotationDue = lastKeyRotationAt === 0n || now - lastKeyRotationAt >= BigInt(keyRotationIntervalMs)
  const epochChanged = lastAvailabilityEpoch !== nextAvailabilityEpoch
  const proofAgedOut = safeBigInt(record.lastProofAt || 0n, 0n) > 0n && now - safeBigInt(record.lastProofAt || 0n, 0n) >= proofAgeMs
  const shouldRefetchSource = Boolean(options.forceRefetch) || proofWindowExpired || staleSource || proofAgedOut
  const shouldRotateSigningKey = Boolean(options.forceRotateSigningKey) || keyRotationDue || epochChanged
  const shouldRefresh = Boolean(options.forceRefresh) || shouldRefetchSource || shouldRotateSigningKey || staleRefresh
  const nextRefreshAt = Number((now + BigInt(Math.min(refreshIntervalMs, refetchIntervalMs, keyRotationIntervalMs))) & 0xffffffffffffffffn)

  return {
    shouldRefresh,
    shouldRefetchSource,
    shouldRotateSigningKey,
    nextAvailabilityEpoch,
    nextRefreshAt,
    refreshIntervalMs,
    refetchIntervalMs,
    keyRotationIntervalMs,
    epochIntervalMs,
    staleRefresh,
  }
}

export function createMirrorRefreshPolicy(options = {}) {
  return {
    options: {
      refreshIntervalMs: options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS,
      refetchIntervalMs: options.refetchIntervalMs ?? DEFAULT_REFETCH_INTERVAL_MS,
      keyRotationIntervalMs: options.keyRotationIntervalMs ?? DEFAULT_KEY_ROTATION_INTERVAL_MS,
      epochIntervalMs: options.epochIntervalMs ?? DEFAULT_EPOCH_INTERVAL_MS,
    },
    plan(record = {}, nextOptions = {}) {
      return computeMirrorRefreshPlan(record, { ...this.options, ...nextOptions })
    },
    shouldRefresh(record = {}, nextOptions = {}) {
      return this.plan(record, nextOptions).shouldRefresh
    },
    shouldRefetchSource(record = {}, nextOptions = {}) {
      return this.plan(record, nextOptions).shouldRefetchSource
    },
    shouldRotateSigningKey(record = {}, nextOptions = {}) {
      return this.plan(record, nextOptions).shouldRotateSigningKey
    },
  }
}

export function createMirrorRefreshManager(options = {}) {
  const policy = createMirrorRefreshPolicy(options)
  const timers = new Set()
  let stopped = false

  const stop = () => {
    stopped = true
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
  }

  const schedule = (fn, delayMs) => {
    if (stopped) return null
    const timer = setTimeout(async () => {
      timers.delete(timer)
      if (stopped) return
      try { await fn() } catch {}
    }, Math.max(0, delayMs))
    timers.add(timer)
    return timer
  }

  const refresh = async (record, actions = {}) => {
    const plan = policy.plan(record, actions)
    if (!plan.shouldRefresh) return { refreshed: false, plan }

    const result = { refreshed: true, plan, refetched: false, rotatedSigningKey: false, rotatedAvailabilityEpoch: false }

    if (plan.shouldRefetchSource && typeof actions.refetchSource === 'function') {
      result.refetched = Boolean(await actions.refetchSource(record, plan))
    }

    if (plan.shouldRotateSigningKey && typeof actions.rotateSigningKey === 'function') {
      result.rotatedSigningKey = Boolean(await actions.rotateSigningKey(record, plan))
    }

    if ((plan.shouldRotateSigningKey || plan.shouldRefetchSource) && typeof actions.rotateAvailabilityEpoch === 'function') {
      result.rotatedAvailabilityEpoch = Boolean(await actions.rotateAvailabilityEpoch(record, plan))
    }

    return result
  }

  const tick = async ({ record, intervalMs = options.intervalMs || DEFAULT_REFRESH_INTERVAL_MS, ...actions } = {}) => {
    if (stopped) return null
    const outcome = await refresh(record, actions)
    if (outcome?.plan?.shouldRefresh && !stopped) {
      schedule(() => tick({ record, intervalMs, ...actions }), intervalMs)
    }
    return outcome
  }

  return {
    policy,
    refresh,
    tick,
    schedule,
    stop,
  }
}

export default {
  computeMirrorRefreshPlan,
  createMirrorRefreshPolicy,
  createMirrorRefreshManager,
}
