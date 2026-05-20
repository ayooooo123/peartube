import { createDescriptorBloom, bloomFilterKnownDescriptors, decodeDescriptorBloom } from './bloom.js'
import { createIdentityQuota, createQuotaTracker, rateLimitFanout, shouldRequestMore } from './quota.js'
import { validateIncomingDescriptor, validateIncomingProof } from '../validators.js'
export { validateIncomingDescriptor, validateIncomingProof } from '../validators.js'

const textEncoder = new TextEncoder()

function bytesToHex(bytes) {
  return Array.from(bytes || [], (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function normalizeDescriptorId(value) {
  if (!value) return null
  if (value instanceof Uint8Array) return bytesToHex(value)
  if (typeof value === 'string') return value.trim().toLowerCase().replace(/^0x/, '')
  if (typeof value === 'object') {
    return normalizeDescriptorId(value.descriptorId || value.id || value.driveKey || value.channelId || value.key || value.descriptor?.descriptorId || value.proof?.descriptorId)
  }
  return null
}

function safeNumber(value, fallback = 0) {
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) return fallback
    return Number(value)
  }
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function isFreshEnough(descriptor, now = Date.now(), maxAgeMs = 10 * 60 * 1000, options = {}) {
  if (!descriptor || typeof descriptor !== 'object') return false
  const expiresAt = safeNumber(descriptor.expiresAt, 0)
  const publishAt = safeNumber(descriptor.publishAt ?? descriptor.publishedAt ?? descriptor.createdAt ?? descriptor.updatedAt ?? descriptor.timestamp, 0)
  const availabilityEpoch = safeNumber(descriptor.availabilityEpoch ?? descriptor.epoch ?? descriptor.sequenceEpoch, 0)
  const freshnessSkewMs = Math.max(0, safeNumber(options.freshnessSkewMs ?? options.maxClockSkewMs ?? options.clockDriftMs, 15 * 60 * 1000))
  const expireGraceMs = Math.max(0, safeNumber(options.expireGraceMs, 5 * 60 * 1000))
  const availabilityEpochSlack = Math.max(1, safeNumber(options.availabilityEpochSlack ?? options.maxEpochSkew ?? options.epochDrift, 6))
  if (expiresAt && now > expiresAt + Math.max(expireGraceMs, freshnessSkewMs)) return false
  if (publishAt && now + Math.max(maxAgeMs, freshnessSkewMs) < publishAt) return false
  if (availabilityEpoch) {
    const currentEpoch = Math.floor(now / 600000)
    if (Math.abs(currentEpoch - availabilityEpoch) > availabilityEpochSlack) return false
  }
  return true
}

export function shouldPropagateDescriptor(descriptor, options = {}) {
  if (!descriptor) return false
  if (!isFreshEnough(descriptor, options.now, options.maxAgeMs, options)) return false
  if (options.reachabilityGate && !options.reachabilityGate(descriptor)) return false
  if (options.requirePlayable !== false && descriptor.flags != null && (Number(descriptor.flags) & (1 << 4))) {
    return false
  }
  return true
}

export function buildGossipState(options = {}) {
  const now = options.now || Date.now()
  const known = Array.isArray(options.knownDescriptors) ? options.knownDescriptors : []
  const bloom = bloomFilterKnownDescriptors(known, options.bloom)
  const quota = createQuotaTracker(options.identity || {}, now)
  return {
    now,
    bloom,
    quota,
    knownDescriptors: known.map((descriptor) => normalizeDescriptorId(descriptor)).filter(Boolean),
    identityWeight: createIdentityQuota(options.identity || {}, now).weight,
  }
}

export function createGossipSync(options = {}) {
  const state = buildGossipState(options)
  const validators = {
    verifySignature: options.verifySignature,
    allowUnsignedForTests: options.allowUnsignedForTests,
    reachabilityGate: options.reachabilityGate,
    maxAgeMs: options.maxAgeMs,
    now: options.now,
    maxClockSkewMs: options.maxClockSkewMs,
    clockDriftMs: options.clockDriftMs,
    epochDrift: options.epochDrift,
    maxEpochSkew: options.maxEpochSkew,
    expireGraceMs: options.expireGraceMs,
  }

  async function buildOutboundFilter(descriptors = []) {
    const local = bloomFilterKnownDescriptors(descriptors.length ? descriptors : state.knownDescriptors, options.bloom)
    return local.serialize()
  }

  async function exchange(peer, descriptors = []) {
    const remoteFilter = await peer?.sendBloom?.(await buildOutboundFilter(descriptors))
    const remote = remoteFilter?.has ? remoteFilter : (remoteFilter ? decodeDescriptorBloom(remoteFilter) : null)
    const localCandidates = Array.isArray(descriptors) ? descriptors : []
    const remoteMissing = localCandidates.filter((descriptor) => {
      const id = normalizeDescriptorId(descriptor)
      if (!id) return false
      return !remote?.bits || !remote?.has?.(id)
    })
    const allowed = []
    for (const descriptor of remoteMissing) {
      if (!state.quota.consume(1)) break
      allowed.push(descriptor)
    }
    if (allowed.length > 0) {
      if (typeof peer?.sendDescriptors === 'function') {
        await peer.sendDescriptors(allowed)
      } else if (typeof peer?.offerDescriptors === 'function') {
        await peer.offerDescriptors(allowed.map((descriptor) => normalizeDescriptorId(descriptor)).filter(Boolean))
      }
    }
    return { remoteFilter, missing: allowed, remoteMissing: allowed }
  }

  async function ingest(entries = []) {
    const accepted = []
    for (const entry of Array.isArray(entries) ? entries : []) {
      const isProof = Boolean(entry?.proof)
      const descriptorResult = isProof
        ? await validateIncomingProof(entry, validators)
        : await validateIncomingDescriptor(entry, validators)
      if (!descriptorResult.ok) continue
      const payload = isProof ? entry.proof : (entry?.descriptor || entry)
      if (!isProof && payload && !shouldPropagateDescriptor(payload, { ...validators, reachabilityGate: options.reachabilityGate })) {
        continue
      }
      accepted.push(entry)
      const id = normalizeDescriptorId(payload)
      if (id) state.bloom.add(id)
      if (id && !state.knownDescriptors.includes(id)) state.knownDescriptors.push(id)
    }
    return accepted
  }

  async function fanout(peers = [], descriptors = []) {
    const quotaPeers = rateLimitFanout(Array.isArray(peers) ? peers : [], state.quota)
    const payload = await buildOutboundFilter(descriptors)
    let sent = 0
    for (const peer of quotaPeers) {
      if (!state.quota.consume(1)) break
      sent += 1
      if (typeof peer?.sendBloom === 'function') await peer.sendBloom(payload)
      if (typeof peer?.requestDescriptors === 'function' && shouldRequestMore(state.quota, peer?.pendingRequests || 0)) {
        const ids = (Array.isArray(descriptors) ? descriptors : []).map((descriptor) => normalizeDescriptorId(descriptor)).filter(Boolean)
        if (ids.length > 0) await peer.requestDescriptors(ids)
      }
    }
    return sent
  }

  return {
    state,
    validators,
    buildOutboundFilter,
    exchange,
    ingest,
    fanout,
    validateIncomingDescriptor: (entry) => validateIncomingDescriptor(entry, validators),
    validateIncomingProof: (entry) => validateIncomingProof(entry, validators),
    shouldPropagateDescriptor: (descriptor) => shouldPropagateDescriptor(descriptor, { ...validators, reachabilityGate: options.reachabilityGate }),
  }
}

export default {
  createGossipSync,
  buildGossipState,
  validateIncomingDescriptor,
  validateIncomingProof,
  shouldPropagateDescriptor,
}
