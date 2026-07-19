import b4a from 'b4a'

const DURABILITY_KINDS = new Set(['media', 'thumbnail', 'artwork'])
const HEX_KEY_PATTERN = /^[a-f0-9]{64}$/i

function isByteKey (value) {
  return value instanceof Uint8Array || (typeof b4a.isBuffer === 'function' && b4a.isBuffer(value))
}

function normalizeKey (value, label) {
  if (typeof value === 'string') {
    if (!HEX_KEY_PATTERN.test(value)) throw new TypeError(`${label} must be a 32-byte hex key`)
    return value.toLowerCase()
  }
  if (!isByteKey(value) || value.byteLength !== 32) {
    throw new TypeError(`${label} must be a 32-byte key`)
  }
  return b4a.toString(value, 'hex')
}

function normalizeRef (value, index = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`refs[${index}] must be an object`)
  }

  const coreKey = normalizeKey(value.coreKey, `refs[${index}].coreKey`)
  const { start, end, kind } = value
  if (!Number.isSafeInteger(start) || start < 0) {
    throw new RangeError(`refs[${index}].start must be a nonnegative safe integer`)
  }
  if (!Number.isSafeInteger(end) || end <= start) {
    throw new RangeError(`refs[${index}].end must be a safe integer greater than start`)
  }
  if (!DURABILITY_KINDS.has(kind)) {
    throw new TypeError(`refs[${index}].kind must be media, thumbnail, or artwork`)
  }

  return { coreKey, start, end, kind }
}

function compareCanonicalRefs (a, b) {
  if (a.coreKey !== b.coreKey) return a.coreKey < b.coreKey ? -1 : 1
  if (a.start !== b.start) return a.start - b.start
  if (a.end !== b.end) return a.end - b.end
  if (a.kind === b.kind) return 0
  return a.kind < b.kind ? -1 : 1
}

function serializeCanonicalRef (ref) {
  return JSON.stringify([ref.coreKey, ref.start, ref.end, ref.kind])
}

function keyIterable (value, label) {
  if (value == null) return []
  if (typeof value === 'string' || isByteKey(value)) return [value]
  if (typeof value[Symbol.iterator] !== 'function') {
    throw new TypeError(`${label} must be an iterable of holder keys`)
  }
  return value
}

function normalizeKeyList (value, label) {
  const keys = new Set()
  for (const key of keyIterable(value, label)) keys.add(normalizeKey(key, label))
  return [...keys].sort()
}

/**
 * Validate, normalize, byte-sort, and deduplicate finite durability refs.
 * Returned refs and the returned array never alias caller-owned objects.
 */
export function canonicalizeDurabilityRefs (refs) {
  if (!Array.isArray(refs)) throw new TypeError('refs must be an array')

  const normalized = new Array(refs.length)
  for (let index = 0; index < refs.length; index++) {
    normalized[index] = normalizeRef(refs[index], index)
  }
  normalized.sort(compareCanonicalRefs)

  const deduplicated = []
  let previous = null
  for (const durabilityRef of normalized) {
    const identity = serializeCanonicalRef(durabilityRef)
    if (identity === previous) continue
    deduplicated.push(durabilityRef)
    previous = identity
  }
  return deduplicated
}

/**
 * Return an unambiguous deterministic identity for a validated durability ref.
 * JSON's structural encoding avoids delimiter collisions between fields.
 */
export function canonicalDurabilityRefKey (ref) {
  return serializeCanonicalRef(normalizeRef(ref))
}

/**
 * Intersect authenticated holders observed for every required ref.
 * Observation keys must be produced by canonicalDurabilityRefKey().
 */
export function intersectFullCopyHolders (refs, observations) {
  let canonicalRefs
  try {
    canonicalRefs = canonicalizeDurabilityRefs(refs)
  } catch {
    return new Set()
  }
  if (canonicalRefs.length === 0) return new Set()
  if (!observations || typeof observations.get !== 'function') {
    throw new TypeError('observations must be a Map-like collection')
  }

  let intersection = null
  for (const durabilityRef of canonicalRefs) {
    const observed = observations.get(serializeCanonicalRef(durabilityRef))
    if (observed == null) return new Set()

    const holders = normalizeKeyList(observed, 'observation holder key')
    if (holders.length === 0) return new Set()

    if (intersection === null) {
      intersection = new Set(holders)
      continue
    }

    const holderSet = new Set(holders)
    for (const holder of intersection) {
      if (!holderSet.has(holder)) intersection.delete(holder)
    }
    if (intersection.size === 0) return new Set()
  }

  return new Set([...intersection].sort())
}

/**
 * Classify complete-item holders under the durability policy.
 * Categories are deterministic and exclusive: trusted, then paired, then ordinary.
 */
export function evaluateDurabilityPolicy ({
  holderKeys = [],
  trustedRelayKeys = [],
  pairedDeviceKeys = [],
  ordinaryRequired = 2,
} = {}) {
  if (!Number.isSafeInteger(ordinaryRequired) || ordinaryRequired < 0) {
    throw new RangeError('ordinaryRequired must be a nonnegative safe integer')
  }

  const holders = normalizeKeyList(holderKeys, 'holder key')
  const trustedSet = new Set(normalizeKeyList(trustedRelayKeys, 'trusted relay key'))
  const pairedSet = new Set(normalizeKeyList(pairedDeviceKeys, 'paired device key'))
  const trusted = []
  const paired = []
  const ordinary = []

  for (const holder of holders) {
    if (trustedSet.has(holder)) trusted.push(holder)
    else if (pairedSet.has(holder)) paired.push(holder)
    else ordinary.push(holder)
  }

  return {
    eligible: trusted.length > 0 || paired.length > 0 || ordinary.length >= ordinaryRequired,
    trusted,
    paired,
    ordinary,
  }
}
