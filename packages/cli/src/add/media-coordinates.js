import { MEDIA_COORDINATE_KINDS, MEDIA_COORDINATE_SHAPES } from '@peartube/backend/structured-content'

// MEDIA_COORDINATE_SHAPES owns which metadata authority may categorize which
// kind of work and which ordinals that kind carries. This module owns nothing
// but the command-line spelling of those coordinates, so widening the table is
// the whole of adding an authority: no provider name is written twice.
const MEDIA_ID_FLAGS = Object.freeze({
  episode: Object.freeze(['showId', '--show-id']),
  movie: Object.freeze(['movieId', '--movie-id']),
  track: Object.freeze(['recordingId', '--recording-id']),
  release: Object.freeze(['releaseId', '--release-id'])
})

const ORDINAL_FLAGS = Object.freeze({
  seasonNumber: Object.freeze(['season', '--season']),
  episodeNumber: Object.freeze(['episode', '--episode'])
})

const KIND_LABELS = Object.freeze({
  episode: 'Episode',
  movie: 'Movie',
  track: 'Track',
  release: 'Release'
})

const MEDIA_PROVIDERS = Object.freeze([...new Set(
  MEDIA_COORDINATE_KINDS.flatMap((kind) => MEDIA_COORDINATE_SHAPES[kind].providers)
)])

// What `add` can publish: every kind the coordinate table categorizes, plus a
// direct video that no metadata authority categorizes at all.
export const CONTENT_TYPES = Object.freeze([...MEDIA_COORDINATE_KINDS, 'video'])

// The authorities PearTube can actually ask. TMDB is the only one with a
// metadata client, so it is also the only one the interactive picker can
// browse: every other authority publishes exactly the coordinates and title the
// publisher supplied, and is never resolved against a catalogue it did not name.
const QUERYABLE_PROVIDERS = Object.freeze(['tmdb'])

export function isQueryable (provider) {
  return QUERYABLE_PROVIDERS.includes(provider)
}

// "tmdb|tvdb (episode, movie); musicbrainz (track, release)" — help text that
// cannot fall behind the table it describes.
export function providerHelp () {
  const groups = new Map()
  for (const kind of MEDIA_COORDINATE_KINDS) {
    const providers = MEDIA_COORDINATE_SHAPES[kind].providers.join('|')
    if (!groups.has(providers)) groups.set(providers, [])
    groups.get(providers).push(kind)
  }
  return [...groups].map(([providers, kinds]) => `${providers} (${kinds.join(', ')})`).join('; ')
}

export function mediaShape (kind) {
  return (kind && MEDIA_COORDINATE_SHAPES[kind]) || null
}

export function modeLabel (kind) {
  return KIND_LABELS[kind] || kind
}

// `[[flagKey, flagName], ...]` for one kind: the media id, then its ordinals in
// table order. A kind the shape table gains without a spelling here fails loudly
// rather than quietly becoming coordinate-less.
export function coordinateFlags (kind) {
  const shape = mediaShape(kind)
  if (!shape) return []
  const id = MEDIA_ID_FLAGS[kind]
  if (!id) throw new Error(`no command-line spelling for ${kind} media coordinates`)
  return [id, ...shape.ordinals.map((ordinal) => {
    const flag = ORDINAL_FLAGS[ordinal]
    if (!flag) throw new Error(`no command-line spelling for the ${ordinal} coordinate`)
    return flag
  })]
}

export const ALL_COORDINATE_FLAGS = Object.freeze(
  [...new Map(MEDIA_COORDINATE_KINDS.flatMap(coordinateFlags).map((flag) => [flag[0], flag])).values()]
)

function joinAnd (parts) {
  if (parts.length < 2) return parts.join('')
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`
}

// "--provider tmdb|tvdb, --show-id, --season, and --episode"
export function coordinateRequirement (kind) {
  const shape = mediaShape(kind)
  if (!shape) return null
  return joinAnd([`--provider ${shape.providers.join('|')}`, ...coordinateFlags(kind).map(([, flag]) => flag)])
}

export function coordinatesComplete (kind, flags) {
  if (!mediaShape(kind)) return false
  return Boolean(flags.provider) && coordinateFlags(kind).every(([key]) => Object.hasOwn(flags, key))
}

// The reason the table refuses this authority for this kind, or null when it
// allows it. Naming what IS allowed is the point: a bare refusal by provider
// name is what made `tvdb` a declared namespace nothing could publish to.
export function providerRefusal (kind, provider) {
  if (!provider) return null
  const shape = mediaShape(kind)
  if (shape) {
    if (shape.providers.includes(provider)) return null
    return `Provider "${provider}" is not available for ${kind}; ${kind} coordinates require ${coordinateRequirement(kind)}`
  }
  if (MEDIA_PROVIDERS.includes(provider)) return null
  return `Provider "${provider}" is not available; supported providers are ${MEDIA_PROVIDERS.join(', ')}`
}

// The reason the supplied coordinates cannot be this kind's, or null. A
// coordinate the kind does not have is refused rather than ignored: a track with
// a season number is a mistake someone should hear about.
export function coordinateRefusal (kind, flags) {
  if (!mediaShape(kind)) return null
  const own = new Set(coordinateFlags(kind).map(([key]) => key))
  const requirement = coordinateRequirement(kind)
  for (const [key, flag] of ALL_COORDINATE_FLAGS) {
    if (own.has(key) || !Object.hasOwn(flags, key)) continue
    return `${modeLabel(kind)} mode does not accept ${flag}; ${kind} coordinates are ${requirement}`
  }
  for (const ordinal of mediaShape(kind).ordinals) {
    const [key, flag] = ORDINAL_FLAGS[ordinal]
    if (!Object.hasOwn(flags, key)) continue
    const value = Number(flags[key])
    if (!Number.isSafeInteger(value) || value < 1) return `${flag} must be a positive integer`
  }
  return null
}

// The kinds whose coordinates appear in `flags`, in table order. More than one
// without a `--type` to disambiguate is a contradiction, not a default.
function coordinateKindsIn (flags) {
  return MEDIA_COORDINATE_KINDS.filter((kind) => coordinateFlags(kind).some(([key]) => Object.hasOwn(flags, key)))
}

export function coordinateCollision (flags) {
  const kinds = coordinateKindsIn(flags)
  if (kinds.length < 2) return null
  return `Cannot combine ${joinAnd(kinds)} coordinates`
}

// The publisher's coordinates exactly as supplied. A metadata client's own
// notion of provider never overrides them, and a coordinate the kind does not
// have is absent rather than null-filled.
export function readMediaCoordinates (kind, flags) {
  const shape = mediaShape(kind)
  if (!shape) return null
  const [idKey] = MEDIA_ID_FLAGS[kind]
  const coordinates = {
    mediaProvider: flags.provider,
    mediaId: flags[idKey] != null ? String(flags[idKey]) : null
  }
  for (const ordinal of shape.ordinals) {
    const [key] = ORDINAL_FLAGS[ordinal]
    coordinates[ordinal] = Number(flags[key])
  }
  return coordinates
}
