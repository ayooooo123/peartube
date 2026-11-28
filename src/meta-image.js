import b4a from 'b4a'
import { MAX_ART_BYTES } from './meta-wire.js'

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function asBuffer (bytes) {
  if (b4a.isBuffer(bytes)) return bytes
  if (bytes instanceof Uint8Array) return b4a.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return null
}

function validDims (width, height) {
  return width > 0 && height > 0 && width <= 0xffff && height <= 0xffff
}

function readU32BE (buf, off) {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0
}

function sniffWebp (buf) {
  if (buf.byteLength < 16) return null
  if (b4a.toString(buf.subarray(0, 4), 'latin1') !== 'RIFF') return null
  if (b4a.toString(buf.subarray(8, 12), 'latin1') !== 'WEBP') return null
  const chunk = b4a.toString(buf.subarray(12, 16), 'latin1')
  if (chunk === 'VP8X') {
    if (buf.byteLength < 30) return null
    const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16))
    const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16))
    return validDims(width, height) ? { mime: 'image/webp', width, height } : null
  }
  if (chunk === 'VP8L') {
    if (buf.byteLength < 25 || buf[20] !== 0x2f) return null
    const bits = (buf[21] | (buf[22] << 8) | (buf[23] << 16) | (buf[24] << 24)) >>> 0
    const width = (bits & 0x3fff) + 1
    const height = ((bits >>> 14) & 0x3fff) + 1
    return validDims(width, height) ? { mime: 'image/webp', width, height } : null
  }
  if (chunk === 'VP8 ') {
    if (buf.byteLength < 30) return null
    if ((buf[20] & 1) !== 0) return null
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null
    const width = (buf[26] | (buf[27] << 8)) & 0x3fff
    const height = (buf[28] | (buf[29] << 8)) & 0x3fff
    return validDims(width, height) ? { mime: 'image/webp', width, height } : null
  }
  return null
}

function sniffPng (buf) {
  if (buf.byteLength < 24) return null
  for (let i = 0; i < PNG_SIG.length; i++) {
    if (buf[i] !== PNG_SIG[i]) return null
  }
  if (b4a.toString(buf.subarray(12, 16), 'latin1') !== 'IHDR') return null
  const width = readU32BE(buf, 16)
  const height = readU32BE(buf, 20)
  return validDims(width, height) ? { mime: 'image/png', width, height } : null
}

function isStandaloneJpegMarker (marker) {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)
}

function sniffJpeg (buf) {
  if (buf.byteLength < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let pos = 2
  while (pos < buf.byteLength) {
    if (buf[pos] !== 0xff) return null
    while (pos < buf.byteLength && buf[pos] === 0xff) pos++
    if (pos >= buf.byteLength) return null
    const marker = buf[pos++]
    if (marker === 0xd9 || marker === 0xda) return null
    if (isStandaloneJpegMarker(marker)) continue
    if (pos + 2 > buf.byteLength) return null
    const segLen = (buf[pos] << 8) | buf[pos + 1]
    if (segLen < 2 || pos + segLen > buf.byteLength) return null
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (segLen < 7) return null
      const height = (buf[pos + 3] << 8) | buf[pos + 4]
      const width = (buf[pos + 5] << 8) | buf[pos + 6]
      return validDims(width, height) ? { mime: 'image/jpeg', width, height } : null
    }
    pos += segLen
  }
  return null
}

// Pure-JS artwork header sniffer supporting WebP (VP8X/VP8L/VP8), PNG (IHDR), and JPEG (SOF0/1/2).
// Strictly rejects HTML error pages, truncated/corrupt headers, and oversized payloads.
export function sniffArtHeader (bytes) {
  const buf = asBuffer(bytes)
  if (!buf || buf.byteLength < 12 || buf.byteLength > MAX_ART_BYTES) return null
  return sniffWebp(buf) || sniffPng(buf) || sniffJpeg(buf)
}

function dctCoeff (channel, w, h, cx, cy) {
  const fx = new Float64Array(w)
  for (let x = 0; x < w; x++) fx[x] = Math.cos((Math.PI / w) * cx * (x + 0.5))
  let sum = 0
  for (let y = 0; y < h; y++) {
    const fy = Math.cos((Math.PI / h) * cy * (y + 0.5))
    const row = y * w
    for (let x = 0; x < w; x++) sum += channel[row + x] * fx[x] * fy
  }
  return sum / (w * h)
}

function encodeDctChannel (channel, w, h, nx, ny) {
  let dc = 0
  const ac = []
  let scale = 0
  for (let cy = 0; cy < ny; cy++) {
    for (let cx = 0; cx * ny < nx * (ny - cy); cx++) {
      const f = dctCoeff(channel, w, h, cx, cy)
      if (cx || cy) {
        ac.push(f)
        scale = Math.max(scale, Math.abs(f))
      } else {
        dc = f
      }
    }
  }
  if (scale) {
    for (let i = 0; i < ac.length; i++) ac[i] = 0.5 + (0.5 / scale) * ac[i]
  }
  return [dc, ac, scale]
}

// Pure-JS ThumbHash encoder (Evan Wallace's compact specification, <= 25 bytes, zero deps).
export function encodeThumbHash (w, h, rgba) {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 100 || h > 100) {
    throw new Error('ThumbHash dimensions must be integers in 1..100')
  }
  if (!rgba || rgba.length < w * h * 4) {
    throw new Error('ThumbHash RGBA buffer is too short for dimensions')
  }
  const pixels = w * h
  let avgR = 0
  let avgG = 0
  let avgB = 0
  let avgA = 0
  for (let i = 0, j = 0; i < pixels; i++, j += 4) {
    const alpha = rgba[j + 3] / 255
    avgR += (alpha / 255) * rgba[j]
    avgG += (alpha / 255) * rgba[j + 1]
    avgB += (alpha / 255) * rgba[j + 2]
    avgA += alpha
  }
  if (avgA) {
    avgR /= avgA
    avgG /= avgA
    avgB /= avgA
  }
  const hasAlpha = avgA < pixels
  const lLimit = hasAlpha ? 5 : 7
  const maxDim = Math.max(w, h)
  const lx = Math.max(1, Math.round((lLimit * w) / maxDim))
  const ly = Math.max(1, Math.round((lLimit * h) / maxDim))

  const l = new Float64Array(pixels)
  const p = new Float64Array(pixels)
  const q = new Float64Array(pixels)
  const a = new Float64Array(pixels)
  for (let i = 0, j = 0; i < pixels; i++, j += 4) {
    const alpha = rgba[j + 3] / 255
    const r = avgR * (1 - alpha) + (alpha / 255) * rgba[j]
    const g = avgG * (1 - alpha) + (alpha / 255) * rgba[j + 1]
    const b = avgB * (1 - alpha) + (alpha / 255) * rgba[j + 2]
    l[i] = (r + g + b) / 3
    p[i] = (r + g) / 2 - b
    q[i] = r - g
    a[i] = alpha
  }

  const [lDc, lAc, lScale] = encodeDctChannel(l, w, h, Math.max(3, lx), Math.max(3, ly))
  const [pDc, pAc, pScale] = encodeDctChannel(p, w, h, 3, 3)
  const [qDc, qAc, qScale] = encodeDctChannel(q, w, h, 3, 3)
  const [aDc, aAc, aScale] = hasAlpha ? encodeDctChannel(a, w, h, 5, 5) : [0, [], 0]

  const isLandscape = w > h
  const header24 =
    Math.round(63 * lDc) |
    (Math.round(31.5 + 31.5 * pDc) << 6) |
    (Math.round(31.5 + 31.5 * qDc) << 12) |
    (Math.round(31 * lScale) << 18) |
    (hasAlpha ? (1 << 23) : 0)
  const header16 =
    (isLandscape ? ly : lx) |
    (Math.round(63 * pScale) << 3) |
    (Math.round(63 * qScale) << 9) |
    (isLandscape ? (1 << 15) : 0)

  const acLists = hasAlpha ? [lAc, pAc, qAc, aAc] : [lAc, pAc, qAc]
  let nibbleCount = 0
  for (const list of acLists) nibbleCount += list.length
  const acStart = hasAlpha ? 6 : 5
  const out = b4a.alloc(acStart + Math.ceil(nibbleCount / 2))
  out[0] = header24 & 0xff
  out[1] = (header24 >> 8) & 0xff
  out[2] = (header24 >> 16) & 0xff
  out[3] = header16 & 0xff
  out[4] = (header16 >> 8) & 0xff
  if (hasAlpha) out[5] = Math.round(15 * aDc) | (Math.round(15 * aScale) << 4)

  let acIndex = 0
  for (const list of acLists) {
    for (const f of list) {
      out[acStart + (acIndex >> 1)] |= Math.round(15 * f) << ((acIndex & 1) << 2)
      acIndex++
    }
  }
  return out
}
