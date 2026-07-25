function positiveInteger(value, fallback, minimum = 1) {
  return Number.isSafeInteger(value) && value >= minimum ? value : fallback
}

export function normalizeBudgetLimit(value, fallback) {
  return positiveInteger(value, fallback)
}

export function createWindowedIngestBudget(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const windowMs = positiveInteger(options.windowMs, 60_000)
  const maxTrackedKeys = positiveInteger(options.maxTrackedKeys, 4096)
  const usage = new Map()
  let windowStartedAt = Number(now())

  function refresh(current = Number(now())) {
    if (!Number.isFinite(current)) current = windowStartedAt
    if (current < windowStartedAt || current - windowStartedAt >= windowMs) {
      usage.clear()
      windowStartedAt = current
    }
    return current
  }

  function reserve(requirements = []) {
    const current = refresh()
    const pending = []
    const additions = new Map()
    for (const requirement of requirements) {
      if (!requirement || requirement.key == null) continue
      const limit = Number(requirement.limit)
      if (!Number.isSafeInteger(limit) || limit < 1) continue
      const units = positiveInteger(requirement.units, 1)
      const compositeKey = `${String(requirement.scope || 'default')}\0${String(requirement.key)}`
      const priorAddition = additions.get(compositeKey) || 0
      additions.set(compositeKey, priorAddition + units)
      pending.push({
        compositeKey,
        errorCode: String(requirement.errorCode || 'WINDOW_BUDGET_EXCEEDED'),
        limit,
      })
    }

    let newKeys = 0
    for (const compositeKey of additions.keys()) {
      if (!usage.has(compositeKey)) newKeys++
    }
    if (usage.size + newKeys > maxTrackedKeys) {
      return {
        accepted: false,
        errorCode: 'BUDGET_TRACKER_CAPACITY_EXCEEDED',
        resetAt: windowStartedAt + windowMs,
      }
    }

    const checked = new Set()
    for (const requirement of pending) {
      if (checked.has(requirement.compositeKey)) continue
      checked.add(requirement.compositeKey)
      const used = usage.get(requirement.compositeKey) || 0
      const requested = additions.get(requirement.compositeKey) || 0
      if (used + requested > requirement.limit) {
        return {
          accepted: false,
          errorCode: requirement.errorCode,
          resetAt: windowStartedAt + windowMs,
        }
      }
    }

    for (const [compositeKey, units] of additions) {
      usage.set(compositeKey, (usage.get(compositeKey) || 0) + units)
    }
    return {
      accepted: true,
      errorCode: null,
      resetAt: windowStartedAt + windowMs,
    }
  }

  return {
    reserve,
    resetAt() {
      refresh()
      return windowStartedAt + windowMs
    },
    size() {
      refresh()
      return usage.size
    },
  }
}
