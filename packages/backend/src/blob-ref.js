const HEX_64 = /^[0-9a-f]{64}$/i

function finiteNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0
}

function normalizeNumber(value) {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value !== 'string' || value.trim() === '') return NaN
  return Number(value)
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

export function normalizeBlobRefInput(value) {
  if (typeof value === 'string') return parseBlobId(value)
  if (!value || typeof value !== 'object') return null
  const blockOffset = normalizeNumber(value.blockOffset)
  const blockLength = normalizeNumber(value.blockLength)
  const byteOffset = normalizeNumber(value.byteOffset)
  const byteLength = normalizeNumber(value.byteLength)
  if (!finiteNonNegativeInteger(blockOffset)) return null
  if (!Number.isInteger(blockLength) || blockLength <= 0) return null
  if (!finiteNonNegativeInteger(byteOffset)) return null
  if (!Number.isInteger(byteLength) || byteLength < 0) return null
  return { blockOffset, blockLength, byteOffset, byteLength }
}

export function stringifyBlobId(value) {
  const blob = typeof value === 'string' ? parseBlobId(value) : normalizeBlobRefInput(value)
  if (!blob) return null
  return `${blob.blockOffset}:${blob.blockLength}:${blob.byteOffset}:${blob.byteLength}`
}

export function parseBlobRef(value = {}) {
  if (!value || typeof value !== 'object') return null
  const blobsCoreKey = normalizeBlobsCoreKey(value.blobsCoreKey)
  const blob = typeof value.blobId === 'string'
    ? parseBlobId(value.blobId)
    : normalizeBlobRefInput(value.blobId || value.blob)

  if (!blobsCoreKey || !blob) return null

  const byteLength = normalizeNumber(value.byteLength ?? blob.byteLength)
  const normalized = {
    blobsCoreKey,
    blobId: stringifyBlobId(blob),
    blob,
  }

  if (typeof value.mimeType === 'string' && value.mimeType.trim()) {
    normalized.mimeType = value.mimeType.trim()
  }
  if (Number.isFinite(byteLength) && byteLength >= 0) {
    normalized.byteLength = byteLength
  }

  return normalized
}

export function buildBlobRefCacheKey({ driveKey = 'unknown', id = 'unknown', blobsCoreKey, blobId, blob } = {}) {
  const ref = parseBlobRef({ blobsCoreKey, blobId: blobId || blob })
  if (!ref) return `${driveKey || 'unknown'}:${id || 'unknown'}:${blobsCoreKey || ''}:${typeof blobId === 'string' ? blobId : stringifyBlobId(blobId || blob) || ''}`
  return `${driveKey || 'unknown'}:${id || 'unknown'}:${ref.blobsCoreKey}:${ref.blobId}`
}
