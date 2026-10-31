// A video's picture size from its container header, for clients that rank sources by resolution: Matroska/WebM,
// MP4/MOV (moov anywhere in the file) and AVI. `read(start, end)` returns the bytes start..end inclusive, fewer
// at the end of the file. Anything else, or a header that does not parse, is null.
export async function videoSize (read) {
  const head = await read(0, 256 * 1024 - 1)
  if (u32(head, 0) === 0x1a45dfa3) return matroska(read, head)
  if (text(head, 0, 4) === 'RIFF' && text(head, 8, 12) === 'AVI ' && text(head, 24, 28) === 'avih') {
    return size(u32le(head, 64), u32le(head, 68))
  }
  if (['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip'].includes(text(head, 4, 8))) return mp4(read, head)
  return null
}

// The usual release-name tier, judged by width first so letterboxed pictures (1920x800) keep their tier.
// Standard definition (480 and 576 lines) is 480p.
export function resolutionLabel ({ width, height }) {
  if (width >= 3200 || height >= 2000) return '2160p'
  if (width >= 1800 || height >= 1000) return '1080p'
  if (width >= 1200 || height >= 700) return '720p'
  if (width >= 640 || height >= 480) return '480p'
  return `${height}p`
}

const u32 = (b, p) => p + 4 <= b.length ? ((b[p] << 24) >>> 0) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3] : -1
const u32le = (b, p) => p + 4 <= b.length ? b[p] + (b[p + 1] << 8) + (b[p + 2] << 16) + ((b[p + 3] << 24) >>> 0) : -1
const text = (b, s, e) => e <= b.length ? String.fromCharCode(...b.subarray(s, e)) : ''
const size = (width, height) => width > 0 && height > 0 ? { width, height } : null
// Bytes at [start, end) of the file, from the first read when it holds them.
const bytes = (read, head, start, end) => end <= head.length ? head.subarray(start, end) : read(start, end - 1)

// EBML: an element is an id (marker bit kept), a size (marker bit dropped; all ones means unknown), then its data.
function vint (b, p, keepMarker) {
  if (p >= b.length) return null
  let len = 1
  while (len <= 8 && !(b[p] & (0x80 >> (len - 1)))) len++
  if (len > 8 || p + len > b.length) return null
  let value = keepMarker ? b[p] : b[p] & (0xff >> len)
  for (let i = 1; i < len; i++) value = value * 256 + b[p + i]
  if (!keepMarker && value === 2 ** (7 * len) - 1) value = -1
  return { value, len }
}

function header (b, p) {
  const id = vint(b, p, true)
  const sz = id && vint(b, p + id.len, false)
  return sz && { id: id.value, size: sz.value, data: p + id.len + sz.len }
}

function * children (b, start = 0, end = b.length) {
  for (let p = start; p < end;) {
    const h = header(b, p)
    if (!h || h.size < 0 || h.data + h.size > end) return
    yield { id: h.id, data: b.subarray(h.data, h.data + h.size) }
    p = h.data + h.size
  }
}

const uint = b => b.reduce((v, x) => v * 256 + x, 0)

async function matroska (read, head) {
  const ebml = header(head, 0)
  const segment = ebml && ebml.size >= 0 && header(head, ebml.data + ebml.size)
  if (!segment || segment.id !== 0x18538067) return null
  // Walk the segment's top level until Tracks, jumping there through the SeekHead if Clusters come first.
  let tracksAt = -1
  for (let p = segment.data, i = 0; i < 64; i++) {
    const near = p + 16 <= head.length
    const h = header(near ? head : await read(p, p + 15), near ? p : 0)
    if (!h || h.size < 0) return null
    const start = near ? h.data : p + h.data
    if (h.id === 0x1654ae6b) return tracksSize(await bytes(read, head, start, start + Math.min(h.size, 4 * 1024 * 1024)))
    if (h.id === 0x114d9b74) {
      for (const seek of children(await bytes(read, head, start, start + Math.min(h.size, 1024 * 1024)))) {
        const f = seek.id === 0x4dbb && fieldsOf(seek.data)
        if (f && f.get(0x53ab) && uint(f.get(0x53ab)) === 0x1654ae6b && f.get(0x53ac)) tracksAt = segment.data + uint(f.get(0x53ac))
      }
    }
    if (h.id !== 0x1f43b675) p = start + h.size
    else if (tracksAt > p) p = tracksAt
    else return null
  }
  return null
}

const fieldsOf = b => new Map([...children(b)].map(f => [f.id, f.data]))

function tracksSize (tracks) {
  for (const entry of children(tracks)) {
    if (entry.id !== 0xae) continue
    const fields = fieldsOf(entry.data)
    if (!fields.get(0x83) || uint(fields.get(0x83)) !== 1 || !fields.get(0xe0)) continue
    const video = fieldsOf(fields.get(0xe0))
    if (video.get(0xb0) && video.get(0xba)) return size(uint(video.get(0xb0)), uint(video.get(0xba)))
  }
  return null
}

// ISO BMFF: top-level boxes are walked by size to reach moov, which may follow mdat.
async function mp4 (read, head) {
  for (let p = 0, i = 0; i < 64; i++) {
    const h = await bytes(read, head, p, p + 16)
    let box = u32(h, 0)
    let hdr = 8
    if (box === 1) { box = u32(h, 8) * 2 ** 32 + u32(h, 12); hdr = 16 }
    if (box < hdr) return null
    if (text(h, 4, 8) === 'moov') return moovSize(await bytes(read, head, p + hdr, p + Math.min(box, 64 * 1024 * 1024)))
    p += box
  }
  return null
}

function * boxes (b) {
  for (let p = 0; p + 8 <= b.length;) {
    const box = u32(b, p)
    if (box < 8 || p + box > b.length) return
    yield { type: text(b, p + 4, p + 8), data: b.subarray(p + 8, p + box) }
    p += box
  }
}

function moovSize (moov) {
  for (const trak of boxes(moov)) {
    if (trak.type !== 'trak') continue
    let tkhd = null
    let video = false
    for (const box of boxes(trak.data)) {
      if (box.type === 'tkhd') tkhd = box.data
      if (box.type === 'mdia') for (const m of boxes(box.data)) if (m.type === 'hdlr' && text(m.data, 8, 12) === 'vide') video = true
    }
    if (!video || !tkhd) continue
    const at = tkhd[0] === 1 ? 88 : 76
    return size(Math.round(u32(tkhd, at) / 65536), Math.round(u32(tkhd, at + 4) / 65536))
  }
  return null
}
