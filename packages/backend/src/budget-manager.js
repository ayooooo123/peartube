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

function normalizeCpuStats(stats = {}) {
  const cpu = stats.cpu || stats
  const usagePercent = clamp(safeNumber(cpu.usagePercent ?? cpu.percent ?? cpu.usage ?? cpu.busy, 0), 0, 100)
  const loadAverage = safeNumber(Array.isArray(cpu.loadAverage) ? cpu.loadAverage[0] : cpu.loadAverage ?? cpu.loadavg, 0)
  const pressure = clamp(safeNumber(cpu.pressure ?? usagePercent, usagePercent), 0, 100)
  return { usagePercent, loadAverage, pressure }
}

async function readBareHcMemoryStats(source) {
  if (!source) return null
  if (typeof source === 'function') return normalizeMemoryStats(await source())
  for (const name of ['memoryStats', 'getMemoryStats', 'stats', 'getStats', 'systemStats', 'getSystemStats']) {
    if (typeof source[name] === 'function') {
      const stats = await source[name]()
      return normalizeMemoryStats(stats?.memory || stats)
    }
  }
  if (source.memory || source.rss || source.heapUsed) return normalizeMemoryStats(source)
  return null
}

async function readBareHcCpuStats(source) {
  if (!source) return null
  if (typeof source === 'function') return normalizeCpuStats(await source())
  for (const name of ['cpuStats', 'getCpuStats', 'getCPUStats', 'stats', 'getStats', 'systemStats', 'getSystemStats']) {
    if (typeof source[name] === 'function') {
      const stats = await source[name]()
      return normalizeCpuStats(stats?.cpu || stats)
    }
  }
  if (source.cpu || source.usagePercent || source.loadAverage) return normalizeCpuStats(source)
  return null
}

export const budgetStateEncoding = {
  preencode(state, budget = {}) {
    c.uint.preencode(state, 2)
    c.string.preencode(state, String(budget.role || 'hybrid'))
    c.uint.preencode(state, Math.max(0, Math.floor(safeNumber(budget.memoryPressure, 0))))
    c.uint.preencode(state, Math.max(0, Math.floor(safeNumber(budget.cpuPressure, 0))))
    c.uint.preencode(state, Math.max(0, Math.floor(safeNumber(budget.maxFanout, 0))))
    c.uint.preencode(state, Math.max(0, Math.floor(safeNumber(budget.maxRequestsPerWindow, 0))))
    c.uint.preencode(state, Math.max(0, Math.floor(safeNumber(budget.maxFeedEntries, 0))))
    c.uint.preencode(state, Math.max(0, Math.floor(safeNumber(budget.maxConcurrentSync, 0))))
    c.uint.preencode(state, Math.max(0, Math.floor(safeNumber(budget.maxConcurrentProofs, 0))))
    c.uint.preencode(state, Math.max(0, Math.floor(safeNumber(budget.maxConcurrentFetches, 0))))
  },
  encode(state, budget = {}) {
    c.uint.encode(state, 2)
    c.string.encode(state, String(budget.role || 'hybrid'))
    c.uint.encode(state, Math.max(0, Math.floor(safeNumber(budget.memoryPressure, 0))))
    c.uint.encode(state, Math.max(0, Math.floor(safeNumber(budget.cpuPressure, 0))))
    c.uint.encode(state, Math.max(0, Math.floor(safeNumber(budget.maxFanout, 0))))
    c.uint.encode(state, Math.max(0, Math.floor(safeNumber(budget.maxRequestsPerWindow, 0))))
    c.uint.encode(state, Math.max(0, Math.floor(safeNumber(budget.maxFeedEntries, 0))))
    c.uint.encode(state, Math.max(0, Math.floor(safeNumber(budget.maxConcurrentSync, 0))))
    c.uint.encode(state, Math.max(0, Math.floor(safeNumber(budget.maxConcurrentProofs, 0))))
    c.uint.encode(state, Math.max(0, Math.floor(safeNumber(budget.maxConcurrentFetches, 0))))
  },
  decode(state) {
    const version = c.uint.decode(state)
    if (version !== 1 && version !== 2) throw new Error(`Unsupported budget state version ${version}`)
    const role = c.string.decode(state)
    const memoryPressure = c.uint.decode(state)
    const cpuPressure = version >= 2 ? c.uint.decode(state) : 0
    return {
      role,
      memoryPressure,
      cpuPressure,
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
  const systemSource = options.systemStats || options.bareHc || options.libhc || null
  const memorySource = options.memoryStats || systemSource
  const cpuSource = options.cpuStats || systemSource
  let memoryStats = normalizeMemoryStats(options.initialMemoryStats || {})
  let cpuStats = normalizeCpuStats(options.initialCpuStats || {})
  let lastThresholds = null

  function thresholdsFor(stats = memoryStats, cpu = cpuStats) {
    const memoryPressure = clamp(safeNumber(stats?.pressure, 0), 0, 100)
    const cpuPressure = clamp(safeNumber(cpu?.pressure ?? cpu?.usagePercent, 0), 0, 100)
    const pressure = Math.max(memoryPressure, Math.floor(cpuPressure * 0.75))
    const relief = pressure >= 90 ? 0.25 : pressure >= 80 ? 0.4 : pressure >= 65 ? 0.65 : pressure >= 45 ? 0.85 : 1
    const cpuRelief = cpuPressure >= 90 ? 0.45 : cpuPressure >= 75 ? 0.7 : 1
    const combinedRelief = Math.min(relief, cpuRelief)
    const fanout = clamp((profile.maxFanout || 1) * combinedRelief, 1, profile.maxFanout || 1)
    const requests = clamp((profile.maxRequestsPerWindow || 1) * combinedRelief, 1, profile.maxRequestsPerWindow || 1)
    const feeds = clamp((profile.maxFeedEntries || 32) * relief, role === ROLE_RELAY ? 64 : 16, profile.maxFeedEntries || 32)
    return {
      role,
      memoryPressure,
      cpuPressure,
      maxFanout: fanout,
      maxRequestsPerWindow: requests,
      maxFeedEntries: feeds,
      maxConcurrentSync: clamp(baseConcurrentSync * combinedRelief, 1, baseConcurrentSync),
      maxConcurrentProofs: clamp(baseConcurrentProofs * combinedRelief, 1, baseConcurrentProofs),
      maxConcurrentFetches: clamp(baseConcurrentFetches * relief, 1, baseConcurrentFetches),
    }
  }

  async function refreshMemoryStats(source = memorySource) {
    const next = await readBareHcMemoryStats(source)
    if (next) memoryStats = next
    lastThresholds = thresholdsFor(memoryStats, cpuStats)
    return { memoryStats, cpuStats, thresholds: lastThresholds }
  }

  async function refreshCpuStats(source = cpuSource) {
    const next = await readBareHcCpuStats(source)
    if (next) cpuStats = next
    lastThresholds = thresholdsFor(memoryStats, cpuStats)
    return { memoryStats, cpuStats, thresholds: lastThresholds }
  }

  async function refreshSystemStats() {
    await refreshMemoryStats(memorySource)
    await refreshCpuStats(cpuSource)
    lastThresholds = thresholdsFor(memoryStats, cpuStats)
    return { memoryStats, cpuStats, thresholds: lastThresholds }
  }

  function updateMemoryStats(stats = {}) {
    memoryStats = normalizeMemoryStats(stats)
    lastThresholds = thresholdsFor(memoryStats, cpuStats)
    return lastThresholds
  }

  function updateCpuStats(stats = {}) {
    cpuStats = normalizeCpuStats(stats)
    lastThresholds = thresholdsFor(memoryStats, cpuStats)
    return lastThresholds
  }

  function getThresholds(resource = {}) {
    const resourceStats = resource.memory || resource.memoryStats ? normalizeMemoryStats(resource.memory || resource.memoryStats) : memoryStats
    const resourceCpu = resource.cpu || resource.cpuStats ? normalizeCpuStats(resource.cpu || resource.cpuStats) : cpuStats
    lastThresholds = thresholdsFor(resourceStats, resourceCpu)
    return lastThresholds
  }

  function allocate(requested = {}, resource = {}) {
    const thresholds = getThresholds(resource)
    const feedIndexers = clamp(safeNumber(requested.feedIndexers ?? requested.maxFeedEntries, thresholds.maxFeedEntries), 1, thresholds.maxFeedEntries)
    const autobaseLinearizationBuffers = clamp(
      safeNumber(requested.autobaseLinearizationBuffers ?? requested.linearizationBuffers, thresholds.maxConcurrentSync * 8),
      1,
      Math.max(1, thresholds.maxConcurrentSync * 8),
    )
    const activeSwarmConnections = clamp(safeNumber(requested.activeSwarmConnections ?? requested.swarmConnections, thresholds.maxFanout), 1, thresholds.maxFanout)
    return {
      feedIndexers,
      autobaseLinearizationBuffers,
      activeSwarmConnections,
      maxConcurrentSync: thresholds.maxConcurrentSync,
      maxConcurrentProofs: thresholds.maxConcurrentProofs,
      maxConcurrentFetches: thresholds.maxConcurrentFetches,
      memoryPressure: thresholds.memoryPressure,
      cpuPressure: thresholds.cpuPressure,
    }
  }

  function budgetFor(resource = {}) {
    const battery = safeNumber(resource.batteryPercent, 100)
    const bandwidth = safeNumber(resource.bandwidthScore, 100)
    const thermal = safeNumber(resource.thermalScore, 0)
    const charging = Boolean(resource.isCharging)
    const thresholds = getThresholds(resource)

    const mobilePenalty = role === ROLE_MOBILE ? Math.max(0, 30 - battery) + Math.max(0, 20 - bandwidth) + Math.max(0, thermal) : 0
    const memoryPenalty = Math.max(0, thresholds.memoryPressure - 70)
    const cpuPenalty = Math.max(0, Math.floor((thresholds.cpuPressure - 75) / 2))
    const base = role === ROLE_RELAY ? 100 : 50
    const credit = Math.max(0, base - mobilePenalty - memoryPenalty - cpuPenalty + (charging ? 10 : 0))

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
      cpuPressure: thresholds.cpuPressure,
      memoryStats,
      cpuStats,
      allocation: allocate(resource.allocations || {}, resource),
      credit,
      canSync: battery >= batteryFloor && bandwidth >= bandwidthFloor && thresholds.memoryPressure < 92 && thresholds.cpuPressure < 96,
      canEmitProof: battery >= Math.max(10, batteryFloor - 5) && bandwidth >= bandwidthFloor && thresholds.memoryPressure < 95 && thresholds.cpuPressure < 98,
      canFetch: battery >= Math.max(10, batteryFloor - 10) && bandwidth >= bandwidthFloor && thresholds.memoryPressure < 97,
    }
  }

  function snapshot() {
    const thresholds = lastThresholds || getThresholds()
    return { role, profile, memoryStats, cpuStats, thresholds }
  }

  return {
    role,
    profile,
    budgetFor,
    getThresholds,
    allocate,
    refreshMemoryStats,
    refreshCpuStats,
    refreshSystemStats,
    updateMemoryStats,
    updateCpuStats,
    snapshot,
    encodeBudgetState,
    decodeBudgetState,
  }
}

export function createResourcePolicy(options = {}) {
  return createBudgetManager(options)
}
