import c from 'compact-encoding'

import { createBudgetManager, createResourcePolicy } from './budget-manager.js'
import { createPeerScorer, createSybilPolicy, createUsefulWorkLedger } from './peer-scorer.js'
import {
  DEFAULT_PLAYER_POLICY,
  DEFAULT_POLICY,
  PLAYER_MAIN,
  PLAYER_SHORTS,
  ROLE_HYBRID,
  ROLE_MOBILE,
  ROLE_RELAY,
  TRANSITION_RANK,
  descriptorIdOf,
  hashText,
  maxBigInt,
  normalizeRole,
  nowMs,
  safeBigInt,
  safeNumber,
  toHex,
} from './universal-core-utils.js'

export {
  createBudgetManager,
  createResourcePolicy,
  encodeBudgetState,
  decodeBudgetState,
} from './budget-manager.js'
export {
  createPeerScorer,
  createSybilPolicy,
  createUsefulWorkLedger,
  createPeerMetricDiffStream,
  encodePeerMetric,
  decodePeerMetric,
} from './peer-scorer.js'

function compactJson(value) {
  return c.encode(c.string, JSON.stringify(value, (_key, val) => typeof val === 'bigint' ? val.toString() : val))
}

function cloneDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') return null
  return {
    ...descriptor,
    descriptorId: toHex(descriptor.descriptorId),
    contentRoot: toHex(descriptor.contentRoot),
    dasRoot: toHex(descriptor.dasRoot),
    swarmTopic: toHex(descriptor.swarmTopic),
    sourceRefHash: toHex(descriptor.sourceRefHash),
    publisherIdentity: toHex(descriptor.publisherIdentity),
    parentDescriptorId: toHex(descriptor.parentDescriptorId),
    signer: toHex(descriptor.signer),
    signature: toHex(descriptor.signature),
    publishAt: safeBigInt(descriptor.publishAt, 0n),
    expiresAt: safeBigInt(descriptor.expiresAt, 0n),
    availabilityEpoch: safeNumber(descriptor.availabilityEpoch, 0),
    flags: safeNumber(descriptor.flags, 0),
  }
}

function compareEventOrder(a, b) {
  const timeA = safeBigInt(a?.observedAt || a?.localSeenAt || a?.ts || 0n, 0n)
  const timeB = safeBigInt(b?.observedAt || b?.localSeenAt || b?.ts || 0n, 0n)
  if (timeA > timeB) return 1
  if (timeA < timeB) return -1
  const eventA = toHex(a?.eventId || a?.entryId || a?.proofId || '')
  const eventB = toHex(b?.eventId || b?.entryId || b?.proofId || '')
  return eventA.localeCompare(eventB)
}

function transitionRank(state) {
  return TRANSITION_RANK[String(state || 'discovered').toLowerCase()] ?? 0
}

function isNewerThan(current, next) {
  if (!current) return true
  const cmp = compareEventOrder(next, current)
  if (cmp > 0) return true
  if (cmp < 0) return false
  const currentRank = transitionRank(current.state)
  const nextRank = transitionRank(next.state)
  return nextRank >= currentRank
}

function mergeDescriptor(current, incoming) {
  if (!current) return cloneDescriptor(incoming)
  const merged = cloneDescriptor(current)
  const next = cloneDescriptor(incoming)
  if (!next) return merged
  for (const key of Object.keys(next)) {
    if (next[key] === null || next[key] === undefined || next[key] === '') continue
    if (merged[key] === null || merged[key] === undefined || merged[key] === '') {
      merged[key] = next[key]
      continue
    }
    if (typeof next[key] === 'bigint' && next[key] > merged[key]) merged[key] = next[key]
    else if (typeof next[key] === 'number' && next[key] > merged[key]) merged[key] = next[key]
  }
  return merged
}



export function createAvailabilityPlanner(options = {}) {
  const minCopies = Math.max(1, safeNumber(options.minReachableCopies, DEFAULT_POLICY.minReachableCopies))
  const longTailWindowMs = Math.max(60 * 60 * 1000, safeNumber(options.longTailWindowMs, DEFAULT_POLICY.longTailWindowMs))
  const proofFreshnessMs = Math.max(5 * 60 * 1000, safeNumber(options.proofFreshnessMs, DEFAULT_POLICY.proofFreshnessMs))
  const descriptorFreshnessMs = Math.max(60 * 1000, safeNumber(options.minDescriptorFreshnessMs, DEFAULT_POLICY.minDescriptorFreshnessMs))

  function isLongTail(descriptor = {}, now = Date.now()) {
    const lastSeenAt = safeBigInt(descriptor.lastSeenAt || descriptor.publishAt || 0n, 0n)
    const seenWindow = nowMs(now) - lastSeenAt
    const peerCount = safeNumber(descriptor.peerCount, 0)
    const videoCount = safeNumber(descriptor.videoCount, 0)
    return seenWindow >= BigInt(longTailWindowMs) || peerCount <= minCopies || videoCount <= 3
  }

  function hasReachability(descriptor = {}, now = Date.now()) {
    const proofAt = safeBigInt(descriptor.lastProofAt || 0n, 0n)
    const expiresAt = safeBigInt(descriptor.expiresAt || 0n, 0n)
    if (expiresAt > 0n && nowMs(now) > expiresAt) return false
    if (proofAt > 0n && nowMs(now) - proofAt > BigInt(proofFreshnessMs)) return false
    return Boolean(descriptor.reachable !== false)
  }

  function shouldAdmit(descriptor = {}, now = Date.now()) {
    if (!descriptorIdOf(descriptor)) return false
    if (descriptor.tombstoned) return false
    if (descriptor.quarantined && !descriptor.quarantineExpired) return false
    return hasReachability(descriptor, now)
  }

  function shouldForward(descriptor = {}, now = Date.now()) {
    if (!shouldAdmit(descriptor, now)) return false
    const freshness = safeBigInt(descriptor.publishAt || 0n, 0n)
    if (freshness > 0n && nowMs(now) - freshness > BigInt(descriptorFreshnessMs)) return false
    return true
  }

  function needsRefresh(descriptor = {}, now = Date.now()) {
    const lastRefreshAt = safeBigInt(descriptor.lastRefreshAt || 0n, 0n)
    const proofAt = safeBigInt(descriptor.lastProofAt || 0n, 0n)
    if (lastRefreshAt === 0n) return true
    if (nowMs(now) - lastRefreshAt >= BigInt(descriptorFreshnessMs)) return true
    if (proofAt > 0n && nowMs(now) - proofAt >= BigInt(proofFreshnessMs)) return true
    return isLongTail(descriptor, now)
  }

  return { minCopies, longTailWindowMs, proofFreshnessMs, descriptorFreshnessMs, isLongTail, hasReachability, shouldAdmit, shouldForward, needsRefresh }
}


export function createConcurrentState(options = {}) {
  return {
    descriptors: new Map(),
    peers: new Map(),
    events: new Map(),
    tombstones: new Map(),
    quarantines: new Map(),
    causalWatermark: 0n,
    lastAppliedAt: nowMs(options.now || Date.now()),
  }
}

function normalizeTransition(input = {}) {
  const state = String(input.state || input.nextState || 'discovered').toLowerCase()
  return {
    state,
    eventId: input.eventId || input.entryId || input.proofId || input.id || '',
    observedAt: safeBigInt(input.observedAt || input.localSeenAt || Date.now(), nowMs()),
    descriptorId: descriptorIdOf(input.descriptorId || input.descriptor || input),
    descriptor: input.descriptor || null,
    reason: input.reason || input.reasonCode || null,
    proofId: input.proofId || input.lastProofId || null,
    quarantineUntil: safeBigInt(input.quarantineUntil || 0n, 0n),
    tombstonedAt: safeBigInt(input.tombstonedAt || 0n, 0n),
    signatureValid: input.signatureValid !== false,
    reachable: input.reachable !== false,
  }
}

function resolveConflict(current, incoming) {
  if (!current) return incoming
  const newer = isNewerThan(current, incoming)
  if (!newer) return current
  const mergedDescriptor = mergeDescriptor(current.descriptor, incoming.descriptor)
  const next = {
    ...current,
    ...incoming,
    descriptor: mergedDescriptor,
    firstSeenAt: current.firstSeenAt || incoming.firstSeenAt || incoming.observedAt,
    lastSeenAt: maxBigInt(current.lastSeenAt, incoming.observedAt),
    lastUpdatedAt: incoming.observedAt,
    conflictCount: (current.conflictCount || 0) + (current.descriptor && incoming.descriptor && hashText(current.descriptor) !== hashText(incoming.descriptor) ? 1 : 0),
    duplicateCount: current.duplicateCount || 0,
  }

  const currentRank = transitionRank(current.state)
  const incomingRank = transitionRank(incoming.state)
  if (incomingRank >= currentRank) {
    next.state = incoming.state
  }
  if (incoming.state === 'quarantined') {
    next.quarantineUntil = maxBigInt(current.quarantineUntil, incoming.quarantineUntil)
  }
  if (incoming.state === 'tombstoned') {
    next.tombstonedAt = maxBigInt(current.tombstonedAt, incoming.tombstonedAt || incoming.observedAt)
  }
  return next
}


export function applyConcurrentUpdate(state, input = {}, options = {}) {
  const next = normalizeTransition(input)
  const id = next.descriptorId
  if (!id) return { applied: false, reason: 'missing-descriptor-id', state }

  const eventKey = toHex(next.eventId)
  if (eventKey && state.events.has(eventKey)) {
    const record = state.events.get(eventKey)
    record.duplicateCount = (record.duplicateCount || 0) + 1
    return { applied: false, reason: 'duplicate-event', state, record }
  }

  const current = state.descriptors.get(id) || null
  const record = resolveConflict(current, next)
  record.eventId = next.eventId
  record.lastUpdatedAt = next.observedAt
  record.state = record.state || next.state

  if (next.state === 'quarantined') {
    record.quarantined = true
    state.quarantines.set(id, record)
    state.tombstones.delete(id)
  } else if (next.state === 'tombstoned') {
    record.tombstoned = true
    state.tombstones.set(id, record)
    state.quarantines.delete(id)
  } else {
    record.quarantined = false
    record.tombstoned = false
    if (next.signatureValid) {
      state.quarantines.delete(id)
      if (record.state !== 'tombstoned') state.tombstones.delete(id)
    }
  }

  state.descriptors.set(id, record)
  state.events.set(eventKey || hashText(next), record)
  state.causalWatermark = record.lastUpdatedAt > state.causalWatermark ? record.lastUpdatedAt : state.causalWatermark
  state.lastAppliedAt = record.lastUpdatedAt

  return { applied: true, record, state }
}

function normalizePlayerSurface(surface) {
  return surface === PLAYER_MAIN ? PLAYER_MAIN : PLAYER_SHORTS
}

function createPlayerSurfaceState(surface, options = {}) {
  const normalizedSurface = normalizePlayerSurface(surface)
  const policy = { ...DEFAULT_PLAYER_POLICY[normalizedSurface], ...(options.policy || {}) }
  return {
    surface: normalizedSurface,
    sessionId: options.sessionId || hashText({ surface: normalizedSurface, seed: options.seed || 'player' }),
    playerId: options.playerId || hashText({ surface: normalizedSurface, playerId: options.playerId || options.seed || 'player' }),
    policy,
    active: Boolean(options.active ?? (normalizedSurface === PLAYER_MAIN)),
    suspended: Boolean(options.suspended ?? false),
    pipVisible: Boolean(options.pipVisible ?? false),
    localClock: 0n,
    lastActiveAt: nowMs(options.lastActiveAt || Date.now()),
    lastSuspendedAt: safeBigInt(options.lastSuspendedAt || 0n, 0n),
    lastEventAt: safeBigInt(options.lastEventAt || 0n, 0n),
    currentMediaId: toHex(options.currentMediaId || ''),
    currentQueueId: toHex(options.currentQueueId || ''),
    playbackState: {
      mediaId: toHex(options.currentMediaId || ''),
      positionMs: safeBigInt(options.positionMs || 0n, 0n),
      bufferedUntilMs: safeBigInt(options.bufferedUntilMs || 0n, 0n),
      paused: Boolean(options.paused ?? !options.active),
      muted: Boolean(options.muted ?? false),
      visible: Boolean(options.visible ?? (normalizedSurface === PLAYER_MAIN)),
      pipEnabled: normalizedSurface === PLAYER_MAIN ? Boolean(options.pipEnabled ?? true) : false,
    },
    resourcePool: {
      cpuBudget: safeNumber(options.cpuBudget, policy.activeBudget),
      bandwidthBudget: safeNumber(options.bandwidthBudget, policy.backgroundBudget),
      decodeBudget: safeNumber(options.decodeBudget, policy.maxConcurrentDecodes),
      prefetchBudget: safeNumber(options.prefetchBudget, policy.maxConcurrentPrefetches),
      suspended: Boolean(options.suspended ?? false),
    },
    localState: new Map(),
    localEvents: new Map(),
    queue: [],
  }
}

function createPlayerResourceGate(options = {}) {
  const mainPolicy = { ...DEFAULT_PLAYER_POLICY.main, ...(options.main || {}) }
  const shortsPolicy = { ...DEFAULT_PLAYER_POLICY.shorts, ...(options.shorts || {}) }

  function budgetFor(surface, resourceContext = {}) {
    const normalizedSurface = normalizePlayerSurface(surface)
    const policy = normalizedSurface === PLAYER_MAIN ? mainPolicy : shortsPolicy
    const priority = normalizedSurface === PLAYER_MAIN ? policy.priority : policy.priority
    const pressure = safeNumber(resourceContext.pressure, 0)
    const backgroundPenalty = normalizedSurface === PLAYER_SHORTS ? Math.min(policy.backgroundBudget, Math.max(0, pressure)) : 0
    const activeBudget = Math.max(0, policy.activeBudget - backgroundPenalty)
    const suspended = Boolean(resourceContext.inactive || (normalizedSurface === PLAYER_SHORTS && resourceContext.mainActive && pressure > 0))
    return {
      surface: normalizedSurface,
      priority,
      activeBudget,
      backgroundBudget: policy.backgroundBudget,
      maxConcurrentDecodes: policy.maxConcurrentDecodes,
      maxConcurrentPrefetches: policy.maxConcurrentPrefetches,
      pipAllowed: policy.pipAllowed,
      suspended,
      suspendAfterMs: policy.suspendAfterMs,
      shouldPreempt: normalizedSurface === PLAYER_MAIN,
    }
  }

  function shouldSuspend(surface, resourceContext = {}) {
    const budget = budgetFor(surface, resourceContext)
    if (budget.surface === PLAYER_MAIN) return Boolean(resourceContext.forceSuspendMain)
    if (resourceContext.mainActive && !resourceContext.allowShortsWhileMainActive) return true
    if (budget.suspended) return true
    if (resourceContext.inactiveForMs && budget.suspendAfterMs > 0 && resourceContext.inactiveForMs >= budget.suspendAfterMs) return true
    return false
  }

  function chooseActiveSurface(resourceContext = {}) {
    if (resourceContext.mainRequested || resourceContext.mainActive) return PLAYER_MAIN
    if (resourceContext.shortsRequested) return PLAYER_SHORTS
    return PLAYER_SHORTS
  }

  return { mainPolicy, shortsPolicy, budgetFor, shouldSuspend, chooseActiveSurface }
}

export function createUnifiedAutobaseSink(options = {}) {
  const events = []
  const bySurface = new Map()
  const seen = new Set()
  const appendSubscribers = new Set()
  const appendFn = typeof options.append === 'function'
    ? options.append
    : typeof options.autobase?.append === 'function'
      ? options.autobase.append.bind(options.autobase)
      : typeof options.autobase?.write === 'function'
        ? options.autobase.write.bind(options.autobase)
        : typeof options.autobase?.log?.append === 'function'
          ? options.autobase.log.append.bind(options.autobase.log)
          : null
  const nativeOnAppend = typeof options.autobase?.onappend === 'function'
    ? options.autobase.onappend.bind(options.autobase)
    : typeof options.autobase?.log?.onappend === 'function'
      ? options.autobase.log.onappend.bind(options.autobase.log)
      : null

  function notifyAppend(record) {
    for (const subscriber of appendSubscribers) {
      try {
        subscriber(record)
      } catch {
        // Keep native onappend fanout non-blocking.
      }
    }
  }

  function decodeNativeRecord(record) {
    if (!(record instanceof Uint8Array)) return record || {}
    try {
      return JSON.parse(c.decode(c.string, record))
    } catch {
      return { payload: record }
    }
  }

  function storeEnvelope(envelope) {
    const surface = normalizePlayerSurface(envelope.surface)
    const bucket = surfaceBucket(surface)
    const sequence = safeBigInt(envelope.sequence || envelope.seq || bucket.sequence + 1n, bucket.sequence + 1n)
    const observedAt = safeBigInt(envelope.observedAt || Date.now(), nowMs())
    const eventId = toHex(envelope.eventId || hashText({ surface, sequence: String(sequence), kind: envelope.kind, payload: envelope.payload || {} }))
    const dedupeKey = `${surface}:${eventId}`
    if (seen.has(dedupeKey)) return { duplicate: true, envelope: { ...envelope, surface, sequence, observedAt, eventId } }
    const stored = {
      version: safeNumber(envelope.version, 1),
      domain: envelope.domain || 'playback',
      surface,
      playerId: toHex(envelope.playerId || envelope.sessionId || ''),
      sessionId: toHex(envelope.sessionId || ''),
      eventId,
      sequence,
      observedAt,
      kind: envelope.kind || 'state',
      payload: envelope.payload || {},
    }
    seen.add(dedupeKey)
    bucket.sequence = sequence > bucket.sequence ? sequence : bucket.sequence
    bucket.events.push(stored)
    bucket.lastEventAt = observedAt > bucket.lastEventAt ? observedAt : bucket.lastEventAt
    events.push(stored)
    return { duplicate: false, envelope: stored }
  }

  function ingestNativeAppend(record) {
    const { duplicate, envelope } = storeEnvelope(decodeNativeRecord(record))
    if (!duplicate) notifyAppend(envelope)
    return envelope
  }

  const closeNativeOnAppend = nativeOnAppend
    ? nativeOnAppend((record) => ingestNativeAppend(record))
    : null

  function surfaceBucket(surface) {
    const key = normalizePlayerSurface(surface)
    if (!bySurface.has(key)) bySurface.set(key, { sequence: 0n, events: [], lastEventAt: 0n })
    return bySurface.get(key)
  }

  async function append(record = {}) {
    const surface = normalizePlayerSurface(record.surface)
    const bucket = surfaceBucket(surface)
    const sequence = bucket.sequence + 1n
    const envelope = {
      version: 1,
      domain: 'playback',
      surface,
      playerId: toHex(record.playerId || record.sessionId || ''),
      sessionId: toHex(record.sessionId || ''),
      sequence,
      observedAt: safeBigInt(record.observedAt || Date.now(), nowMs()),
      kind: record.kind || 'state',
      payload: record.payload || {},
    }
    envelope.eventId = toHex(record.eventId || hashText({ surface, sequence: String(sequence), ...record }))
    const stored = storeEnvelope(envelope)
    if (stored.duplicate) {
      return { appended: false, duplicate: true, eventId: stored.envelope.eventId, sequence, surface }
    }

    if (appendFn) {
      await appendFn(compactJson(stored.envelope))
    }
    notifyAppend(stored.envelope)

    return { appended: true, duplicate: false, envelope: stored.envelope }
  }

  function onappend(listener) {
    if (typeof listener !== 'function') return () => {}
    appendSubscribers.add(listener)
    return () => appendSubscribers.delete(listener)
  }

  function close() {
    if (typeof closeNativeOnAppend === 'function') closeNativeOnAppend()
  }

  function snapshot() {
    return {
      events: events.slice(),
      bySurface: Array.from(bySurface.entries()).map(([surface, bucket]) => ({
        surface,
        sequence: bucket.sequence,
        lastEventAt: bucket.lastEventAt,
        events: bucket.events.slice(),
      })),
    }
  }

  return { append, onappend, close, snapshot, bySurface, events }
}

export function createPlayerSplitState(options = {}) {
  return {
    main: createPlayerSurfaceState(PLAYER_MAIN, options.main || {}),
    shorts: createPlayerSurfaceState(PLAYER_SHORTS, options.shorts || {}),
    activeSurface: normalizePlayerSurface(options.activeSurface || PLAYER_MAIN),
    lastSwitchoverAt: safeBigInt(options.lastSwitchoverAt || 0n, 0n),
  }
}

function routePlayerEvent(surfaceState, event = {}, sink, resourceGate, globalContext = {}) {
  const surface = surfaceState.surface
  const nextEventAt = safeBigInt(event.observedAt || globalContext.observedAt || Date.now(), nowMs())
  const budget = resourceGate.budgetFor(surface, {
    mainActive: globalContext.mainActive,
    inactive: globalContext.inactive,
    pressure: globalContext.pressure,
    allowShortsWhileMainActive: globalContext.allowShortsWhileMainActive,
    inactiveForMs: globalContext.inactiveForMs,
  })
  const suspended = resourceGate.shouldSuspend(surface, {
    ...globalContext,
    forceSuspendMain: globalContext.forceSuspendMain,
  })

  surfaceState.lastEventAt = nextEventAt
  surfaceState.localClock += 1n
  surfaceState.active = !suspended && (surface === PLAYER_MAIN || globalContext.allowShortsWhileMainActive !== false)
  surfaceState.suspended = suspended
  surfaceState.resourcePool = {
    ...surfaceState.resourcePool,
    cpuBudget: budget.activeBudget,
    bandwidthBudget: surface === PLAYER_MAIN ? Math.max(budget.activeBudget, surfaceState.resourcePool.bandwidthBudget) : budget.backgroundBudget,
    decodeBudget: budget.maxConcurrentDecodes,
    prefetchBudget: budget.maxConcurrentPrefetches,
    suspended,
  }
  surfaceState.playbackState = {
    ...surfaceState.playbackState,
    mediaId: toHex(event.mediaId || surfaceState.playbackState.mediaId),
    positionMs: safeBigInt(event.positionMs || surfaceState.playbackState.positionMs, 0n),
    bufferedUntilMs: safeBigInt(event.bufferedUntilMs || surfaceState.playbackState.bufferedUntilMs, 0n),
    paused: Boolean(event.paused ?? surfaceState.playbackState.paused),
    muted: Boolean(event.muted ?? surfaceState.playbackState.muted),
    visible: Boolean(event.visible ?? (surface === PLAYER_MAIN && !suspended)),
    pipEnabled: surface === PLAYER_MAIN ? Boolean(event.pipEnabled ?? surfaceState.playbackState.pipEnabled) : false,
  }
  surfaceState.localState.set(event.kind || 'state', {
    ...event,
    surface,
    budget,
    suspended,
    observedAt: nextEventAt,
  })
  surfaceState.localEvents.set(toHex(event.eventId || hashText(event)), event)
  surfaceState.queue.push({
    kind: event.kind || 'state',
    surface,
    payload: event,
    observedAt: nextEventAt,
  })

  const sinkRecord = {
    surface,
    sessionId: surfaceState.sessionId,
    playerId: surfaceState.playerId,
    kind: event.kind || 'state',
    eventId: event.eventId || '',
    observedAt: nextEventAt,
    payload: {
      ...event,
      localStateKey: event.kind || 'state',
      playbackState: surfaceState.playbackState,
    },
  }

  const commit = sink ? sink.append(sinkRecord) : Promise.resolve({ appended: false })
  return { surfaceState, budget, suspended, commit }
}

export function createDualPlayerPlaybackCore(options = {}) {
  const state = options.state || createPlayerSplitState(options)
  const resourceGate = createPlayerResourceGate(options.resourceGate || options)
  const sink = createUnifiedAutobaseSink(options.autobaseSink || { autobase: options.autobase, append: options.append })

  function syncActiveSurface(nextSurface, context = {}) {
    const normalized = normalizePlayerSurface(nextSurface)
    state.activeSurface = normalized
    state.lastSwitchoverAt = nowMs(context.observedAt || Date.now())
    state.main.active = normalized === PLAYER_MAIN
    state.shorts.active = normalized === PLAYER_SHORTS && context.allowShortsWhileMainActive !== false
    state.main.suspended = resourceGate.shouldSuspend(PLAYER_MAIN, { ...context, mainActive: normalized === PLAYER_MAIN })
    state.shorts.suspended = resourceGate.shouldSuspend(PLAYER_SHORTS, { ...context, mainActive: normalized === PLAYER_MAIN })
    state.main.resourcePool = resourceGate.budgetFor(PLAYER_MAIN, { ...context, mainActive: normalized === PLAYER_MAIN })
    state.shorts.resourcePool = resourceGate.budgetFor(PLAYER_SHORTS, { ...context, mainActive: normalized === PLAYER_MAIN })
    return state.activeSurface
  }

  function emit(surface, event = {}, context = {}) {
    const normalized = normalizePlayerSurface(surface)
    const surfaceState = normalized === PLAYER_MAIN ? state.main : state.shorts
    if (normalized === PLAYER_MAIN) {
      state.shorts.suspended = resourceGate.shouldSuspend(PLAYER_SHORTS, {
        ...context,
        mainActive: true,
        allowShortsWhileMainActive: context.allowShortsWhileMainActive,
        inactiveForMs: context.inactiveForMs,
      })
      if (state.shorts.suspended) state.shorts.active = false
    }
    return routePlayerEvent(surfaceState, event, sink, resourceGate, {
      ...context,
      mainActive: normalized === PLAYER_MAIN || state.main.active,
    })
  }

  function dispatch(event = {}, context = {}) {
    const surface = normalizePlayerSurface(event.surface || context.surface || state.activeSurface)
    return emit(surface, event, context)
  }

  function prioritizeMain(context = {}) {
    return syncActiveSurface(PLAYER_MAIN, context)
  }

  function prioritizeShorts(context = {}) {
    if (context.allowShortsWhileMainActive === false && state.main.active) {
      return state.activeSurface
    }
    return syncActiveSurface(PLAYER_SHORTS, context)
  }

  function suspendInactivePlayers(context = {}) {
    const mainSuspended = resourceGate.shouldSuspend(PLAYER_MAIN, { ...context, mainActive: state.activeSurface === PLAYER_MAIN })
    const shortsSuspended = resourceGate.shouldSuspend(PLAYER_SHORTS, {
      ...context,
      mainActive: state.activeSurface === PLAYER_MAIN,
      allowShortsWhileMainActive: context.allowShortsWhileMainActive,
      inactiveForMs: context.inactiveForMs,
    })
    state.main.suspended = mainSuspended
    state.shorts.suspended = shortsSuspended
    if (shortsSuspended) state.shorts.active = false
    if (mainSuspended) state.main.active = false
    return { mainSuspended, shortsSuspended }
  }

  function snapshot() {
    return {
      activeSurface: state.activeSurface,
      lastSwitchoverAt: state.lastSwitchoverAt,
      main: state.main,
      shorts: state.shorts,
      sink: sink.snapshot(),
    }
  }

  function close() {
    sink.close()
  }

  return {
    state,
    resourceGate,
    sink,
    dispatch,
    emit,
    prioritizeMain,
    prioritizeShorts,
    suspendInactivePlayers,
    syncActiveSurface,
    close,
    snapshot,
  }
}

export function createUniversalCore(options = {}) {
  const role = normalizeRole(options.role)
  const sybil = createSybilPolicy(options.sybil)
  const usefulWork = createUsefulWorkLedger(options.usefulWork)
  const availability = createAvailabilityPlanner(options.availability)
  const resources = createResourcePolicy({ role, ...options.resources })
  const concurrentState = options.state || createConcurrentState(options)
  const peerScorer = createPeerScorer({
    sybil,
    usefulWork,
    availability,
    resources,
    state: concurrentState,
    persist: async (key, value) => {
      const metaDb = backend?.ctx?.metaDb
      if (typeof metaDb?.put === 'function') await metaDb.put(key, value)
    },
  })
  const playerCore = createDualPlayerPlaybackCore(options.players || {})
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {}
  const playbackLeases = new Map()
  let lifecycleState = 'created'
  let backend = null
  let services = null
  let nativeHandles = {}
  let eventSeq = 0
  const appendSubscribers = new Set()
  let lifecycleTail = Promise.resolve()

  function runLifecycle(task) {
    const run = lifecycleTail.then(task, task)
    lifecycleTail = run.catch(() => {})
    return run
  }

  function emitCoreEvent(type, payload = {}) {
    const event = { event: 'autobase:event', detail: { type, payload } }
    onEvent(event)
    return event
  }

  function eventSinkSnapshot() {
    return {
      current: {
        lastSeq: eventSeq,
        recent: Array.from({ length: eventSeq }, (_, index) => ({ seq: index + 1 })).slice(-64),
      },
    }
  }

  const eventSink = {
    async append(kind = 'event', payload = {}) {
      eventSeq += 1
      const record = { seq: eventSeq, kind, payload }
      const metaDb = backend?.ctx?.metaDb
      if (typeof metaDb?.put === 'function') {
        await metaDb.put('universal-core:snapshot', compactJson(eventSinkSnapshot()))
      }
      for (const subscriber of appendSubscribers) {
        try {
          subscriber(record)
        } catch {
          // Ignore observer failures so append processing is not blocked.
        }
      }
      return record
    },
    onappend(listener) {
      if (typeof listener !== 'function') return () => {}
      appendSubscribers.add(listener)
      return () => appendSubscribers.delete(listener)
    },
    snapshot: eventSinkSnapshot,
  }

  async function createNativeHandle(name, mod, context) {
    if (!mod) return null
    if (typeof mod.create === 'function') return await mod.create({ ...context, nativeName: name })
    if (typeof mod.default?.create === 'function') return await mod.default.create({ ...context, nativeName: name })
    return mod
  }

  async function callIfPresent(target, names, context) {
    for (const name of names) {
      const fn = target?.[name]
      if (typeof fn === 'function') return await fn.call(target, context)
    }
    return null
  }

  async function initializeNativeHandles(context) {
    const loaded = typeof options.loadNativeModules === 'function'
      ? await options.loadNativeModules()
      : (options.nativeModules || {})
    const created = []
    nativeHandles = {}
    try {
      for (const name of ['libhc', 'libkv', 'libudx']) {
        const mod = loaded?.[name]
        if (!mod) continue
        const handle = await createNativeHandle(name, mod, context)
        if (!handle) continue
        nativeHandles[name] = handle
        created.push(name)
        await callIfPresent(handle, ['init', 'open', 'boot'], { ...context, nativeName: name, phase: 'init' })
      }
    } catch (error) {
      for (const name of created.reverse()) {
        const handle = nativeHandles[name]
        await callIfPresent(handle, ['rollback', 'reset', 'abort'], { ...context, nativeName: name, phase: 'init', error }).catch(() => {})
        await callIfPresent(handle, ['shutdown', 'close', 'stop', 'destroy'], { ...context, nativeName: name, phase: 'init', error }).catch(() => {})
        delete nativeHandles[name]
      }
      throw error
    }
  }

  async function transitionNative(phase, names, methods, context = {}) {
    for (const name of names) {
      await callIfPresent(nativeHandles[name], methods, { ...context, nativeName: name, phase })
      await callIfPresent(nativeHandles[name], ['flush', 'drain', 'sync', 'barrier'], { ...context, nativeName: name, phase })
    }
  }

  async function init() {
    return await runLifecycle(async () => {
      if (backend) return backend
      lifecycleState = 'initializing'
      await initializeNativeHandles({ platform: options.platform, storagePath: options.storagePath })
      const createBackendContext = typeof options.createBackendContext === 'function'
        ? options.createBackendContext
        : null
      backend = createBackendContext ? await createBackendContext({ ...options, peerScorer }) : { ctx: {} }
      const mirrorWorker = typeof options.createMirrorSeedWorker === 'function'
        ? options.createMirrorSeedWorker({ backend, core: api })
        : {}
      let mirrorRefreshInFlight = null
      services = {
        gossip: typeof options.createGossipService === 'function' ? options.createGossipService({ backend, core: api }) : {},
        storage: typeof options.createStorageService === 'function' ? options.createStorageService({ backend, core: api }) : {},
        mirrorSeed: {
          ...mirrorWorker,
          async refresh(reason = 'manual') {
            if (mirrorRefreshInFlight) return { skipped: true, why: 'refresh already in flight' }
            mirrorRefreshInFlight = (async () => {
              try {
                if (typeof mirrorWorker.refresh === 'function') return await mirrorWorker.refresh(reason)
                const entries = backend?.publicFeed?.getFeed?.() || []
                for (const entry of entries) await backend?.seedingManager?.addSeed?.(entry)
                return { refreshed: true }
              } finally {
                mirrorRefreshInFlight = null
              }
            })()
            return await mirrorRefreshInFlight
          },
        },
        hrpc: options.hrpc || null,
      }
      lifecycleState = 'initialized'
      await eventSink.append('core.initialized', { state: lifecycleState })
      emitCoreEvent('core.initialized', { state: lifecycleState })
      return backend
    })
  }

  async function start() {
    return await runLifecycle(async () => {
      lifecycleState = 'starting'
      await transitionNative('start', ['libhc', 'libkv', 'libudx'], ['start', 'resume', 'open', 'boot'], { platform: options.platform })
      lifecycleState = 'started'
      emitCoreEvent('core.started', { state: lifecycleState })
      return backend
    })
  }

  async function suspend() {
    return await runLifecycle(async () => {
      lifecycleState = 'suspending'
      await transitionNative('suspend', ['libudx', 'libkv', 'libhc'], ['suspend', 'pause', 'stop'], { platform: options.platform })
      lifecycleState = 'suspended'
      emitCoreEvent('core.suspended', { state: lifecycleState })
      return backend
    })
  }

  async function resume() {
    return await runLifecycle(async () => {
      lifecycleState = 'resuming'
      await transitionNative('resume', ['libhc', 'libkv', 'libudx'], ['resume', 'start', 'open', 'boot'], { platform: options.platform })
      lifecycleState = 'resumed'
      emitCoreEvent('core.resumed', { state: lifecycleState })
      return backend
    })
  }

  async function shutdown() {
    return await runLifecycle(async () => {
      lifecycleState = 'shutting_down'
      await transitionNative('shutdown', ['libudx', 'libkv', 'libhc'], ['shutdown', 'close', 'stop', 'destroy'], { platform: options.platform })
      playerCore.close()
      lifecycleState = 'shutdown'
      emitCoreEvent('core.shutdown', { state: lifecycleState })
      return backend
    })
  }

  function getStatus() {
    return { state: lifecycleState, role, backendReady: Boolean(backend), servicesReady: Boolean(services) }
  }

  const playback = {
    ...playerCore,
    async acquire(surface, context = {}) {
      const normalized = normalizePlayerSurface(surface)
      const hostSurfaceId = context.hostSurfaceId || context.surfaceId || normalized
      if (normalized === PLAYER_SHORTS && (context.pictureInPicture || context.allowPiP)) {
        return { granted: false, reason: 'shorts surface is not PiP-capable' }
      }
      for (const lease of playbackLeases.values()) {
        if (lease.hostSurfaceId === hostSurfaceId && lease.surface !== normalized) {
          return { granted: false, reason: `surface already owned by ${lease.surface}` }
        }
      }
      const lease = { id: hashText({ surface: normalized, hostSurfaceId, at: Date.now() }), surface: normalized, hostSurfaceId }
      playbackLeases.set(lease.id, lease)
      return { granted: true, context: lease }
    },
    async release(context = {}) {
      playbackLeases.delete(context.id)
      return { released: true }
    },
  }

  function scorePeer(peer = {}, now = Date.now()) {
    return peerScorer.scorePeer(peer, now)
  }

  function registerPeer(peer = {}) {
    return peerScorer.registerPeer(peer)
  }

  function recordUsefulWork(kind, amount = 1, context = {}) {
    return usefulWork.reward(kind, amount, context)
  }

  function ingestDescriptor(descriptor, context = {}) {
    const normalized = cloneDescriptor(descriptor)
    if (!normalized) return { accepted: false, reason: 'invalid-descriptor' }
    if (!availability.shouldAdmit(normalized, context.now || Date.now())) {
      return { accepted: false, reason: 'unreachable-or-stale' }
    }
    const result = applyConcurrentUpdate(concurrentState, {
      descriptorId: normalized.descriptorId,
      descriptor: normalized,
      state: availability.shouldForward(normalized, context.now || Date.now()) ? 'active' : 'verified',
      eventId: context.eventId || normalized.signature || normalized.descriptorId,
      observedAt: context.observedAt || normalized.publishAt || nowMs(),
      signatureValid: context.signatureValid !== false,
      reachable: true,
    }, context)

    if (result.applied) recordUsefulWork('descriptor-verified', 1, { descriptorId: normalized.descriptorId, peerId: context.peerId, at: context.observedAt || Date.now() })
    return { accepted: result.applied, record: result.record, state: concurrentState }
  }

  function ingestProof(proof, context = {}) {
    const descriptorId = descriptorIdOf(proof?.descriptorId || proof?.descriptor || '')
    if (!descriptorId) return { accepted: false, reason: 'missing-descriptor-id' }
    const reachable = Boolean(proof?.reachable !== false && proof?.signatureValid !== false)
    const result = applyConcurrentUpdate(concurrentState, {
      descriptorId,
      descriptor: context.descriptor || proof.descriptor || { descriptorId },
      state: reachable ? 'active' : 'quarantined',
      eventId: context.eventId || proof.proofId || proof.signature || descriptorId,
      observedAt: proof.observedAt || context.observedAt || Date.now(),
      proofId: proof.proofId,
      quarantineUntil: proof.quarantineUntil || 0n,
      tombstonedAt: proof.tombstonedAt || 0n,
      signatureValid: proof.signatureValid !== false,
      reachable,
    }, context)

    if (reachable && result.applied) {
      recordUsefulWork('proof-accepted', 1, { descriptorId, peerId: context.peerId, at: context.observedAt || Date.now() })
    } else {
      recordUsefulWork('proof-rejected', 1, { descriptorId, peerId: context.peerId, at: context.observedAt || Date.now() })
    }
    return { accepted: result.applied, record: result.record, state: concurrentState }
  }

  function shouldSyncPeer(peer = {}, now = Date.now()) {
    const peerRecord = concurrentState.peers.get(toHex(peer.peerId || peer.identity?.publicKey || '')) || registerPeer(peer)
    return resources.budgetFor(peer.resources || peer).canSync && peerRecord.score >= 20 && sybil.allowsRequest(peer.identity || peer, peer.inFlightRequests || 0, now)
  }

  function chooseFanoutPeers(peers = [], now = Date.now()) {
    const ranked = Array.isArray(peers)
      ? peers.map((peer) => ({ peer, score: scorePeer(peer, now) })).sort((a, b) => b.score - a.score)
      : []
    const limit = sybil.allowsFanout(options.identity || {}, resources.profile.maxFanout, now)
    return ranked.slice(0, limit).map((entry) => entry.peer)
  }

  function planRefresh(descriptor, now = Date.now()) {
    const record = descriptor || {}
    const longTail = availability.isLongTail(record, now)
    const needsRefresh = availability.needsRefresh(record, now)
    const proofDue = safeBigInt(record.lastProofAt || 0n, 0n) === 0n || nowMs(now) - safeBigInt(record.lastProofAt || 0n, 0n) >= BigInt(resources.profile.proofIntervalMs)
    const fetchDue = needsRefresh || longTail
    const rotateEpoch = fetchDue || proofDue
    return {
      longTail,
      needsRefresh,
      proofDue,
      fetchDue,
      rotateEpoch,
      nextSyncAt: Number(nowMs(now) + BigInt(resources.profile.syncIntervalMs)),
      nextProofAt: Number(nowMs(now) + BigInt(resources.profile.proofIntervalMs)),
      nextRefreshAt: Number(nowMs(now) + BigInt(resources.profile.refreshIntervalMs)),
    }
  }

  function playerSnapshot() {
    return playerCore.snapshot()
  }

  function routePlayerEvent(event = {}, context = {}) {
    return playerCore.dispatch(event, context)
  }

  function prioritizeMainPlayer(context = {}) {
    return playerCore.prioritizeMain(context)
  }

  function prioritizeShortsPlayer(context = {}) {
    return playerCore.prioritizeShorts(context)
  }

  function suspendInactivePlayers(context = {}) {
    return playerCore.suspendInactivePlayers(context)
  }

  function usefulWorkSnapshot() {
    return usefulWork.snapshot()
  }

  function stateSnapshot() {
    return {
      role,
      peers: Array.from(concurrentState.peers.values()),
      descriptors: Array.from(concurrentState.descriptors.values()),
      quarantines: Array.from(concurrentState.quarantines.values()),
      tombstones: Array.from(concurrentState.tombstones.values()),
      causalWatermark: concurrentState.causalWatermark,
      lastAppliedAt: concurrentState.lastAppliedAt,
      players: playerSnapshot(),
    }
  }

  const api = {
    role,
    get state() { return lifecycleState },
    get concurrentState() { return concurrentState },
    get backend() { return backend },
    get services() { return services },
    sybil,
    usefulWork,
    peerScorer,
    availability,
    resources,
    playerCore,
    playback,
    eventSink,
    scorePeer,
    registerPeer,
    recordUsefulWork,
    ingestDescriptor,
    ingestProof,
    shouldSyncPeer,
    chooseFanoutPeers,
    planRefresh,
    routePlayerEvent,
    prioritizeMainPlayer,
    prioritizeShortsPlayer,
    suspendInactivePlayers,
    playerSnapshot,
    usefulWorkSnapshot,
    stateSnapshot,
    getStatus,
    init,
    start,
    suspend,
    resume,
    shutdown,
  }

  return api
}

/**
 * HRPC surface for the universal core lifecycle.
 * Runtime adapters register this shared surface instead of each shell inventing
 * its own core status/start/suspend/resume/shutdown handlers.
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
    },
  }
}

export default {
  ROLE_MOBILE,
  ROLE_RELAY,
  ROLE_HYBRID,
  PLAYER_MAIN,
  PLAYER_SHORTS,
  createSybilPolicy,
  createUsefulWorkLedger,
  createPeerScorer,
  createAvailabilityPlanner,
  createResourcePolicy,
  createBudgetManager,
  createConcurrentState,
  applyConcurrentUpdate,
  createPlayerSplitState,
  createPlayerResourceGate,
  createUnifiedAutobaseSink,
  createDualPlayerPlaybackCore,
  createUniversalCore,
  createUniversalHrpcSurface,
}
