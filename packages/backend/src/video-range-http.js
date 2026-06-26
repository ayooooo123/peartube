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

import {
  decodeBlobServerBlobRef,
  getPrioritizedBlobDownloadRange,
  parseHttpByteRange,
  prioritizeBlobServerRangeRequest,
} from './blob-range-priority.js'
import { markPlaybackTiming } from './playback-timing.js'

function isVideoContentType(type) {
  if (!type) return true
  const value = String(type).toLowerCase()
  return value.startsWith('video/') || value === 'application/octet-stream'
}

function once(emitter, event) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      try { emitter.off?.(event, onEvent) } catch {}
      try { emitter.off?.('error', onError) } catch {}
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
    try { core.core?.replicator?.updateAll?.() } catch {}
  } catch (err) {
    console.log('[Storage] Video range HTTP remote sync failed:', err?.message || err, JSON.stringify(summarizeVideoRangePeerSync(core)))
  }
}

async function writeResponseChunk(res, chunk) {
  if (!chunk || chunk.byteLength === 0) return
  if (res.writableEnded || res.destroyed) return
  const ok = res.write(chunk)
  if (ok === false && typeof res.once === 'function') {
    await once(res, 'drain')
  }
}

async function resolveStartPosition(core, blob, start) {
  if (start === 0) {
    return { index: blob.blockOffset, offset: 0 }
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
  }

  return remaining === 0
}

/**
 * Serve a video Range request from the blob server.
 * @returns {Promise<boolean>} true if it wrote the response, false to fall
 * through to hypercore-blob-server.
 */
export async function serveVideoRangeHttpRequest(deps, req, res) {
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
    try {
      await prioritizeBlobServerRangeRequest(blobServer, req)
    } catch (err) {
      console.log('[Storage] Video range priority failed:', err?.message || err)
    }

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
    try { res.flushHeaders?.() } catch {}

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
    await syncVideoRangeRemoteLength(core, syncRange?.start ?? ref.blob.blockOffset)

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
    try { res.destroy?.() } catch {}
    return true
  } finally {
    try {
      const closing = core?.close?.()
      if (closing?.catch) closing.catch(() => {})
    } catch {}
  }
}
