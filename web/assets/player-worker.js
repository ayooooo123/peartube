// Dedicated Web Worker driving peartube-media's SIMD128 Rust/OxideAV WebAssembly engine:
//   - The page fetches 2 MiB blocks ahead and posts them into a 64 MiB ring; a wasm read never blocks on sync XHR
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
let lastDrawAt = 0
let watchdog = null
let lastVideoPts = null
let hasVideo = false
let hasAudio = false
let useMse = false
let useWebCodecs = false
let wcConfig = null
let wcDecoder = null
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

// OffscreenCanvas WebGL renderer + zero-GC recycled buffer pools
let offRenderer = null
let renderQueue = []
let renderLoopActive = false
let drawnInSession = 0
let streamCropDone = false
let streamCropCandidate = null
let streamCropSame = 0
const freeVideoPool = []
const freeAudioPool = []

// The page owns read-ahead: it fetches 2 MiB ranges with fetch() and posts them here, because this
// Worker's event loop is blocked inside a wasm read, so its own async fetches settled too late and
// every miss fell through to a blocking sync XHR that froze the frame clock for seconds. The ring
// keeps 64 MiB so the demuxer's sequential pages hit long after the page fetched them.
const STREAM_BLOCK = 2 * 1024 * 1024
const MAX_BLOCKS = 32
const blockCache = new Map()
let blockStamp = 0
let headProbe = null

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
    let oldestKey = null
    let oldestStamp = Infinity
    for (const [k, v] of blockCache) {
      if (v.stamp < oldestStamp) { oldestStamp = v.stamp; oldestKey = k }
    }
    if (oldestKey !== null) blockCache.delete(oldestKey)
  }
  blockCache.set(idx, { data, stamp: blockStamp })
}

function probeStream (url) {
  blockCache.clear()
  headProbe = null
  const xhr = new XMLHttpRequest()
  xhr.open('GET', url, false)
  xhr.timeout = 5000
  xhr.responseType = 'arraybuffer'
  xhr.setRequestHeader('Range', 'bytes=0-' + (STREAM_BLOCK - 1))
  xhr.send()
  if (xhr.status !== 200 && xhr.status !== 206) {
    throw new Error('Stream HTTP ' + xhr.status)
  }
  const buf = new Uint8Array(xhr.response || new ArrayBuffer(0))
  const cr = xhr.getResponseHeader('Content-Range') || ''
  const slash = cr.lastIndexOf('/')
  if (slash !== -1) {
    const total = Number(cr.slice(slash + 1).trim())
    streamLen = total > 0 ? total : buf.byteLength
  } else {
    const cl = Number(xhr.getResponseHeader('Content-Length') || 0)
    streamLen = cl > 0 ? cl : buf.byteLength
  }
  headProbe = buf
  if (buf.byteLength > 0) putBlock(0, buf)
}

function readAtSync (offset, dstPtr, len) {
  if (offset >= streamLen || len === 0) return 0
  const maxLen = Math.min(len, streamLen - offset)
  if (headProbe && offset + maxLen <= headProbe.byteLength) {
    new Uint8Array(wasm.memory.buffer, dstPtr, maxLen).set(headProbe.subarray(offset, offset + maxLen))
    return maxLen
  }

  const bIdx = Math.floor(offset / STREAM_BLOCK)
  // The page's fetch() is reliable where the Worker's can hang; tell it which block the demuxer is
  // on and let it fill the cache ahead. One message per block, not per 256 KiB page.
  if (bIdx !== lastPostedBlock) {
    lastPostedBlock = bIdx
    self.postMessage({ type: 'readBlock', block: bIdx, force: true })
  }
  const bOff = offset - bIdx * STREAM_BLOCK
  const cached = blockCache.get(bIdx)
  if (cached && bOff < cached.data.byteLength) {
    cached.stamp = ++blockStamp
    const take = Math.min(maxLen, cached.data.byteLength - bOff)
    new Uint8Array(wasm.memory.buffer, dstPtr, take).set(cached.data.subarray(bOff, bOff + take))
    return take
  }

  const fetchStart = bIdx * STREAM_BLOCK
  const fetchEnd = Math.min(streamLen - 1, fetchStart + STREAM_BLOCK - 1)

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const xhr = new XMLHttpRequest()
      xhr.open('GET', streamUrl, false)
      // This blocks the Worker's event loop, so it must never own the frame clock for long: the page
      // prefetch is what feeds the cache; this is a short-leashed last resort, not a read-ahead.
      xhr.timeout = 2500
      xhr.responseType = 'arraybuffer'
      xhr.setRequestHeader('Range', 'bytes=' + fetchStart + '-' + fetchEnd)
      xhr.send()
      if (xhr.status !== 200 && xhr.status !== 206) continue
      const src = new Uint8Array(xhr.response || new ArrayBuffer(0))
      if (src.byteLength === 0) continue
      putBlock(bIdx, src)
      const offInSrc = offset - fetchStart
      if (offInSrc >= src.byteLength) return -1
      const take = Math.min(maxLen, src.byteLength - offInSrc)
      new Uint8Array(wasm.memory.buffer, dstPtr, take).set(src.subarray(offInSrc, offInSrc + take))
      return take
    } catch {}
  }
  return -1
}

// SRI hash of web/assets/peartube_web.wasm; regenerate (openssl dgst -sha384 -binary <wasm> | openssl base64 -A)
// and update this constant whenever `sh web/build.sh` produces a new binary.
const WASM_SRI = 'sha384-CjCopec5iYvL1ueeJ4LVGbAjkZZRd6Ic4D7n0xnvRYFwKsmFwKvxxvHBsI+JnJfg'

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
        inst = (await WebAssembly.instantiateStreaming(fetch(wasmUrl, { integrity: WASM_SRI }), imports)).instance
      } catch {}
    }
    if (!inst) {
      const bytes = await fetch(wasmUrl, { integrity: WASM_SRI }).then(r => r.arrayBuffer())
      inst = (await WebAssembly.instantiate(bytes, imports)).instance
    }
    wasm = inst.exports
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

// Dual-mode WebGL2/WebGL1 OffscreenCanvas renderer inside the Worker:
// mode 0 = planar YUV420P (R8 in WebGL2 / LUMINANCE in WebGL1), mode 1 = RGBA or zero-copy WebCodecs VideoFrame.
function initOffscreenRenderer (canvas) {
  const opts = { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'high-performance', desynchronized: true }
  const gl2 = canvas.getContext('webgl2', opts)
  const gl = gl2 || canvas.getContext('webgl', opts)
  if (!gl) return null
  const isGl2 = Boolean(gl2)
  const vsSrc = isGl2
    ? '#version 300 es\nin vec2 a_pos;out vec2 v_uv;uniform vec4 u_crop;void main(){vec2 uv=vec2(a_pos.x*0.5+0.5,0.5-a_pos.y*0.5);v_uv=mix(u_crop.xy,u_crop.zw,uv);gl_Position=vec4(a_pos,0.0,1.0);}'
    : 'attribute vec2 a_pos;varying vec2 v_uv;uniform vec4 u_crop;void main(){vec2 uv=vec2(a_pos.x*0.5+0.5,0.5-a_pos.y*0.5);v_uv=mix(u_crop.xy,u_crop.zw,uv);gl_Position=vec4(a_pos,0.0,1.0);}'
  const fsSrc = isGl2
    ? '#version 300 es\nprecision mediump float;in vec2 v_uv;out vec4 outColor;uniform int u_mode;uniform sampler2D u_y;uniform sampler2D u_u;uniform sampler2D u_v;void main(){if(u_mode==1){outColor=vec4(texture(u_y,v_uv).rgb,1.0);return;}float y=(texture(u_y,v_uv).r-0.062745)*1.164384;float u=texture(u_u,v_uv).r-0.5;float v=texture(u_v,v_uv).r-0.5;outColor=vec4(y+1.792741*v,y-0.213249*u-0.532909*v,y+2.112402*u,1.0);}'
    : 'precision mediump float;varying vec2 v_uv;uniform int u_mode;uniform sampler2D u_y;uniform sampler2D u_u;uniform sampler2D u_v;void main(){if(u_mode==1){gl_FragColor=vec4(texture2D(u_y,v_uv).rgb,1.0);return;}float y=(texture2D(u_y,v_uv).r-0.062745)*1.164384;float u=texture2D(u_u,v_uv).r-0.5;float v=texture2D(u_v,v_uv).r-0.5;gl_FragColor=vec4(y+1.792741*v,y-0.213249*u-0.532909*v,y+2.112402*u,1.0);}'

  const vs = gl.createShader(gl.VERTEX_SHADER)
  gl.shaderSource(vs, vsSrc); gl.compileShader(vs)
  const fs = gl.createShader(gl.FRAGMENT_SHADER)
  gl.shaderSource(fs, fsSrc); gl.compileShader(fs)
  const prog = gl.createProgram()
  gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null
  gl.useProgram(prog)

  const quad = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, quad)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  const loc = gl.getAttribLocation(prog, 'a_pos')
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)

  const mkTex = unit => {
    gl.activeTexture(gl.TEXTURE0 + unit)
    const t = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texParameteri(gl.TEXTURE_2D, gl.LINEAR ? gl.TEXTURE_MIN_FILTER : 0x2801, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return t
  }
  const texY = mkTex(0), texU = mkTex(1), texV = mkTex(2)
  gl.uniform1i(gl.getUniformLocation(prog, 'u_y'), 0)
  gl.uniform1i(gl.getUniformLocation(prog, 'u_u'), 1)
  gl.uniform1i(gl.getUniformLocation(prog, 'u_v'), 2)
  const modeLoc = gl.getUniformLocation(prog, 'u_mode')
  const cropLoc = gl.getUniformLocation(prog, 'u_crop')
  gl.uniform4f(cropLoc, 0, 0, 1, 1)
  return { gl, isGl2, canvas, texY, texU, texV, modeLoc, cropLoc, crop: [0, 0, 1, 1], cropPx: null, cropTries: 0, cropDone: false, w: 0, h: 0, mode: -1 }
}

// Encoded letterbox: a 16:9 frame can carry a 2.39 picture with black rows baked in, and then the
// stage's own contain adds side bars too (black on all four sides). Find the active rectangle on
// the first bright software frame and let the shader sample only that, so the picture fills the
// width. Rows count as bars only when every sampled pixel there is black; dark scenes are skipped.
function detectLetterbox (u8, w, h) {
  let sum = 0, n = 0
  for (let y = 0; y < h; y += 16) for (let x = 0; x < w; x += 16) { sum += u8[y * w + x]; n++ }
  if (n === 0 || sum / n < 25) return null
  const blackRow = y => { for (let x = 0; x < w; x += 8) if (u8[y * w + x] > 24) return false; return true }
  let top = 0
  while (top < h && blackRow(top)) top++
  let bottom = h - 1
  while (bottom > top && blackRow(bottom)) bottom--
  if (bottom - top + 1 < h * 0.5) return null
  const blackCol = x => { for (let y = top; y <= bottom; y += 8) if (u8[y * w + x] > 24) return false; return true }
  let left = 0
  while (left < w && blackCol(left)) left++
  let right = w - 1
  while (right > left && blackCol(right)) right--
  // Letterbox only: the active picture spans the full width, so a narrow bright object on black
  // (a studio logo) is not mistaken for the picture, and side pillars are left alone.
  if (right - left + 1 < w * 0.95) return null
  if (top < 2 && h - 1 - bottom < 2 && left < 2 && w - 1 - right < 2) {
    return { left: 0, top: 0, right: w, bottom: h, full: true }
  }
  return { left, top, right: right + 1, bottom: bottom + 1 }
}

function applyCrop (r, c) {
  const { gl } = r
  r.crop = [c.left / r.w, c.top / r.h, c.right / r.w, c.bottom / r.h]
  r.cropPx = c
  r.canvas.width = c.right - c.left
  r.canvas.height = c.bottom - c.top
  gl.viewport(0, 0, r.canvas.width, r.canvas.height)
  gl.uniform4f(r.cropLoc, r.crop[0], r.crop[1], r.crop[2], r.crop[3])
}

function drawOnWorkerGl (item) {
  const r = offRenderer
  if (!r) return
  const tDraw = performance.now()
  const { gl, isGl2 } = r
  if (item.hwFrame) {
    const vf = item.hwFrame
    const fw = vf.displayWidth || vf.codedWidth || 0
    const fh = vf.displayHeight || vf.codedHeight || 0
    if (fw > 0 && fh > 0 && (r.w !== fw || r.h !== fh)) {
      r.w = fw; r.h = fh
      r.canvas.width = fw; r.canvas.height = fh
      gl.viewport(0, 0, fw, fh)
    }
    if (r.mode !== 1) { r.mode = 1; gl.uniform1i(r.modeLoc, 1) }
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, r.texY)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, vf)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    return
  }

  const resized = (r.w !== item.w || r.h !== item.h)
  if (resized) {
    r.w = item.w; r.h = item.h
    r.canvas.width = item.w; r.canvas.height = item.h
    gl.viewport(0, 0, item.w, item.h)
    r.crop = [0, 0, 1, 1]
    r.cropPx = null
    r.cropCandidate = null
    r.cropSame = 0
    r.cropTries = 0
    r.cropDone = false
    gl.uniform4f(r.cropLoc, 0, 0, 1, 1)
  }
  const u8 = new Uint8Array(item.ab, 0, item.len)
  if (item.yuv && !r.cropDone) {
    r.cropTries++
    const c = detectLetterbox(u8, item.w, item.h)
    if (c && c.full) {
      r.cropDone = true
    } else if (c) {
      // Three bright frames must agree before cropping: a dark scene with black sky rows must not
      // be mistaken for a letterbox, and the real bars repeat identically.
      const p = r.cropCandidate
      const same = p && Math.abs(p.left - c.left) <= 2 && Math.abs(p.top - c.top) <= 2 &&
        Math.abs(p.right - c.right) <= 2 && Math.abs(p.bottom - c.bottom) <= 2
      r.cropCandidate = c
      r.cropSame = same ? (r.cropSame || 1) + 1 : 1
      if (r.cropSame >= 3) {
        applyCrop(r, c)
        r.cropDone = true
      }
    }
  }
  if (item.yuv) {
    const modeChanged = r.mode !== 0
    if (modeChanged) { r.mode = 0; gl.uniform1i(r.modeLoc, 0) }
    const cw = (item.w + 1) >> 1, ch = (item.h + 1) >> 1
    const yLen = item.w * item.h, cLen = cw * ch
    const intFmt = isGl2 ? gl.R8 : gl.LUMINANCE
    const srcFmt = isGl2 ? gl.RED : gl.LUMINANCE
    const reinit = resized || modeChanged
    const up = (unit, tex, tw, th, data) => {
      gl.activeTexture(gl.TEXTURE0 + unit)
      gl.bindTexture(gl.TEXTURE_2D, tex)
      if (reinit) gl.texImage2D(gl.TEXTURE_2D, 0, intFmt, tw, th, 0, srcFmt, gl.UNSIGNED_BYTE, data)
      else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, tw, th, srcFmt, gl.UNSIGNED_BYTE, data)
    }
    up(0, r.texY, item.w, item.h, u8.subarray(0, yLen))
    up(1, r.texU, cw, ch, u8.subarray(yLen, yLen + cLen))
    up(2, r.texV, cw, ch, u8.subarray(yLen + cLen, yLen + cLen * 2))
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  } else {
    const modeChanged = r.mode !== 1
    if (modeChanged) { r.mode = 1; gl.uniform1i(r.modeLoc, 1) }
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, r.texY)
    if (resized || modeChanged) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, item.w, item.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, u8)
    else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, item.w, item.h, gl.RGBA, gl.UNSIGNED_BYTE, u8)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }
}

function releaseRenderItem (item) {
  if (!item) return
  if (item.hwFrame) {
    try { item.hwFrame.close() } catch {}
  } else if (item.ab) {
    recyclePool(freeVideoPool, item.ab, 24)
  }
}

function clearRenderQueue () {
  while (renderQueue.length > 0) releaseRenderItem(renderQueue.shift())
  drawnInSession = 0
}

function ensureRenderLoop () {
  if (renderLoopActive || !offRenderer || useMse || closed) return
  renderLoopActive = true
  // A worker's requestAnimationFrame is compositor-driven but can tick slower than the display
  // wants; an 8 ms timer checks due pictures often enough that a 24 fps frame is never skipped by a
  // late tick. Drawing only happens when a frame is actually due, so the extra checks cost nothing.
  const sched = fn => setTimeout(fn, 8)
  const step = () => {
    if (closed || useMse || !offRenderer) {
      renderLoopActive = false
      return
    }
    if (renderQueue.length > 0) {
      if (drawnInSession === 0) {
        const first = renderQueue[0]
        drawOnWorkerGl(first)
        drawnInSession = 1
        lastDrawAt = nowWall()
        self.postMessage({ type: 'videoPrimed', seq: activeSeq, hw: useWebCodecs })
      } else if (clockPlaying) {
        const now = workerMediaTime()
        let pick = null
        while (renderQueue.length > 0 && renderQueue[0].pts <= now + 0.015) {
          const item = renderQueue.shift()
          queuedVideoSec = Math.max(0, queuedVideoSec - item.step)
          if (pick) releaseRenderItem(pick)
          pick = item
        }
        if (pick) {
          drawOnWorkerGl(pick)
          drawnInSession++
          lastDrawAt = nowWall()
          releaseRenderItem(pick)
          if (!eof && !bufferedAhead()) schedulePump(0)
        }
      }
    }
    if (!eof || renderQueue.length > 0) {
      sched(step)
    } else {
      renderLoopActive = false
    }
  }
  sched(step)
}

function closeWebCodecs () {
  if (wcDecoder) {
    try { if (wcDecoder.state !== 'closed') wcDecoder.close() } catch {}
    wcDecoder = null
  }
}

async function setupWebCodecsIfPossible (hint) {
  closeWebCodecs()
  if (!offRenderer || !hint || !hint.codec || typeof self.VideoDecoder !== 'function') return false
  const cfg = {
    codec: hint.codec,
    codedWidth: hint.width,
    codedHeight: hint.height,
    optimizeForLatency: true
  }
  if (hint.descriptionHex && hint.descriptionHex.length >= 2) {
    const bytes = new Uint8Array(hint.descriptionHex.length >> 1)
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Number.parseInt(hint.descriptionHex.slice(i * 2, i * 2 + 2), 16)
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
  try {
    const decInst = new self.VideoDecoder({
      output: vf => {
        if (closed || seq !== activeSeq) {
          try { vf.close() } catch {}
          return
        }
        const pts = (vf.timestamp || 0) / 1e6
        if (pts + 0.025 < minPts) {
          try { vf.close() } catch {}
          return
        }
        const step = lastVideoPts !== null ? Math.max(0.01, Math.min(0.2, pts - lastVideoPts)) : (1 / 30)
        lastVideoPts = pts
        queuedVideoSec += step
        // Maintain presentation order across B-frame reorders
        let ins = renderQueue.length
        while (ins > 0 && renderQueue[ins - 1].pts > pts) ins--
        renderQueue.splice(ins, 0, { pts, step, hwFrame: vf })
        ensureRenderLoop()
      },
      error: () => {
        if (!closed && seq === activeSeq && useWebCodecs) {
          useWebCodecs = false
          closeWebCodecs()
          wasm.pt_configure(currentVideoStream, currentAudioStream, currentSubStream, 0)
          wasm.pt_seek(workerMediaTime())
          schedulePump(0)
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

let currentVideoStream = -1
let currentAudioStream = -1
let currentSubStream = -1

function bufferedAhead () {
  const wcQueueSec = (useWebCodecs && wcDecoder) ? (wcDecoder.decodeQueueSize / 30) : 0
  const maxVideo = useMse ? 8.0 : (offRenderer ? 1.0 : 1.5)
  const maxAudio = 2.5
  // Credits arrive from the page's playback clock; when they stop, drain the estimates at wall
  // speed instead of believing the buffers are still full. Otherwise the worker stops decoding and
  // playback dies about one buffer after the window loses focus.
  const sinceCredit = clockPlaying ? Math.min(30, Math.max(0, (nowWall() - lastCreditAt) / 1000)) : 0
  const pageOwnsVideo = useMse || !offRenderer
  const sinceDraw = pageOwnsVideo ? sinceCredit : Math.min(30, Math.max(0, (nowWall() - lastDrawAt) / 1000))
  const videoSec = Math.max(0, queuedVideoSec - sinceDraw)
  const audioSec = Math.max(0, queuedAudioSec - sinceCredit)
  const vOk = pageHidden || !hasVideo || (videoSec + wcQueueSec) >= maxVideo
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
    if (code === 0) {
      if (useWebCodecs && wcDecoder && wcDecoder.state === 'configured') {
        wcDecoder.flush().catch(() => {})
      }
      eof = true
      self.postMessage({ type: 'eof', seq })
      return
    }
    if (code < 0) {
      const err = readJson()
      self.postMessage({ type: 'error', seq, error: err.error || 'WASM decode failed' })
      eof = true
      return
    }
    if (code === 1) {
      const { ab, len } = copyPooledBuf([])
      const exact = len === ab.byteLength ? ab : ab.slice(0, len)
      self.postMessage({ type: 'mseInit', seq, buf: exact }, [exact])
    } else if (code === 2) {
      const { ab, len } = copyPooledBuf([])
      const exact = len === ab.byteLength ? ab : ab.slice(0, len)
      const start = wasm.pt_out_pts()
      const end = wasm.pt_out_dur()
      queuedVideoSec += Math.max(0.04, Math.min(4.0, end - start))
      self.postMessage({ type: 'mseSeg', seq, start, end, buf: exact }, [exact])
    } else if (code === 8) {
      if (wcDecoder && wcDecoder.state === 'configured') {
        const ptr = wasm.pt_out_ptr() >>> 0
        const len = wasm.pt_out_len() >>> 0
        const pts = wasm.pt_out_pts()
        const dur = wasm.pt_out_dur()
        const isKey = (wasm.pt_out_w() >>> 0) !== 0
        try {
          wcDecoder.decode(new self.EncodedVideoChunk({
            type: isKey ? 'key' : 'delta',
            timestamp: Math.round(pts * 1e6),
            duration: Math.round(dur * 1e6),
            data: new Uint8Array(wasm.memory.buffer, ptr, len)
          }))
        } catch {}
      }
    } else if (code === 3 || code === 7) {
      const pts = wasm.pt_out_pts()
      const w = wasm.pt_out_w() >>> 0
      const h = wasm.pt_out_h() >>> 0
      const step = lastVideoPts !== null ? Math.max(0.01, Math.min(0.2, pts - lastVideoPts)) : (1 / 30)
      lastVideoPts = pts
      queuedVideoSec += step
      const { ab, len } = copyPooledBuf(freeVideoPool)
      if (!offRenderer && code === 7 && !streamCropDone) {
        const c = detectLetterbox(new Uint8Array(ab, 0, len), w, h)
        if (c && c.full) {
          streamCropDone = true
          self.postMessage({ type: 'videoCrop', full: true, w, h })
        } else if (c) {
          const p = streamCropCandidate
          const same = p && Math.abs(p.left - c.left) <= 2 && Math.abs(p.top - c.top) <= 2 &&
            Math.abs(p.right - c.right) <= 2 && Math.abs(p.bottom - c.bottom) <= 2
          streamCropCandidate = c
          streamCropSame = same ? streamCropSame + 1 : 1
          if (streamCropSame >= 3) {
            streamCropDone = true
            self.postMessage({ type: 'videoCrop', full: false, left: c.left, top: c.top, right: c.right, bottom: c.bottom, w, h })
          }
        }
      }
      if (offRenderer) {
        renderQueue.push({ pts, step, w, h, yuv: code === 7, ab, len })
        ensureRenderLoop()
      } else {
        self.postMessage({ type: 'videoFrame', seq, pts, w, h, yuv: code === 7, buf: ab, byteLen: len }, [ab])
      }
    } else if (code === 4) {
      const { ab, len } = copyPooledBuf(freeAudioPool)
      const pts = wasm.pt_out_pts()
      const rate = wasm.pt_out_rate() >>> 0
      const samples = wasm.pt_out_samples() >>> 0
      if (rate > 0) queuedAudioSec += samples / rate
      self.postMessage({ type: 'audioChunk', seq, pts, rate, samples, buf: ab, byteLen: len }, [ab])
    } else if (code === 5) {
      const ptr = wasm.pt_out_ptr() >>> 0
      const len = wasm.pt_out_len() >>> 0
      const text = dec.decode(new Uint8Array(wasm.memory.buffer, ptr, len))
      self.postMessage({ type: 'subText', seq, start: wasm.pt_out_pts(), end: wasm.pt_out_dur(), text })
    } else if (code === 6) {
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
  if (msg.cmd === 'initCanvas') {
    if (msg.canvas && !offRenderer) {
      offRenderer = initOffscreenRenderer(msg.canvas)
    }
    self.postMessage({ type: 'canvasReady', offscreen: Boolean(offRenderer) })
  } else if (msg.cmd === 'warmup') {
    await ensureWasm(msg.wasmUrl)
    self.postMessage({ type: 'warm' })
  } else if (msg.cmd === 'open') {
    closed = true
    closeWebCodecs()
    clearRenderQueue()
    if (wasm) wasm.pt_close()
    closed = false
    configured = false
    eof = false
    streamingMode = false
    clockPlaying = false
    clockMedia = 0
    wcConfig = null
    useWebCodecs = false
    activeSeq = msg.seq || 1
    streamUrl = msg.streamUrl
    await ensureWasm(msg.wasmUrl)
    probeStream(streamUrl)
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
      offscreen: Boolean(offRenderer),
      webCodecsSupported: wcSupported
    })
  } else if (msg.cmd === 'start') {
    activeSeq = msg.seq || activeSeq
    currentVideoStream = msg.videoStream
    currentAudioStream = msg.audioStream
    currentSubStream = msg.subStream
    hasVideo = msg.videoStream >= 0
    hasAudio = msg.audioStream >= 0
    useMse = Boolean(msg.useMse)
    clearRenderQueue()
    closeWebCodecs()
    useWebCodecs = !useMse && hasVideo && Boolean(msg.allowWebCodecs) && openWebCodecsInstance(activeSeq, 0)
    streamingMode = true
    clockMedia = 0
    clockWallMs = nowWall()
    clockPlaying = false
    streamCropDone = false
    streamCropCandidate = null
    streamCropSame = 0
    queuedVideoSec = 0
    queuedAudioSec = 0
    lastCreditAt = lastDrawAt = nowWall()
    lastVideoPts = null
    eof = false
    const modeInt = useMse ? 1 : (useWebCodecs ? 2 : 0)
    const rc = wasm.pt_configure(msg.videoStream, msg.audioStream, msg.subStream, modeInt)
    if (rc < 0) {
      self.postMessage({ type: 'error', seq: activeSeq, error: readJson().error || 'Configure failed' })
      return
    }
    configured = true
    wasm.pt_set_clock?.(0)
    if (offRenderer && !useMse) ensureRenderLoop()
    schedulePump(0)
    armWatchdog()
  } else if (msg.cmd === 'seek') {
    activeSeq = msg.seq
    currentVideoStream = msg.videoStream
    currentAudioStream = msg.audioStream
    currentSubStream = msg.subStream
    hasVideo = msg.videoStream >= 0
    hasAudio = msg.audioStream >= 0
    useMse = Boolean(msg.useMse)
    clearRenderQueue()
    closeWebCodecs()
    const target = Math.max(0, Number(msg.time) || 0)
    useWebCodecs = !useMse && hasVideo && Boolean(msg.allowWebCodecs) && openWebCodecsInstance(activeSeq, target)
    streamingMode = true
    clockMedia = target
    clockWallMs = nowWall()
    clockPlaying = false
    streamCropDone = false
    streamCropCandidate = null
    streamCropSame = 0
    queuedVideoSec = 0
    queuedAudioSec = 0
    lastCreditAt = lastDrawAt = nowWall()
    lastVideoPts = null
    eof = false
    const modeInt = useMse ? 1 : (useWebCodecs ? 2 : 0)
    wasm.pt_configure(msg.videoStream, msg.audioStream, msg.subStream, modeInt)
    wasm.pt_seek(target)
    configured = true
    wasm.pt_set_clock?.(target)
    self.postMessage({ type: 'flushed', seq: activeSeq, time: target })
    if (offRenderer && !useMse) ensureRenderLoop()
    schedulePump(0)
    armWatchdog()
  } else if (msg.cmd === 'clock') {
    if (typeof msg.time === 'number') clockMedia = Math.max(0, msg.time)
    clockWallMs = typeof msg.wallMs === 'number' ? msg.wallMs : nowWall()
    clockPlaying = Boolean(msg.playing)
    if (typeof msg.hidden === 'boolean') pageHidden = msg.hidden
    lastCreditAt = nowWall()
    if (wasm) wasm.pt_set_clock?.(workerMediaTime())
    if (offRenderer && !useMse && clockPlaying) ensureRenderLoop()
    if (!eof && !bufferedAhead()) schedulePump(0)
    if (clockPlaying) armWatchdog()
  } else if (msg.cmd === 'consumed') {
    if (!offRenderer || useMse) {
      queuedVideoSec = Math.max(0, queuedVideoSec - (Number(msg.videoSec) || 0))
    }
    queuedAudioSec = Math.max(0, queuedAudioSec - (Number(msg.audioSec) || 0))
    if (typeof msg.time === 'number') clockMedia = Math.max(0, msg.time)
    clockWallMs = typeof msg.wallMs === 'number' ? msg.wallMs : nowWall()
    if (typeof msg.playing === 'boolean') clockPlaying = msg.playing
    if (typeof msg.hidden === 'boolean') pageHidden = msg.hidden
    lastCreditAt = nowWall()
    if (wasm) wasm.pt_set_clock?.(workerMediaTime())
    if (!eof && !bufferedAhead()) schedulePump(0)
    if (clockPlaying) armWatchdog()
  } else if (msg.cmd === 'mem') {
    self.postMessage({ type: 'mem', wasm: wasm && wasm.memory ? wasm.memory.buffer.byteLength : 0, blocks: blockCache.size, renderQ: renderQueue.length, videoPool: freeVideoPool.length, audioPool: freeAudioPool.length })
  } else if (msg.cmd === 'block') {
    if (msg.buf && msg.buf.byteLength > 0) putBlock(Number(msg.block) || 0, new Uint8Array(msg.buf))
  } else if (msg.cmd === 'close') {
    if (watchdog !== null) { clearTimeout(watchdog); watchdog = null }
    closed = true
    configured = false
    eof = true
    clockPlaying = false
    streamingMode = false
    closeWebCodecs()
    clearRenderQueue()
    blockCache.clear()
    if (wasm) wasm.pt_close()
  }
}

let cmdChain = Promise.resolve()
self.onmessage = ev => {
  const msg = ev.data || {}
  // Fast lock-free buffer recycling bypasses the async command queue
  if (msg.cmd === 'recycleVideo') {
    recyclePool(freeVideoPool, msg.buf, 24)
    return
  }
  if (msg.cmd === 'recycleAudio') {
    recyclePool(freeAudioPool, msg.buf, 32)
    return
  }
  if (msg.cmd === 'clock' && configured && !closed) {
    if (typeof msg.time === 'number') clockMedia = Math.max(0, msg.time)
    clockWallMs = typeof msg.wallMs === 'number' ? msg.wallMs : nowWall()
    clockPlaying = Boolean(msg.playing)
    if (wasm) wasm.pt_set_clock?.(workerMediaTime())
    if (offRenderer && !useMse && clockPlaying) ensureRenderLoop()
    if (!eof && !bufferedAhead()) schedulePump(0)
    return
  }
  cmdChain = cmdChain.then(() => handleCmd(msg)).catch(err => {
    self.postMessage({ type: 'error', seq: activeSeq, error: err?.message || String(err) })
  })
}
