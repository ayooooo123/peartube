// Zero-dependency ISO/IEC 18004 QR Code encoder (Versions 1–14, Byte Mode, Error Correction Level M).
// Runs identically in Node, Bare, QuickJS worklets, and browser pages with zero external assets.
import b4a from 'b4a'

// Total codewords and EC codewords per block for Versions 1..14 at ECC Level M:
// [totalCodewords, ecPerBlock, group1Blocks, group1DataCw, group2Blocks, group2DataCw]
const V_M = [
  null,
  [26, 10, 1, 16, 0, 0],
  [44, 16, 1, 28, 0, 0],
  [70, 26, 1, 44, 0, 0],
  [100, 18, 2, 32, 0, 0],
  [134, 24, 2, 43, 0, 0],
  [172, 16, 4, 27, 0, 0],
  [196, 18, 4, 31, 0, 0],
  [242, 22, 2, 38, 2, 39],
  [292, 22, 3, 36, 2, 37],
  [346, 26, 4, 43, 1, 44],
  [404, 30, 1, 50, 4, 51],
  [466, 22, 6, 36, 2, 37],
  [532, 22, 8, 37, 1, 38],
  [581, 24, 4, 40, 5, 41]
]

const ALIGN = [
  null,
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66]
]

const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)
;(() => {
  let x = 1
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x
    GF_LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]
})()

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]])

function rsGenerator (degree) {
  let poly = [1]
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0)
    const root = GF_EXP[i]
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]
      next[j + 1] ^= gfMul(poly[j], root)
    }
    poly = next
  }
  return poly
}

function rsRemainder (data, degree) {
  const gen = rsGenerator(degree)
  const rem = new Uint8Array(degree)
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ rem[0]
    rem.copyWithin(0, 1)
    rem[degree - 1] = 0
    for (let j = 0; j < degree; j++) rem[j] ^= gfMul(gen[j + 1], factor)
  }
  return rem
}

function bchFormat (ecBits, mask) {
  const data = (ecBits << 3) | mask
  let rem = data << 10
  for (let i = 14; i >= 10; i--) {
    if ((rem >> i) & 1) rem ^= 0x537 << (i - 10)
  }
  return ((data << 10) | rem) ^ 0x5412
}

function bchVersion (ver) {
  let rem = ver << 12
  for (let i = 17; i >= 12; i--) {
    if ((rem >> i) & 1) rem ^= 0x1f25 << (i - 12)
  }
  return (ver << 12) | rem
}

function buildCodewords (bytes) {
  let ver = 1
  for (; ver < V_M.length; ver++) {
    const [, , g1b, g1d, g2b, g2d] = V_M[ver]
    const capBytes = g1b * g1d + g2b * g2d
    const headerBits = 4 + (ver <= 9 ? 8 : 16)
    if (headerBits + bytes.length * 8 <= capBytes * 8) break
  }
  if (ver >= V_M.length) throw new Error('QR payload exceeds Version 14 capacity')

  const [, ecLen, g1b, g1d, g2b, g2d] = V_M[ver]
  const totalData = g1b * g1d + g2b * g2d
  const bits = []
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1)
  }
  pushBits(0b0100, 4) // Byte mode
  pushBits(bytes.length, ver <= 9 ? 8 : 16)
  for (let i = 0; i < bytes.length; i++) pushBits(bytes[i], 8)
  const maxBits = totalData * 8
  pushBits(0, Math.min(4, maxBits - bits.length))
  while (bits.length % 8 !== 0) bits.push(0)
  const dataCw = new Uint8Array(totalData)
  for (let i = 0; i < bits.length / 8; i++) {
    let b = 0
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i * 8 + j]
    dataCw[i] = b
  }
  for (let i = bits.length / 8, pad = 0; i < totalData; i++, pad ^= 1) {
    dataCw[i] = pad ? 0x11 : 0xec
  }

  const blocks = []
  const ecs = []
  let offset = 0
  for (let i = 0; i < g1b; i++) {
    const blk = dataCw.subarray(offset, offset + g1d)
    offset += g1d
    blocks.push(blk)
    ecs.push(rsRemainder(blk, ecLen))
  }
  for (let i = 0; i < g2b; i++) {
    const blk = dataCw.subarray(offset, offset + g2d)
    offset += g2d
    blocks.push(blk)
    ecs.push(rsRemainder(blk, ecLen))
  }

  const out = []
  const maxBlk = Math.max(g1d, g2d)
  for (let i = 0; i < maxBlk; i++) {
    for (const blk of blocks) if (i < blk.length) out.push(blk[i])
  }
  for (let i = 0; i < ecLen; i++) {
    for (const ec of ecs) out.push(ec[i])
  }
  return { ver, codewords: out }
}

function penaltyScore (mat, size) {
  let score = 0
  for (let y = 0; y < size; y++) {
    let runH = 1, runV = 1
    for (let x = 1; x < size; x++) {
      if (mat[y * size + x] === mat[y * size + x - 1]) {
        runH++
        if (runH === 5) score += 3
        else if (runH > 5) score += 1
      } else runH = 1
      if (mat[x * size + y] === mat[(x - 1) * size + y]) {
        runV++
        if (runV === 5) score += 3
        else if (runV > 5) score += 1
      } else runV = 1
    }
  }
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = mat[y * size + x]
      if (c === mat[y * size + x + 1] && c === mat[(y + 1) * size + x] && c === mat[(y + 1) * size + x + 1]) score += 3
    }
  }
  let dark = 0
  for (let i = 0; i < mat.length; i++) if (mat[i]) dark++
  const k = Math.floor(Math.abs((dark * 100) / mat.length - 50) / 5)
  return score + k * 10
}

function encodeQrMatrix (text) {
  const bytes = b4a.from(String(text || ''))
  const { ver, codewords } = buildCodewords(bytes)
  const size = ver * 4 + 17
  const base = new Uint8Array(size * size)
  const isFunc = new Uint8Array(size * size)

  const setFn = (x, y, dark) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return
    base[y * size + x] = dark ? 1 : 0
    isFunc[y * size + x] = 1
  }

  const finder = (ox, oy) => {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const inOuter = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6
        const onRing = dx === 0 || dx === 6 || dy === 0 || dy === 6
        const inCore = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4
        setFn(ox + dx, oy + dy, inOuter && (onRing || inCore))
      }
    }
  }
  finder(0, 0)
  finder(size - 7, 0)
  finder(0, size - 7)

  for (let i = 8; i < size - 8; i++) {
    setFn(i, 6, i % 2 === 0)
    setFn(6, i, i % 2 === 0)
  }

  const pos = ALIGN[ver]
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue
      const cx = pos[i], cy = pos[j]
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setFn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
        }
      }
    }
  }

  // Reserve format & version areas
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) { setFn(8, i, false); setFn(i, 8, false) }
  }
  for (let i = 0; i < 8; i++) {
    setFn(size - 1 - i, 8, false)
    setFn(8, size - 1 - i, false)
  }
  setFn(8, size - 8, true) // Dark module

  if (ver >= 7) {
    const vbits = bchVersion(ver)
    for (let i = 0; i < 18; i++) {
      const bit = ((vbits >>> i) & 1) === 1
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      setFn(a, b, bit)
      setFn(b, a, bit)
    }
  }

  // Zig-zag data placement
  let bitIdx = 0
  const totalBits = codewords.length * 8
  let upward = true
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      const y = upward ? size - 1 - vert : vert
      for (let j = 0; j < 2; j++) {
        const x = right - j
        if (isFunc[y * size + x]) continue
        let dark = false
        if (bitIdx < totalBits) {
          dark = ((codewords[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1) === 1
          bitIdx++
        }
        base[y * size + x] = dark ? 1 : 0
      }
    }
    upward = !upward
  }

  const masks = [
    (x, y) => (x + y) % 2 === 0,
    (_x, y) => y % 2 === 0,
    (x, _y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
  ]

  const writeFormat = (mat, maskIdx) => {
    const bits = bchFormat(0b00, maskIdx) // ECC Level M = 00
    for (let i = 0; i <= 5; i++) mat[i * size + 8] = (bits >>> i) & 1
    mat[7 * size + 8] = (bits >>> 6) & 1
    mat[8 * size + 8] = (bits >>> 7) & 1
    mat[8 * size + 7] = (bits >>> 8) & 1
    for (let i = 9; i < 15; i++) mat[8 * size + (14 - i)] = (bits >>> i) & 1
    for (let i = 0; i < 8; i++) mat[8 * size + (size - 1 - i)] = (bits >>> i) & 1
    for (let i = 8; i < 15; i++) mat[(size - 15 + i) * size + 8] = (bits >>> i) & 1
    mat[(size - 8) * size + 8] = 1
  }

  let bestMat = null
  let bestScore = Infinity
  for (let m = 0; m < 8; m++) {
    const cand = new Uint8Array(base)
    const fn = masks[m]
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!isFunc[y * size + x] && fn(x, y)) cand[y * size + x] ^= 1
      }
    }
    writeFormat(cand, m)
    const sc = penaltyScore(cand, size)
    if (sc < bestScore) { bestScore = sc; bestMat = cand }
  }

  return { size, modules: bestMat }
}

export function qrSvg (text, { margin = 4 } = {}) {
  const { size, modules } = encodeQrMatrix(text)
  const full = size + margin * 2
  const paths = []
  for (let y = 0; y < size; y++) {
    let x = 0
    while (x < size) {
      if (!modules[y * size + x]) { x++; continue }
      let run = 1
      while (x + run < size && modules[y * size + x + run]) run++
      paths.push(`M${x + margin},${y + margin}h${run}v1h-${run}z`)
      x += run
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${full} ${full}" shape-rendering="crispEdges"><rect width="${full}" height="${full}" fill="#ffffff"/><path d="${paths.join('')}" fill="#000000"/></svg>`
}
