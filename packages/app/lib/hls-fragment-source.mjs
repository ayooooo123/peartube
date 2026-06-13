/**
 * Pure helpers for the MSE compat-fallback fragment source.
 *
 * The backend compat transcoder (cast-transcoder.mjs startCompatTranscode)
 * serves fMP4 HLS on 127.0.0.1: a master playlist, a media playlist with
 * `#EXT-X-MAP:URI="init.mp4"` + `seg-N.m4s` entries, and the segments
 * themselves. The MSE backend fetches these over local HTTP and appends them
 * to its SourceBuffer — fragments carry absolute timestamps (fMP4 tfdt), so
 * they land at the right place on the timeline without timestampOffset
 * bookkeeping. These parsing helpers are dependency-free so they can be
 * unit-tested with node:test.
 *
 * See docs/superpowers/plans/2026-06-11-desktop-mse-audio-transcode-fallback.md
 */

/** Resolve a (possibly relative) playlist/segment URI against a playlist URL. */
export function resolveAgainstPlaylist(playlistUrl, uri) {
  if (!uri) return null
  try {
    return new URL(uri, playlistUrl).toString()
  } catch {
    return null
  }
}

/** True when the text is a master playlist (variant streams, no segments). */
export function isMasterPlaylist(text) {
  if (typeof text !== 'string') return false
  return text.includes('#EXT-X-STREAM-INF') && !text.includes('#EXTINF')
}

/** Extract the first variant URI from a master playlist, or null. */
export function parseMasterPlaylist(text) {
  if (typeof text !== 'string') return null
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith('#EXT-X-STREAM-INF')) {
      for (let j = i + 1; j < lines.length; j++) {
        const candidate = lines[j].trim()
        if (!candidate) continue
        if (candidate.startsWith('#')) continue
        return candidate
      }
    }
  }
  return null
}

/**
 * Parse an fMP4 HLS media playlist.
 *
 * @returns {{
 *   initUri: string|null,
 *   segments: Array<{ uri: string, duration: number, start: number }>,
 *   ended: boolean,
 *   mediaSequence: number,
 *   targetDuration: number
 * }}
 */
export function parseMediaPlaylist(text) {
  const result = { initUri: null, segments: [], ended: false, mediaSequence: 0, targetDuration: 6 }
  if (typeof text !== 'string') return result

  let pendingDuration = null
  let cursor = 0
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('#EXT-X-MAP:')) {
      const match = line.match(/URI="([^"]+)"/)
      if (match) result.initUri = match[1]
      continue
    }
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      const value = Number(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length))
      if (Number.isFinite(value)) result.mediaSequence = value
      continue
    }
    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      const value = Number(line.slice('#EXT-X-TARGETDURATION:'.length))
      if (Number.isFinite(value) && value > 0) result.targetDuration = value
      continue
    }
    if (line.startsWith('#EXTINF:')) {
      const value = Number(line.slice('#EXTINF:'.length).split(',')[0])
      pendingDuration = Number.isFinite(value) && value > 0 ? value : 6
      continue
    }
    if (line === '#EXT-X-ENDLIST') {
      result.ended = true
      continue
    }
    if (line.startsWith('#')) continue
    const duration = pendingDuration ?? 6
    result.segments.push({ uri: line, duration, start: cursor })
    cursor += duration
    pendingDuration = null
  }
  return result
}

/**
 * Index of the segment whose [start, start+duration) window contains `time`.
 * Returns -1 when `time` is beyond the produced playlist (caller should wait
 * for the transcoder to catch up), clamping negative times to segment 0.
 */
export function findSegmentIndexForTime(segments, time) {
  if (!Array.isArray(segments) || segments.length === 0) return -1
  if (!(time > 0)) return 0
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    if (time < seg.start + seg.duration) return i
  }
  return -1
}

/**
 * SourceBuffer MIME candidates for the compat stream. The video track is
 * stream-copied in the common (audio-gap) case, so the original codec string
 * stays valid; audio is always AAC-LC (mp4a.40.2). A full transcode rewrites
 * video to H.264, covered by the avc1 fallbacks.
 */
export function buildCompatMimeCandidates(videoCodecString) {
  const candidates = []
  if (videoCodecString) candidates.push(`video/mp4; codecs="${videoCodecString}, mp4a.40.2"`)
  candidates.push(
    'video/mp4; codecs="avc1.640029, mp4a.40.2"',
    'video/mp4; codecs="hev1.1.6.L150.B0, mp4a.40.2"',
    'video/mp4',
  )
  return candidates
}

export default {
  resolveAgainstPlaylist,
  isMasterPlaylist,
  parseMasterPlaylist,
  parseMediaPlaylist,
  findSegmentIndexForTime,
  buildCompatMimeCandidates,
}
