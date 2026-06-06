import c from 'compact-encoding'
import BeeDiffStream from 'hyperbee-diff-stream'

import {
  descriptorIdOf,
  hashText,
  nowMs,
  safeBigInt,
  safeNumber,
  toHex,
} from './universal-core-utils.js'

const METRIC_PREFIX = 'universal-core:peer-metric:'

function identityAgeScore(identity = {}, now = Date.now()) {
  const createdAt = safeBigInt(identity.createdAt || 0n, 0n)
  const ageMs = createdAt > 0n ? Math.max(0n, nowMs(now) - createdAt) : 0n
  return Math.min(40, Number(ageMs / BigInt(24 * 60 * 60 * 1000)))
}

function clampScore(score) {
  return Math.max(0, Math.min(100, Math.floor(safeNumber(score, 0))))
}

function metricIncludes(metric = {}, names = []) {
  return names.some((name) => metric[name] !== undefined && metric[name] !== null)
}

function normalizeMetric(peerId, metric = {}) {
  const handshakes = safeNumber(metric.handshakes ?? metric.handshakeCount, 0)
  const failures = safeNumber(metric.handshakeFailures ?? metric.failedHandshakes, 0)
  const successes = safeNumber(metric.handshakeSuccesses ?? metric.successfulHandshakes, 0)
  const total = Math.max(handshakes, successes + failures)
  const latencyMs = Math.max(0, safeNumber(metric.latencyMs ?? metric.rttMs, 0))
  const handshakeDurationMs = Math.max(0, safeNumber(metric.handshakeDurationMs ?? metric.handshakeMs ?? metric.handshakeLatencyMs, 0))
  const socketStabilityObserved = metric.socketStabilityObserved !== undefined && metric.socketStabilityObserved !== null
    ? Boolean(metric.socketStabilityObserved)
    : metricIncludes(metric, ['socketStability', 'socketStabilityScore', 'stability'])
  const socketStability = socketStabilityObserved
    ? Math.max(0, Math.min(100, safeNumber(metric.socketStability ?? metric.socketStabilityScore ?? metric.stability, 0)))
    : 0
  const throughput = Math.max(0, safeNumber(metric.udxThroughputBps ?? metric.throughputBps ?? metric.bytesPerSecond, 0))
  return {
    peerId: toHex(peerId || metric.peerId || metric.identityId || hashText(metric)),
    latencyMs,
    handshakeDurationMs,
    socketStability,
    socketStabilityObserved,
    handshakeSuccesses: successes,
    handshakeFailures: failures,
    handshakes: total,
    udxThroughputBps: throughput,
    observedAt: safeBigInt(metric.observedAt || metric.at || Date.now(), nowMs()),
  }
}

function performanceScore(metric = {}) {
  if (!metric) return 0
  const latency = safeNumber(metric.latencyMs, 0)
  const handshakeDuration = safeNumber(metric.handshakeDurationMs, 0)
  const stability = safeNumber(metric.socketStability, 0)
  const throughput = safeNumber(metric.udxThroughputBps, 0)
  const handshakes = Math.max(1, safeNumber(metric.handshakes, 0))
  const successes = safeNumber(metric.handshakeSuccesses, 0)
  const failures = safeNumber(metric.handshakeFailures, 0)
  const handshakeRate = Math.max(0, Math.min(1, successes / Math.max(handshakes, successes + failures, 1)))
  const latencyScore = latency <= 0 ? 5 : Math.max(-20, 20 - Math.floor(latency / 50))
  const handshakeDurationScore = handshakeDuration <= 0 ? 0 : Math.max(-15, 12 - Math.floor(handshakeDuration / 75))
  const stabilityScore = Math.floor(stability / 5) - (stability > 0 && stability < 20 ? 15 : 0)
  const throughputScore = Math.min(20, Math.floor(throughput / (128 * 1024)))
  const handshakeScore = Math.floor(handshakeRate * 20) - Math.min(20, failures * 4)
  return latencyScore + handshakeDurationScore + stabilityScore + throughputScore + handshakeScore
}

export const peerMetricEncoding = {
  preencode(state, metric = {}) {
    c.uint.preencode(state, 3)
    c.string.preencode(state, toHex(metric.peerId || ''))
    c.uint.preencode(state, Math.max(0, Math.floor(safeNumber(metric.latencyMs, 0))))
    c.uint.preencode(state, Math.max(0, Math.floor(safeNumber(metric.handshakeDurationMs, 0))))
    c.uint.preencode(state, Math.max(0, Math.floor(safeNumber(metric.socketStability, 0))))
    c.bool.preencode(state, Boolean(metric.socketStabilityObserved))
    c.uint.preencode(state, Math.max(0, Math.floor(safeNumber(metric.handshakeSuccesses, 0))))
    c.uint.preencode(state, Math.max(0, Math.floor(safeNumber(metric.handshakeFailures, 0))))
    c.uint.preencode(state, Math.max(0, Math.floor(safeNumber(metric.handshakes, 0))))
    c.uint.preencode(state, Math.max(0, Math.floor(safeNumber(metric.udxThroughputBps, 0))))
    c.biguint.preencode(state, safeBigInt(metric.observedAt, 0n))
  },
  encode(state, metric = {}) {
    c.uint.encode(state, 3)
    c.string.encode(state, toHex(metric.peerId || ''))
    c.uint.encode(state, Math.max(0, Math.floor(safeNumber(metric.latencyMs, 0))))
    c.uint.encode(state, Math.max(0, Math.floor(safeNumber(metric.handshakeDurationMs, 0))))
    c.uint.encode(state, Math.max(0, Math.floor(safeNumber(metric.socketStability, 0))))
    c.bool.encode(state, Boolean(metric.socketStabilityObserved))
    c.uint.encode(state, Math.max(0, Math.floor(safeNumber(metric.handshakeSuccesses, 0))))
    c.uint.encode(state, Math.max(0, Math.floor(safeNumber(metric.handshakeFailures, 0))))
    c.uint.encode(state, Math.max(0, Math.floor(safeNumber(metric.handshakes, 0))))
    c.uint.encode(state, Math.max(0, Math.floor(safeNumber(metric.udxThroughputBps, 0))))
    c.biguint.encode(state, safeBigInt(metric.observedAt, 0n))
  },
  decode(state) {
    const version = c.uint.decode(state)
    if (version !== 1 && version !== 2 && version !== 3) throw new Error(`Unsupported peer metric version ${version}`)
    const peerId = c.string.decode(state)
    const latencyMs = c.uint.decode(state)
    const handshakeDurationMs = version >= 2 ? c.uint.decode(state) : 0
    const socketStability = version >= 2 ? c.uint.decode(state) : 0
    const socketStabilityObserved = version >= 3 ? c.bool.decode(state) : version >= 2
    return {
      peerId,
      latencyMs,
      handshakeDurationMs,
      socketStability,
      socketStabilityObserved,
      handshakeSuccesses: c.uint.decode(state),
      handshakeFailures: c.uint.decode(state),
      handshakes: c.uint.decode(state),
      udxThroughputBps: c.uint.decode(state),
      observedAt: c.biguint.decode(state),
    }
  },
}

export function encodePeerMetric(metric = {}) {
  return c.encode(peerMetricEncoding, normalizeMetric(metric.peerId, metric))
}

export function decodePeerMetric(buffer) {
  if (!buffer) return null
  return c.decode(peerMetricEncoding, buffer)
}

export function createPeerMetricDiffStream(leftSnapshot, rightSnapshot, options = {}) {
  return new BeeDiffStream(leftSnapshot, rightSnapshot, {
    ...options,
    gte: options.gte || METRIC_PREFIX,
    lt: options.lt || 'universal-core:peer-metric;',
    keyEncoding: options.keyEncoding || 'utf-8',
    valueEncoding: options.valueEncoding || 'binary',
  })
}

export function createSybilPolicy(options = {}) {
  const base = {
    minProofs: safeNumber(options.minProofs, 1),
    maxFailurePenalty: safeNumber(options.maxFailurePenalty, 45),
    maxQuarantinePenalty: safeNumber(options.maxQuarantinePenalty, 35),
    maxTombstonePenalty: safeNumber(options.maxTombstonePenalty, 50),
    maxSpamPenalty: safeNumber(options.maxSpamPenalty, 20),
  }

  return {
    scoreIdentity(identity = {}, now = Date.now()) {
      const age = identityAgeScore(identity, now)
      const validProofs = Math.min(30, safeNumber(identity.validProofCount, 0) * 6)
      const successfulSeals = Math.min(15, safeNumber(identity.successfulSealCount, 0) * 3)
      const serviceScore = Math.min(15, Math.floor(safeNumber(identity.usefulWorkScore, 0) / 25))
      const failures = Math.min(base.maxFailurePenalty, safeNumber(identity.failureCount, 0) * 9)
      const quarantines = Math.min(base.maxQuarantinePenalty, safeNumber(identity.quarantineCount, 0) * 7)
      const tombstones = Math.min(base.maxTombstonePenalty, safeNumber(identity.tombstoneCount, 0) * 10)
      const spam = Math.min(base.maxSpamPenalty, safeNumber(identity.spamScore, 0) * 4)
      const freshness = Math.max(0, 10 - Math.floor(Math.max(0, safeNumber(identity.lastProofAgeMs, Infinity)) / (60 * 60 * 1000)))
      const score = 20 + age + validProofs + successfulSeals + serviceScore + freshness - failures - quarantines - tombstones - spam
      return clampScore(score)
    },
    allowsFanout(identity, peerCount = 0, now = Date.now()) {
      const score = this.scoreIdentity(identity, now)
      const scaledFanout = Math.max(1, Math.floor(score / 10))
      return Math.min(Math.max(1, peerCount || 1), scaledFanout)
    },
    allowsRequest(identity, inFlight = 0, now = Date.now()) {
      const score = this.scoreIdentity(identity, now)
      const allowance = Math.max(1, Math.floor(score / 15))
      return inFlight < allowance
    },
  }
}

export function createUsefulWorkLedger(options = {}) {
  const byPeer = new Map()
  const byDescriptor = new Map()
  const totals = {
    verifiedDescriptors: 0,
    refreshedDescriptors: 0,
    sampledDescriptors: 0,
    bytesServed: 0n,
    longTailServed: 0,
    proofsAccepted: 0,
    proofsRejected: 0,
  }

  function bucket(map, key) {
    if (!map.has(key)) map.set(key, { count: 0, score: 0, bytes: 0n, lastAt: 0n })
    return map.get(key)
  }

  function reward(kind, amount = 1, context = {}) {
    const descriptorId = descriptorIdOf(context.descriptorId || context.descriptor || '')
    const peerId = toHex(context.peerId || context.identityId || '')
    const at = safeBigInt(context.at || Date.now(), nowMs())
    let scoreDelta = 0

    switch (kind) {
      case 'descriptor-verified':
        scoreDelta = 10 * amount
        totals.verifiedDescriptors += amount
        break
      case 'descriptor-refreshed':
        scoreDelta = 6 * amount
        totals.refreshedDescriptors += amount
        break
      case 'availability-sampled':
        scoreDelta = 5 * amount
        totals.sampledDescriptors += amount
        break
      case 'bytes-served':
        scoreDelta = Math.max(1, Math.floor(Number(amount) / (64 * 1024)))
        totals.bytesServed += safeBigInt(amount, 0n)
        break
      case 'long-tail-served':
        scoreDelta = 12 * amount
        totals.longTailServed += amount
        break
      case 'proof-accepted':
        scoreDelta = 8 * amount
        totals.proofsAccepted += amount
        break
      case 'proof-rejected':
        scoreDelta = -6 * amount
        totals.proofsRejected += amount
        break
      default:
        scoreDelta = 0
    }

    if (descriptorId) {
      const d = bucket(byDescriptor, descriptorId)
      d.count += amount
      d.score += scoreDelta
      d.lastAt = at > d.lastAt ? at : d.lastAt
      if (kind === 'bytes-served') d.bytes += safeBigInt(amount, 0n)
    }

    if (peerId) {
      const p = bucket(byPeer, peerId)
      p.count += amount
      p.score += scoreDelta
      p.lastAt = at > p.lastAt ? at : p.lastAt
      if (kind === 'bytes-served') p.bytes += safeBigInt(amount, 0n)
    }

    return scoreDelta
  }

  function scoreUsefulWork() {
    const byteScore = Number(totals.bytesServed / BigInt(1024 * 1024))
    return Math.max(0, totals.verifiedDescriptors * 10 + totals.refreshedDescriptors * 6 + totals.sampledDescriptors * 5 + totals.longTailServed * 12 + totals.proofsAccepted * 8 + byteScore + totals.proofsRejected * -2)
  }

  function snapshot() {
    return {
      totals: {
        ...totals,
        bytesServed: totals.bytesServed,
      },
      byPeer: Array.from(byPeer.entries()),
      byDescriptor: Array.from(byDescriptor.entries()),
      usefulWorkScore: scoreUsefulWork(),
    }
  }

  return { reward, scoreUsefulWork, snapshot, byPeer, byDescriptor, totals }
}

export function createPeerScorer(options = {}) {
  const sybil = options.sybil || createSybilPolicy(options.sybilOptions || {})
  const usefulWork = options.usefulWork || createUsefulWorkLedger(options.usefulWorkOptions || {})
  const state = options.state || { peers: new Map() }
  const availability = options.availability
  const resources = options.resources
  const metrics = options.metrics || new Map()
  const subscribers = new Set()
  const persist = typeof options.persist === 'function' ? options.persist : null
  const metaDb = options.metaDb || null
  const evictPeer = typeof options.evictPeer === 'function' ? options.evictPeer : null

  function notify(peerId, record) {
    for (const subscriber of subscribers) {
      try {
        subscriber(peerId, record)
      } catch {
        // Ignore observer failures so scoring updates keep flowing.
      }
    }
  }

  async function persistMetric(metric) {
    const key = `${METRIC_PREFIX}${metric.peerId}`
    const value = encodePeerMetric(metric)
    if (persist) return await persist(key, value, metric)
    if (typeof metaDb?.put === 'function') return await metaDb.put(key, value)
    return null
  }

  function metricFor(peer = {}) {
    const peerId = toHex(peer.peerId || peer.identity?.publicKey || peer.identityId || '')
    return metrics.get(peerId) || null
  }

  function scorePeer(peer = {}, now = Date.now()) {
    const identityScore = sybil.scoreIdentity(peer.identity || peer, now)
    const useful = Math.max(0, safeNumber(peer.usefulWorkScore, 0))
    const reachability = availability?.shouldAdmit?.(peer.descriptor || peer, now) ? 10 : 0
    const resourceFit = resources?.budgetFor ? resources.budgetFor(peer.resources || peer).credit : 50
    const metricScore = performanceScore(metricFor(peer) || peer.performance || peer.metrics)
    return clampScore(identityScore + Math.floor(useful / 10) + reachability + Math.floor(resourceFit / 10) + metricScore)
  }

  function registerPeer(peer = {}) {
    const id = toHex(peer.peerId || peer.identity?.publicKey || peer.identityId || hashText(peer))
    const score = scorePeer({ ...peer, peerId: id })
    const fanoutCap = resources?.getThresholds ? resources.getThresholds(peer.resources || peer).maxFanout : resources?.profile?.maxFanout
    const record = {
      ...peer,
      peerId: id,
      score,
      lastSeenAt: nowMs(peer.lastSeenAt || Date.now()),
      fanoutBudget: sybil.allowsFanout(peer.identity || peer, fanoutCap || 1),
      requestBudget: sybil.allowsRequest(peer.identity || peer, peer.inFlightRequests || 0),
      performance: metrics.get(id) || peer.performance || null,
    }
    state.peers.set(id, record)
    notify(id, record)
    return record
  }

  async function recordPerformance(peerId, metric = {}) {
    const normalized = normalizeMetric(peerId, metric)
    const current = metrics.get(normalized.peerId)
    const merged = current
      ? {
          ...current,
          latencyMs: metricIncludes(metric, ['latencyMs', 'rttMs']) ? normalized.latencyMs : current.latencyMs,
          handshakeDurationMs: metricIncludes(metric, ['handshakeDurationMs', 'handshakeMs', 'handshakeLatencyMs']) ? normalized.handshakeDurationMs : current.handshakeDurationMs,
          socketStability: metricIncludes(metric, ['socketStability', 'socketStabilityScore', 'stability']) ? normalized.socketStability : current.socketStability,
          socketStabilityObserved: Boolean(current.socketStabilityObserved || normalized.socketStabilityObserved),
          handshakeSuccesses: current.handshakeSuccesses + normalized.handshakeSuccesses,
          handshakeFailures: current.handshakeFailures + normalized.handshakeFailures,
          handshakes: current.handshakes + normalized.handshakes,
          udxThroughputBps: Math.max(current.udxThroughputBps, normalized.udxThroughputBps),
          observedAt: normalized.observedAt > current.observedAt ? normalized.observedAt : current.observedAt,
        }
      : normalized
    metrics.set(merged.peerId, merged)
    const peer = state.peers.get(merged.peerId)
    if (peer) registerPeer({ ...peer, performance: merged })
    await persistMetric(merged)
    return merged
  }

  async function applyPerformanceDiff(diff) {
    const entry = diff?.left || diff?.right
    if (!entry?.value) return null
    const metric = decodePeerMetric(entry.value)
    if (diff.left) metrics.set(metric.peerId, metric)
    else metrics.delete(metric.peerId)
    const peer = state.peers.get(metric.peerId)
    if (peer) registerPeer({ ...peer, performance: metric })
    return metric
  }

  async function applyPerformanceDiffStream(stream) {
    const applied = []
    for await (const diff of stream) {
      const metric = await applyPerformanceDiff(diff)
      if (metric) applied.push(metric)
    }
    return applied
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {}
    subscribers.add(listener)
    return () => subscribers.delete(listener)
  }

  function rankPeers(peers = Array.from(state.peers.values()), now = Date.now()) {
    return peers
      .map((peer) => registerPeer({ ...peer, score: scorePeer(peer, now) }))
      .sort((a, b) => b.score - a.score)
  }

  function shouldEvict(peerOrId, options = {}) {
    const minScore = safeNumber(options.minScore, 40)
    const peer = typeof peerOrId === 'string' ? state.peers.get(peerOrId) : peerOrId
    if (!peer) return false
    const metric = metricFor(peer) || peer.performance || {}
    if (safeNumber(metric.handshakeFailures, 0) >= safeNumber(options.maxHandshakeFailures, 4)) return true
    const stability = safeNumber(metric.socketStability, 100)
    if (metric.socketStabilityObserved && stability < safeNumber(options.minSocketStability, 20)) return true
    return safeNumber(peer.score ?? scorePeer(peer), 0) < minScore
  }

  function evictLowPerformers(options = {}) {
    const evicted = []
    for (const peer of Array.from(state.peers.values())) {
      if (!shouldEvict(peer, options)) continue
      state.peers.delete(peer.peerId)
      evicted.push(peer)
      if (evictPeer) evictPeer(peer.peerId, peer)
      notify(peer.peerId, { ...peer, evicted: true })
    }
    return { evicted, remaining: rankPeers() }
  }

  function snapshot() {
    return {
      peers: Array.from(state.peers.values()),
      metrics: Array.from(metrics.values()),
    }
  }

  return {
    sybil,
    usefulWork,
    metrics,
    scorePeer,
    registerPeer,
    recordPerformance,
    applyPerformanceDiff,
    applyPerformanceDiffStream,
    createPerformanceDiffStream: createPeerMetricDiffStream,
    rankPeers,
    shouldEvict,
    evictLowPerformers,
    subscribe,
    snapshot,
  }
}
