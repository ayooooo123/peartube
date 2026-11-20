import b4a from 'b4a'
import { mediaFormat } from './protocol.js'

// What a video file holds, from its container header: Matroska/WebM, MP4/MOV (moov anywhere in the file) and AVI
// give duration and tracks; any other container mediaFormat knows is named with no tracks. `read(start, end)`
// returns the bytes start..end inclusive, fewer at the end of the file. Bytes that name no container give null.
// { container, duration: seconds | null, video: [{ codec, width, height, hdr }],
//   audio: [{ codec, channels, language, name }], subtitles: [{ codec, language, name }] }
// Codecs are display names ('HEVC', 'E-AC-3'); an unknown one is its raw id. MP4's `mp4a` is named AAC unread.
export async function mediaInfo (read) {
  const head = await read(0, 256 * 1024 - 1)
  const container = mediaFormat(head)
  if (!container) return null
  let found = null
  if (container === 'mkv' || container === 'webm') found = await matroska(read, head)
  else if (container === 'mp4' || container === 'mov') found = await mp4(read, head)
  else if (container === 'avi' && text(head, 24, 28) === 'avih') found = avi(head)
  return { container, duration: null, video: [], audio: [], subtitles: [], ...found }
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

const u16 = (b, p) => p + 2 <= b.length ? (b[p] << 8) + b[p + 1] : -1
const u16le = (b, p) => p + 2 <= b.length ? b[p] + (b[p + 1] << 8) : -1
const u32 = (b, p) => p + 4 <= b.length ? ((b[p] << 24) >>> 0) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3] : -1
const u32le = (b, p) => p + 4 <= b.length ? b[p] + (b[p + 1] << 8) + (b[p + 2] << 16) + ((b[p + 3] << 24) >>> 0) : -1
const text = (b, s, e) => e <= b.length ? String.fromCharCode(...b.subarray(s, e)) : ''
const utf8 = (b, max = 128) => b ? b4a.toString(b, 'utf8').replace(/\0+$/, '').slice(0, max) : ''
const dim = n => n > 0 ? n : null
// 'und' (undetermined) names no language.
const known = code => code && code !== 'und' ? code : null
// Bytes at [start, end) of the file, from the first read when it holds them.
const bytes = (read, head, start, end) => end <= head.length ? head.subarray(start, end) : read(start, end - 1)
// Transfer characteristics 16 (PQ) and 18 (HLG) from the container's colour tags (not the bitstream's VUI), plus a
// Dolby Vision configuration.
const hdrLabel = (transfer, dolbyVision) => [dolbyVision && 'Dolby Vision', transfer === 16 && 'HDR10', transfer === 18 && 'HLG'].filter(Boolean).join(' · ') || null

const MKV = {
  'V_MPEG4/ISO/AVC': 'H.264', 'V_MPEGH/ISO/HEVC': 'HEVC', V_AV1: 'AV1', V_VP9: 'VP9', V_VP8: 'VP8', V_MPEG4: 'MPEG-4 Part 2',
  V_MPEG2: 'MPEG-2', V_MPEG1: 'MPEG-1', V_THEORA: 'Theora', V_MJPEG: 'Motion JPEG', V_PRORES: 'ProRes',
  A_AAC: 'AAC', A_AC3: 'AC-3', A_EAC3: 'E-AC-3', A_TRUEHD: 'TrueHD', A_MLP: 'MLP', A_DTS: 'DTS', 'A_DTS/LOSSLESS': 'DTS-HD MA',
  A_FLAC: 'FLAC', A_OPUS: 'Opus', A_VORBIS: 'Vorbis', 'A_MPEG/L3': 'MP3', 'A_MPEG/L2': 'MP2', A_ALAC: 'ALAC', A_PCM: 'PCM',
  'S_TEXT/UTF8': 'SRT', 'S_TEXT/ASS': 'ASS', 'S_TEXT/SSA': 'SSA', 'S_TEXT/WEBVTT': 'WebVTT', S_TEXT: 'Text',
  'S_HDMV/PGS': 'PGS', 'S_HDMV/TEXTST': 'HDMV Text', S_VOBSUB: 'VobSub', S_DVBSUB: 'DVB'
}
const mkvCodec = id => MKV[id] || MKV[id.split('/')[0]] || id || null
const MP4 = {
  avc1: 'H.264', avc3: 'H.264', hvc1: 'HEVC', hev1: 'HEVC', dvh1: 'HEVC', dvhe: 'HEVC', av01: 'AV1', dav1: 'AV1',
  vp09: 'VP9', vp08: 'VP8', mp4v: 'MPEG-4 Part 2', jpeg: 'Motion JPEG',
  apch: 'ProRes', apcn: 'ProRes', apcs: 'ProRes', apco: 'ProRes', ap4h: 'ProRes', ap4x: 'ProRes',
  mp4a: 'AAC', 'ac-3': 'AC-3', 'ec-3': 'E-AC-3', mlpa: 'TrueHD', dtsc: 'DTS', dtsh: 'DTS', dtsl: 'DTS-HD MA', dtse: 'DTS',
  Opus: 'Opus', fLaC: 'FLAC', alac: 'ALAC', '.mp3': 'MP3', lpcm: 'PCM', sowt: 'PCM', twos: 'PCM', ipcm: 'PCM',
  tx3g: 'Timed Text', wvtt: 'WebVTT', stpp: 'TTML', c608: 'CEA-608'
}
const MP4_DOLBY_VISION = new Set(['dvh1', 'dvhe', 'dav1'])
const FOURCC = {
  XVID: 'MPEG-4 Part 2', DIVX: 'MPEG-4 Part 2', DX50: 'MPEG-4 Part 2', FMP4: 'MPEG-4 Part 2', MP4V: 'MPEG-4 Part 2',
  DIV3: 'MS MPEG-4 v3', H264: 'H.264', X264: 'H.264', AVC1: 'H.264', HEVC: 'HEVC', H265: 'HEVC', HVC1: 'HEVC',
  WVC1: 'VC-1', WMV3: 'WMV 9', MJPG: 'Motion JPEG', MPG2: 'MPEG-2'
}
const fourccCodec = cc => FOURCC[cc.toUpperCase()] || cc.trim() || null
const WAVE = { 1: 'PCM', 3: 'PCM', 0x50: 'MP2', 0x55: 'MP3', 0xff: 'AAC', 0x161: 'WMA', 0x162: 'WMA Pro', 0x1610: 'AAC', 0x2000: 'AC-3', 0x2001: 'DTS', 0xf1ac: 'FLAC' }
const waveCodec = tag => tag < 0 ? null : WAVE[tag] || `0x${tag.toString(16)}`

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

const uint = b => b ? b.reduce((v, x) => v * 256 + x, 0) : 0
const float = b => b?.length === 4 || b?.length === 8
  ? (b.length === 4 ? new DataView(b.buffer, b.byteOffset, 4).getFloat32(0) : new DataView(b.buffer, b.byteOffset, 8).getFloat64(0))
  : 0

async function matroska (read, head) {
  const ebml = header(head, 0)
  const segment = ebml && ebml.size >= 0 && header(head, ebml.data + ebml.size)
  if (!segment || segment.id !== 0x18538067) return null
  // Walk the segment's top level until Tracks, jumping there through the SeekHead if Clusters come first.
  // Info (duration) comes before Tracks in what mkvmerge and FFmpeg write.
  let tracksAt = -1
  let duration = null
  for (let p = segment.data, i = 0; i < 64; i++) {
    const near = p + 16 <= head.length
    const h = header(near ? head : await read(p, p + 15), near ? p : 0)
    if (!h || h.size < 0) return null
    const start = near ? h.data : p + h.data
    if (h.id === 0x1549a966) {
      const info = fieldsOf(await bytes(read, head, start, start + Math.min(h.size, 64 * 1024)))
      const scale = uint(info.get(0x2ad7b1)) || 1e6
      duration = float(info.get(0x4489)) * scale / 1e9 || null
    }
    if (h.id === 0x1654ae6b) return { duration, ...matroskaTracks(await bytes(read, head, start, start + Math.min(h.size, 4 * 1024 * 1024))) }
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
const DV_CONFIGS = new Set([0x64766343, 0x64767643, 0x64767743]) // dvcC, dvvC, dvwC

function matroskaTracks (tracks) {
  const out = { video: [], audio: [], subtitles: [] }
  for (const entry of children(tracks)) {
    if (entry.id !== 0xae) continue
    const f = fieldsOf(entry.data)
    const id = utf8(f.get(0x86))
    const language = known(utf8(f.get(0x22b59d)) || utf8(f.get(0x22b59c)))
    const name = utf8(f.get(0x536e)) || null
    const priv = f.get(0x63a2)
    switch (uint(f.get(0x83))) {
      case 1: {
        const v = fieldsOf(f.get(0xe0) || b4a.alloc(0))
        const colour = fieldsOf(v.get(0x55b0) || b4a.alloc(0))
        const dolbyVision = [...children(entry.data)].some(c => c.id === 0x41e4 && DV_CONFIGS.has(uint(fieldsOf(c.data).get(0x41e7))))
        if (out.video.length < 32) {
          out.video.push({
            codec: id === 'V_MS/VFW/FOURCC' && priv ? fourccCodec(text(priv, 16, 20)) : mkvCodec(id),
            width: dim(uint(v.get(0xb0))),
            height: dim(uint(v.get(0xba))),
            hdr: hdrLabel(uint(colour.get(0x55ba)), dolbyVision)
          })
        }
        break
      }
      case 2: {
        if (out.audio.length < 32) {
          const a = fieldsOf(f.get(0xe1) || b4a.alloc(0))
          out.audio.push({ codec: id === 'A_MS/ACM' && priv ? waveCodec(u16le(priv, 0)) : mkvCodec(id), channels: uint(a.get(0x9f)) || 1, language, name })
        }
        break
      }
      case 0x11:
        if (out.subtitles.length < 64) out.subtitles.push({ codec: mkvCodec(id), language, name })
        break
    }
  }
  return out
}

// ISO BMFF: top-level boxes are walked by size to reach moov, which may follow mdat.
async function mp4 (read, head) {
  for (let p = 0, i = 0; i < 64; i++) {
    const h = await bytes(read, head, p, p + 16)
    let box = u32(h, 0)
    let hdr = 8
    if (box === 1) { box = u32(h, 8) * 2 ** 32 + u32(h, 12); hdr = 16 }
    if (box < hdr) return null
    if (text(h, 4, 8) === 'moov') return moovInfo(await bytes(read, head, p + hdr, p + Math.min(box, 64 * 1024 * 1024)))
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

const child = (b, type) => { for (const box of boxes(b)) if (box.type === type) return box.data; return null }
// mdhd's packed ISO 639-2 code, three letters a–z; QuickTime's Macintosh codes (below 0x400) name nothing.
function isoLanguage (v) {
  if (v < 0x400) return null
  const letters = [(v >> 10) & 31, (v >> 5) & 31, v & 31]
  return letters.every(c => c >= 1 && c <= 26) ? known(String.fromCharCode(...letters.map(c => c + 0x60))) : null
}

function moovInfo (moov) {
  const out = { duration: null, video: [], audio: [], subtitles: [] }
  for (const box of boxes(moov)) {
    if (box.type === 'mvhd') {
      const v1 = box.data[0] === 1
      const scale = u32(box.data, v1 ? 20 : 12)
      const length = v1 ? u32(box.data, 24) * 2 ** 32 + u32(box.data, 28) : u32(box.data, 16)
      if (scale > 0 && length > 0 && length !== 0xffffffff) out.duration = length / scale
    }
    if (box.type === 'trak') mp4Track(box.data, out)
  }
  return out
}

function mp4Track (trak, out) {
  const tkhd = child(trak, 'tkhd')
  const mdia = child(trak, 'mdia')
  if (!mdia) return
  const hdlr = child(mdia, 'hdlr')
  const mdhd = child(mdia, 'mdhd')
  const stbl = child(child(mdia, 'minf') || b4a.alloc(0), 'stbl')
  const stsd = stbl && child(stbl, 'stsd')
  // stsd: version/flags and an entry count, then the sample entries; the first names the codec.
  const entry = stsd && boxes(stsd.subarray(8)).next().value
  if (!entry) return
  const handler = hdlr ? text(hdlr, 8, 12) : ''
  const codec = MP4[entry.type] || entry.type.trim() || null
  const language = mdhd ? isoLanguage(u16(mdhd, mdhd[0] === 1 ? 32 : 20)) : null
  if (handler === 'vide') {
    // VisualSampleEntry: 78 bytes of fields (width and height at 24), then its boxes (avcC, colr, dvcC, …).
    let transfer = 0
    let dolbyVision = MP4_DOLBY_VISION.has(entry.type)
    for (const box of boxes(entry.data.subarray(78))) {
      if (box.type === 'colr' && text(box.data, 0, 4) === 'nclx') transfer = u16(box.data, 6)
      if (box.type === 'dvcC' || box.type === 'dvvC' || box.type === 'dvwC') dolbyVision = true
    }
    // tkhd carries the display size (16.16 fixed point), which accounts for non-square pixels.
    const at = tkhd && tkhd[0] === 1 ? 88 : 76
    const width = tkhd ? Math.round(u32(tkhd, at) / 65536) : 0
    const height = tkhd ? Math.round(u32(tkhd, at + 4) / 65536) : 0
    if (out.video.length < 32) {
      out.video.push({
        codec,
        width: dim(width) || dim(u16(entry.data, 24)),
        height: dim(height) || dim(u16(entry.data, 26)),
        hdr: hdrLabel(transfer, dolbyVision)
      })
    }
  } else if (handler === 'soun') {
    // AudioSampleEntry: channel count at 16.
    if (out.audio.length < 32) out.audio.push({ codec, channels: dim(u16(entry.data, 16)), language, name: null })
  } else if (['sbtl', 'subt', 'text', 'clcp'].includes(handler)) {
    if (out.subtitles.length < 64) out.subtitles.push({ codec, language, name: null })
  }
}

// AVI: hdrl holds avih (frame time, frame count, size) and one strl list per stream: strh names the stream's type,
// strf its format (a BITMAPINFOHEADER's compression fourcc, a WAVEFORMATEX's format tag and channels).
function avi (head) {
  const out = { duration: null, video: [], audio: [], subtitles: [] }
  const usPerFrame = u32le(head, 32)
  const frames = u32le(head, 48)
  if (usPerFrame > 0 && frames > 0) out.duration = usPerFrame * frames / 1e6
  const width = dim(u32le(head, 64))
  const height = dim(u32le(head, 68))
  const hdrlEnd = Math.min(head.length, 20 + u32le(head, 16))
  const avihLen = u32le(head, 28)
  for (let p = 32 + avihLen + (avihLen & 1); p + 12 <= hdrlEnd;) {
    const len = u32le(head, p + 4)
    if (len < 0) break
    if (text(head, p, p + 4) === 'LIST' && text(head, p + 8, p + 12) === 'strl') {
      let strh = null
      let strf = null
      const end = Math.min(hdrlEnd, p + 8 + len)
      for (let q = p + 12; q + 8 <= end;) {
        const size = u32le(head, q + 4)
        if (size < 0) break
        if (text(head, q, q + 4) === 'strh') strh = head.subarray(q + 8, q + 8 + size)
        if (text(head, q, q + 4) === 'strf') strf = head.subarray(q + 8, q + 8 + size)
        q += 8 + size + (size & 1)
      }
      const type = strh ? text(strh, 0, 4) : ''
      if (type === 'vids' && out.video.length < 32) out.video.push({ codec: fourccCodec(strf ? text(strf, 16, 20) : text(strh, 4, 8)), width, height, hdr: null })
      if (type === 'auds' && strf && out.audio.length < 32) out.audio.push({ codec: waveCodec(u16le(strf, 0)), channels: dim(u16le(strf, 2)), language: null, name: null })
    }
    p += 8 + len + (len & 1)
  }
  return out
}
