/**
 * MP4 Playback Probe
 *
 * Demux-free MP4 container inspection for playback optimization. Parses box
 * headers and the moov sample tables to produce a playback profile:
 *
 * - moovPosition: whether the moov box sits before ('front') or after ('back')
 *   the media data. Back-moov files are the worst P2P startup case — the
 *   player cannot parse anything until tail bytes arrive from the swarm.
 * - keyframe index: presentation time + byte offset of every video sync
 *   sample (from stss/stts/stsc/stco/stsz), so range prioritization can snap
 *   seeks to decodable boundaries.
 *
 * No decoding, no native dependencies: only box headers and the moov box are
 * read, never media payload. All probing is best-effort — any structural
 * surprise returns null rather than throwing.
 *
 * Spec: docs/superpowers/specs/2026-06-11-livestreaming-design.md (KeyframeIndexV1)
 */

const MAX_TOP_LEVEL_BOXES = 256
const DEFAULT_MAX_MOOV_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_KEYFRAME_ENTRIES = 5000
// Sample iteration is a plain JS loop; this guards against pathological or
// hostile sample tables, not normal content (a 4h 60fps video is ~864k samples).
const MAX_SAMPLES = 4_000_000

const MP4_MIME_TYPES = new Set([
  'video/mp4',
  'video/x-m4v',
  'video/quicktime',
  'video/3gpp',
  'video/3gpp2',
])

export function isMp4MimeType(mimeType) {
  return MP4_MIME_TYPES.has(String(mimeType || '').toLowerCase())
}

export function readBoxHeader(buf, offset) {
  if (offset + 8 > buf.length) return null
  const size32 = buf.readUInt32BE(offset)
  const type = buf.toString('latin1', offset + 4, offset + 8)
  if (size32 === 1) {
    if (offset + 16 > buf.length) return null
    const size = Number(buf.readBigUInt64BE(offset + 8))
    if (!Number.isSafeInteger(size) || size < 16) return null
    return { type, size, headerSize: 16 }
  }
  if (size32 !== 0 && size32 < 8) return null
  return { type, size: size32, headerSize: 8 }
}

export function* iterateChildBoxes(buf, start, end) {
  let offset = start
  while (offset + 8 <= end) {
    const header = readBoxHeader(buf, offset)
    if (!header) return
    const size = header.size === 0 ? end - offset : header.size
    if (size < header.headerSize || offset + size > end) return
    yield { type: header.type, contentStart: offset + header.headerSize, contentEnd: offset + size }
    offset += size
  }
}

export function findChildBox(buf, start, end, type) {
  for (const box of iterateChildBoxes(buf, start, end)) {
    if (box.type === type) return box
  }
  return null
}

export function findBoxPath(buf, start, end, path) {
  let range = { contentStart: start, contentEnd: end }
  for (const type of path) {
    range = findChildBox(buf, range.contentStart, range.contentEnd, type)
    if (!range) return null
  }
  return range
}

/**
 * Walk top-level boxes via sparse reads to locate moov and the first mdat
 * without reading media bytes.
 *
 * @param {(offset: number, length: number) => Promise<Buffer>} readAt
 * @param {number} fileSize
 */
async function locateTopLevelBoxes(readAt, fileSize) {
  let offset = 0
  let moov = null
  let firstMdatOffset = null
  let sawFtyp = false

  for (let i = 0; i < MAX_TOP_LEVEL_BOXES && offset + 8 <= fileSize; i++) {
    const header = readBoxHeader(await readAt(offset, Math.min(16, fileSize - offset)), 0)
    if (!header) return null
    const size = header.size === 0 ? fileSize - offset : header.size
    if (size < header.headerSize || offset + size > fileSize) return null

    if (header.type === 'ftyp') sawFtyp = true
    else if (header.type === 'moov' && !moov) moov = { offset, size }
    else if (header.type === 'mdat' && firstMdatOffset === null) firstMdatOffset = offset

    if (moov && firstMdatOffset !== null) break
    offset += size
  }

  if (!sawFtyp || !moov) return null
  return { moov, firstMdatOffset }
}

function parseFullBoxVersion(buf, contentStart) {
  return buf.readUInt8(contentStart)
}

function parseMdhdTimescale(buf, mdhd) {
  const version = parseFullBoxVersion(buf, mdhd.contentStart)
  // version 0: creation(4) modification(4) timescale(4) duration(4)
  // version 1: creation(8) modification(8) timescale(4) duration(8)
  const timescaleOffset = mdhd.contentStart + 4 + (version === 1 ? 16 : 8)
  if (timescaleOffset + 4 > mdhd.contentEnd) return null
  const timescale = buf.readUInt32BE(timescaleOffset)
  let duration = null
  const durationOffset = timescaleOffset + 4
  if (version === 1) {
    if (durationOffset + 8 <= mdhd.contentEnd) duration = Number(buf.readBigUInt64BE(durationOffset))
  } else if (durationOffset + 4 <= mdhd.contentEnd) {
    duration = buf.readUInt32BE(durationOffset)
  }
  return { timescale, duration }
}

function isVideoTrak(buf, trak) {
  const hdlr = findBoxPath(buf, trak.contentStart, trak.contentEnd, ['mdia', 'hdlr'])
  if (!hdlr) return false
  // hdlr: version/flags(4) pre_defined(4) handler_type(4)
  const handlerOffset = hdlr.contentStart + 8
  if (handlerOffset + 4 > hdlr.contentEnd) return false
  return buf.toString('latin1', handlerOffset, handlerOffset + 4) === 'vide'
}

function readEntryCountTable(buf, box) {
  // full box: version/flags(4) entry_count(4)
  const countOffset = box.contentStart + 4
  if (countOffset + 4 > box.contentEnd) return null
  return { count: buf.readUInt32BE(countOffset), entriesStart: countOffset + 4 }
}

function parseStblTables(buf, stbl) {
  const stts = findChildBox(buf, stbl.contentStart, stbl.contentEnd, 'stts')
  const stsc = findChildBox(buf, stbl.contentStart, stbl.contentEnd, 'stsc')
  const stsz = findChildBox(buf, stbl.contentStart, stbl.contentEnd, 'stsz')
  const stss = findChildBox(buf, stbl.contentStart, stbl.contentEnd, 'stss')
  const stco = findChildBox(buf, stbl.contentStart, stbl.contentEnd, 'stco')
  const co64 = stco ? null : findChildBox(buf, stbl.contentStart, stbl.contentEnd, 'co64')
  if (!stts || !stsc || !stsz || (!stco && !co64)) return null

  const sttsTable = readEntryCountTable(buf, stts)
  const stscTable = readEntryCountTable(buf, stsc)
  const chunkTable = readEntryCountTable(buf, stco || co64)
  if (!sttsTable || !stscTable || !chunkTable) return null

  // stsz: version/flags(4) sample_size(4) sample_count(4)
  if (stsz.contentStart + 12 > stsz.contentEnd) return null
  const uniformSampleSize = buf.readUInt32BE(stsz.contentStart + 4)
  const sampleCount = buf.readUInt32BE(stsz.contentStart + 8)
  if (sampleCount === 0 || sampleCount > MAX_SAMPLES) return null
  if (uniformSampleSize === 0 && stsz.contentStart + 12 + sampleCount * 4 > stsz.contentEnd) return null

  if (sttsTable.entriesStart + sttsTable.count * 8 > stts.contentEnd) return null
  if (stscTable.entriesStart + stscTable.count * 12 > stsc.contentEnd) return null
  const chunkEntrySize = stco ? 4 : 8
  if (chunkTable.entriesStart + chunkTable.count * chunkEntrySize > (stco || co64).contentEnd) return null

  let syncSamples = null
  if (stss) {
    const stssTable = readEntryCountTable(buf, stss)
    if (!stssTable || stssTable.entriesStart + stssTable.count * 4 > stss.contentEnd) return null
    syncSamples = new Set()
    for (let i = 0; i < stssTable.count; i++) {
      syncSamples.add(buf.readUInt32BE(stssTable.entriesStart + i * 4))
    }
  }

  return {
    buf,
    stts: sttsTable,
    stsc: stscTable,
    chunks: { ...chunkTable, is64: !stco },
    stszStart: stsz.contentStart + 12,
    uniformSampleSize,
    sampleCount,
    syncSamples,
  }
}

/**
 * Walk samples in storage order, emitting { timeUnits, byteOffset } for every
 * sync sample. With no stss box every sample is a sync sample per ISO 14496-12.
 */
function collectKeyframes(tables) {
  const { buf, stts, stsc, chunks, stszStart, uniformSampleSize, sampleCount, syncSamples } = tables

  const keyframes = []
  let sampleNum = 0
  let sttsIndex = 0
  let sttsRemaining = 0
  let sttsDelta = 0
  let timeUnits = 0
  let stscIndex = 0

  for (let chunkIndex = 1; chunkIndex <= chunks.count && sampleNum < sampleCount; chunkIndex++) {
    // Advance the sample-to-chunk cursor: entry applies from firstChunk until
    // the next entry's firstChunk.
    while (
      stscIndex + 1 < stsc.count &&
      buf.readUInt32BE(stsc.entriesStart + (stscIndex + 1) * 12) <= chunkIndex
    ) {
      stscIndex++
    }
    const samplesPerChunk = buf.readUInt32BE(stsc.entriesStart + stscIndex * 12 + 4)
    const chunkOffset = chunks.is64
      ? Number(buf.readBigUInt64BE(chunks.entriesStart + (chunkIndex - 1) * 8))
      : buf.readUInt32BE(chunks.entriesStart + (chunkIndex - 1) * 4)
    if (!Number.isSafeInteger(chunkOffset)) return null

    let withinChunkOffset = 0
    for (let i = 0; i < samplesPerChunk && sampleNum < sampleCount; i++) {
      sampleNum++
      while (sttsRemaining === 0) {
        if (sttsIndex >= stts.count) return null
        sttsRemaining = buf.readUInt32BE(stts.entriesStart + sttsIndex * 8)
        sttsDelta = buf.readUInt32BE(stts.entriesStart + sttsIndex * 8 + 4)
        sttsIndex++
      }

      if (!syncSamples || syncSamples.has(sampleNum)) {
        keyframes.push({ timeUnits, byteOffset: chunkOffset + withinChunkOffset })
      }

      timeUnits += sttsDelta
      sttsRemaining--
      withinChunkOffset += uniformSampleSize !== 0
        ? uniformSampleSize
        : buf.readUInt32BE(stszStart + (sampleNum - 1) * 4)
    }
  }

  return keyframes
}

function downsample(values, maxEntries) {
  if (values.length <= maxEntries) return values
  const stride = Math.ceil(values.length / maxEntries)
  const sampled = []
  for (let i = 0; i < values.length; i += stride) sampled.push(values[i])
  return sampled
}

/**
 * Probe an MP4 file through a sparse byte reader.
 *
 * @param {(offset: number, length: number) => Promise<Buffer>} readAt
 * @param {number} fileSize
 * @param {{ maxMoovBytes?: number, maxKeyframeEntries?: number, source?: string }} [options]
 * @returns {Promise<Object|null>} playback profile, or null when the file is
 *   not parseable MP4 (never throws for structural problems)
 */
export async function probeMp4PlaybackProfile(readAt, fileSize, options = {}) {
  try {
    if (!Number.isSafeInteger(fileSize) || fileSize < 16) return null

    const located = await locateTopLevelBoxes(readAt, fileSize)
    if (!located) return null
    const { moov, firstMdatOffset } = located

    const moovPosition = firstMdatOffset !== null && firstMdatOffset < moov.offset ? 'back' : 'front'
    const maxMoovBytes = options.maxMoovBytes ?? DEFAULT_MAX_MOOV_BYTES

    const profile = {
      version: 1,
      container: 'mp4',
      source: options.source || 'probe',
      probedAt: Date.now(),
      fileSize,
      moovPosition,
      moovStart: moov.offset,
      moovEnd: moov.offset + moov.size,
      fragmented: false,
      timescale: null,
      durationMs: null,
      maxGopMs: null,
      keyframeTimesMs: [],
      keyframeOffsets: [],
    }

    // moov too large to inspect: position info alone is still valuable.
    if (moov.size > maxMoovBytes) return profile

    const buf = await readAt(moov.offset, moov.size)
    if (!buf || buf.length < moov.size) return profile
    // Box offsets below are relative to the start of the moov buffer.
    const moovBox = readBoxHeader(buf, 0)
    if (!moovBox || moovBox.type !== 'moov') return profile
    const moovStart = moovBox.headerSize
    const moovEnd = Math.min(moov.size, buf.length)

    profile.fragmented = Boolean(findChildBox(buf, moovStart, moovEnd, 'mvex'))

    for (const trak of iterateChildBoxes(buf, moovStart, moovEnd)) {
      if (trak.type !== 'trak' || !isVideoTrak(buf, trak)) continue

      const mdhd = findBoxPath(buf, trak.contentStart, trak.contentEnd, ['mdia', 'mdhd'])
      const stbl = findBoxPath(buf, trak.contentStart, trak.contentEnd, ['mdia', 'minf', 'stbl'])
      if (!mdhd || !stbl) continue

      const timing = parseMdhdTimescale(buf, mdhd)
      if (!timing || !timing.timescale) continue

      const tables = parseStblTables(buf, stbl)
      if (!tables) continue

      const keyframes = collectKeyframes(tables)
      if (!keyframes || keyframes.length === 0) continue

      const toMs = (units) => Math.round((units * 1000) / timing.timescale)
      profile.timescale = timing.timescale
      if (timing.duration != null) profile.durationMs = toMs(timing.duration)

      let maxGopUnits = 0
      for (let i = 1; i < keyframes.length; i++) {
        const gap = keyframes[i].timeUnits - keyframes[i - 1].timeUnits
        if (gap > maxGopUnits) maxGopUnits = gap
      }
      if (timing.duration != null && keyframes.length > 0) {
        const tailGap = timing.duration - keyframes[keyframes.length - 1].timeUnits
        if (tailGap > maxGopUnits) maxGopUnits = tailGap
      }
      profile.maxGopMs = keyframes.length > 1 || timing.duration != null ? toMs(maxGopUnits) : null

      const sampled = downsample(keyframes, options.maxKeyframeEntries ?? DEFAULT_MAX_KEYFRAME_ENTRIES)
      profile.keyframeTimesMs = sampled.map((kf) => toMs(kf.timeUnits))
      profile.keyframeOffsets = sampled.map((kf) => kf.byteOffset)
      break
    }

    return profile
  } catch {
    return null
  }
}

/**
 * Probe an MP4 from an in-memory buffer (mobile upload path).
 */
export async function probeMp4Buffer(buffer, options = {}) {
  if (!buffer || buffer.length < 16) return null
  const readAt = async (offset, length) => buffer.subarray(offset, Math.min(buffer.length, offset + length))
  return probeMp4PlaybackProfile(readAt, buffer.length, options)
}

/**
 * Probe an MP4 from a file path (desktop upload path). `fs` is injected for
 * bare-fs / node:fs compatibility, matching the upload manager convention.
 */
export async function probeMp4File(fs, filePath, options = {}) {
  let fd = null
  try {
    const fileSize = options.fileSize ?? fs.statSync(filePath).size
    fd = fs.openSync(filePath, 'r')
    const readAt = async (offset, length) => {
      const buf = Buffer.alloc(length)
      const bytesRead = fs.readSync(fd, buf, 0, length, offset)
      return bytesRead === length ? buf : buf.subarray(0, bytesRead)
    }
    return await probeMp4PlaybackProfile(readAt, fileSize, options)
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd) } catch { /* best effort */ }
    }
  }
}
