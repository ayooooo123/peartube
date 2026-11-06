// Dedicated Web Worker driving peartube-media's SIMD128 Rust/OxideAV WebAssembly engine:
//   - The page fetches 2 MiB blocks ahead into a 64 MiB ring; only an uncached read falls back to sync XHR
//   - Zero-allocation OffscreenCanvas WebGL2/WebGL1 YUV420 + RGBA + WebCodecs GPU renderer inside the Worker
//   - Recycled Transferable ArrayBuffer pools for zero steady-state GC churn
let wasm = null
let wasmReady = null
let streamUrl = ''
let streamLen = 0
let streamingMode = false
let queuedVideoSec = 0
let queuedAudioSec = 0
// The page credits what it has played; these anchors let the worker drain those estimates on its
// own when a hidden tab, an unfocused/occluded window, or a frozen timer stops the credits.
let lastCreditAt = 0
let watchdog = null
let lastVideoPts = null
let hasVideo = false
let hasAudio = false
let useMse = false
let useWebCodecs = false
let wcConfig = null
let wcDecoder = null
let wcMinPts = 0
let wcPacketQueue = []
let wcGops = []
let wcQueuedSpanSec = 0
let wcInFlight = 0
let wcFlushAtDrain = false
// Pictures the decoder may hold in flight. Ten ran dry when the worker paused even briefly
// (a letterbox readback, a queue drain), and late pictures reach the page as drops; sixteen
// rides out a stall of a few hundred milliseconds at 24 fps.
const MAX_WC_ACTIVE = 16
let lastMseSegEnd = 0
let latestQueuedSeq = 0
let eof = false
let pumping = false
let closed = true
let configured = false
let activeSeq = 0

// Speaker-locked monotonic clock interpolated smoothly at Worker VSync rate
let clockMedia = 0
let clockWallMs = 0
let clockPlaying = false
let pageHidden = false
let lastPostedBlock = -1
let ABI = null

let streamCrop = null
let streamCropCandidate = null
let streamCropSame = 0
let streamCropFrames = 0
let cropProbe = null
const freeVideoPool = []
const freeAudioPool = []

// The page owns read-ahead: it fetches 2 MiB ranges with fetch() and posts them here, because this
// Worker's event loop is blocked inside a wasm read, so its own async fetches settled too late and
// every miss fell through to a blocking sync XHR that froze the frame clock for seconds. The ring
// keeps 64 MiB so the demuxer's sequential pages hit long after the page fetched them.
const STREAM_BLOCK = 2 * 1024 * 1024
const MAX_BLOCKS = 32
const blockCache = new Map()
const hiddenPrefetchInFlight = new Map()
let blockStamp = 0
let headProbe = null

function abortHiddenPrefetch () {
  for (const ctl of hiddenPrefetchInFlight.values()) { try { ctl.abort() } catch {} }
  hiddenPrefetchInFlight.clear()
}

// While the page is hidden or occluded, Chromium throttles main-thread timers and fetch callbacks;
// this Dedicated Worker stays unthrottled while audio plays and pulls 2 MiB blocks straight into blockCache.
function pumpHiddenPrefetch () {
  if (!pageHidden || closed || eof || !streamingMode || !streamUrl || streamLen <= 0) return
  const base = Math.max(0, lastPostedBlock)
  for (let i = 0; i <= 16; i++) {
    if (hiddenPrefetchInFlight.size >= 4) break
    const idx = base + i
    const start = idx * STREAM_BLOCK
    if (start >= streamLen) break
    if (blockCache.has(idx) || hiddenPrefetchInFlight.has(idx) || (idx === 0 && headProbe && headProbe.byteLength > 0)) continue
    const end = Math.min(streamLen - 1, start + STREAM_BLOCK - 1)
    const ctl = new AbortController()
    hiddenPrefetchInFlight.set(idx, ctl)
    const killTimer = setTimeout(() => { try { ctl.abort() } catch {} }, 6000)
    const seq = activeSeq
    fetch(streamUrl, { headers: { Range: 'bytes=' + start + '-' + end }, signal: ctl.signal })
      .then(r => (r.ok || r.status === 206) ? r.arrayBuffer() : null)
      .then(ab => {
        clearTimeout(killTimer)
        hiddenPrefetchInFlight.delete(idx)
        if (!ab || closed || seq !== activeSeq) return
        putBlock(idx, new Uint8Array(ab))
        if (pageHidden) pumpHiddenPrefetch()
      })
      .catch(() => {
        clearTimeout(killTimer)
        hiddenPrefetchInFlight.delete(idx)
        if (!closed && seq === activeSeq && pageHidden) {
          setTimeout(() => { if (!closed && seq === activeSeq && pageHidden) pumpHiddenPrefetch() }, 400)
        }
      })
  }
}
const dec = new TextDecoder()
const enc = new TextEncoder()
const nowWall = () => (self.performance.timeOrigin || 0) + self.performance.now()

function workerMediaTime () {
  if (!clockPlaying) return clockMedia
  return clockMedia + Math.max(0, (nowWall() - clockWallMs) / 1000)
}

function putBlock (idx, data) {
  blockStamp++
  const existing = blockCache.get(idx)
  if (existing) {
    existing.stamp = blockStamp
    return
  }
  if (blockCache.size >= MAX_BLOCKS) {
    // Never evict a block the demuxer has not read yet. Blocks ahead of the read position keep the
    // stamp they were fetched with, while every block behind is re-stamped each time it is read, so
    // plain oldest-stamp eviction threw away the next block on every insert: every read became a
    // cache miss, and a miss is a synchronous fetch that freezes this worker for the round trip.
    let victim = null
    let victimStamp = Infinity
    for (const [k, v] of blockCache) {
      if (k >= lastPostedBlock) continue
      if (v.stamp < victimStamp) { victimStamp = v.stamp; victim = k }
    }
    if (victim === null) {
      for (const [k, v] of blockCache) {
        if (v.stamp < victimStamp) { victimStamp = v.stamp; victim = k }
      }
    }
    if (victim !== null) blockCache.delete(victim)
  }
  blockCache.set(idx, { data, stamp: blockStamp })
}

async function probeStream (url) {
  blockCache.clear()
  headProbe = null
  const response = await fetch(url, {
    headers: { Range: 'bytes=0-' + (STREAM_BLOCK - 1) },
    signal: AbortSignal.timeout(30000)
  })
  if (response.status !== 200 && response.status !== 206) throw new Error('Stream HTTP ' + response.status)
  const buf = new Uint8Array(await response.arrayBuffer())
  const cr = response.headers.get('Content-Range') || ''
  const slash = cr.lastIndexOf('/')
  if (slash !== -1) {
    const total = Number(cr.slice(slash + 1).trim())
    streamLen = total > 0 ? total : buf.byteLength
  } else {
    const cl = Number(response.headers.get('Content-Length') || 0)
    streamLen = cl > 0 ? cl : buf.byteLength
  }
  headProbe = buf
  if (buf.byteLength > 0) putBlock(0, buf)
}

function readAtSync (offset, dstPtr, len) {
  if (offset >= streamLen || len === 0) return 0
  const maxLen = Math.min(len, streamLen - offset)
  const bIdx = Math.floor(offset / STREAM_BLOCK)
  const inHead = Boolean(headProbe && offset + maxLen <= headProbe.byteLength)
  const bOff = offset - bIdx * STREAM_BLOCK
  const cached = inHead ? null : blockCache.get(bIdx)
  const inCache = inHead || Boolean(cached && bOff < cached.data.byteLength)
  // Only notify the page's read-ahead once streaming starts, and only set force on real cache misses
  // so sequential hits advance the prefetch window without re-downloading every 2 MiB block twice.
  if (streamingMode && (bIdx !== lastPostedBlock || !inCache)) {
    lastPostedBlock = bIdx
    if (pageHidden) pumpHiddenPrefetch()
    else self.postMessage({ type: 'readBlock', block: bIdx, force: !inCache })
  }
  if (inHead) {
    new Uint8Array(wasm.memory.buffer, dstPtr, maxLen).set(headProbe.subarray(offset, offset + maxLen))
    return maxLen
  }
  if (cached && bOff < cached.data.byteLength) {
    cached.stamp = ++blockStamp
    const take = Math.min(maxLen, cached.data.byteLength - bOff)
    new Uint8Array(wasm.memory.buffer, dstPtr, take).set(cached.data.subarray(bOff, bOff + take))
    return take
  }

  // A sync read blocks this worker — demux, decode and mux all stop until it returns — so on a
  // cache miss fetch only enough to serve the caller (a fraction of the 2 MiB block) instead of
  // the whole thing. The page is told to fetch the full block in parallel (the readBlock message
  // above), and only a complete block is ever put into blockCache.
  const fetchStart = bIdx * STREAM_BLOCK
  const need = Math.min(STREAM_BLOCK, Math.max(131072, bOff + maxLen))
  const fetchEnd = Math.min(streamLen - 1, fetchStart + need - 1)

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const xhr = new XMLHttpRequest()
      xhr.open('GET', streamUrl, false)
      // shortcut: sync wasm reads cannot be timed out by XHR; move this last-resort read to an async host bridge when available.
      xhr.responseType = 'arraybuffer'
      xhr.setRequestHeader('Range', 'bytes=' + fetchStart + '-' + fetchEnd)
      xhr.send()
      if (xhr.status !== 200 && xhr.status !== 206) continue
      const src = new Uint8Array(xhr.response || new ArrayBuffer(0))
      if (src.byteLength === 0) continue
      const wholeBlock = src.byteLength >= Math.min(STREAM_BLOCK, streamLen - fetchStart)
      if (wholeBlock) putBlock(bIdx, src)
      const offInSrc = offset - fetchStart
      if (offInSrc >= src.byteLength) return -1
      const take = Math.min(maxLen, src.byteLength - offInSrc)
      new Uint8Array(wasm.memory.buffer, dstPtr, take).set(src.subarray(offInSrc, offInSrc + take))
      return take
    } catch {}
  }
  return -1
}

function ensureWasm (wasmUrl) {
  if (wasm) return Promise.resolve(wasm)
  if (wasmReady) return wasmReady
  const imports = {
    env: {
      host_stream_len: () => BigInt(streamLen),
      host_read_at: (offBig, dstPtr, len) => readAtSync(Number(offBig), dstPtr >>> 0, len >>> 0)
    }
  }
  wasmReady = (async () => {
    let inst
    if (WebAssembly.instantiateStreaming) {
      try {
        inst = (await WebAssembly.instantiateStreaming(fetch(wasmUrl), imports)).instance
      } catch {}
    }
    if (!inst) {
      const bytes = await fetch(wasmUrl).then(r => r.arrayBuffer())
      inst = (await WebAssembly.instantiate(bytes, imports)).instance
    }
    wasm = inst.exports
    wasm.pt_abi_json()
    ABI = readJson()
    return wasm
  })()
  return wasmReady
}

function readJson () {
  const ptr = wasm.pt_json_ptr() >>> 0
  const len = wasm.pt_json_len() >>> 0
  if (!len) return {}
  return JSON.parse(dec.decode(new Uint8Array(wasm.memory.buffer, ptr, len)))
}

function copyPooledBuf (pool) {
  const ptr = wasm.pt_out_ptr() >>> 0
  const len = wasm.pt_out_len() >>> 0
  let ab = null
  for (let i = 0; i < pool.length; i++) {
    if (pool[i].byteLength >= len) {
      ab = pool.splice(i, 1)[0]
      break
    }
  }
  if (!ab) ab = new ArrayBuffer(len)
  if (len > 0) {
    new Uint8Array(ab, 0, len).set(new Uint8Array(wasm.memory.buffer, ptr, len))
  }
  return { ab, len }
}

function recyclePool (pool, ab, maxItems) {
  if (ab && ab.byteLength > 0 && pool.length < maxItems) {
    pool.push(ab)
  }
}


// Decode a small preview only occasionally: black rows baked into a 16:9 movie must not
// become a second set of side bars when the stage contains its encoded frame. Three
// matching bright pictures protect dark scenes, and continued probes restore IMAX shots.
function detectLetterbox (u8, w, h, rgba = false) {
  const value = i => rgba ? Math.max(u8[i * 4], u8[i * 4 + 1], u8[i * 4 + 2]) : u8[i]
  let sum = 0, n = 0
  for (let y = 0; y < h; y += 16) for (let x = 0; x < w; x += 16) { sum += value(y * w + x); n++ }
  if (n === 0 || sum / n < 25) return null
  const blackRow = y => { for (let x = 0; x < w; x += 8) if (value(y * w + x) > 24) return false; return true }
  let top = 0
  while (top < h && blackRow(top)) top++
  let bottom = h - 1
  while (bottom > top && blackRow(bottom)) bottom--
  if (bottom - top + 1 < h * 0.5) return null
  const blackCol = x => { for (let y = top; y <= bottom; y += 8) if (value(y * w + x) > 24) return false; return true }
  let left = 0
  while (left < w && blackCol(left)) left++
  let right = w - 1
  while (right > left && blackCol(right)) right--
  // A narrow bright logo against black is not evidence that the picture has bars.
  if (right - left + 1 < w * 0.95) return null
  if (top < h * 0.02 && h - 1 - bottom < h * 0.02 && left < w * 0.02 && w - 1 - right < w * 0.02) {
    return { left: 0, top: 0, right: w, bottom: h, full: true }
  }
  return { left: 0, top, right: w, bottom: bottom + 1 }
}

function sampleVideoFrame (vf, w, h) {
  if (typeof OffscreenCanvas !== 'function') return null
  const sw = 320, sh = Math.max(1, Math.round(h * sw / w))
  if (!cropProbe || cropProbe.canvas.height !== sh) {
    const canvas = new OffscreenCanvas(sw, sh)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    cropProbe = { canvas, ctx }
  }
  try {
    cropProbe.ctx.drawImage(vf, 0, 0, sw, sh)
    const c = detectLetterbox(cropProbe.ctx.getImageData(0, 0, sw, sh).data, sw, sh, true)
    if (!c) return null
    return { left: Math.round(c.left * w / sw), top: Math.round(c.top * h / sh),
      right: Math.round(c.right * w / sw), bottom: Math.round(c.bottom * h / sh), full: c.full }
  } catch { return null }
}

// Reading a 4K frame back from the GPU to look for baked-in bars costs a full resolve and a
// colour convert. Three agreeing samples settle a file's letterbox, so after that look far less
// often — every thirtieth frame still follows a picture that opens up, while the readback
// that was starving the decoder (and dropping late pictures) happens a fraction as often.
function cropSampleDue () {
  if (streamCropSame >= 3) return ++streamCropFrames % 30 === 1
  return ++streamCropFrames % 4 === 1
}

function trackLetterbox (c, w, h) {
  if (!c) return
  const p = streamCropCandidate
  const tolerance = Math.max(2, Math.round(h / 100))
  const same = p && Math.abs(p.left - c.left) <= tolerance && Math.abs(p.top - c.top) <= tolerance &&
    Math.abs(p.right - c.right) <= tolerance && Math.abs(p.bottom - c.bottom) <= tolerance
  streamCropCandidate = c
  streamCropSame = same ? streamCropSame + 1 : 1
  if (streamCropSame < 3) return
  if (c.full ? streamCrop !== null : streamCrop === null ||
    Math.abs(streamCrop.top - c.top) > tolerance || Math.abs(streamCrop.bottom - c.bottom) > tolerance) {
    streamCrop = c.full ? null : c
    self.postMessage({ type: 'videoCrop', seq: activeSeq, full: c.full, ...c, w, h })
  }
}

function resetWebCodecsGops () {
  wcGops = []
}

function closeWebCodecs () {
  wcPacketQueue.length = 0
  wcQueuedSpanSec = 0
  wcInFlight = 0
  wcFlushAtDrain = false
  if (wcDecoder) {
    try { if (wcDecoder.state !== 'closed') wcDecoder.close() } catch {}
    wcDecoder = null
  }
}

function recordWcGopPacket (pkt) {
  const now = workerMediaTime()
  if (pkt.isKey) {
    while (wcGops.length >= 2 && wcGops[1][0].pts <= now + 0.02) {
      wcGops.shift()
    }
    if (wcGops.length > 0 && pkt.pts <= now + 0.02) {
      wcGops = []
    }
    while (wcGops.length >= ABI.limits.maxHiddenGops) wcGops.shift()
    wcGops.push([pkt])
  } else if (wcGops.length > 0) {
    const cur = wcGops[wcGops.length - 1]
    if (cur.length < ABI.limits.maxGopPkts) cur.push(pkt)
  }
}
function feedWebCodecs () {
  if (!useWebCodecs || pageHidden || !wcDecoder || wcDecoder.state !== 'configured') return
  const seq = activeSeq
  let drained = false
  while (wcPacketQueue.length > 0) {
    const next = wcPacketQueue[0]
    const active = next.counted ? (wcInFlight + wcDecoder.decodeQueueSize) : wcDecoder.decodeQueueSize
    if (active >= MAX_WC_ACTIVE) break
    wcPacketQueue.shift()
    drained = true
    if (next.counted) wcQueuedSpanSec = Math.max(0, wcQueuedSpanSec - next.dur)
    try {
      wcDecoder.decode(new self.EncodedVideoChunk({
        type: next.isKey ? 'key' : 'delta',
        timestamp: Math.round(next.pts * 1e6),
        duration: Math.round(next.dur * 1e6),
        data: next.data
      }))
    } catch {
      break
    }
  }
  if (wcFlushAtDrain && wcPacketQueue.length === 0 && wcDecoder && wcDecoder.state === 'configured') {
    wcFlushAtDrain = false
    wcDecoder.flush()
      .catch(() => {})
      .finally(() => {
        if (!closed && seq === activeSeq) self.postMessage({ type: 'eof', seq })
      })
    return
  }
  if (drained && configured && !closed && !eof && !bufferedAhead()) schedulePump(0)
}

async function setupWebCodecsIfPossible (hint) {
  closeWebCodecs()
  if (!hint || !hint.codec || typeof self.VideoDecoder !== 'function') return false
  const cfg = {
    codec: hint.codec,
    codedWidth: hint.width,
    codedHeight: hint.height
  }
  if (hint.descriptionHex && hint.descriptionHex.length >= 2) {
    const bytes = new Uint8Array(hint.descriptionHex.length >> 1)
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Number.parseInt(hint.descriptionHex.slice(i * 2 + 0, i * 2 + 2), 16)
    }
    cfg.description = bytes
  }
  try {
    const sup = await self.VideoDecoder.isConfigSupported(cfg)
    if (!sup || !sup.supported) return false
    wcConfig = sup.config || cfg
    return true
  } catch {
    return false
  }
}

function openWebCodecsInstance (seq, minPts) {
  closeWebCodecs()
  if (!wcConfig || typeof self.VideoDecoder !== 'function') return false
  wcMinPts = minPts
  try {
    const decInst = new self.VideoDecoder({
      output: vf => {
        if (closed || seq !== activeSeq || pageHidden) {
          try { vf.close() } catch {}
          feedWebCodecs()
          return
        }
        const pts = (vf.timestamp || 0) / 1e6
        if (pts + 0.025 < wcMinPts) {
          try { vf.close() } catch {}
          feedWebCodecs()
          return
        }
        const step = lastVideoPts !== null ? Math.max(0.01, Math.min(0.2, pts - lastVideoPts)) : (1 / 30)
        lastVideoPts = pts
        queuedVideoSec += step
        wcInFlight++
        const w = vf.displayWidth || vf.codedWidth || 0
        const h = vf.displayHeight || vf.codedHeight || 0
        if (cropSampleDue() && w > 0 && h > 0) {
          trackLetterbox(sampleVideoFrame(vf, w, h), w, h)
        }
        self.postMessage({ type: 'videoFrame', seq, pts, w, h, hwFrame: vf }, [vf])
        feedWebCodecs()
      },
      error: () => {
        if (!closed && seq === activeSeq && useWebCodecs) {
          useWebCodecs = false
          closeWebCodecs()
          self.postMessage({ type: 'webCodecsError', seq })
        }
      }
    })
    decInst.configure(wcConfig)
    wcDecoder = decInst
    return true
  } catch {
    return false
  }
}


function setPageHidden (nextHidden) {
  const h = Boolean(nextHidden)
  if (h === pageHidden) return
  pageHidden = h
  if (h) {
    if (useWebCodecs) closeWebCodecs()
    else if (!useMse && wasm) wasm.pt_set_hidden?.(1)
    pumpHiddenPrefetch()
  } else {
    if (streamingMode && lastPostedBlock >= 0) {
      self.postMessage({ type: 'readBlock', block: lastPostedBlock, force: false })
    }
    const now = workerMediaTime()
    queuedVideoSec = 0
    if (useWebCodecs) {
      openWebCodecsInstance(activeSeq, now)
      while (wcGops.length >= 2 && wcGops[1][0].pts <= now + 0.02) {
        wcGops.shift()
      }
      const replay = wcGops.flat()
      wcPacketQueue = []
      wcQueuedSpanSec = 0
      for (const p of replay) {
        const counted = p.pts + 0.025 >= now
        wcPacketQueue.push({ isKey: p.isKey, pts: p.pts, dur: p.dur, counted, data: p.data })
        if (counted) wcQueuedSpanSec += p.dur
      }
      if (eof && wcPacketQueue.length > 0) wcFlushAtDrain = true
      feedWebCodecs()
    } else if (!useMse && wasm) {
      wasm.pt_set_hidden?.(0)
    }
  }
}

function bufferedAhead () {
  const maxVideo = useMse ? 8.0 : (useWebCodecs ? 3.5 : 1.5)
  const maxAudio = pageHidden ? 5.0 : (useWebCodecs ? 3.0 : 2.5)
  const sinceCredit = clockPlaying ? Math.min(30, Math.max(0, (nowWall() - lastCreditAt) / 1000)) : 0
  const videoSec = useMse
    ? Math.max(0, lastMseSegEnd - workerMediaTime())
    : (useWebCodecs
        ? (wcQueuedSpanSec + (wcInFlight / 24))
        : Math.max(0, queuedVideoSec - sinceCredit))
  const audioSec = Math.max(0, queuedAudioSec - sinceCredit)
  // MSE keeps its SourceBuffer fed while hidden so high-bitrate 4K remuxes snap cleanly on return without re-seeking.
  const vOk = (pageHidden && !useMse) || !hasVideo || videoSec >= maxVideo
  const aOk = !hasAudio || audioSec >= maxAudio
  return (hasVideo || hasAudio) ? (vOk && aOk) : false
}

// Nobody calls the pump when the page goes quiet, so a small worker timer re-checks the decaying
// buffers and keeps decoding. It self-arms while playback runs and dies with the player.
function armWatchdog () {
  if (watchdog !== null) return
  watchdog = setTimeout(() => {
    watchdog = null
    if (closed || eof || !configured) return
    if (clockPlaying) {
      if (!pumping && !bufferedAhead()) schedulePump(0)
      armWatchdog()
    }
  }, 250)
}

function schedulePump (delay = 0) {
  if (!configured || pumping || closed || eof) return
  pumping = true
  setTimeout(pump, delay)
}

function pump () {
  pumping = false
  if (!configured || closed || eof || !wasm) return
  if (bufferedAhead()) return

  const seq = activeSeq
  const tStart = performance.now()
  const maxSliceMs = 16
  for (let i = 0; i < 96; i++) {
    if (closed || seq !== activeSeq) return
    if (clockPlaying) wasm.pt_set_clock?.(workerMediaTime())
    const code = wasm.pt_step()
    if (code === ABI.step.eof) {
      eof = true
      if (useWebCodecs && wcDecoder && wcDecoder.state === 'configured') {
        wcFlushAtDrain = true
        feedWebCodecs()
      } else {
        self.postMessage({ type: 'eof', seq })
      }
      return
    }
    if (code === ABI.step.yield) {
      // Slice budget spent skipping pre-seek TrueHD packets or hidden frames; yield to event loop and pump again.
      break
    }
    if (code < 0) {
      const err = readJson()
      self.postMessage({ type: 'error', seq, error: err.error || 'WASM decode failed' })
      eof = true
      return
    }
    if (code === ABI.step.mseInit) {
      const { ab, len } = copyPooledBuf([])
      const exact = len === ab.byteLength ? ab : ab.slice(0, len)
      self.postMessage({ type: 'mseInit', seq, buf: exact }, [exact])
    } else if (code === ABI.step.mseSegment) {
      const { ab, len } = copyPooledBuf([])
      const exact = len === ab.byteLength ? ab : ab.slice(0, len)
      const start = wasm.pt_out_pts()
      const end = wasm.pt_out_dur()
      if (end > lastMseSegEnd) lastMseSegEnd = end
      queuedVideoSec += Math.max(0.04, Math.min(4.0, end - start))
      self.postMessage({ type: 'mseSeg', seq, start, end, buf: exact }, [exact])
    } else if (code === ABI.step.videoPacket) {
      if (useWebCodecs) {
        const ptr = wasm.pt_out_ptr() >>> 0
        const len = wasm.pt_out_len() >>> 0
        const pts = wasm.pt_out_pts()
        const dur = Math.max(0.008, Math.min(0.25, wasm.pt_out_dur() || (1 / 24)))
        const isKey = (wasm.pt_out_w() >>> 0) !== 0
        const copy = new Uint8Array(len)
        if (len > 0) copy.set(new Uint8Array(wasm.memory.buffer, ptr, len))
        const pkt = { isKey, pts, dur, counted: pts + 0.025 >= wcMinPts, data: copy }
        recordWcGopPacket(pkt)
        if (!pageHidden) {
          wcPacketQueue.push(pkt)
          if (pkt.counted) wcQueuedSpanSec += dur
          feedWebCodecs()
        }
      }
    } else if (code === ABI.step.videoRgba || code === ABI.step.videoYuv420) {
      const pts = wasm.pt_out_pts()
      const w = wasm.pt_out_w() >>> 0
      const h = wasm.pt_out_h() >>> 0
      const step = lastVideoPts !== null ? Math.max(0.01, Math.min(0.2, pts - lastVideoPts)) : (1 / 30)
      lastVideoPts = pts
      queuedVideoSec += step
      const { ab, len } = copyPooledBuf(freeVideoPool)
      if (code === ABI.step.videoYuv420 && cropSampleDue()) {
        trackLetterbox(detectLetterbox(new Uint8Array(ab, 0, len), w, h), w, h)
      }
      self.postMessage({ type: 'videoFrame', seq, pts, w, h, yuv: code === ABI.step.videoYuv420, buf: ab, byteLen: len }, [ab])
    } else if (code === ABI.step.audioPlanarF32) {
      const { ab, len } = copyPooledBuf(freeAudioPool)
      const pts = wasm.pt_out_pts()
      const rate = wasm.pt_out_rate() >>> 0
      const samples = wasm.pt_out_samples() >>> 0
      if (rate > 0) queuedAudioSec += samples / rate
      self.postMessage({ type: 'audioChunk', seq, pts, rate, samples, buf: ab, byteLen: len }, [ab])
    } else if (code === ABI.step.subText) {
      const ptr = wasm.pt_out_ptr() >>> 0
      const len = wasm.pt_out_len() >>> 0
      const text = dec.decode(new Uint8Array(wasm.memory.buffer, ptr, len))
      self.postMessage({ type: 'subText', seq, start: wasm.pt_out_pts(), end: wasm.pt_out_dur(), text })
    } else if (code === ABI.step.subBitmap) {
      const { ab, len } = copyPooledBuf([])
      const exact = len === ab.byteLength ? ab : ab.slice(0, len)
      self.postMessage({
        type: 'subBitmap',
        seq,
        start: wasm.pt_out_pts(),
        end: wasm.pt_out_dur(),
        x: wasm.pt_out_x(),
        y: wasm.pt_out_y(),
        w: wasm.pt_out_w() >>> 0,
        h: wasm.pt_out_h() >>> 0,
        cw: wasm.pt_out_cw() >>> 0,
        ch: wasm.pt_out_ch() >>> 0,
        buf: exact
      }, [exact])
    }
    if (bufferedAhead() || (performance.now() - tStart) >= maxSliceMs) break
  }
  if (!bufferedAhead()) schedulePump(0)
  armWatchdog()
}

async function handleCmd (msg) {
  if (msg.cmd === 'warmup') {
    await ensureWasm(msg.wasmUrl)
    self.postMessage({ type: 'warm', streamBlock: STREAM_BLOCK })
  } else if (msg.cmd === 'open') {
    closed = true
    abortHiddenPrefetch()
    resetWebCodecsGops()
    closeWebCodecs()
    if (wasm) wasm.pt_close()
    closed = false
    configured = false
    eof = false
    streamingMode = false
    lastPostedBlock = -1
    lastMseSegEnd = 0
    clockPlaying = false
    clockMedia = 0
    pageHidden = false
    wcConfig = null
    useWebCodecs = false
    activeSeq = msg.seq || 1
    streamUrl = msg.streamUrl
    await ensureWasm(msg.wasmUrl)
    await probeStream(streamUrl)
    const extBytes = enc.encode(msg.ext || '')
    let ptr = 0
    if (extBytes.length > 0) {
      ptr = wasm.pt_alloc(extBytes.length) >>> 0
      new Uint8Array(wasm.memory.buffer, ptr, extBytes.length).set(extBytes)
    }
    const rc = wasm.pt_open(ptr, extBytes.length)
    if (ptr) wasm.pt_free(ptr, extBytes.length)
    const payload = readJson()
    if (rc < 0) {
      self.postMessage({ type: 'error', seq: msg.seq, error: payload.error || 'Failed to open media' })
      return
    }
    const wcSupported = await setupWebCodecsIfPossible(payload.webCodecs)
    self.postMessage({
      type: 'manifest',
      seq: msg.seq,
      manifest: payload,
      byteLength: streamLen,
      streamBlock: STREAM_BLOCK,
      webCodecsSupported: wcSupported
    })
  } else if (msg.cmd === 'start') {
    if (msg.seq && msg.seq < latestQueuedSeq) return
    activeSeq = msg.seq || activeSeq
    hasVideo = msg.videoStream >= 0
    hasAudio = msg.audioStream >= 0
    useMse = Boolean(msg.useMse)
    const startAt = Math.max(0, Number(msg.time) || 0)
    resetWebCodecsGops()
    closeWebCodecs()
    useWebCodecs = !useMse && hasVideo && Boolean(msg.allowWebCodecs) && openWebCodecsInstance(activeSeq, startAt)
    streamingMode = true
    lastPostedBlock = -1
    lastMseSegEnd = startAt
    clockMedia = startAt
    clockWallMs = nowWall()
    clockPlaying = false
    streamCrop = null
    streamCropCandidate = null
    streamCropSame = 0
    streamCropFrames = 0
    queuedVideoSec = 0
    queuedAudioSec = 0
    lastCreditAt = nowWall()
    lastVideoPts = null
    eof = false
    const modeInt = useMse ? ABI.mode.mse : (useWebCodecs ? ABI.mode.webcodecs : ABI.mode.software)
    const rc = wasm.pt_configure(msg.videoStream, msg.audioStream, msg.subStream, modeInt)
    if (rc < 0) {
      self.postMessage({ type: 'error', seq: activeSeq, error: readJson().error || 'Configure failed' })
      return
    }
    if (startAt > 0) wasm.pt_seek(startAt)
    configured = true
    wasm.pt_set_clock?.(startAt)
    wasm.pt_set_hidden?.((pageHidden && !useWebCodecs && !useMse) ? 1 : 0)
    schedulePump(0)
    armWatchdog()
  } else if (msg.cmd === 'seek') {
    // Coalesce scrub storms: skip obsolete seeks queued behind an earlier blocking Range read.
    if (msg.seq && msg.seq < latestQueuedSeq) return
    activeSeq = msg.seq
    hasVideo = msg.videoStream >= 0
    hasAudio = msg.audioStream >= 0
    useMse = Boolean(msg.useMse)
    abortHiddenPrefetch()
    resetWebCodecsGops()
    closeWebCodecs()
    const target = Math.max(0, Number(msg.time) || 0)
    useWebCodecs = !useMse && hasVideo && Boolean(msg.allowWebCodecs) && openWebCodecsInstance(activeSeq, target)
    streamingMode = true
    lastPostedBlock = -1
    lastMseSegEnd = target
    clockMedia = target
    clockWallMs = nowWall()
    clockPlaying = false
    streamCrop = null
    streamCropCandidate = null
    streamCropSame = 0
    streamCropFrames = 0
    queuedVideoSec = 0
    queuedAudioSec = 0
    lastCreditAt = nowWall()
    lastVideoPts = null
    eof = false
    const modeInt = useMse ? ABI.mode.mse : (useWebCodecs ? ABI.mode.webcodecs : ABI.mode.software)
    const rc = wasm.pt_configure(msg.videoStream, msg.audioStream, msg.subStream, modeInt)
    if (rc < 0) {
      self.postMessage({ type: 'error', seq: activeSeq, error: readJson().error || 'Seek configure failed' })
      return
    }
    wasm.pt_seek(target)
    configured = true
    wasm.pt_set_clock?.(target)
    wasm.pt_set_hidden?.((pageHidden && !useWebCodecs && !useMse) ? 1 : 0)
    self.postMessage({ type: 'flushed', seq: activeSeq, time: target })
    schedulePump(0)
    armWatchdog()
  } else if (msg.cmd === 'clock') {
    if (typeof msg.time === 'number') clockMedia = Math.max(0, msg.time)
    clockWallMs = typeof msg.wallMs === 'number' ? msg.wallMs : nowWall()
    clockPlaying = Boolean(msg.playing)
    lastCreditAt = nowWall()
    if (wasm) wasm.pt_set_clock?.(workerMediaTime())
    if (typeof msg.hidden === 'boolean') setPageHidden(msg.hidden)
    if (!eof && !bufferedAhead()) schedulePump(0)
    if (clockPlaying) armWatchdog()
  } else if (msg.cmd === 'consumed') {
    if (!useMse) {
      queuedVideoSec = Math.max(0, queuedVideoSec - (Number(msg.videoSec) || 0))
    }
    queuedAudioSec = Math.max(0, queuedAudioSec - (Number(msg.audioSec) || 0))
    if (typeof msg.time === 'number') clockMedia = Math.max(0, msg.time)
    clockWallMs = typeof msg.wallMs === 'number' ? msg.wallMs : nowWall()
    if (typeof msg.playing === 'boolean') clockPlaying = msg.playing
    lastCreditAt = nowWall()
    if (wasm) wasm.pt_set_clock?.(workerMediaTime())
    if (typeof msg.hidden === 'boolean') setPageHidden(msg.hidden)
    if (!eof && !bufferedAhead()) schedulePump(0)
    if (clockPlaying) armWatchdog()
  } else if (msg.cmd === 'mem') {
    self.postMessage({ type: 'mem', wasm: wasm && wasm.memory ? wasm.memory.buffer.byteLength : 0, blocks: blockCache.size, renderQ: 0, videoPool: freeVideoPool.length, audioPool: freeAudioPool.length, pageHidden })
  } else if (msg.cmd === 'block') {
    if (msg.buf && msg.buf.byteLength > 0) putBlock(Number(msg.block) || 0, new Uint8Array(msg.buf))
  } else if (msg.cmd === 'close') {
    if (watchdog !== null) { clearTimeout(watchdog); watchdog = null }
    abortHiddenPrefetch()
    closed = true
    eof = true
    clockPlaying = false
    streamingMode = false
    pageHidden = false
    lastPostedBlock = -1
    lastMseSegEnd = 0
    closeWebCodecs()
    blockCache.clear()
    if (wasm) wasm.pt_close()
  }
}

let cmdChain = Promise.resolve()
self.onmessage = ev => {
  const msg = ev.data || {}
  if ((msg.cmd === 'open' || msg.cmd === 'start' || msg.cmd === 'seek') && msg.seq) {
    if (msg.seq > latestQueuedSeq) latestQueuedSeq = msg.seq
  }
  // Fast lock-free buffer & GPU surface recycling bypasses the async command queue
  if (msg.cmd === 'releaseHwFrame') {
    if (msg.seq === activeSeq) wcInFlight = Math.max(0, wcInFlight - 1)
    feedWebCodecs()
    if (configured && !closed && !eof && !bufferedAhead()) schedulePump(0)
    return
  }
  if (msg.cmd === 'recycleVideo') {
    recyclePool(freeVideoPool, msg.buf, 24)
    return
  }
  if (msg.cmd === 'recycleAudio') {
    recyclePool(freeAudioPool, msg.buf, 32)
    return
  }
  if (msg.cmd === 'block') {
    if (msg.buf && msg.buf.byteLength > 0) putBlock(Number(msg.block) || 0, new Uint8Array(msg.buf))
    return
  }
  if (msg.cmd === 'consumed' && configured && !closed) {
    if (!useMse) {
      queuedVideoSec = Math.max(0, queuedVideoSec - (Number(msg.videoSec) || 0))
    }
    queuedAudioSec = Math.max(0, queuedAudioSec - (Number(msg.audioSec) || 0))
    if (typeof msg.time === 'number') clockMedia = Math.max(0, msg.time)
    clockWallMs = typeof msg.wallMs === 'number' ? msg.wallMs : nowWall()
    if (typeof msg.playing === 'boolean') clockPlaying = msg.playing
    lastCreditAt = nowWall()
    if (wasm) wasm.pt_set_clock?.(workerMediaTime())
    if (typeof msg.hidden === 'boolean') setPageHidden(msg.hidden)
    if (!eof && !bufferedAhead()) schedulePump(0)
    if (clockPlaying) armWatchdog()
    return
  }
  if (msg.cmd === 'clock' && configured && !closed) {
    if (typeof msg.time === 'number') clockMedia = Math.max(0, msg.time)
    clockWallMs = typeof msg.wallMs === 'number' ? msg.wallMs : nowWall()
    clockPlaying = Boolean(msg.playing)
    lastCreditAt = nowWall()
    if (wasm) wasm.pt_set_clock?.(workerMediaTime())
    if (typeof msg.hidden === 'boolean') setPageHidden(msg.hidden)
    if (!eof && !bufferedAhead()) schedulePump(0)
    if (clockPlaying) armWatchdog()
    return
  }
  cmdChain = cmdChain.then(() => handleCmd(msg)).catch(err => {
    self.postMessage({ type: 'error', seq: activeSeq, error: err?.message || String(err) })
  })
}
