import { MEDIA_COORDINATE_SHAPES } from '@peartube/backend/structured-content'

// Where each metadata authority lives and what it needs before it can answer.
//
// Which KINDS an authority may describe is not repeated here: that is
// MEDIA_COORDINATE_SHAPES in the backend, and this file derives from it. An
// authority added to the shapes table and left out of this one is a coordinate
// a publisher can supply by hand but nothing can look up — which is a real
// state (it is exactly what tvdb and musicbrainz were), so it is reported
// rather than made impossible.
const AUTHORITY_MODULES = Object.freeze({
  tmdb: Object.freeze({
    module: './tmdb.js',
    factory: 'createTmdbProvider',
    // The preferences key holding this authority's credential, or null when it
    // needs none. MusicBrainz is open; it asks for a User-Agent, not a key.
    secretKey: 'tmdbApiKey',
    missingSecretCode: 'ERR_TMDB_MISSING_KEY'
  }),
  tvdb: Object.freeze({
    module: './tvdb.js',
    factory: 'createTvdbProvider',
    secretKey: 'tvdbApiKey',
    missingSecretCode: 'ERR_TVDB_MISSING_KEY'
  }),
  musicbrainz: Object.freeze({
    module: './musicbrainz.js',
    factory: 'createMusicBrainzProvider',
    secretKey: null,
    missingSecretCode: null
  })
})

export const METADATA_AUTHORITIES = Object.freeze(Object.keys(AUTHORITY_MODULES))

// The kinds an authority is allowed to describe, straight from the coordinate
// table so the two can never disagree.
export function authorityKinds (authority) {
  const kinds = []
  for (const [kind, shape] of Object.entries(MEDIA_COORDINATE_SHAPES)) {
    if (shape.providers.includes(authority)) kinds.push(kind)
  }
  return kinds
}

// Whether this authority can be read at all, as opposed to only written by a
// publisher supplying coordinates by hand.
export function isReadableAuthority (authority) {
  return Object.prototype.hasOwnProperty.call(AUTHORITY_MODULES, authority)
}

// Whether this authority can be read *right now*, given the credentials on
// hand. An authority needing a key nobody configured is readable in principle
// and unusable in fact, and callers must be able to tell those apart.
export function authoritySecretKey (authority) {
  return AUTHORITY_MODULES[authority]?.secretKey ?? null
}

export function canReadAuthority (authority, preferences = {}) {
  const descriptor = AUTHORITY_MODULES[authority]
  if (!descriptor) return false
  if (descriptor.secretKey === null) return true
  const secret = preferences[descriptor.secretKey]
  return typeof secret === 'string' && secret.trim().length > 0
}

export class MetadataAuthorityError extends Error {
  constructor (message, { code } = {}) {
    super(message)
    this.name = 'MetadataAuthorityError'
    this.code = code
  }
}

/**
 * Build the client for one authority. `loadModule` is injectable so a test can
 * exercise the wiring without reaching the network, matching how `add` already
 * injects its other dependencies.
 */
export async function createMetadataProvider (authority, {
  preferences = {},
  loadModule = specifier => import(specifier),
  ...options
} = {}) {
  const descriptor = AUTHORITY_MODULES[authority]
  if (!descriptor) {
    throw new MetadataAuthorityError(
      `No metadata client exists for "${authority}"; readable authorities are ${METADATA_AUTHORITIES.join(', ')}`,
      { code: 'ERR_AUTHORITY_UNREADABLE' }
    )
  }
  if (descriptor.secretKey !== null && !canReadAuthority(authority, preferences)) {
    throw new MetadataAuthorityError(
      `${authority} needs a configured API key before it can be read`,
      { code: descriptor.missingSecretCode }
    )
  }
  const loaded = await loadModule(descriptor.module)
  const factory = loaded?.[descriptor.factory]
  if (typeof factory !== 'function') {
    throw new MetadataAuthorityError(
      `${descriptor.module} does not export ${descriptor.factory}`,
      { code: 'ERR_AUTHORITY_MODULE' }
    )
  }
  const secret = descriptor.secretKey === null ? undefined : preferences[descriptor.secretKey]
  return factory({ ...(secret === undefined ? {} : { apiKey: secret }), ...options })
}
