const TWO_MINUTES_MS = 2 * 60 * 1000
const TEN_MINUTES_MS = 10 * 60 * 1000
const MAX_EPOCH_DRIFT = 1

function safeNumber(value, fallback = NaN) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function normalizeIdentifier(value) {
  if (typeof value === 'string') {
    const cleaned = value.trim().toLowerCase().replace(/^0x/, '')
    return cleaned.length > 0 ? cleaned : null
  }
  if (value instanceof Uint8Array) {
    return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')
  }
  if (value && typeof value === 'object') {
    return normalizeIdentifier(value.id || value.descriptorId || value.channelId || value.driveKey || value.key)
  }
  return null
}

function getEpoch(value, now = Date.now()) {
  const epoch = safeNumber(value, NaN)
  if (!Number.isFinite(epoch)) return null
  if (epoch < 0) return null
  if (epoch > 1000000) return epoch
  return epoch
}

function withinClockDrift(timestamp, now = Date.now(), driftMs = TWO_MINUTES_MS) {
  const ts = safeNumber(timestamp, NaN)
  if (!Number.isFinite(ts)) return true
  return Math.abs(now - ts) <= driftMs
}

function withinEpochDrift(epoch, now = Date.now(), allowedDrift = MAX_EPOCH_DRIFT) {
  const candidate = getEpoch(epoch, now)
  if (candidate == null) return true
  const currentEpoch = Math.floor(now / TEN_MINUTES_MS)
  return Math.abs(currentEpoch - candidate) <= allowedDrift
}

function hasValidTarget(entry) {
  const descriptorId = normalizeIdentifier(entry?.descriptorId || entry?.id || entry?.driveKey || entry?.channelId)
  return Boolean(descriptorId)
}

function buildValidationResult({ ok, reason = null, entry = null, descriptor = null }) {
  return { ok, reason, entry, descriptor }
}

export async function validateIncomingDescriptor(entry, options = {}) {
  const descriptor = entry?.descriptor || entry || null
  if (!descriptor || !hasValidTarget(descriptor)) {
    return buildValidationResult({ ok: false, reason: 'missing-descriptor-id', entry, descriptor })
  }

  const now = safeNumber(options.now, Date.now()) || Date.now()
  const timestamp = descriptor.publishedAt ?? descriptor.createdAt ?? descriptor.updatedAt ?? descriptor.timestamp ?? descriptor.observedAt
  if (!withinClockDrift(timestamp, now, options.clockDriftMs ?? TWO_MINUTES_MS)) {
    return buildValidationResult({ ok: false, reason: 'descriptor-clock-drift', entry, descriptor })
  }

  const epoch = descriptor.epoch ?? descriptor.availabilityEpoch ?? descriptor.sequenceEpoch
  if (!withinEpochDrift(epoch, now, options.epochDrift ?? MAX_EPOCH_DRIFT)) {
    return buildValidationResult({ ok: false, reason: 'descriptor-epoch-drift', entry, descriptor })
  }

  if (descriptor.expiresAt != null && safeNumber(descriptor.expiresAt, NaN) < now - (options.clockDriftMs ?? TWO_MINUTES_MS)) {
    return buildValidationResult({ ok: false, reason: 'descriptor-expired', entry, descriptor })
  }

  if (descriptor.notBefore != null && safeNumber(descriptor.notBefore, NaN) > now + (options.clockDriftMs ?? TWO_MINUTES_MS)) {
    return buildValidationResult({ ok: false, reason: 'descriptor-not-yet-valid', entry, descriptor })
  }

  const verifier = options.verifySignature
  if (typeof verifier === 'function') {
    const signatureOk = await verifier({ descriptor, entry })
    if (!signatureOk) {
      return buildValidationResult({ ok: false, reason: 'bad-signature', entry, descriptor })
    }
  }

  return buildValidationResult({ ok: true, entry, descriptor })
}

export async function validateIncomingProof(entry, options = {}) {
  const proof = entry?.proof || entry || null
  if (!proof || !hasValidTarget(proof)) {
    return buildValidationResult({ ok: false, reason: 'missing-proof-target', entry, descriptor: null })
  }

  const now = safeNumber(options.now, Date.now()) || Date.now()
  const timestamp = proof.publishedAt ?? proof.createdAt ?? proof.updatedAt ?? proof.timestamp ?? proof.observedAt
  if (!withinClockDrift(timestamp, now, options.clockDriftMs ?? TWO_MINUTES_MS)) {
    return buildValidationResult({ ok: false, reason: 'proof-clock-drift', entry, descriptor: null })
  }

  const epoch = proof.epoch ?? proof.availabilityEpoch ?? proof.sequenceEpoch
  if (!withinEpochDrift(epoch, now, options.epochDrift ?? MAX_EPOCH_DRIFT)) {
    return buildValidationResult({ ok: false, reason: 'proof-epoch-drift', entry, descriptor: null })
  }

  if (proof.expiresAt != null && safeNumber(proof.expiresAt, NaN) < now - (options.clockDriftMs ?? TWO_MINUTES_MS)) {
    return buildValidationResult({ ok: false, reason: 'proof-expired', entry, descriptor: null })
  }

  if (proof.notBefore != null && safeNumber(proof.notBefore, NaN) > now + (options.clockDriftMs ?? TWO_MINUTES_MS)) {
    return buildValidationResult({ ok: false, reason: 'proof-not-yet-valid', entry, descriptor: null })
  }

  const verifier = options.verifySignature
  if (typeof verifier === 'function') {
    const signatureOk = await verifier({ descriptor: proof, entry })
    if (!signatureOk) {
      return buildValidationResult({ ok: false, reason: 'bad-signature', entry, descriptor: null })
    }
  }

  return buildValidationResult({ ok: true, entry, descriptor: null })
}

export { TWO_MINUTES_MS, TEN_MINUTES_MS, MAX_EPOCH_DRIFT }
