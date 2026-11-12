// Dedicated Web Worker driving peartube-media's SIMD128 Rust/OxideAV WebAssembly engine:
//   - The page fetches 2 MiB blocks ahead into a 64 MiB ring; only an uncached read falls back to sync XHR
//   - Zero-allocation OffscreenCanvas WebGL2/WebGL1 YUV420 + RGBA + WebCodecs GPU renderer inside the Worker
//   - Recycled Transferable ArrayBuffer pools for zero steady-state GC churn
let wasm = null
let wasmReady = null
let streamUrl = ''
let streamLen = 0
let streamingMode = false
let watchdog = null
let hasVideo = false
let hasAudio = false
let useMse = false
let useWebCodecs = false
let wcConfig = null
let wcDecoder = null
let wcMinPts = 0
let wcPacketQueue = []
let wcQueuedSpanSec = 0
let wcInFlight = 0
let wcFlushAtDrain = false
// Pictures the decoder may hold in flight. Ten ran dry when the worker paused even briefly
// (a letterbox readback, a queue drain), and late pictures reach the page as drops; sixteen
// rides out a stall of a few hundred milliseconds at 24 fps.
const MAX_WC_ACTIVE = 16
let latestQueuedSeq = 0
let eof = false
let pumping = false
let closed = true
let configured = false
let activeSeq = 0

// Speaker-locked monotonic clock interpolated smoothly at Worker VSync rate
let clockPlaying = false
let pageHidden = false
let ABI = null

let cropProbe = null
const freeVideoPool = []
const freeAudioPool = []

// 2 MiB block cache bytes, head probe, partial sync window, LRU eviction, and read-ahead yield
// are owned inside WASM linear memory by Rust's `StreamCache` (`pt_cache_*` in `web/src/controller.rs`).
const STREAM_BLOCK = 2 * 1024 * 1024
const hiddenPrefetchInFlight = new Map()
function abortHiddenPrefetch () {
  for (const ctl of hiddenPrefetchInFlight.values()) { try { ctl.abort() } catch {} }
  hiddenPrefetchInFlight.clear()
  wasm?.pt_cache_hidden_clear?.()
}

// While the page is hidden or occluded, Chromium throttles main-thread timers and fetch callbacks;
// this Dedicated Worker stays unthrottled while audio plays and pulls 2 MiB blocks straight into blockCache.
function pumpHiddenPrefetch () {
  if (!pageHidden || closed || eof || !streamingMode || !streamUrl || streamLen <= 0 || !wasm?.pt_cache_next_hidden_block) return
  while (hiddenPrefetchInFlight.size < 4) {
    const idx = wasm.pt_cache_next_hidden_block(BigInt(streamLen)) | 0
    if (idx < 0) break
    const start = idx * STREAM_BLOCK
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
        wasm?.pt_cache_hidden_done?.(idx >>> 0)
        if (!ab || closed || seq !== activeSeq) return
        storeBlockInRust(idx, new Uint8Array(ab))
        if (pageHidden) pumpHiddenPrefetch()
      })
      .catch(() => {
        clearTimeout(killTimer)
        hiddenPrefetchInFlight.delete(idx)
        wasm?.pt_cache_hidden_done?.(idx >>> 0)
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
  return wasm && wasm.pt_ctrl_media_time ? wasm.pt_ctrl_media_time(nowWall()) : 0
}

function storeBlockInRust (idx, u8) {
  if (!wasm || !wasm.pt_cache_put_block || !u8 || u8.byteLength === 0) return
  const ptr = wasm.pt_alloc(u8.byteLength) >>> 0
  if (!ptr) return
  new Uint8Array(wasm.memory.buffer, ptr, u8.byteLength).set(u8)
  wasm.pt_cache_put_block(idx >>> 0, ptr, u8.byteLength)
  wasm.pt_free(ptr, u8.byteLength)
}

function storeHeadInRust (u8) {
  if (!wasm || !wasm.pt_cache_put_head || !u8 || u8.byteLength === 0) return
  const ptr = wasm.pt_alloc(u8.byteLength) >>> 0
  if (!ptr) return
  new Uint8Array(wasm.memory.buffer, ptr, u8.byteLength).set(u8)
  wasm.pt_cache_put_head(ptr, u8.byteLength)
  wasm.pt_free(ptr, u8.byteLength)
}

function storePartialInRust (start, u8) {
  if (!wasm || !wasm.pt_cache_set_partial || !u8 || u8.byteLength === 0) return
  const ptr = wasm.pt_alloc(u8.byteLength) >>> 0
  if (!ptr) return
  new Uint8Array(wasm.memory.buffer, ptr, u8.byteLength).set(u8)
  wasm.pt_cache_set_partial(BigInt(start), ptr, u8.byteLength)
  wasm.pt_free(ptr, u8.byteLength)
}

async function probeStream (url) {
  wasm?.pt_cache_clear_all?.()
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
  wasm?.pt_cache_clear_all?.()
  if (buf.byteLength > 0) storeHeadInRust(buf)
}
function postReadBlock (bIdx, force) {
  if (wasm && wasm.pt_ctrl_prefetch_plan) {
    const packed = BigInt(wasm.pt_ctrl_prefetch_plan(bIdx >>> 0, BigInt(streamLen), STREAM_BLOCK))
    const endBlock = Number((packed >> 32n) & 0xffffffffn)
    const evictBefore = Number(packed & 0xffffffffn)
    const maxInFlight = ABI?.limits?.prefetchInFlight || 6
    self.postMessage({
      type: 'readBlock',
      block: bIdx >>> 0,
      endBlock,
      evictBefore,
      maxInFlight,
      force
    })
  } else {
    self.postMessage({ type: 'readBlock', block: bIdx, force })
  }
}
function flushCacheReadReq () {
  if (!wasm || !wasm.pt_cache_take_read_req) return
  const req = wasm.pt_cache_take_read_req() >>> 0
  if (req & 1) {
    const force = (req & 2) !== 0
    const bIdx = req >>> 2
    if (pageHidden) pumpHiddenPrefetch()
    else postReadBlock(bIdx, force)
  }
}
function readAtSync (offset, dstPtr, len) {
  if (offset >= streamLen || len === 0) return 0
  flushCacheReadReq()
  const maxLen = Math.min(len, streamLen - offset)
  const bIdx = Math.floor(offset / STREAM_BLOCK)
  const bOff = offset - bIdx * STREAM_BLOCK

  // Inside a synchronous pt_seek/pt_step call, main-thread block messages sit queued until WASM
  // yields. Fetch the full 2 MiB block when streaming starts near the block head (cached once in
  // blockCache), or a forward 512 KiB window cached in partialSync so sequential 64 KiB demux
  // reads never re-download [0..bOff] quadratically.
  const blockStart = bIdx * STREAM_BLOCK
  const blockEnd = Math.min(streamLen, blockStart + STREAM_BLOCK)
  const wantFullBlock = streamingMode && bOff <= 262144
  const fetchStart = wantFullBlock ? blockStart : offset
  const span = streamingMode
    ? (blockEnd - fetchStart)
    : Math.min(Math.max(524288, maxLen), streamLen - offset)
  const fetchEnd = Math.min(streamLen - 1, fetchStart + span - 1)
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
      if (fetchStart === blockStart && src.byteLength >= Math.min(STREAM_BLOCK, streamLen - blockStart)) {
        storeBlockInRust(bIdx, src)
      } else {
        storePartialInRust(fetchStart, src)
      }
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


function probeCropInRust (u8, sw, sh, w, h, rgba) {
  if (!wasm || !wasm.pt_ctrl_probe_crop || !u8 || u8.byteLength === 0) return
  const ptr = wasm.pt_alloc(u8.byteLength) >>> 0
  if (!ptr) return
  new Uint8Array(wasm.memory.buffer, ptr, u8.byteLength).set(u8)
  const changed = wasm.pt_ctrl_probe_crop(ptr, u8.byteLength, sw >>> 0, sh >>> 0, w >>> 0, h >>> 0, rgba ? 1 : 0)
  wasm.pt_free(ptr, u8.byteLength)
  if (changed > 0) {
    self.postMessage({
      type: 'videoCrop',
      seq: activeSeq,
      left: wasm.pt_out_x() | 0,
      top: wasm.pt_out_y() | 0,
      right: wasm.pt_out_w() >>> 0,
      bottom: wasm.pt_out_h() >>> 0,
      full: (wasm.pt_out_cw() >>> 0) !== 0,
      w,
      h
    })
  }
}

function sampleVideoFrame (vf, w, h) {
  if (w > 4096 || h > 2304 || typeof OffscreenCanvas !== 'function') return
  const sw = w >= 1280 ? 160 : 320
  const sh = Math.max(1, Math.round(h * sw / w))
  if (!cropProbe || cropProbe.canvas.width !== sw || cropProbe.canvas.height !== sh) {
    const canvas = new OffscreenCanvas(sw, sh)
    const ctx = w >= 1280
      ? canvas.getContext('2d')
      : canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return
    cropProbe = { canvas, ctx }
  }
  try {
    cropProbe.ctx.drawImage(vf, 0, 0, sw, sh)
    probeCropInRust(cropProbe.ctx.getImageData(0, 0, sw, sh).data, sw, sh, w, h, true)
  } catch {}
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
  const baseCfg = {
    codec: hint.codec,
    codedWidth: hint.width,
    codedHeight: hint.height
  }
  if (hint.descriptionHex && hint.descriptionHex.length >= 2) {
    const bytes = new Uint8Array(hint.descriptionHex.length >> 1)
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Number.parseInt(hint.descriptionHex.slice(i * 2 + 0, i * 2 + 2), 16)
    }
    baseCfg.description = bytes
  }
  const candidates = hint.colorSpace ? [{ ...baseCfg, colorSpace: hint.colorSpace }, baseCfg] : [baseCfg]
  for (const cfg of candidates) {
    try {
      const sup = await self.VideoDecoder.isConfigSupported(cfg)
      if (sup && sup.supported) {
        wcConfig = sup.config || cfg
        return true
      }
    } catch {}
  }
  return false
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
        wasm?.pt_ctrl_on_video_frame?.(pts)
        wcInFlight++
        const w = vf.displayWidth || vf.codedWidth || 0
        const h = vf.displayHeight || vf.codedHeight || 0
        if (w > 0 && h > 0 && wasm?.pt_ctrl_crop_due?.(w >>> 0)) {
          sampleVideoFrame(vf, w, h)
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
    wasm?.pt_set_hidden?.(1)
    pumpHiddenPrefetch()
  } else {
    const lastBlk = wasm?.pt_cache_last_posted_block ? (wasm.pt_cache_last_posted_block() | 0) : -1
    if (streamingMode && lastBlk >= 0) {
      postReadBlock(lastBlk, false)
    }
    const now = workerMediaTime()
    wasm?.pt_set_clock?.(now)
    if (useWebCodecs) openWebCodecsInstance(activeSeq, now)
    wasm?.pt_set_hidden?.(0)
  }
}

function bufferedAhead () {
  if (!wasm || !wasm.pt_ctrl_buffered_ahead) return false
  return Boolean(wasm.pt_ctrl_buffered_ahead(nowWall(), wcQueuedSpanSec, wcInFlight))
}

// Yield briefly to the Worker event loop when nearing an uncached 2 MiB boundary so main-thread
// async fetch() blocks already in flight land via postMessage instead of triggering duplicate sync XHRs.
function shouldYieldForNextBlock () {
  if (!wasm || !wasm.pt_cache_should_yield) return false
  const flags = wasm.pt_cache_should_yield(streamingMode ? 1 : 0, pageHidden ? 1 : 0, BigInt(streamLen), performance.now()) >>> 0
  if (flags & 2) postReadBlock(flags >>> 2, false)
  return (flags & 1) !== 0
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
  if (shouldYieldForNextBlock()) {
    schedulePump(12)
    armWatchdog()
    return
  }

  const seq = activeSeq
  const tStart = performance.now()
  const maxSliceMs = 16
  for (let i = 0; i < 96; i++) {
    if (closed || seq !== activeSeq) return
    if (i > 0 && shouldYieldForNextBlock()) {
      schedulePump(12)
      armWatchdog()
      return
    }
    if (clockPlaying) wasm.pt_set_clock?.(workerMediaTime())
    const code = wasm.pt_step()
    flushCacheReadReq()
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
      const keyMs = wasm.pt_out_w() >>> 0
      const keyPts = keyMs !== 0xffffffff ? (keyMs / 1000) : null
      const maxEvictCap = wasm.pt_ctrl_max_evict_cap ? wasm.pt_ctrl_max_evict_cap(end, 1.5) : 0
      self.postMessage({ type: 'mseSeg', seq, start, end, keyPts, maxEvictCap, buf: exact }, [exact])
    } else if (code === ABI.step.videoPacket) {
      if (useWebCodecs && !pageHidden) {
        const ptr = wasm.pt_out_ptr() >>> 0
        const len = wasm.pt_out_len() >>> 0
        const pts = wasm.pt_out_pts()
        const dur = Math.max(0.008, Math.min(0.25, wasm.pt_out_dur() || (1 / 24)))
        const isKey = (wasm.pt_out_w() >>> 0) !== 0
        const copy = new Uint8Array(len)
        if (len > 0) copy.set(new Uint8Array(wasm.memory.buffer, ptr, len))
        const pkt = { isKey, pts, dur, counted: pts + 0.025 >= wcMinPts, data: copy }
        wcPacketQueue.push(pkt)
        if (pkt.counted) wcQueuedSpanSec += dur
        feedWebCodecs()
      }
    } else if (code === ABI.step.videoRgba || code === ABI.step.videoYuv420) {
      const pts = wasm.pt_out_pts()
      const w = wasm.pt_out_w() >>> 0
      const h = wasm.pt_out_h() >>> 0
      const isYuv = code === ABI.step.videoYuv420
      const matrix = isYuv ? (wasm.pt_out_x() | 0) : 0
      const full = isYuv ? (wasm.pt_out_y() | 0) !== 0 : false
      const { ab, len } = copyPooledBuf(freeVideoPool)
      if (isYuv && w > 0 && h > 0 && wasm?.pt_ctrl_crop_due?.(w >>> 0)) {
        probeCropInRust(new Uint8Array(ab, 0, Math.min(len, w * h)), w, h, w, h, false)
      }
      self.postMessage({ type: 'videoFrame', seq, pts, w, h, yuv: isYuv, matrix, full, buf: ab, byteLen: len }, [ab])
    } else if (code === ABI.step.audioPlanarF32) {
      const { ab, len } = copyPooledBuf(freeAudioPool)
      const pts = wasm.pt_out_pts()
      const rate = wasm.pt_out_rate() >>> 0
      const samples = wasm.pt_out_samples() >>> 0
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
    self.postMessage({ type: 'warm', streamBlock: STREAM_BLOCK, limits: ABI?.limits })
  } else if (msg.cmd === 'open') {
    closed = true
    abortHiddenPrefetch()
    closeWebCodecs()
    if (wasm) wasm.pt_close()
    closed = false
    configured = false
    eof = false
    streamingMode = false
    clockPlaying = false
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
    closeWebCodecs()
    useWebCodecs = !useMse && hasVideo && Boolean(msg.allowWebCodecs) && openWebCodecsInstance(activeSeq, startAt)
    streamingMode = true
    wasm.pt_cache_reset_stream?.()
    clockPlaying = false
    eof = false
    const modeInt = useMse ? ABI.mode.mse : (useWebCodecs ? ABI.mode.webcodecs : ABI.mode.software)
    const rc = wasm.pt_configure(msg.videoStream, msg.audioStream, msg.subStream, modeInt)
    if (rc < 0) {
      self.postMessage({ type: 'error', seq: activeSeq, error: readJson().error || 'Configure failed' })
      return
    }
    if (startAt > 0) { wasm.pt_seek(startAt); flushCacheReadReq() }
    configured = true
    wasm.pt_set_clock?.(startAt)
    wasm.pt_set_hidden?.((pageHidden && !useMse) ? 1 : 0)
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
    closeWebCodecs()
    const target = Math.max(0, Number(msg.time) || 0)
    useWebCodecs = !useMse && hasVideo && Boolean(msg.allowWebCodecs) && openWebCodecsInstance(activeSeq, target)
    streamingMode = true
    wasm.pt_cache_reset_stream?.()
    clockPlaying = false
    eof = false
    const modeInt = useMse ? ABI.mode.mse : (useWebCodecs ? ABI.mode.webcodecs : ABI.mode.software)
    const rc = wasm.pt_configure(msg.videoStream, msg.audioStream, msg.subStream, modeInt)
    if (rc < 0) {
      self.postMessage({ type: 'error', seq: activeSeq, error: readJson().error || 'Seek configure failed' })
      return
    }
    wasm.pt_seek(target)
    flushCacheReadReq()
    configured = true
    wasm.pt_set_clock?.(target)
    wasm.pt_set_hidden?.((pageHidden && !useMse) ? 1 : 0)
    self.postMessage({ type: 'flushed', seq: activeSeq, time: target })
    schedulePump(0)
    armWatchdog()
  } else if (msg.cmd === 'clock' || msg.cmd === 'consumed') {
    applyClock(msg)
  } else if (msg.cmd === 'mem') {
    const stats = wasm?.pt_ctrl_crop_stats ? BigInt(wasm.pt_ctrl_crop_stats()) : 0n
    const cropReadbacks = Number((stats >> 32n) & 0xffffffffn)
    const streamCropSame = Number(stats & 0xffffffffn)
    const blocks = wasm?.pt_cache_block_count ? (wasm.pt_cache_block_count() >>> 0) : 0
    self.postMessage({ type: 'mem', wasm: wasm && wasm.memory ? wasm.memory.buffer.byteLength : 0, blocks, videoPool: freeVideoPool.length, audioPool: freeAudioPool.length, pageHidden, cropReadbacks, streamCropSame })
  } else if (msg.cmd === 'block') {
    if (msg.buf && msg.buf.byteLength > 0) storeBlockInRust(Number(msg.block) || 0, new Uint8Array(msg.buf))
  } else if (msg.cmd === 'close') {
    if (watchdog !== null) { clearTimeout(watchdog); watchdog = null }
    abortHiddenPrefetch()
    closed = true
    eof = true
    clockPlaying = false
    streamingMode = false
    pageHidden = false
    closeWebCodecs()
    wasm?.pt_cache_clear_all?.()
    if (wasm) wasm.pt_close()
  }
}

// The page's clock report: `clock` sets the play state, `consumed` also returns the queue credit it played out.
function applyClock (msg) {
  const isConsumed = msg.cmd === 'consumed'
  const vSec = isConsumed ? (Number(msg.videoSec) || 0) : 0
  const aSec = isConsumed ? (Number(msg.audioSec) || 0) : 0
  if (typeof msg.playing === 'boolean') clockPlaying = msg.playing
  else if (!isConsumed) clockPlaying = Boolean(msg.playing)
  const t = typeof msg.time === 'number' ? Math.max(0, msg.time) : -1
  if (wasm && wasm.pt_ctrl_apply_clock) {
    wasm.pt_ctrl_apply_clock(t, nowWall(), clockPlaying ? 1 : 0, vSec, aSec)
  }
  if (useMse && typeof msg.vt === 'number' && wasm && wasm.pt_ctrl_mse_tick) {
    const rc = wasm.pt_ctrl_mse_tick(
      t >= 0 ? t : workerMediaTime(),
      msg.vt,
      typeof msg.b0 === 'number' ? msg.b0 : -1,
      typeof msg.bEnd === 'number' ? msg.bEnd : -1,
      msg.readyState >>> 0,
      msg.mseStalled ? 1 : 0,
      msg.canHardSync ? 1 : 0,
      Number(msg.duration) || 0,
      msg.rebuffering ? 1 : 0,
      Number(msg.mseBufferedAhead) || 0,
      Number(msg.audioQueuedAhead) || 0,
      eof ? 1 : 0
    )
    if (rc > 0) {
      const evictTo = wasm.pt_out_pts()
      const snapTo = wasm.pt_out_dur()
      const rate = (wasm.pt_out_w() >>> 0) / 1000
      const maxEvictCap = (wasm.pt_out_h() >>> 0) / 1000
      const exitRebuffer = (wasm.pt_out_x() | 0) !== 0
      self.postMessage({ type: 'mseCtrl', seq: activeSeq, evictTo, snapTo, rate, maxEvictCap, exitRebuffer })
    }
  }
  if (msg.returnSync && wasm && wasm.pt_ctrl_return_sync) {
    const target = t >= 0 ? t : workerMediaTime()
    const mode = wasm.pt_ctrl_return_sync(
      useMse ? 1 : 0,
      msg.wasHidden ? 1 : 0,
      msg.isAvi ? 1 : 0,
      target,
      typeof msg.vt === 'number' ? msg.vt : 0,
      Number(msg.mseBufferedAtAudio) || 0,
      msg.sbUpdating ? 1 : 0
    ) >>> 0
    self.postMessage({ type: 'returnCtrl', seq: activeSeq, mode, target })
  }
  if (typeof msg.hidden === 'boolean') setPageHidden(msg.hidden)
  if (!eof && !bufferedAhead()) schedulePump(0)
  if (clockPlaying) armWatchdog()
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
  if (msg.cmd === 'evictCut' && wasm && wasm.pt_ctrl_evict_cut) {
    const cut = wasm.pt_ctrl_evict_cut(Number(msg.now) || 0, Number(msg.keepBehind) || 1.5, Number(msg.b0) || 0, Number(msg.bEnd) || 0)
    const maxEvictCap = wasm.pt_ctrl_max_evict_cap ? wasm.pt_ctrl_max_evict_cap(Number(msg.now) || 0, Number(msg.keepBehind) || 1.5) : 0
    self.postMessage({ type: 'mseCtrl', seq: activeSeq, evictTo: cut, snapTo: -1, rate: 1, maxEvictCap, exitRebuffer: false })
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
    if (!closed && msg.buf && msg.buf.byteLength > 0) storeBlockInRust(Number(msg.block) || 0, new Uint8Array(msg.buf))
    if (configured && !closed && !eof && !bufferedAhead()) schedulePump(0)
    return
  }
  if ((msg.cmd === 'consumed' || msg.cmd === 'clock') && configured && !closed) {
    applyClock(msg)
    return
  }
  cmdChain = cmdChain.then(() => handleCmd(msg)).catch(err => {
    self.postMessage({ type: 'error', seq: activeSeq, error: err?.message || String(err) })
  })
}
