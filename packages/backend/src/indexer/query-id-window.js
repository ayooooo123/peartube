import { MAX_INDEX_QUERY_DEADLINE_MS } from './query-codec.js'

const DEFAULT_MAX_SETTLED_QUERY_IDS = 1024
const MAX_SETTLED_QUERY_IDS = 4096

function boundedCount(value) {
  const count = Number(value ?? DEFAULT_MAX_SETTLED_QUERY_IDS)
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_SETTLED_QUERY_IDS) {
    throw new RangeError('maxSettledQueryIds is outside the bounded limit')
  }
  return count
}

function currentTime(limits) {
  const value = typeof limits.now === 'function' ? limits.now() : (limits.now ?? Date.now())
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('current time must be a non-negative safe integer')
  return value
}

export function createSettledQueryIdWindow(limits = {}) {
  const maximum = boundedCount(limits.maxSettledQueryIds)
  const settled = new Map()
  let timer = null
  let closed = false

  function clearTimer() {
    if (timer === null) return
    ;(limits.clearTimeout || clearTimeout)(timer)
    timer = null
  }

  function prune(now = currentTime(limits)) {
    for (const [queryId, expiresAt] of settled) {
      if (expiresAt <= now) settled.delete(queryId)
    }
  }

  function schedule() {
    clearTimer()
    if (closed || settled.size === 0) return
    let expiresAt = Infinity
    for (const value of settled.values()) expiresAt = Math.min(expiresAt, value)
    const delay = Math.max(1, expiresAt - currentTime(limits))
    timer = (limits.setTimeout || setTimeout)(() => {
      timer = null
      prune()
      schedule()
    }, delay)
    timer?.unref?.()
  }

  return Object.freeze({
    has(queryId) {
      prune()
      return settled.has(queryId)
    },
    canAdmit(inFlightCount = 0) {
      prune()
      return settled.size + inFlightCount < maximum
    },
    remember(queryId) {
      if (closed) return false
      prune()
      if (!settled.has(queryId) && settled.size >= maximum) return false
      settled.delete(queryId)
      settled.set(queryId, currentTime(limits) + MAX_INDEX_QUERY_DEADLINE_MS)
      schedule()
      return true
    },
    close() {
      if (closed) return false
      closed = true
      clearTimer()
      settled.clear()
      return true
    },
    get size() { return settled.size },
  })
}
