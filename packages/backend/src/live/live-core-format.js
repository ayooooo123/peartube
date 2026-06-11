/**
 * Live Core Format
 *
 * Block layout for PearTube live streams: one single-writer hypercore per
 * stream, where the hypercore block index is the MoQ-style group ID and
 * every media block starts at a video keyframe.
 *
 *   block 0   stream descriptor (JSON)
 *   block 1   fMP4 init segment (ftyp + moov)
 *   block 2+  one fragment per block (moof + mdat), keyframe-aligned
 *   block N   end-of-stream marker (JSON)
 *
 * JSON control blocks start with '{' (0x7b); media blocks start with a box
 * header whose bytes 4-8 are 'moof'/'ftyp', so the two are unambiguous.
 *
 * Spec: docs/superpowers/specs/2026-06-11-livestreaming-design.md
 */

import b4a from 'b4a'

import { readBoxHeader, findChildBox, findBoxPath, iterateChildBoxes } from '../mp4-playback-probe.js'

export const LIVE_CORE_FORMAT_VERSION = 1
export const DESCRIPTOR_BLOCK = 0
export const INIT_SEGMENT_BLOCK = 1
export const FIRST_MEDIA_BLOCK = 2
export const DEFAULT_TARGET_FRAGMENT_DURATION_S = 1

const JSON_OPEN_BRACE = 0x7b

export function encodeStreamDescriptor({
  videoId,
  channelKey = null,
  title = null,
  targetFragmentDuration = DEFAULT_TARGET_FRAGMENT_DURATION_S,
  startedAt = Date.now(),
  codecs = null,
  width = 0,
  height = 0,
} = {}) {
  if (!videoId) throw new Error('Live descriptor requires a videoId')
  return b4a.from(JSON.stringify({
    peartubeLive: LIVE_CORE_FORMAT_VERSION,
    type: 'descriptor',
    videoId,
    channelKey,
    title,
    targetFragmentDuration,
    startedAt,
    codecs,
    width,
    height,
  }))
}

export function encodeEndOfStream({ mediaBlocks, endedAt = Date.now() } = {}) {
  return b4a.from(JSON.stringify({
    peartubeLive: LIVE_CORE_FORMAT_VERSION,
    type: 'eos',
    mediaBlocks: Number(mediaBlocks) || 0,
    endedAt,
  }))
}

export function decodeControlBlock(block) {
  if (!block || block.length === 0 || block[0] !== JSON_OPEN_BRACE) return null
  try {
    const parsed = JSON.parse(b4a.toString(block))
    if (parsed?.peartubeLive !== LIVE_CORE_FORMAT_VERSION) return null
    if (parsed.type !== 'descriptor' && parsed.type !== 'eos') return null
    return parsed
  } catch {
    return null
  }
}

export function isMediaFragmentBlock(block) {
  if (!block || block.length < 8) return false
  return b4a.toString(block.subarray(4, 8), 'latin1') === 'moof'
}

/**
 * Media timescale from an init segment (moov → trak → mdia → mdhd).
 * Returns the first video track's timescale, falling back to the first
 * track of any kind.
 */
export function parseInitSegmentTimescale(initBlock) {
  try {
    const moov = (() => {
      for (const box of iterateChildBoxes(initBlock, 0, initBlock.length)) {
        if (box.type === 'moov') return box
      }
      return null
    })()
    if (!moov) return null

    let fallback = null
    for (const trak of iterateChildBoxes(initBlock, moov.contentStart, moov.contentEnd)) {
      if (trak.type !== 'trak') continue
      const mdhd = findBoxPath(initBlock, trak.contentStart, trak.contentEnd, ['mdia', 'mdhd'])
      if (!mdhd) continue
      const version = initBlock.readUInt8(mdhd.contentStart)
      const timescaleOffset = mdhd.contentStart + 4 + (version === 1 ? 16 : 8)
      if (timescaleOffset + 4 > mdhd.contentEnd) continue
      const timescale = initBlock.readUInt32BE(timescaleOffset)
      if (!timescale) continue

      const hdlr = findBoxPath(initBlock, trak.contentStart, trak.contentEnd, ['mdia', 'hdlr'])
      const handlerOffset = hdlr ? hdlr.contentStart + 8 : -1
      const isVideo = hdlr && handlerOffset + 4 <= hdlr.contentEnd &&
        b4a.toString(initBlock.subarray(handlerOffset, handlerOffset + 4), 'latin1') === 'vide'
      if (isVideo) return timescale
      if (fallback === null) fallback = timescale
    }
    return fallback
  } catch {
    return null
  }
}

/**
 * Decode time of a media fragment: moof → traf → tfdt baseMediaDecodeTime.
 * Returns null when the fragment carries no tfdt (the writer always emits
 * one via ffmpeg's default_base_moof fMP4 output).
 */
export function parseFragmentDecodeTime(block) {
  try {
    const header = readBoxHeader(block, 0)
    if (!header || header.type !== 'moof') return null
    const moofEnd = Math.min(block.length, header.size)
    const traf = findChildBox(block, header.headerSize, moofEnd, 'traf')
    if (!traf) return null
    const tfdt = findChildBox(block, traf.contentStart, traf.contentEnd, 'tfdt')
    if (!tfdt) return null
    const version = block.readUInt8(tfdt.contentStart)
    const valueOffset = tfdt.contentStart + 4
    if (version === 1) {
      if (valueOffset + 8 > tfdt.contentEnd) return null
      const value = Number(block.readBigUInt64BE(valueOffset))
      return Number.isSafeInteger(value) ? value : null
    }
    if (valueOffset + 4 > tfdt.contentEnd) return null
    return block.readUInt32BE(valueOffset)
  } catch {
    return null
  }
}
