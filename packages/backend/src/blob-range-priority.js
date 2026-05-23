import c from 'compact-encoding'
import HypercoreID from 'hypercore-id-encoding'
import z32 from 'z32'

const DEFAULT_BLOB_RANGE_READ_AHEAD_BYTES = 2 * 1024 * 1024
const DEFAULT_BLOB_RANGE_PRIORITY_TIMEOUT_MS = 15000

const blobIdEncoding = {
  preencode(state, blob) {
    c.uint.preencode(state, blob.blockOffset)
    c.uint.preencode(state, blob.blockLength)
    c.uint.preencode(state, blob.byteOffset)
    c.uint.preencode(state, blob.byteLength)
  },
  encode(state, blob) {
    c.uint.encode(state, blob.blockOffset)
    c.uint.encode(state, blob.blockLength)
    c.uint.encode(state, blob.byteOffset)
    c.uint.encode(state, blob.byteLength)
  },
  decode(state) {
    return {
      blockOffset: c.uint.decode(state),
      blockLength: c.uint.decode(state),
      byteOffset: c.uint.decode(state),
      byteLength: c.uint.decode(state)
    }
  }
}

function isFiniteNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0
}

export function parseHttpByteRange(rangeHeader, byteLength) {
  if (typeof rangeHeader !== 'string' || !rangeHeader.startsWith('bytes=')) return null
  const totalBytes = Number(byteLength)
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null

  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/)
  if (!match) return null

  const [, rawStart, rawEnd] = match
  if (!rawStart && !rawEnd) return null

  let start
  let end

  if (!rawStart) {
    const suffixLength = Number(rawEnd)
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return null
    start = Math.max(0, totalBytes - suffixLength)
    end = totalBytes - 1
  } else {
    start = Number(rawStart)
    end = rawEnd ? Number(rawEnd) : totalBytes - 1
  }

  if (!isFiniteNonNegativeInteger(start) || !isFiniteNonNegativeInteger(end)) return null
  if (start >= totalBytes) return null
  end = Math.min(end, totalBytes - 1)
  if (end < start) return null

  return { start, end }
}

export function getPrioritizedBlobDownloadRange(blob, byteRange, options = {}) {
  if (!blob || !byteRange) return null

  const blockOffset = Number(blob.blockOffset)
  const blockLength = Number(blob.blockLength)
  const byteLength = Number(blob.byteLength)
  const rangeStart = Number(byteRange.start)
  const rangeEnd = Number(byteRange.end)

  if (!isFiniteNonNegativeInteger(blockOffset)) return null
  if (!Number.isInteger(blockLength) || blockLength <= 0) return null
  if (!Number.isFinite(byteLength) || byteLength <= 0) return null
  if (!isFiniteNonNegativeInteger(rangeStart) || !isFiniteNonNegativeInteger(rangeEnd)) return null
  if (rangeEnd < rangeStart || rangeStart >= byteLength) return null

  const readAheadBytes = Math.max(0, Number(options.readAheadBytes ?? DEFAULT_BLOB_RANGE_READ_AHEAD_BYTES) || 0)
  const bytesPerBlock = Math.max(1, byteLength / blockLength)
  const prioritizedEndByte = Math.min(byteLength - 1, rangeEnd + readAheadBytes)
  const relativeStartBlock = Math.max(0, Math.min(blockLength - 1, Math.floor(rangeStart / bytesPerBlock)))
  const relativeEndBlock = Math.max(
    relativeStartBlock + 1,
    Math.min(blockLength, Math.ceil((prioritizedEndByte + 1) / bytesPerBlock))
  )
  const start = blockOffset + relativeStartBlock
  const end = blockOffset + relativeEndBlock

  return { start, end, blocks: end - start }
}

function decodeBlobParam(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    return c.decode(blobIdEncoding, z32.decode(value))
  } catch {
    return null
  }
}

function decodeBlobRangeRequest(blobServer, req) {
  const rangeHeader = req?.headers?.range
  if (!rangeHeader) return null

  let url
  try {
    url = new URL(req.url, 'http://127.0.0.1')
  } catch {
    return null
  }

  const token = url.searchParams.get('token') || ''
  if (blobServer?.token && token !== blobServer.token) return null

  const encodedKey = url.searchParams.get('key')
  const encodedBlob = url.searchParams.get('blob')
  if (!encodedKey || !encodedBlob) return null

  let key
  try {
    key = HypercoreID.decode(encodedKey)
  } catch {
    return null
  }

  const blob = decodeBlobParam(encodedBlob)
  const byteRange = parseHttpByteRange(rangeHeader, blob?.byteLength)
  if (!key || !blob || !byteRange) return null

  return { key, blob, byteRange }
}

export async function prioritizeBlobServerRangeRequest(blobServer, req, options = {}) {
  if (!blobServer || typeof blobServer._getCore !== 'function') return null

  const request = decodeBlobRangeRequest(blobServer, req)
  if (!request) return null

  const downloadRange = getPrioritizedBlobDownloadRange(request.blob, request.byteRange, options)
  if (!downloadRange) return null

  const core = await blobServer._getCore(request.key, {
    key: request.key,
    blob: request.blob,
    range: request.byteRange
  }, true)
  if (!core || typeof core.download !== 'function') return null

  const range = core.download({
    start: downloadRange.start,
    end: downloadRange.end,
    linear: false
  })
  const timeoutMs = Math.max(
    1000,
    Number(options.timeoutMs ?? DEFAULT_BLOB_RANGE_PRIORITY_TIMEOUT_MS) || DEFAULT_BLOB_RANGE_PRIORITY_TIMEOUT_MS
  )
  let cleanedUp = false
  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    try { range?.destroy?.() } catch { /* best effort */ }
    try {
      const closeResult = core.close?.()
      if (closeResult && typeof closeResult.catch === 'function') closeResult.catch(() => {})
    } catch { /* best effort */ }
  }
  const timer = setTimeout(cleanup, timeoutMs)
  const done = typeof range?.done === 'function'
    ? range.done()
    : typeof range?.downloaded === 'function'
      ? range.downloaded()
      : Promise.resolve()

  Promise.resolve(done)
    .catch(() => {})
    .finally(() => {
      clearTimeout(timer)
      cleanup()
    })

  return downloadRange
}
