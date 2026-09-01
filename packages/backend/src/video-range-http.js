/**
 * Explicit video Range responder for the shared blob server.
 *
 * hypercore-blob-server pipes hypercore-byte-stream into the HTTP response.
 * On Android/libqjs we have observed Media3's HTTP DataSource block inside
 * open(): the request reaches the blob server, but response headers/body never
 * reach the player. This responder keeps the same URL contract while avoiding
 * the stream pipe path: it writes Range headers immediately, then copies blocks
 * from Hypercore to the response with plain res.write().
 */

import b4a from 'b4a'
import {
  decodeBlobServerBlobRef,
  getPrioritizedBlobDownloadRange,
  parseHttpByteRange,
  prioritizeBlobServerRangeRequest,
  publishBlobPlayheadProgress,
} from './blob-range-priority.js'
import { ASSET_BLOCK_SIZE } from './assets/static-core.js'
import { markPlaybackTiming } from './playback-timing.js'

// A player that issues one open-ended `bytes=N-` request streams the whole
// remainder through a single response (writeBlobRange below). Emit a playhead
// progress event every time the live read advances this far so the forward-fill
// re-anchors its read-ahead window — and the window cache trims behind — against
// the real read position instead of freezing at the open position. Kept well
// under the forward-fill's own 16MB re-anchor cadence so re-anchoring stays
// smooth; the followers throttle the actual work.
const PLAYHEAD_PROGRESS_EMIT_BYTES = 4 * 1024 * 1024

function isVideoContentType(type) {
  if (!type) return true
  const value = String(type).toLowerCase()
  return value.startsWith('video/') || value === 'application/octet-stream'
}

function once(emitter, event) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      try { emitter.off?.(event, onEvent) } catch { /* best effort */ }
      try { emitter.off?.('error', onError) } catch { /* best effort */ }
    }
    const onEvent = () => {
      cleanup()
      resolve()
    }
    const onError = (err) => {
      cleanup()
      reject(err)
    }
    emitter.once?.(event, onEvent)
    emitter.once?.('error', onError)
  })
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getCorePeerList(core) {
  const peers = core?.peers
  if (Array.isArray(peers)) return peers
  if (peers && typeof peers.values === 'function') return Array.from(peers.values())
  return []
}

function summarizeVideoRangePeerSync(core) {
  const peers = getCorePeerList(core)
  return {
    peers: peers.length,
    synced: peers.filter(peer => peer?.remoteSynced === true).length,
    remoteLengths: peers.slice(0, 3).map(peer => Number(peer?.remoteLength || 0)),
    remoteContiguousLengths: peers.slice(0, 3).map(peer => Number(peer?.remoteContiguousLength || 0)),
  }
}

async function hasLocalBlock(core, index) {
  if (typeof core?.has !== 'function') return false
  try {
    return await core.has(index)
  } catch {
    return false
  }
}

async function syncVideoRangeRemoteLength(core, startBlock) {
  const localStart = await hasLocalBlock(core, startBlock)
  console.log('[Storage] Video range HTTP start block:', localStart ? 'local' : 'missing', JSON.stringify(summarizeVideoRangePeerSync(core)))
  if (localStart || typeof core?.update !== 'function') return

  try {
    const updated = await Promise.race([
      core.update({ wait: true }).then(() => true),
      delay(2500).then(() => false),
    ])
    console.log('[Storage] Video range HTTP remote sync:', updated ? 'ready' : 'timeout', JSON.stringify(summarizeVideoRangePeerSync(core)))
    try { core.core?.replicator?.updateAll?.() } catch { /* best effort */ }
  } catch (err) {
    console.log('[Storage] Video range HTTP remote sync failed:', err?.message || err, JSON.stringify(summarizeVideoRangePeerSync(core)))
  }
}

function waitForResponseDrain(res, signal) {
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      res.off?.('drain', onDrain)
      res.off?.('error', onError)
      res.off?.('close', onClose)
      signal?.removeEventListener?.('abort', onAbort)
    }
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      cleanup()
      callback(value)
    }
    const aborted = () => {
      if (signal?.reason?.name === 'AbortError') return signal.reason
      const error = new Error(signal?.reason?.message || 'static playback response aborted')
      error.name = 'AbortError'
      return error
    }
    const onDrain = () => finish(resolve)
    const onError = error => finish(reject, error)
    const onClose = () => finish(reject, aborted())
    const onAbort = () => finish(reject, aborted())
    res.once?.('drain', onDrain)
    res.once?.('error', onError)
    res.once?.('close', onClose)
    signal?.addEventListener?.('abort', onAbort, { once: true })
    if (signal?.aborted || res.writableEnded || res.destroyed) onAbort()
  })
}

async function writeResponseChunk(res, chunk, signal) {
  if (!chunk || chunk.byteLength === 0) return
  if (res.writableEnded || res.destroyed || signal?.aborted) return
  const ok = res.write(chunk)
  if (ok === false) await waitForResponseDrain(res, signal)
}

function isCanonicalStaticBlob(blob) {
  return blob?.blockOffset === 0 &&
    blob?.byteOffset === 0 &&
    blob?.blockLength === Math.ceil(blob.byteLength / ASSET_BLOCK_SIZE)
}

async function resolveStartPosition(core, blob, start) {
  if (start === 0) {
    return { index: blob.blockOffset, offset: 0 }
  }

  // Static publication assets use canonical 256 KiB blocks. Their data can be
  // restored from object storage while inner Merkle tree nodes are absent.
  // Hypercore.seek() waits for a peer in that state even though the exact data
  // block is locally restorable. Map this committed canonical layout directly.
  if (isCanonicalStaticBlob(blob)) {
    return {
      index: blob.blockOffset + Math.floor(start / ASSET_BLOCK_SIZE),
      offset: start % ASSET_BLOCK_SIZE,
    }
  }

  const absoluteByteOffset = Number(blob.byteOffset || 0) + start
  const result = await core.seek(absoluteByteOffset)
  if (!result) throw new Error('Blob start byte is not available')
  return { index: result[0], offset: result[1] || 0 }
}

async function writeBlobRange({ core, blob, start, length, res, isCancelled, keyHex }) {
  let remaining = length
  let { index, offset } = await resolveStartPosition(core, blob, start)
  const blockEnd = blob.blockOffset + blob.blockLength
  let wroteFirstChunk = false
  let bytesSincePlayheadEmit = 0

  while (remaining > 0 && index < blockEnd) {
    if (isCancelled()) return false

    let block = await core.get(index)
    if (!block || block.byteLength === 0) throw new Error(`Blob block ${index} is not available`)

    if (offset > 0) {
      block = block.subarray(offset)
      offset = 0
    }
    if (block.byteLength > remaining) block = block.subarray(0, remaining)

    await writeResponseChunk(res, block)
    if (!wroteFirstChunk) {
      wroteFirstChunk = true
      // First byte the player actually receives. markPlaybackTiming only records
      // the first such mark per video, so the earliest served range wins.
      markPlaybackTiming(keyHex, 'first-byte', `block ${index}`)
      console.log('[Storage] Video range HTTP first chunk:', block.byteLength, 'bytes at block', index)
    }

    remaining -= block.byteLength
    index++

    // Advance the playhead followers against the live read position. For a single
    // open-ended response this is the only signal they get after the opening
    // request, so without it the read-ahead cushion never moves past its first
    // anchor and playback settles to the backpressured drain rate (rebuffering).
    bytesSincePlayheadEmit += block.byteLength
    if (bytesSincePlayheadEmit >= PLAYHEAD_PROGRESS_EMIT_BYTES) {
      bytesSincePlayheadEmit = 0
      try {
        publishBlobPlayheadProgress({ keyHex, blob, blockIndex: index })
      } catch { /* progress emit is best-effort; never break serving */ }
    }
  }

  return remaining === 0
}

function staticAssetMarker(req) {
  try {
    const values = new URL(req?.url || '/', 'http://127.0.0.1').searchParams.getAll('pt_static_asset')
    if (values.length === 0) return null
    return { assetId: values.length === 1 ? values[0] : null }
  } catch {
    return String(req?.url || '').includes('pt_static_asset') ? { assetId: null } : null
  }
}

function exactStaticByteRange(header, byteLength) {
  if (typeof header !== 'string' || header.includes(',')) return null
  const match = header.match(/^bytes=(\d*)-(\d*)$/)
  if (!match || (!match[1] && !match[2])) return null
  let start
  let end
  if (!match[1]) {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || suffix > byteLength) return null
    start = byteLength - suffix
    end = byteLength - 1
  } else {
    start = Number(match[1])
    end = match[2] ? Number(match[2]) : byteLength - 1
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      start < 0 || end < start || start >= byteLength || end >= byteLength) return null
  return { start, end }
}

function endBoundedStaticResponse(req, res, statusCode, byteLength, message) {
  const body = b4a.from(message)
  res.statusCode = statusCode
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Type', 'text/plain')
  res.setHeader('Content-Length', String(body.byteLength))
  if (statusCode === 416) res.setHeader('Content-Range', `bytes */${byteLength}`)
  res.writeHead(statusCode)
  res.end(req?.method === 'HEAD' ? undefined : body)
  return true
}

async function serveStaticAssetRangeHttpRequest(deps, req, res, marker) {
  const entries = deps?.staticAssetEntries
  const blobServer = deps?.blobServer
  const assetId = marker?.assetId
  const entry = typeof assetId === 'string' && /^[a-f0-9]{64}$/.test(assetId)
    ? entries?.get(assetId)
    : null
  if (!entry || !blobServer) {
    return endBoundedStaticResponse(req, res, 503, Number(entry?.coreRef?.byteLength || 0), 'verified static source unavailable')
  }
  if (req?.method !== 'GET' && req?.method !== 'HEAD') {
    return endBoundedStaticResponse(req, res, 405, entry.coreRef.byteLength, 'method not allowed')
  }

  const ref = decodeBlobServerBlobRef(blobServer, req)
  const keyHex = ref?.key?.toString?.('hex')
  const blob = ref?.blob
  if (!ref || keyHex !== assetId || entry.coreRef?.assetId !== assetId ||
      blob?.blockOffset !== 0 || blob?.blockLength !== entry.coreRef.length ||
      blob?.byteOffset !== 0 || blob?.byteLength !== entry.coreRef.byteLength) {
    return endBoundedStaticResponse(req, res, 416, entry.coreRef.byteLength, 'invalid static asset capability')
  }
  const range = exactStaticByteRange(req?.headers?.range, entry.coreRef.byteLength)
  if (!range) return endBoundedStaticResponse(req, res, 416, entry.coreRef.byteLength, 'invalid byte range')

  const length = range.end - range.start + 1
  const controller = new AbortController()
  let completed = false
  const close = () => {
    if (!completed) controller.abort()
  }
  res.on?.('close', close)

  if (req.method === 'HEAD') {
    completed = true
    res.statusCode = 206
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Content-Type', entry.mimeType || ref.type || 'video/mp4')
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${entry.coreRef.byteLength}`)
    res.setHeader('Content-Length', String(length))
    res.setHeader('Cache-Control', 'no-store')
    res.writeHead(206)
    res.end()
    return true
  }

  try {
    entry.scheduler.seek({ byteStart: range.start })
    const result = await entry.scheduler.requestRange({
      assetId,
      byteStart: range.start,
      byteEnd: range.end + 1,
      deadlineMs: 15_000,
      signal: controller.signal,
    })
    if (controller.signal.aborted || res.writableEnded || res.destroyed) return true
    if (result?.status !== 'ok' || result.verified !== true ||
        !b4a.isBuffer(result.bytes) || result.bytes.byteLength !== length) {
      return endBoundedStaticResponse(req, res, 503, entry.coreRef.byteLength, 'verified static source unavailable')
    }

    res.statusCode = 206
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Content-Type', entry.mimeType || ref.type || 'video/mp4')
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${entry.coreRef.byteLength}`)
    res.setHeader('Content-Length', String(length))
    res.setHeader('Cache-Control', 'no-store')
    res.writeHead(206)
    await writeResponseChunk(res, result.bytes, controller.signal)
    if (controller.signal.aborted || res.writableEnded || res.destroyed) return true
    completed = true
    res.end()
    deps.onStaticPlayhead?.({
      staticAssetId: assetId,
      coreKeyHex: assetId,
      blockOffset: 0,
      blockLength: entry.coreRef.length,
      byteLength: entry.coreRef.byteLength,
      windowStart: Math.floor(range.start / entry.coreRef.blockSize),
      windowEnd: Math.ceil((range.end + 1) / entry.coreRef.blockSize),
    })
    return true
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError' || res.writableEnded || res.destroyed) return true
    if (res.headersSent) {
      try { res.destroy?.(error) } catch {}
      return true
    }
    return endBoundedStaticResponse(req, res, 503, entry.coreRef.byteLength, 'verified static source unavailable')
  } finally {
    res.off?.('close', close)
  }
}

/**
 * Serve a video Range request from the blob server.
 * @returns {Promise<boolean>} true if it wrote the response, false to fall
 * through to hypercore-blob-server.
 */
export async function serveVideoRangeHttpRequest(deps, req, res) {
  const marker = staticAssetMarker(req)
  if (marker) return serveStaticAssetRangeHttpRequest(deps, req, res, marker)
  const blobServer = deps?.blobServer
  if (!blobServer || typeof blobServer._getCore !== 'function') return false
  if (req?.method !== 'GET' && req?.method !== 'HEAD') return false
  if (!req?.headers?.range) return false

  const ref = decodeBlobServerBlobRef(blobServer, req)
  if (!ref || !isVideoContentType(ref.type)) return false

  const byteRange = parseHttpByteRange(req.headers.range, ref.blob?.byteLength)
  if (!byteRange) return false

  const start = byteRange.start
  const end = byteRange.end
  const length = end - start + 1
  const statusCode = 206
  let core = null
  let completed = false
  let cancelled = false

  try {

    core = await blobServer._getCore(ref.key, {
      key: ref.key,
      blob: ref.blob,
      range: byteRange,
    }, true)
    if (!core) return false
    await core.ready?.()

    if (typeof res.on === 'function') {
      res.on('close', () => {
        if (!completed) cancelled = true
      })
    }

    res.statusCode = statusCode
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Content-Type', ref.type || 'video/mp4')
    res.setHeader('Content-Range', `bytes ${start}-${end}/${ref.blob.byteLength}`)
    res.setHeader('Content-Length', String(length))
    res.setHeader('Cache-Control', 'no-store')
    res.writeHead(statusCode)
    try { res.flushHeaders?.() } catch { /* best effort */ }

    console.log(
      '[Storage] Video range HTTP:',
      req.method,
      req.headers.range,
      '->',
      statusCode,
      `${start}-${end}/${ref.blob.byteLength}`,
      'length:',
      length
    )

    if (req.method === 'HEAD') {
      completed = true
      res.end()
      return true
    }

    const syncRange = getPrioritizedBlobDownloadRange(ref.blob, byteRange, { readAheadBytes: 0 })
    const startBlock = syncRange?.start ?? ref.blob.blockOffset
    let startBlockAvailable = false
    try {
      startBlockAvailable = Boolean(await core.get(startBlock, { wait: false }))
    } catch { /* remote acquisition below can still satisfy the request */ }

    if (startBlockAvailable) {
      console.log('[Storage] Video range HTTP start block: local or restored', JSON.stringify(summarizeVideoRangePeerSync(core)))
      publishBlobPlayheadProgress({
        keyHex: ref.key?.toString('hex'),
        blob: ref.blob,
        blockIndex: startBlock,
      })
    } else {
      try {
        await prioritizeBlobServerRangeRequest(blobServer, req)
      } catch (err) {
        console.log('[Storage] Video range priority failed:', err?.message || err)
      }
      await syncVideoRangeRemoteLength(core, startBlock)
    }
    const wroteAll = await writeBlobRange({
      core,
      blob: ref.blob,
      start,
      length,
      res,
      isCancelled: () => cancelled || res.writableEnded || res.destroyed,
      keyHex: ref.key?.toString('hex'),
    })

    if (!wroteAll || cancelled || res.writableEnded || res.destroyed) {
      console.log('[Storage] Video range HTTP cancelled:', req.headers.range)
      return true
    }

    completed = true
    res.end()
    console.log('[Storage] Video range HTTP complete:', req.headers.range, 'bytes:', length)
    return true
  } catch (err) {
    console.log('[Storage] Video range HTTP failed:', err?.message || err)
    if (!res.headersSent && !res.writableEnded) {
      res.statusCode = 500
      res.end()
      return true
    }
    try { res.destroy?.() } catch { /* best effort */ }
    return true
  } finally {
    try {
      const closing = core?.close?.()
      if (closing?.catch) closing.catch(() => {})
    } catch { /* best effort */ }
  }
}
