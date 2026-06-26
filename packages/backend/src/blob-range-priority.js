import c from 'compact-encoding'
import HypercoreID from 'hypercore-id-encoding'
import z32 from 'z32'

import { getBlobPlaybackProfile } from './blob-playback-profile.js'

// Keep the prioritized read-ahead window comfortably larger than the player's
// forward buffer (ExoPlayer/AVPlayer buffer ~20s ahead). A 2MB window was only
// ~2s of video for large archived files, so the player constantly outran the
// prioritized region on bandwidth-constrained mobile links. 16MB keeps the
// front of the stream prioritized ahead of the player without flooding the
// scheduler with the whole file.
const DEFAULT_BLOB_RANGE_READ_AHEAD_BYTES = 16 * 1024 * 1024
const DEFAULT_BLOB_RANGE_PRIORITY_TIMEOUT_MS = 15000
// Progressive playback re-requests ranges that land inside the window we just
// started downloading (connection churn, players probing ahead). Reuse that
// in-flight download instead of restarting it, but only while it is fresh so
// the window still advances with playback.
const PRIORITY_RANGE_REUSE_WINDOW_MS = 5000
// Bound how many blob core sessions the priority registry keeps alive for
// reuse across range requests.
const MAX_TRACKED_PRIORITY_BLOBS = 8
// A seek that lands mid-GOP forces the player to scan back to the previous
// keyframe before it can render. When a playback profile supplies keyframe
// byte offsets, snap the prioritized window back to that keyframe — but only
// within a bounded distance so a sparse-keyframe file can't drag the window
// megabytes behind the playhead.
const DEFAULT_KEYFRAME_SNAP_BACK_BYTES = 8 * 1024 * 1024

// One entry per blob currently being prioritized for playback:
// registryKey -> { core, range, timer, createdAt, start, end }
const activePriorityRanges = new Map()

// Subscribers that want to follow the playhead (e.g. the background full-file
// fill re-anchoring itself past the prioritized window after a seek).
const playheadListeners = new Set()

export function subscribeBlobPlayhead(listener) {
  if (typeof listener !== 'function') return () => {}
  playheadListeners.add(listener)
  return () => playheadListeners.delete(listener)
}

function emitBlobPlayhead(event) {
  for (const listener of playheadListeners) {
    try { listener(event) } catch { /* listener errors must not break serving */ }
  }
}

function getPriorityRegistryKey(key, blob) {
  return `${key.toString('hex')}:${blob.blockOffset}:${blob.blockLength}`
}

function destroyPriorityRange(entry) {
  if (!entry) return
  if (entry.timer) {
    clearTimeout(entry.timer)
    entry.timer = null
  }
  if (entry.range) {
    try { entry.range.destroy?.() } catch { /* best effort */ }
    entry.range = null
  }
}

function closePriorityCore(core) {
  if (!core) return
  try {
    const closing = core.close?.()
    if (closing && typeof closing.catch === 'function') closing.catch(() => {})
  } catch { /* best effort */ }
}

function releasePriorityEntry(entry) {
  destroyPriorityRange(entry)
  if (!entry?.core) return
  closePriorityCore(entry.core)
  entry.core = null
}

export function releaseAllPrioritizedBlobRanges() {
  for (const entry of activePriorityRanges.values()) releasePriorityEntry(entry)
  activePriorityRanges.clear()
}

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

// Largest offset in the sorted array that is <= target, or null.
function findSnapOffsetAtMost(sortedOffsets, target) {
  if (sortedOffsets.length === 0 || sortedOffsets[0] > target) return null
  let lo = 0
  let hi = sortedOffsets.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (sortedOffsets[mid] <= target) lo = mid
    else hi = mid - 1
  }
  return sortedOffsets[lo]
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
  let openEnded = false

  if (!rawStart) {
    const suffixLength = Number(rawEnd)
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return null
    start = Math.max(0, totalBytes - suffixLength)
    end = totalBytes - 1
  } else {
    start = Number(rawStart)
    openEnded = !rawEnd
    end = rawEnd ? Number(rawEnd) : totalBytes - 1
  }

  if (!isFiniteNonNegativeInteger(start) || !isFiniteNonNegativeInteger(end)) return null
  if (start >= totalBytes) return null
  end = Math.min(end, totalBytes - 1)
  if (end < start) return null

  return { start, end, openEnded }
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

  // Snap the window start back to the nearest preceding keyframe so the
  // prioritized region begins at a decodable boundary (MoQ "group is a join
  // point"). The HTTP response still serves exactly the requested bytes; only
  // download prioritization widens.
  let effectiveRangeStart = rangeStart
  const snapOffsets = Array.isArray(options.snapOffsets) && options.snapOffsets.length > 0
    ? options.snapOffsets
    : null
  if (snapOffsets && rangeStart > 0) {
    const maxSnapBackBytes = Math.max(0, Number(options.maxSnapBackBytes ?? DEFAULT_KEYFRAME_SNAP_BACK_BYTES) || 0)
    const snapped = findSnapOffsetAtMost(snapOffsets, rangeStart)
    if (snapped != null && snapped < rangeStart && rangeStart - snapped <= maxSnapBackBytes) {
      effectiveRangeStart = snapped
    }
  }

  const readAheadBytes = Math.max(0, Number(options.readAheadBytes ?? DEFAULT_BLOB_RANGE_READ_AHEAD_BYTES) || 0)
  const bytesPerBlock = Math.max(1, byteLength / blockLength)
  const requestedEndByte = byteRange.openEnded === true ? rangeStart : rangeEnd
  const prioritizedEndByte = Math.min(byteLength - 1, requestedEndByte + readAheadBytes)
  const relativeStartBlock = Math.max(0, Math.min(blockLength - 1, Math.floor(effectiveRangeStart / bytesPerBlock)))
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

// Decode a blob-server GET request's key + blob + type WITHOUT requiring a Range
// header. Used to serve small blobs (thumbnails/images) with a buffered,
// deterministic HTTP response that Android image loaders accept, where the
// upstream streaming pipe does not end cleanly for a plain GET.
export function decodeBlobServerBlobRef(blobServer, req) {
  if (req?.method && req.method !== 'GET' && req.method !== 'HEAD') return null

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
  if (!key || !blob) return null

  const type = url.searchParams.get('type') || null
  return { key, blob, type }
}

function decodeBlobRangeRequest(blobServer, req) {
  if (req?.method && req.method !== 'GET') return null

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

// Back-moov MP4s cannot start rendering until the tail-of-file moov box is
// local: the player's very next request after probing the head is the tail.
// Pull those blocks proactively the moment playback traffic appears for the
// blob, instead of waiting out that extra request round trip. One shot per
// registered profile; downloads of already-local blocks resolve immediately.
function boostBackMoovDownload(core, blob, profile, options = {}) {
  if (!profile || profile.moovPosition !== 'back' || profile._moovBoosted) return
  if (!isFiniteNonNegativeInteger(profile.moovStart) || !Number.isInteger(profile.moovEnd)) return
  if (profile.moovEnd <= profile.moovStart) return
  profile._moovBoosted = true

  const moovRange = getPrioritizedBlobDownloadRange(
    blob,
    { start: profile.moovStart, end: profile.moovEnd - 1 },
    { readAheadBytes: 0 }
  )
  if (!moovRange) return

  let range
  try {
    range = core.download({ start: moovRange.start, end: moovRange.end, linear: true })
  } catch {
    return
  }

  const timeoutMs = Math.max(
    1000,
    Number(options.timeoutMs ?? DEFAULT_BLOB_RANGE_PRIORITY_TIMEOUT_MS) || DEFAULT_BLOB_RANGE_PRIORITY_TIMEOUT_MS
  )
  const stop = () => {
    clearTimeout(timer)
    try { range?.destroy?.() } catch { /* best effort */ }
  }
  const timer = setTimeout(stop, timeoutMs)
  const done = typeof range?.done === 'function' ? range.done() : Promise.resolve()
  Promise.resolve(done).catch(() => {}).finally(stop)
}

export async function prioritizeBlobServerRangeRequest(blobServer, req, options = {}) {
  if (!blobServer || typeof blobServer._getCore !== 'function') return null

  const request = decodeBlobRangeRequest(blobServer, req)
  if (!request) return null

  const profile = getBlobPlaybackProfile(request.key.toString('hex'), request.blob)
  const downloadRange = getPrioritizedBlobDownloadRange(request.blob, request.byteRange, {
    ...options,
    snapOffsets: options.snapOffsets ?? profile?.keyframeOffsets,
  })
  if (!downloadRange) return null

  // Transient callers own the core session lifecycle for this single request
  // and bypass the shared registry entirely.
  const transient = options.closeCoreOnCleanup === true
  const registryKey = getPriorityRegistryKey(request.key, request.blob)
  const existing = activePriorityRanges.get(registryKey) || null

  if (
    !transient &&
    existing?.range &&
    downloadRange.start >= existing.start &&
    downloadRange.start < existing.end &&
    Date.now() - existing.createdAt < PRIORITY_RANGE_REUSE_WINDOW_MS
  ) {
    return downloadRange
  }

  // Anything outside the fresh window is a seek (or the window advancing with
  // playback): drop the stale prioritized range immediately so replication
  // bandwidth refocuses on the bytes the player is about to block on, instead
  // of letting up to 16MB of pre-seek window keep competing for peers for the
  // rest of its timeout lifetime. This is what makes seeks into uncached
  // regions start delivering quickly.
  destroyPriorityRange(existing)

  let core = !transient && existing?.core && existing.core.closed !== true ? existing.core : null
  if (!core) {
    core = await blobServer._getCore(request.key, {
      key: request.key,
      blob: request.blob,
      range: request.byteRange
    }, true)
  }
  if (!core || typeof core.download !== 'function') {
    if (existing) {
      activePriorityRanges.delete(registryKey)
      releasePriorityEntry(existing)
    }
    return null
  }

  boostBackMoovDownload(core, request.blob, profile, options)

  // Video playback reads bytes sequentially from the seek point forward, so the
  // prioritized region must download in play order. `linear: false` let
  // hypercore fetch blocks in rarest/availability order, which leaves gaps the
  // player reaches before they land -> rebuffering on large files. `linear: true`
  // fills the window front-to-back so the player keeps draining contiguous bytes.
  const range = core.download({
    start: downloadRange.start,
    end: downloadRange.end,
    linear: true
  })

  try {
    const byteEnd = request.byteRange.openEnded ? '' : request.byteRange.end
    console.log(`[Storage] Blob range priority: bytes ${request.byteRange.start}-${byteEnd} -> blocks ${downloadRange.start}-${downloadRange.end} (${downloadRange.blocks})`)
  } catch { /* diagnostics only */ }

  const entry = {
    core,
    range,
    timer: null,
    createdAt: Date.now(),
    start: downloadRange.start,
    end: downloadRange.end
  }

  if (!transient) {
    // The session moves to the new entry; make sure no stale reference can
    // close it underneath the active download.
    if (existing) existing.core = null
    activePriorityRanges.delete(registryKey)
    activePriorityRanges.set(registryKey, entry)
    // Keep the session pool bounded (Map preserves insertion order = LRU).
    while (activePriorityRanges.size > MAX_TRACKED_PRIORITY_BLOBS) {
      const oldestKey = activePriorityRanges.keys().next().value
      if (oldestKey === registryKey) break
      const oldest = activePriorityRanges.get(oldestKey)
      activePriorityRanges.delete(oldestKey)
      releasePriorityEntry(oldest)
    }
  }

  const timeoutMs = Math.max(
    1000,
    Number(options.timeoutMs ?? DEFAULT_BLOB_RANGE_PRIORITY_TIMEOUT_MS) || DEFAULT_BLOB_RANGE_PRIORITY_TIMEOUT_MS
  )
  let cleanedUp = false
  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    destroyPriorityRange(entry)
    if (entry.range !== range) {
      try { range?.destroy?.() } catch { /* best effort */ }
    }
    // Do NOT close the registry-held core session here: it stays pooled so the
    // next range request for this blob reuses it instead of leaking a fresh
    // session per request. Transient callers opted into owning the lifecycle.
    if (transient) closePriorityCore(core)
  }
  entry.timer = setTimeout(cleanup, timeoutMs)

  const done = typeof range?.done === 'function'
    ? range.done()
    : typeof range?.downloaded === 'function'
      ? range.downloaded()
      : Promise.resolve()

  Promise.resolve(done)
    .catch(() => {})
    .finally(cleanup)

  emitBlobPlayhead({
    coreKeyHex: request.key.toString('hex'),
    blockOffset: request.blob.blockOffset,
    blockLength: request.blob.blockLength,
    byteLength: request.blob.byteLength,
    windowStart: downloadRange.start,
    windowEnd: downloadRange.end,
  })

  return downloadRange
}
