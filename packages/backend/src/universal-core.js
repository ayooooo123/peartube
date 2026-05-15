/**
 * Universal Peartube Core
 *
 * Master "One Backend" skeleton for the Peartube 2.0 rewrite.
 *
 * All clients (mobile, desktop, relay) execute the exact same native backend core
 * and differ only in shell/UI concerns. Platform is an execution target, not a
 * behavioral fork.
 *
 * Goals:
 * - one universal HRPC surface with init/start/suspend/resume/shutdown hooks
 * - shared gossip, mirror/seed, and storage primitives
 * - partitioned main/shorts playback with resource gating and a unified event sink
 * - bare-build packaging into a single native artifact for mobile, desktop, and relay
 * - elimination of platform-specific P2P drift
 */

export const UNIVERSAL_CORE_VERSION = '0.2.0'

export const UNIVERSAL_CORE_PLATFORMS = Object.freeze({
  MOBILE: 'mobile',
  DESKTOP: 'desktop',
  RELAY: 'relay'
})

export const UNIVERSAL_CORE_STATES = Object.freeze({
  CREATED: 'created',
  INITIALIZING: 'initializing',
  INITIALIZED: 'initialized',
  STARTING: 'starting',
  STARTED: 'started',
  SUSPENDING: 'suspending',
  SUSPENDED: 'suspended',
  RESUMING: 'resuming',
  RESUMED: 'resumed',
  SHUTTING_DOWN: 'shutting_down',
  SHUTDOWN: 'shutdown'
})

const EVENT_PREFIX = 'universal-core:event:'
const SNAPSHOT_KEY = 'universal-core:snapshot'
const PLAYBACK_PREFIX = 'universal-core:playback:'

function assertOptions(options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('createUniversalCore(options) requires an options object')
  }
}

function noop() {}

function now() {
  return Date.now()
}

function safeJsonClone(value) {
  if (value == null) return value
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return value
  }
}

function toErrorMessage(error) {
  if (!error) return null
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  try {
    return String(error)
  } catch {
    return 'unknown error'
  }
}

function createId(prefix) {
  const random = Math.random().toString(16).slice(2)
  return `${prefix}${now().toString(36)}-${random}`
}

function normalizePlatform(platform) {
  if (platform === UNIVERSAL_CORE_PLATFORMS.MOBILE) return UNIVERSAL_CORE_PLATFORMS.MOBILE
  if (platform === UNIVERSAL_CORE_PLATFORMS.DESKTOP) return UNIVERSAL_CORE_PLATFORMS.DESKTOP
  return UNIVERSAL_CORE_PLATFORMS.RELAY
}

function resolveStep(target, names) {
  if (!target) return null
  for (const name of names) {
    const fn = target[name]
    if (typeof fn === 'function') return fn.bind(target)
  }
  return null
}

async function invokeIfPresent(target, names, ...args) {
  const fn = resolveStep(target, names)
  if (!fn) return null
  return await fn(...args)
}

async function loadModuleEntry(entry) {
  if (!entry) return null
  if (typeof entry === 'function') {
    try {
      return await entry()
    } catch {
      return entry
    }
  }
  if (entry && typeof entry.then === 'function') {
    return await entry
  }
  if (typeof entry === 'object' && entry.default && typeof entry.default === 'function') {
    return await entry.default()
  }
  return entry
}

async function resolveNativeModule(modules, name, fallbackNames = []) {
  const candidates = [modules?.[name], ...fallbackNames.map((key) => modules?.[key])]
  for (const candidate of candidates) {
    if (!candidate) continue
    const resolved = await loadModuleEntry(candidate)
    if (resolved) return resolved
  }
  return null
}

async function instantiateNativeRuntime(options, emit) {
  const loader = typeof options.loadNativeModules === 'function'
    ? options.loadNativeModules
    : async () => options.nativeModules || {}

  const loaded = await loader()
  const nativeModules = {
    libhc: await resolveNativeModule(loaded, 'libhc', ['hc', 'nativeCore']),
    libkv: await resolveNativeModule(loaded, 'libkv', ['kv', 'storageCore']),
    libudx: await resolveNativeModule(loaded, 'libudx', ['udx', 'networkCore'])
  }

  const runtime = {
    nativeModules,
    handles: {},
    async init(context) {
      for (const name of ['libhc', 'libkv', 'libudx']) {
        const module = nativeModules[name]
        if (!module) continue
        const handle = await createNativeHandle(name, module, context, emit)
        if (handle) runtime.handles[name] = handle
      }
      return runtime.handles
    },
    async start(context) {
      for (const name of ['libhc', 'libkv', 'libudx']) {
        await invokeIfPresent(runtime.handles[name], ['start', 'resume', 'open', 'boot'], context)
      }
      return runtime.handles
    },
    async suspend(context) {
      for (const name of ['libudx', 'libkv', 'libhc']) {
        await invokeIfPresent(runtime.handles[name], ['suspend', 'pause', 'stop'], context)
      }
      return runtime.handles
    },
    async resume(context) {
      for (const name of ['libhc', 'libkv', 'libudx']) {
        await invokeIfPresent(runtime.handles[name], ['resume', 'start', 'open', 'boot'], context)
      }
      return runtime.handles
    },
    async shutdown(context) {
      for (const name of ['libudx', 'libkv', 'libhc']) {
        await invokeIfPresent(runtime.handles[name], ['shutdown', 'close', 'stop', 'destroy'], context)
      }
      return runtime.handles
    }
  }

  emit('native:modules:resolved', {
    hasLibhc: Boolean(nativeModules.libhc),
    hasLibkv: Boolean(nativeModules.libkv),
    hasLibudx: Boolean(nativeModules.libudx)
  })

  return runtime
}

async function createNativeHandle(name, module, context, emit) {
  if (!module) return null

  let handle = module
  const factory =
    (typeof module === 'function' && module) ||
    (typeof module.create === 'function' && module.create) ||
    (typeof module.createService === 'function' && module.createService) ||
    (typeof module.createNativeCore === 'function' && module.createNativeCore) ||
    (typeof module.default === 'function' && module.default) ||
    null

  if (factory) {
    handle = await factory(context)
  }

  if (!handle || typeof handle !== 'object' && typeof handle !== 'function') {
    return null
  }

  emit('native:handle:created', { name, methods: Object.keys(handle).slice(0, 24) })
  await invokeIfPresent(handle, ['init', 'initialize', 'open'], context)
  return handle
}

function createAutobaseEventSink({ metaDb, platform, storagePath, onEvent = noop }) {
  let seq = 0
  let hydrated = false
  let currentSnapshot = null
  const recent = []

  async function hydrate() {
    if (hydrated) return currentSnapshot
    hydrated = true

    if (!metaDb || typeof metaDb.get !== 'function') {
      currentSnapshot = null
      return null
    }

    try {
      const snapshot = await metaDb.get(SNAPSHOT_KEY).catch(() => null)
      if (snapshot?.value) {
        currentSnapshot = snapshot.value
        seq = Number(currentSnapshot?.lastSeq || 0) || 0
      }
    } catch {
      currentSnapshot = null
    }

    return currentSnapshot
  }

  async function append(type, payload = {}, extra = {}) {
    await hydrate()
    seq += 1
    const record = {
      seq,
      type,
      platform,
      storagePath,
      at: now(),
      payload: safeJsonClone(payload),
      ...extra
    }

    recent.push(record)
    while (recent.length > 100) recent.shift()

    currentSnapshot = {
      ...(currentSnapshot || {}),
      platform,
      storagePath,
      lastSeq: seq,
      updatedAt: record.at,
      lastEventType: type,
      lastEvent: record,
      recent: recent.slice(-32)
    }

    if (metaDb && typeof metaDb.put === 'function') {
      const key = `${EVENT_PREFIX}${String(seq).padStart(12, '0')}`
      try {
        await metaDb.put(key, record)
      } catch {
        // best-effort persistence; the in-memory snapshot still advances.
      }
      try {
        await metaDb.put(SNAPSHOT_KEY, currentSnapshot)
      } catch {
        // best-effort persistence; the in-memory snapshot still advances.
      }
    }

    onEvent(record)
    return record
  }

  async function restore() {
    return await hydrate()
  }

  function snapshot() {
    return {
      lastSeq: seq,
      current: currentSnapshot ? safeJsonClone(currentSnapshot) : null,
      recent: recent.slice()
    }
  }

  return {
    hydrate,
    append,
    restore,
    snapshot
  }
}

function createPartitionedPlaybackContexts({
  resourceBudget = {},
  onEvent = noop,
  platform,
  storagePath,
  metaDb
}) {
  const state = {
    suspended: false,
    nextId: 1,
    active: new Map(),
    partitions: {
      main: {
        kind: 'main',
        priority: 2,
        maxConcurrent: resourceBudget.mainMaxConcurrent ?? 1,
        maxMemoryMb: resourceBudget.mainMaxMemoryMb ?? 512,
        maxBitrateMbps: resourceBudget.mainMaxBitrateMbps ?? 24,
        activeCount: 0,
        activeMemoryMb: 0,
        activeBitrateMbps: 0
      },
      shorts: {
        kind: 'shorts',
        priority: 1,
        maxConcurrent: resourceBudget.shortsMaxConcurrent ?? 1,
        maxMemoryMb: resourceBudget.shortsMaxMemoryMb ?? 192,
        maxBitrateMbps: resourceBudget.shortsMaxBitrateMbps ?? 8,
        activeCount: 0,
        activeMemoryMb: 0,
        activeBitrateMbps: 0
      }
    },
    total: {
      maxConcurrent: resourceBudget.totalMaxConcurrent ?? 2,
      maxMemoryMb: resourceBudget.totalMaxMemoryMb ?? 640,
      maxBitrateMbps: resourceBudget.totalMaxBitrateMbps ?? 32,
      activeCount: 0,
      activeMemoryMb: 0,
      activeBitrateMbps: 0
    }
  }

  function emit(type, detail = {}) {
    const record = {
      type,
      detail: safeJsonClone(detail),
      platform,
      storagePath,
      at: now()
    }
    onEvent(record)
    return record
  }

  function getPartition(kind) {
    return state.partitions[kind] || null
  }

  function computeGate(kind, request = {}) {
    const partition = getPartition(kind)
    if (!partition) {
      return { allowed: false, reason: `unknown partition: ${kind}` }
    }
    if (state.suspended) {
      return { allowed: false, reason: 'core suspended' }
    }

    const estimatedMemoryMb = Number(request.estimatedMemoryMb || 0) || 0
    const estimatedBitrateMbps = Number(request.estimatedBitrateMbps || 0) || 0
    const concurrent = state.total.activeCount
    const nextMemory = state.total.activeMemoryMb + estimatedMemoryMb
    const nextBitrate = state.total.activeBitrateMbps + estimatedBitrateMbps

    if (concurrent >= state.total.maxConcurrent) {
      return { allowed: false, reason: 'total concurrency budget exhausted' }
    }
    if (nextMemory > state.total.maxMemoryMb) {
      return { allowed: false, reason: 'total memory budget exhausted' }
    }
    if (nextBitrate > state.total.maxBitrateMbps) {
      return { allowed: false, reason: 'total bitrate budget exhausted' }
    }

    if (partition.activeCount >= partition.maxConcurrent) {
      return { allowed: false, reason: `${kind} concurrency budget exhausted` }
    }
    if (partition.activeMemoryMb + estimatedMemoryMb > partition.maxMemoryMb) {
      return { allowed: false, reason: `${kind} memory budget exhausted` }
    }
    if (partition.activeBitrateMbps + estimatedBitrateMbps > partition.maxBitrateMbps) {
      return { allowed: false, reason: `${kind} bitrate budget exhausted` }
    }

    if (kind === 'shorts' && state.partitions.main.activeCount > 0) {
      const shortsWeight = estimatedBitrateMbps + estimatedMemoryMb / 128
      const mainPressure = state.partitions.main.activeBitrateMbps + state.partitions.main.activeMemoryMb / 128
      if (mainPressure > 6 && shortsWeight > 2) {
        return { allowed: false, reason: 'shorts gated by main playback pressure' }
      }
    }

    return {
      allowed: true,
      reason: null,
      allocation: {
        memoryMb: estimatedMemoryMb,
        bitrateMbps: estimatedBitrateMbps
      }
    }
  }

  async function persistSnapshot() {
    if (!metaDb || typeof metaDb.put !== 'function') return
    const snapshot = getSnapshot()
    try {
      await metaDb.put(`${PLAYBACK_PREFIX}snapshot`, snapshot)
    } catch {
      // best-effort only
    }
  }

  function applyAllocation(kind, allocation) {
    const partition = getPartition(kind)
    partition.activeCount += 1
    partition.activeMemoryMb += allocation.memoryMb
    partition.activeBitrateMbps += allocation.bitrateMbps
    state.total.activeCount += 1
    state.total.activeMemoryMb += allocation.memoryMb
    state.total.activeBitrateMbps += allocation.bitrateMbps
  }

  function releaseAllocation(kind, allocation) {
    const partition = getPartition(kind)
    partition.activeCount = Math.max(0, partition.activeCount - 1)
    partition.activeMemoryMb = Math.max(0, partition.activeMemoryMb - allocation.memoryMb)
    partition.activeBitrateMbps = Math.max(0, partition.activeBitrateMbps - allocation.bitrateMbps)
    state.total.activeCount = Math.max(0, state.total.activeCount - 1)
    state.total.activeMemoryMb = Math.max(0, state.total.activeMemoryMb - allocation.memoryMb)
    state.total.activeBitrateMbps = Math.max(0, state.total.activeBitrateMbps - allocation.bitrateMbps)
  }

  async function acquire(kind, request = {}) {
    const gate = computeGate(kind, request)
    if (!gate.allowed) {
      emit('playback:gate-denied', { kind, request, reason: gate.reason })
      return { granted: false, reason: gate.reason, context: null }
    }

    const contextId = createId(`${kind}-`)
    const context = {
      id: contextId,
      kind,
      createdAt: now(),
      request: safeJsonClone(request),
      allocation: gate.allocation,
      state: 'active'
    }

    state.active.set(contextId, context)
    applyAllocation(kind, gate.allocation)
    emit('playback:acquired', { kind, contextId, request })
    await persistSnapshot()
    return { granted: true, reason: null, context }
  }

  async function release(contextOrId) {
    const contextId = typeof contextOrId === 'string' ? contextOrId : contextOrId?.id
    if (!contextId) return false
    const context = state.active.get(contextId)
    if (!context) return false

    state.active.delete(contextId)
    releaseAllocation(context.kind, context.allocation)
    emit('playback:released', { kind: context.kind, contextId })
    await persistSnapshot()
    return true
  }

  async function suspend() {
    state.suspended = true
    emit('playback:suspended')
    await persistSnapshot()
  }

  async function resume() {
    state.suspended = false
    emit('playback:resumed')
    await persistSnapshot()
  }

  function getSnapshot() {
    const partitions = {}
    for (const [kind, partition] of Object.entries(state.partitions)) {
      partitions[kind] = {
        kind,
        priority: partition.priority,
        maxConcurrent: partition.maxConcurrent,
        maxMemoryMb: partition.maxMemoryMb,
        maxBitrateMbps: partition.maxBitrateMbps,
        activeCount: partition.activeCount,
        activeMemoryMb: partition.activeMemoryMb,
        activeBitrateMbps: partition.activeBitrateMbps
      }
    }

    return {
      suspended: state.suspended,
      total: { ...state.total },
      partitions,
      active: Array.from(state.active.values()).map((item) => ({
        id: item.id,
        kind: item.kind,
        createdAt: item.createdAt,
        state: item.state,
        request: safeJsonClone(item.request),
        allocation: { ...item.allocation }
      }))
    }
  }

  return {
    computeGate,
    acquire,
    release,
    suspend,
    resume,
    getSnapshot
  }
}

function buildLifecycleBridge(target, emit) {
  return {
    async init(context) {
      await invokeIfPresent(target, ['init', 'initialize', 'open'], context)
      emit('backend:lifecycle:init', {})
    },
    async start(context) {
      await invokeIfPresent(target, ['start', 'resume', 'open'], context)
      emit('backend:lifecycle:start', {})
    },
    async suspend(context) {
      await invokeIfPresent(target, ['suspend', 'pause'], context)
      emit('backend:lifecycle:suspend', {})
    },
    async resume(context) {
      await invokeIfPresent(target, ['resume', 'start'], context)
      emit('backend:lifecycle:resume', {})
    },
    async shutdown(context) {
      await invokeIfPresent(target, ['shutdown', 'close', 'stop', 'destroy'], context)
      emit('backend:lifecycle:shutdown', {})
    }
  }
}

async function withPlaybackLease(playback, kind, request, task) {
  if (!playback || typeof playback.acquire !== 'function') {
    return await task({ granted: true, context: null })
  }

  const lease = await playback.acquire(kind, request)
  if (!lease?.granted) {
    return await task({ granted: false, reason: lease?.reason || 'lease denied', context: null })
  }

  try {
    return await task({ granted: true, context: lease.context || null })
  } finally {
    try {
      if (lease.context) await playback.release(lease.context)
    } catch {
      // best effort
    }
  }
}

function summarizeFeedEntries(entries = []) {
  const list = Array.isArray(entries) ? entries : []
  const previewVideos = list.reduce((count, entry) => count + (Array.isArray(entry?.previewVideos) ? entry.previewVideos.length : 0), 0)
  return {
    entries: list.length,
    localEntries: list.filter((entry) => entry?.source === 'local').length,
    relayServingEntries: list.filter((entry) => Boolean(entry?.relayServing)).length,
    previewVideos
  }
}

function createRelayStorageService({ backend, eventSink, playback, nativeRuntime, platform, storagePath }) {
  const ctx = backend?.ctx || null
  let started = false
  let suspended = false

  function snapshot(extra = {}) {
    return {
      platform,
      storagePath,
      started,
      suspended,
      hasStore: Boolean(ctx?.store),
      hasMetaDb: Boolean(ctx?.metaDb),
      hasSwarm: Boolean(ctx?.swarm),
      hasBlobServer: Boolean(ctx?.blobServer),
      blobServerPort: ctx?.blobServer?.port || ctx?.blobServerPort || null,
      swarmConnections: ctx?.swarm?.connections?.size || 0,
      discoveryHandles: ctx?._swarmDiscoveryHandles?.size || 0,
      native: {
        libhc: Boolean(nativeRuntime?.nativeModules?.libhc),
        libkv: Boolean(nativeRuntime?.nativeModules?.libkv),
        libudx: Boolean(nativeRuntime?.nativeModules?.libudx)
      },
      ...extra
    }
  }

  function createContext(phase, detail = {}) {
    return {
      kind: "gossip",
      phase,
      platform,
      storagePath,
      backend,
      api,
      publicFeed,
      playback,
      eventSink,
      resourcePool: "main",
      modules: serviceModules,
      ...detail
    }
  }

  async function emit(type, detail = {}) {
    if (!eventSink) return
    await eventSink.append(type, snapshot(detail))
  }

  async function runLifecycle(phase, detail = {}) {
    const context = createContext(phase, detail)
    await Promise.all([
      invokeServiceLifecycle(serviceModules.bloom, phase, context),
      invokeServiceLifecycle(serviceModules.quota, phase, context),
      invokeServiceLifecycle(serviceModules.sync, phase, context)
    ])
  }

  async function start() {
    started = true
    suspended = false
    await emit('storage.start', { phase: 'begin' })
    await nativeRuntime?.start?.({ backend, services: backend?.services || null, platform, storagePath, ctx })
    await ctx?.swarm?.resume?.()
    await ctx?.blobServer?.resume?.()
    await emit('storage.start', { phase: 'complete' })
    return snapshot()
  }

  async function refresh(reason = 'manual') {
    return await withPlaybackLease(playback, 'main', {
      estimatedMemoryMb: 12,
      estimatedBitrateMbps: 0.5,
      reason: `storage:${reason}`
    }, async ({ granted, reason: deniedReason }) => {
      const extra = { reason, granted, deniedReason: deniedReason || null }
      await emit('storage.refresh', extra)
      return snapshot(extra)
    })
  }

  async function suspend() {
    suspended = true
    await emit('storage.suspend', { phase: 'begin' })
    await nativeRuntime?.suspend?.({ backend, services: backend?.services || null, platform, storagePath, ctx })
    await ctx?.blobServer?.suspend?.()
    await ctx?.swarm?.suspend?.()
    await emit('storage.suspend', { phase: 'complete' })
    return snapshot()
  }

  async function resume() {
    suspended = false
    await emit('storage.resume', { phase: 'begin' })
    await nativeRuntime?.resume?.({ backend, services: backend?.services || null, platform, storagePath, ctx })
    await ctx?.swarm?.resume?.()
    await ctx?.blobServer?.resume?.()
    await emit('storage.resume', { phase: 'complete' })
    return snapshot()
  }

  async function shutdown() {
    await emit('storage.shutdown', { phase: 'begin' })
    await nativeRuntime?.shutdown?.({ backend, services: backend?.services || null, platform, storagePath, ctx })
    await emit('storage.shutdown', { phase: 'complete' })
    return snapshot()
  }

  return {
    init: async () => {
      await runLifecycle('init')
      return snapshot()
    },
    start,
    refresh,
    suspend,
    resume,
    shutdown,
    getStatus() {
      return snapshot()
    }
  }
}

function normalizeServiceModules(modules = {}) {
  return {
    bloom: modules?.bloom ?? modules?.gossipBloom ?? null,
    quota: modules?.quota ?? modules?.gossipQuota ?? null,
    sync: modules?.sync ?? modules?.gossipSync ?? null,
    autobase: modules?.autobase ?? modules?.mirrorAutobase ?? null,
    fetcher: modules?.fetcher ?? modules?.mirrorFetcher ?? null,
    refresh: modules?.refresh ?? modules?.mirrorRefresh ?? null
  }
}

function summarizeServiceModule(module) {
  if (!module) return null
  const summary = {
    available: true,
    type: typeof module,
    name: module?.name ?? module?.constructor?.name ?? null,
    hasStatus: typeof module?.getStatus === "function" || typeof module?.status === "function" || typeof module?.snapshot === "function"
  }
  try {
    if (typeof module?.state !== "undefined") summary.state = module.state
    if (typeof module?.status !== "undefined" && typeof module?.status !== "function") summary.status = safeJsonClone(module.status)
    if (typeof module?.snapshot === "function") summary.snapshot = safeJsonClone(module.snapshot())
  } catch {
    // best effort summary only
  }
  return summary
}

async function resolveServiceTarget(entry, context) {
  if (!entry) return null
  if (entry && typeof entry.then === "function") return await entry
  if (typeof entry === "function") {
    try {
      return await entry(context)
    } catch {
      try {
        return await entry()
      } catch {
        return entry
      }
    }
  }
  return entry?.default ?? entry
}

async function invokeServiceLifecycle(entry, phase, context, aliases = []) {
  const target = await resolveServiceTarget(entry, context)
  if (!target) return { called: false, result: null }

  const candidateNames = [phase].concat(aliases || [])
  for (const name of candidateNames) {
    const fn = resolveStep(target, [name])
    if (fn) {
      const result = await fn(context)
      return { called: true, result }
    }
  }

  return { called: false, result: null }
}
function createRelayGossipService({ backend, eventSink, playback, platform, storagePath, modules = null }) {
  const publicFeed = backend?.publicFeed || null
  const api = backend?.api || null
  const serviceModules = normalizeServiceModules(modules)
  let started = false
  let syncCount = 0

  function snapshot(extra = {}) {
    const feedEntries = publicFeed?.getFeed?.() || []
    const feedStats = publicFeed?.getStats?.() || {}
    return {
      platform,
      storagePath,
      started,
      syncCount,
      feed: summarizeFeedEntries(feedEntries),
      bloom: {
        discoveredPeers: feedStats.rememberedPeerCandidates || 0,
        feedConnections: feedStats.feedConnections || 0,
        openConnections: feedStats.feedConnections || 0
      },
      quota: {
        maxConcurrent: playback?.getSnapshot?.()?.partitions?.main?.maxConcurrent ?? null,
        activeCount: playback?.getSnapshot?.()?.partitions?.main?.activeCount ?? null
      },
      modules: {
        bloom: summarizeServiceModule(serviceModules.bloom),
        quota: summarizeServiceModule(serviceModules.quota),
        sync: summarizeServiceModule(serviceModules.sync)
      },
      ...extra
    }
  }

  function createContext(phase, detail = {}) {
    return {
      kind: 'gossip',
      phase,
      platform,
      storagePath,
      backend,
      api,
      publicFeed,
      playback,
      eventSink,
      resourcePool: 'main',
      modules: serviceModules,
      ...detail
    }
  }

  async function emit(type, detail = {}) {
    if (!eventSink) return
    await eventSink.append(type, snapshot(detail))
  }

  async function runLifecycle(phase, detail = {}) {
    const context = createContext(phase, detail)
    await Promise.all([
      invokeServiceLifecycle(serviceModules.bloom, phase, context),
      invokeServiceLifecycle(serviceModules.quota, phase, context),
      invokeServiceLifecycle(serviceModules.sync, phase, context)
    ])
  }

  async function start() {
    started = true
    await emit('gossip.start', { phase: 'begin' })
    await runLifecycle('start')
    await publicFeed?.start?.()
    await sync('start')
    await emit('gossip.start', { phase: 'complete' })
    return snapshot()
  }

  async function sync(reason = 'manual') {
    if (!publicFeed) {
      await emit('gossip.sync', { reason, skipped: true, why: 'missing publicFeed' })
      return snapshot({ reason, skipped: true })
    }

    const context = createContext('sync', { reason })
    const moduleInvocation = await invokeServiceLifecycle(serviceModules.sync, 'sync', context, ['refresh'])
    if (moduleInvocation.called && moduleInvocation.result != null) {
      const detail = { reason, moduleUsed: true, moduleResult: safeJsonClone(moduleInvocation.result) }
      await emit('gossip.sync', detail)
      return snapshot(detail)
    }

    return await withPlaybackLease(playback, 'main', {
      estimatedMemoryMb: 10,
      estimatedBitrateMbps: 1,
      reason: `gossip:${reason}`
    }, async ({ granted, reason: deniedReason }) => {
      if (!granted) {
        await emit('gossip.sync', { reason, skipped: true, deniedReason })
        return snapshot({ reason, skipped: true, deniedReason })
      }

      syncCount += 1
      const requested = typeof publicFeed.requestFeedsFromPeers === 'function'
        ? publicFeed.requestFeedsFromPeers()
        : 0
      const feedEntries = publicFeed.getFeed?.() || []
      const snapshotEntries = typeof api?.getFeedSnapshotEntries === 'function'
        ? await api.getFeedSnapshotEntries(feedEntries, { limitPerChannel: 3 })
        : feedEntries

      const detail = {
        reason,
        requested,
        moduleUsed: moduleInvocation.called,
        feed: summarizeFeedEntries(feedEntries),
        snapshotEntries: Array.isArray(snapshotEntries) ? snapshotEntries.length : 0,
        stats: publicFeed.getStats?.() || null
      }

      await emit('gossip.sync', detail)
      return snapshot(detail)
    })
  }

  async function refresh(reason = 'manual') {
    await emit('gossip.refresh', { reason })
    return await sync(reason)
  }

  async function suspend() {
    started = false
    await emit('gossip.suspend', { phase: 'begin' })
    await runLifecycle('suspend')
    await publicFeed?.stop?.()
    await emit('gossip.suspend', { phase: 'complete' })
    return snapshot()
  }

  async function resume() {
    started = true
    await emit('gossip.resume', { phase: 'begin' })
    await runLifecycle('resume')
    await publicFeed?.start?.()
    await sync('resume')
    await emit('gossip.resume', { phase: 'complete' })
    return snapshot()
  }

  async function shutdown() {
    started = false
    await emit('gossip.shutdown', { phase: 'begin' })
    await runLifecycle('shutdown')
    await publicFeed?.stop?.()
    await emit('gossip.shutdown', { phase: 'complete' })
    return snapshot()
  }

  return {
    init: async () => {
      await runLifecycle('init')
      return snapshot()
    },
    start,
    sync,
    refresh,
    suspend,
    resume,
    shutdown,
    getStatus() {
      return snapshot()
    }
  }
}

function createRelayMirrorSeedService({ backend, eventSink, playback, platform, storagePath, modules = null }) {
  const publicFeed = backend?.publicFeed || null
  const seedingManager = backend?.seedingManager || null
  const serviceModules = normalizeServiceModules(modules)
  let started = false
  let refreshTimer = null
  let lastRefreshAt = null
  let refreshCount = 0
  const refreshIntervalMs = 30000

  function snapshot(extra = {}) {
    return {
      platform,
      storagePath,
      started,
      refreshCount,
      lastRefreshAt,
      refreshIntervalMs,
      seeds: typeof seedingManager?.getActiveSeeds === 'function' ? seedingManager.getActiveSeeds().length : 0,
      pinnedChannels: typeof seedingManager?.getPinnedChannels === 'function' ? seedingManager.getPinnedChannels().length : 0,
      modules: {
        autobase: summarizeServiceModule(serviceModules.autobase),
        fetcher: summarizeServiceModule(serviceModules.fetcher),
        refresh: summarizeServiceModule(serviceModules.refresh)
      },
      ...extra
    }
  }

  function createContext(phase, detail = {}) {
    return {
      kind: 'mirror',
      phase,
      platform,
      storagePath,
      backend,
      publicFeed,
      seedingManager,
      playback,
      eventSink,
      resourcePool: 'shorts',
      modules: serviceModules,
      ...detail
    }
  }

  async function emit(type, detail = {}) {
    if (!eventSink) return
    await eventSink.append(type, snapshot(detail))
  }

  async function runLifecycle(phase, detail = {}) {
    const context = createContext(phase, detail)
    await Promise.all([
      invokeServiceLifecycle(serviceModules.autobase, phase, context),
      invokeServiceLifecycle(serviceModules.fetcher, phase, context),
      invokeServiceLifecycle(serviceModules.refresh, phase, context)
    ])
  }

  function clearRefreshTimer() {
    if (refreshTimer) clearInterval(refreshTimer)
    refreshTimer = null
  }

  function collectSeedJobs(feedEntries = []) {
    const jobs = []
    for (const entry of Array.isArray(feedEntries) ? feedEntries : []) {
      const previewVideos = Array.isArray(entry?.previewVideos) ? entry.previewVideos.slice(0, 3) : []
      for (const video of previewVideos) {
        const driveKey = entry?.driveKey || video?.driveKey || video?.channelKey || null
        const videoPath = video?.videoPath || video?.path || video?.id || video?.name || null
        if (!driveKey || !videoPath) continue
        jobs.push({
          driveKey,
          videoPath,
          reason: entry?.source === 'local' ? 'pinned' : (entry?.relayServing ? 'subscribed' : 'watched'),
          blobInfo: {
            blockLength: video?.blockLength || video?.blocks || 0,
            byteLength: video?.byteLength || video?.bytes || 0,
            publicBeeKey: entry?.publicBeeKey || video?.publicBeeKey || null,
            blobId: video?.blobId || null,
            blobsCoreKey: video?.blobsCoreKey || null,
            thumbnailBlobId: video?.thumbnailBlobId || null,
            thumbnailBlobsCoreKey: video?.thumbnailBlobsCoreKey || null,
            mimeType: video?.mimeType || null,
            thumbnailMimeType: video?.thumbnailMimeType || null
          }
        })
      }
    }
    return jobs
  }

  async function refresh(reason = 'manual') {
    const context = createContext('refresh', { reason })
    const moduleInvocation = await invokeServiceLifecycle(serviceModules.refresh, 'refresh', context, ['sync'])
    if (moduleInvocation.called && moduleInvocation.result != null) {
      const detail = { reason, moduleUsed: true, moduleResult: safeJsonClone(moduleInvocation.result) }
      await emit('mirror.refresh', detail)
      return snapshot(detail)
    }

    if (!seedingManager) {
      await emit('mirror.refresh', { reason, skipped: true, why: 'missing seedingManager' })
      return snapshot({ reason, skipped: true })
    }

    return await withPlaybackLease(playback, 'shorts', {
      estimatedMemoryMb: 24,
      estimatedBitrateMbps: 4,
      reason: `mirror:${reason}`
    }, async ({ granted, reason: deniedReason }) => {
      if (!granted) {
        await emit('mirror.refresh', { reason, skipped: true, deniedReason })
        return snapshot({ reason, skipped: true, deniedReason })
      }

      refreshCount += 1
      lastRefreshAt = now()
      const feedEntries = publicFeed?.getFeed?.() || []
      const seedJobs = collectSeedJobs(feedEntries)
      const desiredSeedKeys = new Set(seedJobs.map((job) => `${job.driveKey}:${job.videoPath}`))
      const existingSeeds = typeof seedingManager.getActiveSeeds === 'function' ? seedingManager.getActiveSeeds() : []
      const pinnedChannels = new Set(typeof seedingManager.getPinnedChannels === 'function' ? seedingManager.getPinnedChannels() : [])

      let added = 0
      let removed = 0
      let pinned = 0

      for (const seed of existingSeeds) {
        const key = `${seed.driveKey}:${seed.videoPath}`
        if (desiredSeedKeys.has(key)) continue
        if (seed.reason === 'pinned' || pinnedChannels.has(seed.driveKey)) continue
        try {
          if (typeof seedingManager.removeSeed === 'function') {
            await seedingManager.removeSeed(seed.driveKey, seed.videoPath)
            removed += 1
          }
        } catch {
          // best effort
        }
      }

      for (const job of seedJobs) {
        try {
          if (job.reason === 'pinned' && typeof seedingManager.pinChannel === 'function') {
            await seedingManager.pinChannel(job.driveKey)
            pinned += 1
          }
          const changed = await seedingManager.addSeed(job.driveKey, job.videoPath, job.reason, job.blobInfo)
          if (changed) added += 1
        } catch {
          // best effort
        }
      }

      if (typeof seedingManager.enforceQuota === 'function') {
        try { await seedingManager.enforceQuota() } catch { /* best effort */ }
      }

      await runLifecycle('refresh', {
        feedEntries: feedEntries.length,
        seedJobs: seedJobs.length,
        added,
        removed,
        pinned
      })

      const detail = {
        reason,
        moduleUsed: moduleInvocation.called,
        feedEntries: feedEntries.length,
        seedJobs: seedJobs.length,
        added,
        removed,
        pinned,
        status: typeof seedingManager.getStatus === 'function' ? await seedingManager.getStatus() : null
      }

      await emit('mirror.refresh', detail)
      return snapshot(detail)
    })
  }

  async function start() {
    started = true
    await emit('mirror.start', { phase: 'begin' })
    await runLifecycle('start')
    clearRefreshTimer()
    await refresh('start')
    refreshTimer = setInterval(() => {
      refresh('interval').catch(() => {})
    }, refreshIntervalMs)
    if (typeof refreshTimer?.unref === 'function') refreshTimer.unref()
    await emit('mirror.start', { phase: 'complete' })
    return snapshot()
  }

  async function suspend() {
    started = false
    await emit('mirror.suspend', { phase: 'begin' })
    await runLifecycle('suspend')
    clearRefreshTimer()
    await emit('mirror.suspend', { phase: 'complete' })
    return snapshot()
  }

  async function resume() {
    started = true
    await emit('mirror.resume', { phase: 'begin' })
    await runLifecycle('resume')
    clearRefreshTimer()
    await refresh('resume')
    refreshTimer = setInterval(() => {
      refresh('interval').catch(() => {})
    }, refreshIntervalMs)
    if (typeof refreshTimer?.unref === 'function') refreshTimer.unref()
    await emit('mirror.resume', { phase: 'complete' })
    return snapshot()
  }

  async function shutdown() {
    started = false
    await emit('mirror.shutdown', { phase: 'begin' })
    await runLifecycle('shutdown')
    clearRefreshTimer()
    await emit('mirror.shutdown', { phase: 'complete' })
    return snapshot()
  }

  return {
    start,
    refresh,
    suspend,
    resume,
    shutdown,
    getStatus() {
      return snapshot()
    }
  }
}


/**
 * Create the universal core lifecycle controller.
 *
 * This controller owns the shared backend lifecycle for every platform and is
 * the only place where universal state, HRPC, storage, gossip, and playback
 * orchestration are composed.
 */
export function createUniversalCore(options = {}) {
  assertOptions(options)

  const {
    platform = UNIVERSAL_CORE_PLATFORMS.RELAY,
    hrpc = null,
    runtime = null,
    storagePath = '',
    resourceBudget = {},
    onEvent = noop,
    onStateChange = noop,
    createBackendContext = null,
    createGossipService = null,
    createMirrorSeedWorker = null,
    createStorageService = null,
    createSwarmService = null,
    gossipModules = null,
    mirrorModules = null,
    loadNativeModules = null,
    nativeModules = null
  } = options

  const normalizedPlatform = normalizePlatform(platform)

  let state = UNIVERSAL_CORE_STATES.CREATED
  let backend = null
  let eventSink = null
  let playback = null
  let nativeRuntime = null
  let lifecycle = null
  let services = {
    gossip: null,
    mirrorSeed: null,
    storage: null,
    swarm: null,
    native: null,
    playback: null,
    eventSink: null
  }
  let initPromise = null
  let shutdownRequested = false

  function emit(event, detail = {}) {
    const record = {
      event,
      detail: safeJsonClone(detail),
      state,
      platform: normalizedPlatform,
      storagePath,
      at: now()
    }
    onEvent(record)
    return record
  }

  function setState(nextState, detail = {}) {
    state = nextState
    onStateChange({ state, platform: normalizedPlatform, storagePath, detail: safeJsonClone(detail) })
  }

  async function initializeNative() {
    nativeRuntime = await instantiateNativeRuntime(
      { loadNativeModules, nativeModules },
      emit
    )
    services.native = nativeRuntime
    return nativeRuntime
  }

  async function initializeBackend() {
    const resolvedCreateBackendContext = typeof createBackendContext === 'function'
      ? createBackendContext
      : (await import('./orchestrator.js')).createBackendContext

    if (typeof resolvedCreateBackendContext !== 'function') {
      throw new Error('createUniversalCore requires createBackendContext')
    }

    backend = await resolvedCreateBackendContext({
      storagePath,
      platform: normalizedPlatform,
      hrpc,
      runtime,
      onStatsUpdate: options.onStatsUpdate,
      onFeedUpdate: options.onFeedUpdate,
      blobServerHost: options.blobServerHost,
      blobServerBindHost: options.blobServerBindHost,
      corestoreWaitForLock: options.corestoreWaitForLock,
      disableStandalonePrimaryKeyFile: options.disableStandalonePrimaryKeyFile,
      ipcLog: typeof options.ipcLog === 'function' ? options.ipcLog : noop
    })

    return backend
  }

  async function initializeServices() {
    const ctx = backend?.ctx || null
    eventSink = createAutobaseEventSink({
      metaDb: ctx?.metaDb || null,
      platform: normalizedPlatform,
      storagePath,
      onEvent: (record) => emit('autobase:event', record)
    })

    playback = createPartitionedPlaybackContexts({
      resourceBudget,
      onEvent: (record) => emit('playback:event', record),
      platform: normalizedPlatform,
      storagePath,
      metaDb: ctx?.metaDb || null
    })

    services.eventSink = eventSink
    services.playback = playback

    const storageFactory = typeof createStorageService === 'function'
      ? createStorageService
      : (args) => createRelayStorageService({ ...args, eventSink, playback, nativeRuntime, platform: normalizedPlatform, storagePath })

    const gossipFactory = typeof createGossipService === 'function'
      ? createGossipService
      : (args) => createRelayGossipService({ ...args, eventSink, playback, platform: normalizedPlatform, storagePath, modules: gossipModules })

    const mirrorSeedFactory = typeof createMirrorSeedWorker === 'function'
      ? createMirrorSeedWorker
      : (args) => createRelayMirrorSeedService({ ...args, eventSink, playback, platform: normalizedPlatform, storagePath, modules: mirrorModules })

    services.storage = await storageFactory({ backend, platform: normalizedPlatform, hrpc, runtime, storagePath, ctx, nativeRuntime, eventSink, playback })
    services.swarm = typeof createSwarmService === 'function'
      ? await createSwarmService({ backend, platform: normalizedPlatform, hrpc, runtime, storagePath, ctx })
      : ctx?.swarm || null
    services.gossip = await gossipFactory({ backend, platform: normalizedPlatform, hrpc, runtime, storagePath, ctx })
    services.mirrorSeed = await mirrorSeedFactory({ backend, platform: normalizedPlatform, hrpc, runtime, storagePath, ctx })

    lifecycle = {
      backend: buildLifecycleBridge(backend, emit),
      native: nativeRuntime,
      playback,
      eventSink,
      storage: services.storage,
      gossip: services.gossip,
      mirrorSeed: services.mirrorSeed
    }

    return services
  }

  async function writeStateEvent(type, payload = {}) {
    if (eventSink) {
      await eventSink.append(type, payload)
    }
  }

  async function init() {
    if (backend) return backend
    if (initPromise) return initPromise

    initPromise = (async () => {
      setState(UNIVERSAL_CORE_STATES.INITIALIZING)
      emit('init:start', { platform: normalizedPlatform })

      await initializeNative()
      await initializeBackend()
      await initializeServices()
      await Promise.all([
        invokeIfPresent(services.gossip, ['init'], { backend, services, platform: normalizedPlatform, storagePath }),
        invokeIfPresent(services.mirrorSeed, ['init'], { backend, services, platform: normalizedPlatform, storagePath })
      ])
      await eventSink.restore()
      await writeStateEvent('core.initialized', {
        platform: normalizedPlatform,
        storagePath,
        hasMetaDb: Boolean(backend?.ctx?.metaDb),
        hasSwarm: Boolean(backend?.ctx?.swarm)
      })

      setState(UNIVERSAL_CORE_STATES.INITIALIZED)
      emit('init:complete', {
        native: {
          libhc: Boolean(nativeRuntime?.nativeModules?.libhc),
          libkv: Boolean(nativeRuntime?.nativeModules?.libkv),
          libudx: Boolean(nativeRuntime?.nativeModules?.libudx)
        }
      })

      return backend
    })()

    return initPromise
  }

  async function start() {
    await init()
    setState(UNIVERSAL_CORE_STATES.STARTING)
    emit('start', { platform: normalizedPlatform })

    await nativeRuntime?.start?.({ backend, services, platform: normalizedPlatform, storagePath })
    await invokeIfPresent(services.gossip, ['start', 'resume', 'open'], { backend, services })
    await invokeIfPresent(services.mirrorSeed, ['start', 'resume', 'open'], { backend, services })
    await invokeIfPresent(services.storage, ['start', 'resume', 'open'], { backend, services })
    await invokeIfPresent(services.swarm, ['start', 'resume', 'open'], { backend, services })
    await playback?.resume?.()

    await writeStateEvent('core.started', {
      state,
      playback: playback?.getSnapshot?.() || null
    })

    setState(UNIVERSAL_CORE_STATES.STARTED)
    emit('start:complete', { state })
    return { backend, services, state, lifecycle }
  }

  async function suspend() {
    if (state !== UNIVERSAL_CORE_STATES.STARTED && state !== UNIVERSAL_CORE_STATES.RESUMED) {
      return { backend, services, state, lifecycle }
    }

    setState(UNIVERSAL_CORE_STATES.SUSPENDING)
    emit('suspend', {})

    await playback?.suspend?.()
    await nativeRuntime?.suspend?.({ backend, services, platform: normalizedPlatform, storagePath })
    await invokeIfPresent(services.swarm, ['suspend', 'pause', 'stop'], { backend, services })
    await invokeIfPresent(services.gossip, ['suspend', 'pause', 'stop'], { backend, services })
    await invokeIfPresent(services.mirrorSeed, ['suspend', 'pause', 'stop'], { backend, services })
    await writeStateEvent('core.suspended', { playback: playback?.getSnapshot?.() || null })

    setState(UNIVERSAL_CORE_STATES.SUSPENDED)
    emit('suspend:complete', {})
    return { backend, services, state, lifecycle }
  }

  async function resume() {
    if (state !== UNIVERSAL_CORE_STATES.SUSPENDED) {
      return { backend, services, state, lifecycle }
    }

    setState(UNIVERSAL_CORE_STATES.RESUMING)
    emit('resume', {})

    await nativeRuntime?.resume?.({ backend, services, platform: normalizedPlatform, storagePath })
    await invokeIfPresent(services.storage, ['resume', 'start', 'open'], { backend, services })
    await invokeIfPresent(services.swarm, ['resume', 'start', 'open'], { backend, services })
    await invokeIfPresent(services.gossip, ['resume', 'start', 'open'], { backend, services })
    await invokeIfPresent(services.mirrorSeed, ['resume', 'start', 'open'], { backend, services })
    await playback?.resume?.()

    await writeStateEvent('core.resumed', { playback: playback?.getSnapshot?.() || null })

    setState(UNIVERSAL_CORE_STATES.RESUMED)
    emit('resume:complete', {})
    return { backend, services, state, lifecycle }
  }

  async function shutdown() {
    if (shutdownRequested) return { backend, services, state, lifecycle }
    shutdownRequested = true

    setState(UNIVERSAL_CORE_STATES.SHUTTING_DOWN)
    emit('shutdown:start', {})
    await writeStateEvent('core.shutting_down', { reason: 'requested' })

    await playback?.suspend?.()
    await nativeRuntime?.shutdown?.({ backend, services, platform: normalizedPlatform, storagePath })
    await invokeIfPresent(services.mirrorSeed, ['shutdown', 'close', 'stop', 'destroy'], { backend, services })
    await invokeIfPresent(services.gossip, ['shutdown', 'close', 'stop', 'destroy'], { backend, services })
    await invokeIfPresent(services.swarm, ['shutdown', 'close', 'stop', 'destroy'], { backend, services })
    await invokeIfPresent(services.storage, ['shutdown', 'close', 'stop', 'destroy'], { backend, services })
    await invokeIfPresent(backend, ['shutdown', 'close', 'stop', 'destroy'], { backend, services })

    await writeStateEvent('core.shutdown', { state: UNIVERSAL_CORE_STATES.SHUTDOWN })

    setState(UNIVERSAL_CORE_STATES.SHUTDOWN)
    emit('shutdown:complete', {})
    return { backend, services, state, lifecycle }
  }

  function getStatus() {
    return {
      version: UNIVERSAL_CORE_VERSION,
      platform: normalizedPlatform,
      state,
      storagePath,
      native: {
        libhc: Boolean(nativeRuntime?.nativeModules?.libhc),
        libkv: Boolean(nativeRuntime?.nativeModules?.libkv),
        libudx: Boolean(nativeRuntime?.nativeModules?.libudx)
      },
      playback: playback?.getSnapshot?.() || null,
      eventSink: eventSink?.snapshot?.() || null
    }
  }

  return {
    version: UNIVERSAL_CORE_VERSION,
    platform: normalizedPlatform,
    hrpc,
    runtime,
    storagePath,
    get state() {
      return state
    },
    get backend() {
      return backend
    },
    get services() {
      return services
    },
    get playback() {
      return playback
    },
    get eventSink() {
      return eventSink
    },
    get lifecycle() {
      return lifecycle
    },
    getStatus,
    init,
    start,
    suspend,
    resume,
    shutdown
  }
}

/**
 * HRPC surface for the universal core.
 * Platform adapters should use this instead of reimplementing backend lifecycle
 * behavior on each shell. The same contract applies to mobile, desktop, and
 * relay targets.
 */
export function createUniversalHrpcSurface(core) {
  return {
    async GetUniversalCoreStatus() {
      return core.getStatus()
    },
    async UniversalCoreInit() {
      await core.init()
      return core.getStatus()
    },
    async UniversalCoreStart() {
      await core.start()
      return core.getStatus()
    },
    async UniversalCoreSuspend() {
      await core.suspend()
      return core.getStatus()
    },
    async UniversalCoreResume() {
      await core.resume()
      return core.getStatus()
    },
    async UniversalCoreShutdown() {
      await core.shutdown()
      return core.getStatus()
    }
  }
}

export default {
  UNIVERSAL_CORE_VERSION,
  UNIVERSAL_CORE_PLATFORMS,
  UNIVERSAL_CORE_STATES,
  createUniversalCore,
  createUniversalHrpcSurface
}
