import { createDescriptorBloom, bloomFilterKnownDescriptors, decodeDescriptorBloom } from './bloom.js'
import { createIdentityQuota, createQuotaTracker, rateLimitFanout, shouldRequestMore } from './quota.js'

const textEncoder = new TextEncoder()
const ZERO_32 = new Uint8Array(32)

function toBytes(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value)
  if (typeof value === 'string') {
    const clean = value.trim().replace(/^0x/, '').replace(/[^0-9a-f]/gi, '').toLowerCase()
    if (clean.length === 0) return textEncoder.encode(value)
    const out = new Uint8Array(Math.ceil(clean.length / 2))
    for (let i = 0; i < out.length; i++) {
      const start = i * 2
      out[i] = parseInt(clean.slice(start, start + 2).padEnd(2, '0'), 16) || 0
    }
    return out
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  return textEncoder.encode(String(value ?? ''))
}

function bytesToHex(bytes) {
  return Array.from(bytes || [], (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function normalizeDescriptorId(value) {
  if (!value) return null
  if (value instanceof Uint8Array) return bytesToHex(value)
  if (typeof value === 'string') return value.trim().toLowerCase().replace(/^0x/, '')
  if (typeof value === 'object' && value.descriptorId) return normalizeDescriptorId(value.descriptorId)
  return null
}

function safeNumber(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function isDescriptorFresh(descriptor, now = Date.now(), maxAgeMs = 10 * 60 * 1000) {
  if (!descriptor || typeof descriptor !== 'object') return false
  const expiresAt = safeNumber(descriptor.expiresAt, 0)
  const publishAt = safeNumber(descriptor.publishAt, 0)
  const availabilityEpoch = safeNumber(descriptor.availabilityEpoch, 0)
  if (expiresAt && now > expiresAt) return false
  if (publishAt && now + maxAgeMs < publishAt) return false
  if (availabilityEpoch && Math.abs(((now / 600000) | 0) - availabilityEpoch) > 2) return false
  return true
}

async function defaultVerifySignature({ descriptor, entry, verifier }) {
  if (typeof verifier !== 'function') return true
  return Boolean(await verifier({ descriptor, entry }))
}

function getDescriptorId(entry) {
  return normalizeDescriptorId(entry?.descriptorId || entry?.id || entry?.driveKey || entry?.descriptor?.descriptorId)
}

function buildValidationResult({ ok, reason = null, entry = null, descriptor = null }) {
  return { ok, reason, entry, descriptor }
}

export async function validateIncomingDescriptor(entry, options = {}) {
  const descriptor = entry?.descriptor || entry || null
  const id = getDescriptorId(descriptor)
  if (!id) return buildValidationResult({ ok: false, reason: 'missing-descriptor-id', entry, descriptor })
  if (!isDescriptorFresh(descriptor, options.now, options.maxAgeMs)) {
    return buildValidationResult({ ok: false, reason: 'stale-descriptor', entry, descriptor })
  }
  if (descriptor.flags != null && (Number(descriptor.flags) & (1 << 5))) {
    return buildValidationResult({ ok: false, reason: 'tombstoned', entry, descriptor })
  }
  const signatureOk = await defaultVerifySignature({ descriptor, entry, verifier: options.verifySignature })
  if (!signatureOk) {
    return buildValidationResult({ ok: false, reason: 'bad-signature', entry, descriptor })
  }
  return buildValidationResult({ ok: true, entry, descriptor })
}

export async function validateIncomingProof(entry, options = {}) {
  const proof = entry?.proof || entry || null
  if (!proof || !normalizeDescriptorId(proof.descriptorId)) {
    return buildValidationResult({ ok: false, reason: 'missing-proof-target', entry, descriptor: null })
  }
  const observedAt = safeNumber(proof.observedAt, 0)
  const expiresAt = safeNumber(proof.expiresAt, 0)
  const now = options.now || Date.now()
  if (observedAt && now + (options.maxClockSkewMs || 300000) < observedAt) {
    return buildValidationResult({ ok: false, reason: 'proof-from-future', entry, descriptor: null })
  }
  if (expiresAt && now > expiresAt) {
    return buildValidationResult({ ok: false, reason: 'proof-expired', entry, descriptor: null })
  }
  const signatureOk = await defaultVerifySignature({ descriptor: proof, entry, verifier: options.verifySignature })
  if (!signatureOk) {
    return buildValidationResult({ ok: false, reason: 'bad-signature', entry, descriptor: null })
  }
  return buildValidationResult({ ok: true, entry, descriptor: null })
}

export function shouldPropagateDescriptor(descriptor, options = {}) {
  if (!descriptor) return false
  if (!isDescriptorFresh(descriptor, options.now, options.maxAgeMs)) return false
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
    knownDescriptors: known.map((descriptor) => normalizeDescriptorId(descriptor?.descriptorId || descriptor?.id || descriptor?.driveKey)).filter(Boolean),
    identityWeight: createIdentityQuota(options.identity || {}, now).weight,
  }
}

export function createGossipSync(options = {}) {
  const state = buildGossipState(options)
  const validators = {
    verifySignature: options.verifySignature,
    reachabilityGate: options.reachabilityGate,
    maxAgeMs: options.maxAgeMs,
    now: options.now,
  }

  async function buildOutboundFilter(descriptors = []) {
    const local = bloomFilterKnownDescriptors(descriptors.length ? descriptors : state.knownDescriptors, options.bloom)
    return local.serialize()
  }

  async function exchange(peer, descriptors = []) {
    const remoteFilter = await peer?.sendBloom?.(await buildOutboundFilter(descriptors))
    const remote = remoteFilter?.has ? remoteFilter : (remoteFilter ? decodeDescriptorBloom(remoteFilter) : null)
    const localCandidates = Array.isArray(descriptors) ? descriptors : []
    const missing = localCandidates.filter((descriptor) => {
      const id = normalizeDescriptorId(descriptor?.descriptorId || descriptor?.id || descriptor?.driveKey)
      if (!id) return false
      return !remote?.bits || !remote?.has?.(id)
    })
    const allowed = rateLimitFanout(missing, state.quota)
    if (allowed.length > 0 && shouldRequestMore(state.quota, peer?.pendingRequests || 0)) {
      await peer?.requestDescriptors?.(allowed.map((descriptor) => normalizeDescriptorId(descriptor?.descriptorId || descriptor?.id || descriptor?.driveKey)).filter(Boolean))
    }
    return { remoteFilter, missing: allowed }
  }

  async function ingest(entries = []) {
    const accepted = []
    for (const entry of Array.isArray(entries) ? entries : []) {
      const descriptorResult = entry?.proof
        ? await validateIncomingProof(entry, validators)
        : await validateIncomingDescriptor(entry, validators)
      if (!descriptorResult.ok) continue
      const descriptor = entry?.descriptor || entry
      if (descriptor && !shouldPropagateDescriptor(descriptor, { ...validators, reachabilityGate: options.reachabilityGate })) {
        continue
      }
      accepted.push(entry)
      const id = getDescriptorId(descriptor)
      if (id) state.bloom.add(id)
      if (id && !state.knownDescriptors.includes(id)) state.knownDescriptors.push(id)
    }
    return accepted
  }

  async function fanout(peers = [], descriptors = []) {
    const quotaPeers = rateLimitFanout(Array.isArray(peers) ? peers : [], state.quota)
    const payload = await buildOutboundFilter(descriptors)
    for (const peer of quotaPeers) {
      if (typeof peer?.sendBloom === 'function') await peer.sendBloom(payload)
      if (typeof peer?.requestDescriptors === 'function' && shouldRequestMore(state.quota, peer?.pendingRequests || 0)) {
        const ids = (Array.isArray(descriptors) ? descriptors : []).map((descriptor) => normalizeDescriptorId(descriptor?.descriptorId || descriptor?.id || descriptor?.driveKey)).filter(Boolean)
        if (ids.length > 0) await peer.requestDescriptors(ids)
      }
    }
    return quotaPeers.length
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
