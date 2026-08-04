import { TEST_ONLY_DRM_SYSTEMS, verifyProtectedRendition } from '../access/protected-rendition.js'
import { isArtworkRendition, isProtectedRendition } from './rendition.js'

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

// Protected media is public ciphertext plus a public descriptor of how an
// entitled player gets a licence. Whether that descriptor is well formed is
// settled where it is built (assets/rendition.js calling into
// access/protected-rendition.js); what belongs here is what a whole
// PUBLICATION is allowed to say, which is a different question and has no
// other home. Every path that mints a manifest - upload.js,
// migrations/publication-v1.js, rendition-writer.js, and decoding a peer's
// bytes - runs through manifest normalization, so putting the rule there and
// the policy here means no publisher can route around it.
const PROTECTED_CATALOG_SURFACE_REASON =
  'artwork and subtitle renditions must not be protected: they are the publicly reachable surface that keeps a protected title browsable without an entitlement'

export function validateProtectedPublication(body = {}, { allowClearKeyForTests = false } = {}) {
  // Cover art and subtitles are catalog surface: they are rendered by the app
  // itself, no licence flow exists for them, and a poster nobody can decode is
  // a blank card forever. Refusing them is what keeps a protected title
  // browsable without an entitlement.
  for (const rendition of [...(body.artwork || []), ...(body.subtitles || [])]) {
    if (isProtectedRendition(rendition)) throw new Error(PROTECTED_CATALOG_SURFACE_REASON)
  }
  let drmSystem = null
  let publicCount = 0
  let protectedCount = 0
  for (const rendition of body.renditions || []) {
    // Artwork rides the media array too, so the purpose test decides which
    // rule applies rather than which array something arrived in.
    if (isArtworkRendition(rendition)) {
      if (isProtectedRendition(rendition)) throw new Error(PROTECTED_CATALOG_SURFACE_REASON)
      continue
    }
    if (!isProtectedRendition(rendition)) {
      publicCount++
      continue
    }
    const encryption = rendition.encryption
    // Named separately from the descriptor's own rules so the rejection says
    // WHY: ClearKey is a deterministic test fixture, not a protection scheme.
    if (TEST_ONLY_DRM_SYSTEMS.includes(encryption.drmSystem) && !allowClearKeyForTests) {
      throw new Error(`${encryption.drmSystem} is a test-only drm system and is not publishable without an injected test capability`)
    }
    if (!verifyProtectedRendition(encryption, { allowClearKeyForTests })) {
      throw new Error('protected rendition descriptor is invalid: it is not the canonical public descriptor for its own fields')
    }
    if (drmSystem == null) drmSystem = encryption.drmSystem
    else if (drmSystem !== encryption.drmSystem) {
      throw new Error(`protected renditions must declare one drm system per publication: a source advertises a single drmSystem, not both ${drmSystem} and ${encryption.drmSystem}`)
    }
    protectedCount++
  }
  // A source advertises ONE protected flag and ONE drm system, so a half
  // encrypted title has no representation a consumer could act on: it would
  // offer a licence for bytes that need none, or none for bytes that do.
  if (protectedCount > 0 && publicCount > 0) {
    throw new Error('publications must not mix protected and public media renditions: a source advertises one protected flag for all of them')
  }
  return { protected: protectedCount > 0, drmSystem }
}
