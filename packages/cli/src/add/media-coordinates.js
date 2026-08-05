import { MEDIA_COORDINATE_KINDS, MEDIA_COORDINATE_SHAPES } from '@peartube/backend/structured-content'
import { authorityKinds, canReadAuthority, isReadableAuthority, METADATA_AUTHORITIES } from './providers/index.js'
import { credentialEnvVars } from './preferences.js'

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

// The picker has screens for shows and movies only: music has no browse flow,
// so its coordinates arrive complete or not at all, and a track is never
// resolved against a catalogue the publisher did not name.
const BROWSABLE_KINDS = Object.freeze(['episode', 'movie'])

// Whether the interactive picker can browse this kind at this authority. A null
// kind asks only whether the authority itself is browsable; a null provider,
// only whether the kind is.
export function canBrowse (kind, provider) {
  if (kind != null && !BROWSABLE_KINDS.includes(kind)) return false
  if (provider == null) return true
  if (!isReadableAuthority(provider)) return false
  return authorityKinds(provider).some((candidate) => BROWSABLE_KINDS.includes(candidate))
}

// Why these coordinates cannot be looked up right now, or null when they can.
// Two states a publisher must be able to tell apart: an authority with no
// metadata client at all, and one whose credential nobody configured. Either
// way --title escapes, publishing exactly the coordinates and name supplied.
export function lookupRefusal (provider, preferences = {}) {
  if (!isReadableAuthority(provider)) {
    return `PearTube has no ${provider} metadata client to look those coordinates up; pass --title to publish them as supplied`
  }
  if (canReadAuthority(provider, preferences)) return null
  const [envVar] = credentialEnvVars(provider)
  return `${provider} needs ${envVar} configured before it can be read; set it, run peartube config, or pass --title`
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

// One line per authority naming the credential it is read with, extras in
// parentheses. Derived from the registry and the credential table, so an
// authority cannot gain a key the help text forgets to mention.
export function credentialHelp () {
  const width = Math.max(...METADATA_AUTHORITIES.map((authority) => authority.length))
  return METADATA_AUTHORITIES.map((authority) => {
    const [primary, ...extra] = credentialEnvVars(authority)
    const label = authority.padEnd(width)
    if (!primary) return `${label}  no credential required`
    return `${label}  ${primary}${extra.length > 0 ? ` (+ ${extra.join(', ')})` : ''}`
  })
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
