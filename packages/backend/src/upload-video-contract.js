import b4a from 'b4a'

import { MEDIA_COORDINATE_SHAPES, normalizeContentKind } from './channel/structured-content.js'

const SERIES_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/
const CATALOGUE_ID = /^[1-9][0-9]{0,19}$/
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// How each metadata authority spells the id of a work. MEDIA_COORDINATE_SHAPES
// says who may categorize what; this says what their ids look like, which is the
// only reason an MBID could not simply reuse the catalogue-number bound.
const MEDIA_ID_FORMATS = Object.freeze({
  tmdb: Object.freeze({ pattern: CATALOGUE_ID, maximum: 20, canonical: value => value }),
  tvdb: Object.freeze({ pattern: CATALOGUE_ID, maximum: 20, canonical: value => value }),
  musicbrainz: Object.freeze({ pattern: MBID, maximum: 36, canonical: value => value.toLowerCase() }),
})

// Framing that only a serialized work carries.
const SERIES_FIELDS = ['seriesId', 'seriesTitle', 'expectedEpisodeCount']
const ORDINAL_FIELDS = ['seasonNumber', 'episodeNumber']
const EPISODE_FIELDS = [
  'seriesId',
  'seriesTitle',
  'mediaProvider',
  'mediaId',
  ...ORDINAL_FIELDS,
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

function normalizeCoordinates(request, contentKind, shape) {
  const provider = boundedString(request.mediaProvider, 'mediaProvider', 64)
  if (!shape.providers.includes(provider)) throw new Error('mediaProvider is invalid')
  const format = MEDIA_ID_FORMATS[provider]
  if (!format) throw new Error('mediaProvider is invalid')
  const coordinates = {
    contentKind,
    mediaProvider: provider,
    mediaId: format.canonical(boundedString(request.mediaId, 'mediaId', format.maximum, format.pattern)),
  }
  for (const ordinal of shape.ordinals) coordinates[ordinal] = positiveInteger(request[ordinal], ordinal)
  return coordinates
}

export function normalizeUploadVideoMediaMetadata(request = {}) {
  const hasEpisodeField = EPISODE_FIELDS.some(field => (
    typeof request[field] === 'number' ? request[field] > 0 : request[field] != null
  ))
  if (!hasEpisodeField && request.contentKind == null) return {}
  const contentKind = normalizeContentKind(boundedString(request.contentKind, 'contentKind', 32))
  const shape = MEDIA_COORDINATE_SHAPES[contentKind]
  if (!shape) {
    // A kind no authority categorizes carries no coordinates at all, so a
    // supplied one is a contradiction rather than something to store.
    for (const field of EPISODE_FIELDS) {
      if (request[field] != null) throw new Error(`${contentKind} upload cannot include ${field}`)
    }
    return { contentKind }
  }

  // A coordinate a kind does not have is refused, not stored empty: a track has
  // no season, and only a serialized work has a series around it.
  for (const field of ORDINAL_FIELDS) {
    if (shape.ordinals.includes(field)) continue
    if (request[field] != null) throw new Error(`${contentKind} upload cannot include ${field}`)
  }
  if (contentKind !== 'episode') {
    for (const field of SERIES_FIELDS) {
      if (request[field] != null) throw new Error(`${contentKind} upload cannot include ${field}`)
    }
    const hasMedia = request.mediaProvider != null || request.mediaId != null
    if (!hasMedia) return { contentKind }
    return normalizeCoordinates(request, contentKind, shape)
  }

  for (const field of EPISODE_FIELDS) {
    if (request[field] == null) throw new Error(`episode upload requires ${field}`)
  }
  return {
    ...normalizeCoordinates(request, contentKind, shape),
    seriesId: boundedString(request.seriesId, 'seriesId', 128, SERIES_ID),
    seriesTitle: boundedString(request.seriesTitle, 'seriesTitle', 512),
    expectedEpisodeCount: positiveInteger(request.expectedEpisodeCount, 'expectedEpisodeCount'),
  }
}
