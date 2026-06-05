import c from 'compact-encoding'

import {
  DEFAULT_POLICY,
  ROLE_MOBILE,
  ROLE_RELAY,
  normalizeRole,
  safeNumber,
} from './universal-core-utils.js'

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function normalizeMemoryStats(stats = {}) {
  const memory = stats.memory || stats.mem || stats
  const rss = safeNumber(memory.rss ?? memory.residentSetSize, 0)
  const heapUsed = safeNumber(memory.heapUsed ?? memory.used, 0)
  const external = safeNumber(memory.external ?? memory.native ?? memory.arrayBuffers, 0)
  const total = safeNumber(memory.total ?? memory.heapTotal ?? memory.totalMemory ?? memory.limit, 0)
  const free = safeNumber(memory.free ?? memory.available ?? (total > 0 ? Math.max(0, total - Math.max(rss, heapUsed + external)) : 0), 0)
  const used = Math.max(rss, heapUsed + external)
  const pressure = total > 0 ? clamp((used / total) * 100, 0, 100) : clamp(safeNumber(memory.pressure, 0), 0, 100)
  return { rss, heapUsed, external, total, free, used, pressure }
}

async function readBareHcMemoryStats(source) {
  if (!source) return null
  if (typeof source === 'function') return normalizeMemoryStats(await source())
  for (const name of ['memoryStats', 'getMemoryStats', 'stats', 'getStats']) {
    if (typeof source[name] === 'function') {
      const stats = await source[name]()
      return normalizeMemoryStats(stats?.memory || stats)
    }
  }
  if (source.memory || source.rss || source.heapUsed) return normalizeMemoryStats(source)
  return null
}

export const budgetStateEncoding = {
  preencode(state, budget = {}) {
    c.uint.preencode(state, 1)
    c.string.preencode(state, String(budget.role || 'hybrid'))
    c.uint.preencode(state, Math.max(0, Math.floor(safeNumber(budget.memoryPressure, 0))))
    c.uint.preencode(state, Math.max(0, Math.floor(safeNumber(budget.maxFanout, 0))))
    c.uint.preencode(state, Math.max(0, Math.floor(safeNumber(budget.maxRequestsPerWindow, 0))))
    c.uint.preencode(state, Math.max(0, Math.floor(safeNumber(budget.maxFeedEntries, 0))))
    c.uint.preencode(state, Math.max(0, Math.floor(safeNumber(budget.maxConcurrentSync, 0))))
    c.uint.preencode(state, Math.max(0, Math.floor(safeNumber(budget.maxConcurrentProofs, 0))))
    c.uint.preencode(state, Math.max(0, Math.floor(safeNumber(budget.maxConcurrentFetches, 0))))
  },
  encode(state, budget = {}) {
    c.uint.encode(state, 1)
    c.string.encode(state, String(budget.role || 'hybrid'))
    c.uint.encode(state, Math.max(0, Math.floor(safeNumber(budget.memoryPressure, 0))))
    c.uint.encode(state, Math.max(0, Math.floor(safeNumber(budget.maxFanout, 0))))
    c.uint.encode(state, Math.max(0, Math.floor(safeNumber(budget.maxRequestsPerWindow, 0))))
    c.uint.encode(state, Math.max(0, Math.floor(safeNumber(budget.maxFeedEntries, 0))))
    c.uint.encode(state, Math.max(0, Math.floor(safeNumber(budget.maxConcurrentSync, 0))))
    c.uint.encode(state, Math.max(0, Math.floor(safeNumber(budget.maxConcurrentProofs, 0))))
    c.uint.encode(state, Math.max(0, Math.floor(safeNumber(budget.maxConcurrentFetches, 0))))
  },
  decode(state) {
    const version = c.uint.decode(state)
    if (version !== 1) throw new Error(`Unsupported budget state version ${version}`)
    return {
      role: c.string.decode(state),
      memoryPressure: c.uint.decode(state),
      maxFanout: c.uint.decode(state),
      maxRequestsPerWindow: c.uint.decode(state),
      maxFeedEntries: c.uint.decode(state),
      maxConcurrentSync: c.uint.decode(state),
      maxConcurrentProofs: c.uint.decode(state),
      maxConcurrentFetches: c.uint.decode(state),
    }
  },
}

export function encodeBudgetState(budget = {}) {
  return c.encode(budgetStateEncoding, budget)
}

export function decodeBudgetState(buffer) {
  if (!buffer) return null
  return c.decode(budgetStateEncoding, buffer)
}

export function createBudgetManager(options = {}) {
  const role = normalizeRole(options.role)
  const profile = { ...(role === ROLE_RELAY ? DEFAULT_POLICY.relay : DEFAULT_POLICY.mobile), ...(options.profile || {}) }
  const batteryFloor = safeNumber(options.batteryFloor, role === ROLE_RELAY ? 5 : 25)
  const bandwidthFloor = safeNumber(options.bandwidthFloor, role === ROLE_RELAY ? 0 : 5)
  const baseConcurrentSync = safeNumber(options.maxConcurrentSync, role === ROLE_RELAY ? 8 : 1)
  const baseConcurrentProofs = safeNumber(options.maxConcurrentProofs, role === ROLE_RELAY ? 4 : 1)
  const baseConcurrentFetches = safeNumber(options.maxConcurrentFetches, role === ROLE_RELAY ? 8 : 1)
  const memorySource = options.memoryStats || options.bareHc || options.libhc || null
  let memoryStats = normalizeMemoryStats(options.initialMemoryStats || {})
  let lastThresholds = null

  function thresholdsFor(stats = memoryStats) {
    const pressure = clamp(safeNumber(stats?.pressure, 0), 0, 100)
    const relief = pressure >= 90 ? 0.25 : pressure >= 80 ? 0.4 : pressure >= 65 ? 0.65 : pressure >= 45 ? 0.85 : 1
    const fanout = clamp((profile.maxFanout || 1) * relief, 1, profile.maxFanout || 1)
    const requests = clamp((profile.maxRequestsPerWindow || 1) * relief, 1, profile.maxRequestsPerWindow || 1)
    const feeds = clamp((profile.maxFeedEntries || 32) * relief, role === ROLE_RELAY ? 64 : 16, profile.maxFeedEntries || 32)
    return {
      role,
      memoryPressure: pressure,
      maxFanout: fanout,
      maxRequestsPerWindow: requests,
      maxFeedEntries: feeds,
      maxConcurrentSync: clamp(baseConcurrentSync * relief, 1, baseConcurrentSync),
      maxConcurrentProofs: clamp(baseConcurrentProofs * relief, 1, baseConcurrentProofs),
      maxConcurrentFetches: clamp(baseConcurrentFetches * relief, 1, baseConcurrentFetches),
    }
  }

  async function refreshMemoryStats(source = memorySource) {
    const next = await readBareHcMemoryStats(source)
    if (next) memoryStats = next
    lastThresholds = thresholdsFor(memoryStats)
    return { memoryStats, thresholds: lastThresholds }
  }

  function updateMemoryStats(stats = {}) {
    memoryStats = normalizeMemoryStats(stats)
    lastThresholds = thresholdsFor(memoryStats)
    return lastThresholds
  }

  function getThresholds(resource = {}) {
    const resourceStats = resource.memory || resource.memoryStats ? normalizeMemoryStats(resource.memory || resource.memoryStats) : memoryStats
    lastThresholds = thresholdsFor(resourceStats)
    return lastThresholds
  }

  function budgetFor(resource = {}) {
    const battery = safeNumber(resource.batteryPercent, 100)
    const bandwidth = safeNumber(resource.bandwidthScore, 100)
    const thermal = safeNumber(resource.thermalScore, 0)
    const charging = Boolean(resource.isCharging)
    const thresholds = getThresholds(resource)

    const mobilePenalty = role === ROLE_MOBILE ? Math.max(0, 30 - battery) + Math.max(0, 20 - bandwidth) + Math.max(0, thermal) : 0
    const memoryPenalty = Math.max(0, thresholds.memoryPressure - 70)
    const base = role === ROLE_RELAY ? 100 : 50
    const credit = Math.max(0, base - mobilePenalty - memoryPenalty + (charging ? 10 : 0))

    return {
      role,
      syncIntervalMs: profile.syncIntervalMs,
      proofIntervalMs: profile.proofIntervalMs,
      refreshIntervalMs: profile.refreshIntervalMs,
      maxFanout: thresholds.maxFanout,
      maxRequestsPerWindow: thresholds.maxRequestsPerWindow,
      maxFeedEntries: thresholds.maxFeedEntries,
      maxBytesPerDay: profile.maxBytesPerDay,
      batteryFloor,
      bandwidthFloor,
      maxConcurrentSync: thresholds.maxConcurrentSync,
      maxConcurrentProofs: thresholds.maxConcurrentProofs,
      maxConcurrentFetches: thresholds.maxConcurrentFetches,
      memoryPressure: thresholds.memoryPressure,
      memoryStats,
      credit,
      canSync: battery >= batteryFloor && bandwidth >= bandwidthFloor && thresholds.memoryPressure < 92,
      canEmitProof: battery >= Math.max(10, batteryFloor - 5) && bandwidth >= bandwidthFloor && thresholds.memoryPressure < 95,
      canFetch: battery >= Math.max(10, batteryFloor - 10) && bandwidth >= bandwidthFloor && thresholds.memoryPressure < 97,
    }
  }

  function snapshot() {
    const thresholds = lastThresholds || getThresholds()
    return { role, profile, memoryStats, thresholds }
  }

  return { role, profile, budgetFor, getThresholds, refreshMemoryStats, updateMemoryStats, snapshot, encodeBudgetState, decodeBudgetState }
}

export function createResourcePolicy(options = {}) {
  return createBudgetManager(options)
}
