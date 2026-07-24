export function createMediaValidationPolicy(overrides = {}) {
  return {
    maxWidth: 7680,
    maxHeight: 4320,
    maxDurationMs: 4 * 60 * 60 * 1000,
    maxTracks: 16,
    maxContainerTables: 8192,
    maxSubtitleCues: 100000,
    maxArtworkBytes: 8 * 1024 * 1024,
    maxByteLength: 256 * 1024 * 1024 * 1024,
    onReserve: null,
    onRelease: null,
    ...overrides,
  }
}

function finite(value, name, fallback = 0) {
  const next = value == null ? fallback : Number(value)
  if (!Number.isSafeInteger(next) || next < 0) throw new Error(`${name} must be a non-negative safe integer`)
  return next
}

function assertMax(probe, policy, field, limitField, label = field) {
  const value = finite(probe[field], field, 0)
  if (value > policy[limitField]) throw new Error(`${label} exceeds maximum`)
  return value
}

function validateOffsets(offsets = [], byteLength = null) {
  if (!Array.isArray(offsets)) throw new Error('offsets must be an array')
  let previousEnd = 0
  for (const offset of offsets) {
    const start = finite(offset.start, 'offset.start')
    const end = finite(offset.end, 'offset.end')
    if (end <= start) throw new Error('offset end must be greater than start')
    if (start < previousEnd) throw new Error('offsets must be monotonic')
    if (byteLength != null && end > byteLength) throw new Error('offset exceeds byteLength')
    previousEnd = end
  }
}

function validateArchive(probe = {}) {
  if (!probe.archive) return
  throw new Error('archive media is not auto-extracted as renditions')
}

export function validateHostileMediaProbe(probe = {}, policyInput = {}) {
  const policy = createMediaValidationPolicy(policyInput)
  policy.onReserve?.('probe')
  try {
    if (probe.cancelled) throw new Error('probe cancelled')
    if (probe.timedOut) throw new Error('probe timeout')
    if (probe.workerCrashed) throw new Error('native worker crashed')
    validateArchive(probe)
    const byteLength = finite(probe.byteLength, 'byteLength', 0)
    if (byteLength > policy.maxByteLength) throw new Error('byteLength exceeds maximum')
    assertMax(probe, policy, 'width', 'maxWidth', 'width')
    assertMax(probe, policy, 'height', 'maxHeight', 'height')
    assertMax(probe, policy, 'durationMs', 'maxDurationMs', 'duration')
    assertMax(probe, policy, 'tracks', 'maxTracks', 'track count')
    assertMax(probe, policy, 'containerTables', 'maxContainerTables', 'container table count')
    assertMax(probe, policy, 'subtitleCues', 'maxSubtitleCues', 'subtitle cue count')
    assertMax(probe, policy, 'artworkBytes', 'maxArtworkBytes', 'artwork bytes')
    validateOffsets(probe.offsets || [], byteLength || null)
    return { accepted: true, byteLength }
  } finally {
    policy.onRelease?.('probe')
  }
}
