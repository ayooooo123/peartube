import b4a from 'b4a'

const SERIES_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/
const TMDB_ID = /^[1-9][0-9]{0,19}$/
const EPISODE_FIELDS = [
  'seriesId',
  'seriesTitle',
  'mediaProvider',
  'mediaId',
  'seasonNumber',
  'episodeNumber',
  'expectedEpisodeCount',
]

function boundedString(value, name, maximum, pattern = null) {
  if (typeof value !== 'string' || value.length < 1 || value.trim() !== value ||
      value.includes('\0') || b4a.byteLength(value) > maximum ||
      (pattern && !pattern.test(value))) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

function positiveInteger(value, name, maximum = 100000) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be a positive bounded integer`)
  }
  return value
}

export function normalizeUploadVideoMediaMetadata(request = {}) {
  const hasEpisodeField = EPISODE_FIELDS.some(field => (
    typeof request[field] === 'number' ? request[field] > 0 : request[field] != null
  ))
  if (!hasEpisodeField && request.contentKind == null) return {}
  const contentKind = boundedString(request.contentKind, 'contentKind', 32)
  if (contentKind === 'movie') {
    for (const field of ['seriesId', 'seriesTitle', 'seasonNumber', 'episodeNumber', 'expectedEpisodeCount']) {
      if (request[field] != null) throw new Error(`movie upload cannot include ${field}`)
    }
    const hasMedia = request.mediaProvider != null || request.mediaId != null
    if (!hasMedia) return { contentKind }
    if (request.mediaProvider !== 'tmdb') throw new Error('mediaProvider is invalid')
    return {
      contentKind,
      mediaProvider: 'tmdb',
      mediaId: boundedString(request.mediaId, 'mediaId', 20, TMDB_ID),
    }
  }
  if (contentKind !== 'episode') throw new Error('episode metadata requires contentKind episode')
  for (const field of EPISODE_FIELDS) {
    if (request[field] == null) throw new Error(`episode upload requires ${field}`)
  }
  if (request.mediaProvider !== 'tmdb') throw new Error('mediaProvider is invalid')
  return {
    contentKind,
    seriesId: boundedString(request.seriesId, 'seriesId', 128, SERIES_ID),
    seriesTitle: boundedString(request.seriesTitle, 'seriesTitle', 512),
    mediaProvider: 'tmdb',
    mediaId: boundedString(request.mediaId, 'mediaId', 20, TMDB_ID),
    seasonNumber: positiveInteger(request.seasonNumber, 'seasonNumber'),
    episodeNumber: positiveInteger(request.episodeNumber, 'episodeNumber'),
    expectedEpisodeCount: positiveInteger(request.expectedEpisodeCount, 'expectedEpisodeCount'),
  }
}
