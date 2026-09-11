const HEX_64 = /^[0-9a-f]{64}$/i
const BLOB_ID_RE = /^\d+:\d+:\d+:\d+$/
const DEFAULT_BLOB_SCORE_TIMEOUT_MS = 30 * 1000

function finiteNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0
}

function normalizeNumber(value) {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value !== 'string' || value.trim() === '') return NaN
  return Number(value.trim())
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

export function normalizeBlobsCoreKey(value) {
  if (typeof value !== 'string') return null
  const key = value.trim().toLowerCase()
  return HEX_64.test(key) ? key : null
}

export function parseBlobId(value) {
  if (typeof value !== 'string') return null
  const parts = value.split(':').map(normalizeNumber)
  if (parts.length !== 4) return null
  const [blockOffset, blockLength, byteOffset, byteLength] = parts
  if (!finiteNonNegativeInteger(blockOffset)) return null
  if (!Number.isInteger(blockLength) || blockLength <= 0) return null
  if (!finiteNonNegativeInteger(byteOffset)) return null
  if (!Number.isInteger(byteLength) || byteLength < 0) return null
  return { blockOffset, blockLength, byteOffset, byteLength }
}

function extractBlobRange(source) {
  if (!source || typeof source !== 'object') return null
  const blockOffset = normalizeNumber(source.blockOffset)
  const blockLength = normalizeNumber(source.blockLength)
  const byteOffset = normalizeNumber(source.byteOffset)
  const byteLength = normalizeNumber(source.byteLength)
  if (!finiteNonNegativeInteger(blockOffset)) return null
  if (!Number.isInteger(blockLength) || blockLength <= 0) return null
  if (!finiteNonNegativeInteger(byteOffset)) return null
  if (!Number.isInteger(byteLength) || byteLength < 0) return null
  return { blockOffset, blockLength, byteOffset, byteLength }
}

function normalizeBlobRefFromString(value) {
  const direct = parseBlobId(value)
  if (direct) return direct
  const parsed = parseBlobRefString(value)
  return parsed?.blob || null
}

function resolveNestedBlobTarget(value) {
  const nested = value.blobId ?? value.blob ?? value.blobRef ?? value.ref ?? value.id ?? value.range
  if (nested && nested !== value) {
    return normalizeBlobRefInput(nested)
  }
  return null
}

export function normalizeBlobRefInput(value) {
  if (typeof value === 'string') {
    return normalizeBlobRefFromString(value)
  }
  if (!value || typeof value !== 'object') return null
  const nested = resolveNestedBlobTarget(value)
  if (nested) return nested
  const source = value.blob && typeof value.blob === 'object' ? value.blob : value
  return extractBlobRange(source)
}

export function stringifyBlobId(value) {
  const blob = typeof value === 'string' ? parseBlobId(value) : normalizeBlobRefInput(value)
  if (!blob) return null
  return `${blob.blockOffset}:${blob.blockLength}:${blob.byteOffset}:${blob.byteLength}`
}

function parseBlobRefString(value) {
  const raw = normalizeString(value)
  if (!raw) return null

  const prefixed = raw.replace(/^(?:blob:|@|#|:)/i, '')
  const prefixedMatch = prefixed.match(/^([0-9a-f]{64})(?:[@#:/])(.*)$/i)
  if (prefixedMatch) {
    const blobsCoreKey = normalizeBlobsCoreKey(prefixedMatch[1])
    const blob = parseBlobId(prefixedMatch[2])
    if (blobsCoreKey && blob) {
      return {
        blobsCoreKey,
        blobId: stringifyBlobId(blob),
        blob,
      }
    }
  }

  const maybeCore = raw.match(/^([0-9a-f]{64})$/i)
  if (maybeCore) {
    return { blobsCoreKey: normalizeBlobsCoreKey(maybeCore[1]), blobId: null, blob: null }
  }

  return null
}

function parseBlobRefFromStringInput(value) {
  const parsed = parseBlobRefString(value)
  if (!parsed?.blobsCoreKey || !parsed?.blob) return null
  return parsed
}

function parseBlobRefFromRawRef(value) {
  const rawRef = value.ref || value.blobRef || value.url || value.href || null
  if (typeof rawRef !== 'string') return null
  const parsed = parseBlobRefString(rawRef)
  if (!parsed?.blobsCoreKey || !parsed?.blob) return null
  return {
    ...parsed,
    mimeType: typeof value.mimeType === 'string' && value.mimeType.trim() ? value.mimeType.trim() : undefined,
    byteLength: Number.isFinite(Number(value.byteLength)) ? Number(value.byteLength) : undefined,
  }
}

function extractBlobSource(value) {
  if (value.blobId && typeof value.blobId === 'object') {
    return value.blobId
  }
  return value.blobId || value.blob || value.blobRef || value.range || value.id
}

function attachBlobRefMetadata(normalized, value, blob) {
  const byteLength = normalizeNumber(value.byteLength ?? blob.byteLength ?? value.length)
  if (typeof value.mimeType === 'string' && value.mimeType.trim()) {
    normalized.mimeType = value.mimeType.trim()
  }
  if (Number.isFinite(byteLength) && byteLength >= 0) {
    normalized.byteLength = byteLength
  }
  return normalized
}

export function parseBlobRef(value = {}) {
  if (typeof value === 'string') {
    return parseBlobRefFromStringInput(value)
  }

  if (!value || typeof value !== 'object') return null

  const fromRef = parseBlobRefFromRawRef(value)
  if (fromRef) return fromRef

  const blobsCoreKey = normalizeBlobsCoreKey(value.blobsCoreKey || value.blobsKey || value.coreKey)
  const blob = normalizeBlobRefInput(extractBlobSource(value))

  if (!blobsCoreKey || !blob) return null

  const normalized = {
    blobsCoreKey,
    blobId: stringifyBlobId(blob),
    blob,
  }

  return attachBlobRefMetadata(normalized, value, blob)
}

export function buildBlobRefCacheKey({ driveKey = 'unknown', id = 'unknown', blobsCoreKey, blobId, blob } = {}) {
  const ref = parseBlobRef({ blobsCoreKey, blobId: blobId || blob })
  if (!ref) return `${driveKey || 'unknown'}:${id || 'unknown'}:${blobsCoreKey || ''}:${typeof blobId === 'string' ? blobId : stringifyBlobId(blobId || blob) || ''}`
  return `${driveKey || 'unknown'}:${id || 'unknown'}:${ref.blobsCoreKey}:${ref.blobId}`
}

function readScoreRecord(store, key) {
  if (!store) return null
  if (store instanceof Map) return store.get(key) || null
  return store[key] || null
}

function writeScoreRecord(store, key, value) {
  if (!store) return
  if (store instanceof Map) {
    store.set(key, value)
    return
  }
  store[key] = value
}

function resolveScoreRef(blobRef) {
  const direct = parseBlobRef(blobRef)
  if (direct) return direct
  if (blobRef && typeof blobRef === 'object') {
    return parseBlobRef({ ...blobRef, blobsCoreKey: blobRef.blobsCoreKey || blobRef.coreKey })
  }
  return null
}

function getScoreCacheKey(ref, blobRef, options) {
  return buildBlobRefCacheKey({
    driveKey: options.driveKey || blobRef?.driveKey || 'unknown',
    id: options.id || blobRef?.id || 'unknown',
    blobsCoreKey: ref.blobsCoreKey,
    blobId: ref.blobId,
  })
}

export function updateBlobScore(store, blobRef, delta = 1, options = {}) {
  const ref = resolveScoreRef(blobRef)
  if (!ref) return null

  const key = getScoreCacheKey(ref, blobRef, options)
  const now = Number(options.now || Date.now()) || Date.now()
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : DEFAULT_BLOB_SCORE_TIMEOUT_MS
  const current = readScoreRecord(store, key) || {}
  const expiresAt = now + timeoutMs
  const next = {
    ...current,
    key,
    ref,
    score: Number(current.score || 0) + Number(delta || 0),
    updatedAt: now,
    expiresAt,
  }
  if (Number.isFinite(Number(current.expiresAt)) && Number(current.expiresAt) <= now) {
    next.score = Number(delta || 0)
  }
  writeScoreRecord(store, key, next)
  return next
}

export function pruneExpiredBlobScores(store, now = Date.now()) {
  if (!store) return 0
  let removed = 0
  if (store instanceof Map) {
    for (const [key, value] of store.entries()) {
      if (Number(value?.expiresAt || 0) > now) continue
      store.delete(key)
      removed++
    }
    return removed
  }

  for (const key of Object.keys(store)) {
    if (Number(store[key]?.expiresAt || 0) > now) continue
    delete store[key]
    removed++
  }
  return removed
}
