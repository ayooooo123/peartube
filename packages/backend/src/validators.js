const TWO_MINUTES_MS = 2 * 60 * 1000
const TEN_MINUTES_MS = 10 * 60 * 1000
const DEFAULT_CLOCK_DRIFT_MS = 15 * 60 * 1000
const DEFAULT_EXPIRE_GRACE_MS = 5 * 60 * 1000
const MAX_EPOCH_DRIFT = 6

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

function getItemTimestamp(item) {
  return item.publishedAt ?? item.createdAt ?? item.updatedAt ?? item.timestamp ?? item.observedAt
}

function getItemEpoch(item) {
  return item.epoch ?? item.availabilityEpoch ?? item.sequenceEpoch
}

function getClockDriftMs(options) {
  return options.clockDriftMs ?? options.maxClockSkewMs ?? DEFAULT_CLOCK_DRIFT_MS
}

function getEpochDriftLimit(options) {
  return options.epochDrift ?? options.maxEpochSkew ?? MAX_EPOCH_DRIFT
}

function getExpireGraceMs(options) {
  return options.expireGraceMs ?? options.clockDriftMs ?? options.maxClockSkewMs ?? DEFAULT_EXPIRE_GRACE_MS
}

function getProofExpireGraceMs(options) {
  return options.proofExpireGraceMs ?? options.expireGraceMs ?? options.clockDriftMs ?? options.maxClockSkewMs ?? DEFAULT_EXPIRE_GRACE_MS
}

function validateTimingWindows(item, now, clockDriftMs, epochDriftLimit, expireGraceMs, prefix) {
  const timestamp = getItemTimestamp(item)
  if (!withinClockDrift(timestamp, now, clockDriftMs)) {
    return `${prefix}-clock-drift`
  }
  const epoch = getItemEpoch(item)
  if (!withinEpochDrift(epoch, now, epochDriftLimit)) {
    return `${prefix}-epoch-drift`
  }
  if (item.expiresAt != null && safeNumber(item.expiresAt, NaN) < now - expireGraceMs) {
    return `${prefix}-expired`
  }
  if (item.notBefore != null && safeNumber(item.notBefore, NaN) > now + clockDriftMs) {
    return `${prefix}-not-yet-valid`
  }
  return null
}

async function checkSignature(options, payload) {
  const verifier = options.verifySignature
  if (typeof verifier !== 'function') {
    return options.allowUnsignedForTests ? null : 'bad-signature'
  }
  const signatureOk = await verifier(payload)
  return signatureOk ? null : 'bad-signature'
}

export async function validateIncomingDescriptor(entry, options = {}) {
  const descriptor = entry?.descriptor || entry || null
  if (!descriptor || !hasValidTarget(descriptor)) {
    return buildValidationResult({ ok: false, reason: 'missing-descriptor-id', entry, descriptor })
  }

  const now = safeNumber(options.now, Date.now()) || Date.now()
  const clockDriftMs = getClockDriftMs(options)
  const epochDriftLimit = getEpochDriftLimit(options)
  const expireGraceMs = getExpireGraceMs(options)

  const timingError = validateTimingWindows(descriptor, now, clockDriftMs, epochDriftLimit, expireGraceMs, 'descriptor')
  if (timingError) {
    return buildValidationResult({ ok: false, reason: timingError, entry, descriptor })
  }

  const sigError = await checkSignature(options, { descriptor, entry })
  if (sigError) {
    return buildValidationResult({ ok: false, reason: sigError, entry, descriptor })
  }

  return buildValidationResult({ ok: true, entry, descriptor })
}

export async function validateIncomingProof(entry, options = {}) {
  const proof = entry?.proof || entry || null
  if (!proof || !hasValidTarget(proof)) {
    return buildValidationResult({ ok: false, reason: 'missing-proof-target', entry, descriptor: null })
  }

  const now = safeNumber(options.now, Date.now()) || Date.now()
  const clockDriftMs = getClockDriftMs(options)
  const epochDriftLimit = getEpochDriftLimit(options)
  const expireGraceMs = getProofExpireGraceMs(options)

  const timingError = validateTimingWindows(proof, now, clockDriftMs, epochDriftLimit, expireGraceMs, 'proof')
  if (timingError) {
    return buildValidationResult({ ok: false, reason: timingError, entry, descriptor: null })
  }

  const sigError = await checkSignature(options, { descriptor: proof, entry })
  if (sigError) {
    return buildValidationResult({ ok: false, reason: sigError, entry, descriptor: null })
  }

  return buildValidationResult({ ok: true, entry, descriptor: null })
}

export { TWO_MINUTES_MS, TEN_MINUTES_MS, DEFAULT_CLOCK_DRIFT_MS, DEFAULT_EXPIRE_GRACE_MS, MAX_EPOCH_DRIFT }
