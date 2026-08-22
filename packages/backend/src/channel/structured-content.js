import b4a from 'b4a'
import sodium from 'sodium-universal'

const MAX_PROVIDER_LENGTH = 64
const MAX_ID_LENGTH = 256
const MAX_URL_LENGTH = 2048
const MAX_HANDLE_LENGTH = 256
const MAX_DISPLAY_LENGTH = 256
const MAX_LANGUAGE_LENGTH = 32
const MAX_MIME_TYPE_LENGTH = 128
const MAX_PROVENANCE_LENGTH = 256
const MAX_IDENTITY_KEY_LENGTH = 1024
const MAX_FINGERPRINT_LENGTH = 128
const MAX_JOB_ID_LENGTH = 256
const MAX_MANIFEST_HEX_LENGTH = 2 * 1024 * 1024
const MAX_OPERATION_FRAMES_HEX_LENGTH = 2 * (2 + 3 * (4 + 1024 * 1024))

const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._-]*$/
const WRITER_KEY_PATTERN = /^[0-9a-f]{64}$/i
const CLAIMANT_ID_PATTERN = /^[0-9a-f]{64}$/
const SHA256_FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/
const HEX_32_PATTERN = /^[0-9a-f]{64}$/
const MANIFEST_HEX_PATTERN = /^(?:[0-9a-f]{2})+$/
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/
const CLAIM_STATES = new Set(['reserved', 'published', 'released'])
const CLAIM_DOMAIN = b4a.from('peartube-import-claim/v1\0')
const ZERO_BYTE = b4a.from('\0')

export const PROFILE_KINDS = new Set(['standard', 'tvShow', 'movie', 'creator'])
export const CONTENT_KINDS = new Set(['episode', 'movie', 'video', 'stream', 'trailer', 'extra', 'track', 'release'])
export const PUBLICATION_STATES = new Set(['replicationPending', 'commitUncertain', 'durabilityVerified', 'published'])
export const ARTWORK_ROLES = new Set(['avatar', 'poster', 'banner', 'backdrop'])

// Which metadata authority may categorize which kind of work, and the exact
// coordinate shape that pairing takes. One table, because the alternative is a
// provider name spelled separately into a validator, an identity key and a CLI
// flag — and those three drifting is how `tvdb` came to be a declared
// namespace that the one place which mattered refused by name, and how
// MusicBrainz came to have reference namespaces no publication could reach.
//
// `ordinals` are the coordinate fields a kind requires and, by omission, the
// ones it may not carry: a track has no season, an album has no episode. A
// kind absent from this table takes no media coordinates at all.
export const MEDIA_COORDINATE_SHAPES = Object.freeze({
  episode: Object.freeze({ providers: Object.freeze(['tmdb', 'tvdb']), ordinals: Object.freeze(['seasonNumber', 'episodeNumber']) }),
  movie: Object.freeze({ providers: Object.freeze(['tmdb', 'tvdb']), ordinals: Object.freeze([]) }),
  track: Object.freeze({ providers: Object.freeze(['musicbrainz']), ordinals: Object.freeze([]) }),
  release: Object.freeze({ providers: Object.freeze(['musicbrainz']), ordinals: Object.freeze([]) }),
})

export const MEDIA_COORDINATE_KINDS = Object.freeze(Object.keys(MEDIA_COORDINATE_SHAPES))

// A channel and a work do not illustrate themselves the same way, and asset
// bindings require every role ARTWORK_ROLES names. Content roles therefore live
// in their own set: widening the channel set silently demands new bound assets.
export const CONTENT_ARTWORK_ROLES = new Set(['poster', 'backdrop', 'thumbnail', 'still'])

function sha256Hex (payload) {
  const digest = b4a.allocUnsafe(sodium.crypto_hash_sha256_BYTES)
  sodium.crypto_hash_sha256(digest, payload)
  return b4a.toString(digest, 'hex')
}

function assertRecord (value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${name} must be a plain object`)
  }
  return value
}

function assertAllowedFields (value, allowed, name) {
  assertRecord(value, name)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`${name} contains unknown field ${String(key)}`)
    }
  }
  return value
}

function requiredString (value, name, maxLength, pattern = null) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || value.trim() !== value || value.includes('\0')) {
    throw new Error(`${name} must be a non-empty string of at most ${maxLength} characters`)
  }
  if (pattern !== null && !pattern.test(value)) throw new Error(`${name} is malformed`)
  return value
}

function optionalString (value, name, maxLength, pattern = null) {
  if (value === undefined || value === null) return undefined
  return requiredString(value, name, maxLength, pattern)
}

function optionalSafeInteger (value, name) {
  if (value === undefined || value === null) return undefined
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`)
  return value
}

function assignString (out, input, field, maxLength, pattern = null) {
  const value = optionalString(input[field], field, maxLength, pattern)
  if (value !== undefined) out[field] = value
}

function assignInteger (out, input, field) {
  const value = optionalSafeInteger(input[field], field)
  if (value !== undefined) out[field] = value
}

function assignPersistedInteger (out, input, field) {
  const value = optionalSafeInteger(input[field], field)
  if (value === Number.MAX_SAFE_INTEGER) {
    throw new Error(`${field} must be less than Number.MAX_SAFE_INTEGER`)
  }
  if (value !== undefined) out[field] = value
}

function normalizeSetValue (value, values, name) {
  if (typeof value !== 'string' || !values.has(value)) throw new Error(`invalid ${name}: ${String(value)}`)
  return value
}

export function normalizeProfileKind (value) {
  if (value === 'TV_SHOW') return 'tvShow'
  return normalizeSetValue(value, PROFILE_KINDS, 'profile kind')
}

export function normalizeContentKind (value) {
  return normalizeSetValue(value, CONTENT_KINDS, 'content kind')
}

export function normalizePublicationState (value) {
  return normalizeSetValue(value, PUBLICATION_STATES, 'publication state')
}

export function normalizeArtworkRole (value) {
  return normalizeSetValue(value, ARTWORK_ROLES, 'artwork role')
}

export function normalizeContentArtworkRole (value) {
  return normalizeSetValue(value, CONTENT_ARTWORK_ROLES, 'content artwork role')
}

export function normalizePublicationOperationFramesHex (value) {
  return requiredString(
    value,
    'publicationOperationFramesHex',
    MAX_OPERATION_FRAMES_HEX_LENGTH,
    MANIFEST_HEX_PATTERN
  )
}

const PROFILE_FIELDS = new Set([
  'id',
  'profileKind',
  'mediaProvider',
  'mediaId',
  'originalLanguage',
  'releaseDate',
  'releaseYear'
])

export function normalizeChannelProfile (profile) {
  const input = assertAllowedFields(profile, PROFILE_FIELDS, 'channel profile')
  const out = { id: requiredString(input.id, 'id', MAX_ID_LENGTH) }

  if (input.profileKind !== undefined && input.profileKind !== null) out.profileKind = normalizeProfileKind(input.profileKind)
  assignString(out, input, 'mediaProvider', MAX_PROVIDER_LENGTH, PROVIDER_PATTERN)
  assignString(out, input, 'mediaId', MAX_ID_LENGTH)
  assignString(out, input, 'originalLanguage', MAX_LANGUAGE_LENGTH)
  assignPersistedInteger(out, input, 'releaseDate')
  assignPersistedInteger(out, input, 'releaseYear')
  return out
}

const CONTENT_FIELDS = new Set([
  'id',
  'contentKind',
  'sourceProvider',
  'sourceVideoId',
  'identityUrl',
  'sourceCreatorId',
  'sourceCreatorUrl',
  'sourcePublishedAt',
  'mediaProvider',
  'mediaId',
  'seasonNumber',
  'episodeNumber',
  'originalAirDate',
  'thumbnailUrl',
  'artwork',
  'provenanceVersion',
  'publicationState',
  'contentFingerprint',
  'importIdentityKey',
  'importClaimantId',
  'publication'
])

// The publication cluster is persisted as one nested record. Every value keeps
// the bounds it had as a flat column: 32-byte hex for each identity, the
// persisted-integer path for the sequence, and the manifest hex bound.
const CONTENT_PUBLICATION_ID_FIELDS = [
  'publicationId',
  'manifestId',
  'renditionId',
  'assetId',
  'coreKey',
  'publisherId',
  'metadataClaimId',
  'availabilityClaimId',
  'publicationOperationId',
  'metadataClaimOperationId',
  'availabilityClaimOperationId'
]
const CONTENT_PUBLICATION_FIELDS = new Set([
  ...CONTENT_PUBLICATION_ID_FIELDS,
  'sequence',
  'manifestHex'
])

function normalizeContentPublication (publication) {
  const input = assertAllowedFields(publication, CONTENT_PUBLICATION_FIELDS, 'content publication')
  const out = {}
  for (const field of CONTENT_PUBLICATION_ID_FIELDS) {
    assignString(out, input, field, 64, HEX_32_PATTERN)
  }
  assignPersistedInteger(out, input, 'sequence')
  assignString(out, input, 'manifestHex', MAX_MANIFEST_HEX_LENGTH, MANIFEST_HEX_PATTERN)
  return out
}

export function normalizeContentDetails (details) {
  const input = assertAllowedFields(details, CONTENT_FIELDS, 'content details')
  const out = { id: requiredString(input.id, 'id', MAX_ID_LENGTH) }

  if (input.contentKind !== undefined && input.contentKind !== null) out.contentKind = normalizeContentKind(input.contentKind)
  assignString(out, input, 'sourceProvider', MAX_PROVIDER_LENGTH, PROVIDER_PATTERN)
  assignString(out, input, 'sourceVideoId', MAX_ID_LENGTH)
  assignString(out, input, 'identityUrl', MAX_URL_LENGTH)
  assignString(out, input, 'sourceCreatorId', MAX_ID_LENGTH)
  assignString(out, input, 'sourceCreatorUrl', MAX_URL_LENGTH)
  assignPersistedInteger(out, input, 'sourcePublishedAt')
  assignString(out, input, 'mediaProvider', MAX_PROVIDER_LENGTH, PROVIDER_PATTERN)
  assignString(out, input, 'mediaId', MAX_ID_LENGTH)
  assignPersistedInteger(out, input, 'seasonNumber')
  assignPersistedInteger(out, input, 'episodeNumber')
  assignPersistedInteger(out, input, 'originalAirDate')
  assignString(out, input, 'thumbnailUrl', MAX_URL_LENGTH)
  if (input.artwork !== undefined && input.artwork !== null) {
    out.artwork = normalizeContentArtworkList(input.artwork)
  }
  assignString(out, input, 'provenanceVersion', MAX_PROVENANCE_LENGTH)
  if (input.publicationState !== undefined && input.publicationState !== null) {
    out.publicationState = normalizePublicationState(input.publicationState)
  }
  assignString(out, input, 'contentFingerprint', MAX_FINGERPRINT_LENGTH, SHA256_FINGERPRINT_PATTERN)
  if (input.publication !== undefined && input.publication !== null) {
    const publication = normalizeContentPublication(input.publication)
    if (Object.keys(publication).length > 0) out.publication = publication
  }
  const normalizedImportIdentityKey = optionalString(input.importIdentityKey, 'importIdentityKey', MAX_IDENTITY_KEY_LENGTH)
  const normalizedImportClaimantId = optionalString(input.importClaimantId, 'importClaimantId', 64, CLAIMANT_ID_PATTERN)
  if ((normalizedImportIdentityKey === undefined) !== (normalizedImportClaimantId === undefined)) {
    throw new Error('importIdentityKey and importClaimantId must be supplied together')
  }
  if (normalizedImportIdentityKey !== undefined) {
    const expectedIdentityKey = importIdentityKey({
      contentKind: out.contentKind,
      sourceProvider: out.sourceProvider,
      sourceVideoId: out.sourceVideoId,
      mediaProvider: out.mediaProvider,
      mediaId: out.mediaId,
      seasonNumber: out.seasonNumber,
      episodeNumber: out.episodeNumber,
      contentFingerprint: out.contentFingerprint
    })
    if (normalizedImportIdentityKey !== expectedIdentityKey) {
      throw new Error('importIdentityKey must match normalized content identity')
    }
    out.importIdentityKey = normalizedImportIdentityKey
    out.importClaimantId = normalizedImportClaimantId
  }
  return out
}

const IMPORT_IDENTITY_FIELDS = new Set([
  'contentKind',
  'sourceProvider',
  'sourceVideoId',
  'mediaProvider',
  'mediaId',
  'seasonNumber',
  'episodeNumber',
  'contentFingerprint'
])

export function importIdentityKey (identity) {
  const input = assertAllowedFields(identity, IMPORT_IDENTITY_FIELDS, 'import identity')
  const contentKind = normalizeContentKind(input.contentKind)
  const sourceProvider = optionalString(input.sourceProvider, 'sourceProvider', MAX_PROVIDER_LENGTH, PROVIDER_PATTERN)
  const sourceVideoId = optionalString(input.sourceVideoId, 'sourceVideoId', MAX_ID_LENGTH)
  const mediaProvider = optionalString(input.mediaProvider, 'mediaProvider', MAX_PROVIDER_LENGTH, PROVIDER_PATTERN)
  const mediaId = optionalString(input.mediaId, 'mediaId', MAX_ID_LENGTH)
  const seasonNumber = optionalSafeInteger(input.seasonNumber, 'seasonNumber')
  const episodeNumber = optionalSafeInteger(input.episodeNumber, 'episodeNumber')
  const contentFingerprint = optionalString(input.contentFingerprint, 'contentFingerprint', MAX_FINGERPRINT_LENGTH)

  const hasSourceGroup = sourceProvider !== undefined || sourceVideoId !== undefined
  if (hasSourceGroup && (sourceProvider === undefined || sourceVideoId === undefined)) {
    throw new Error('import identity requires both sourceProvider and sourceVideoId')
  }

  const ordinals = { seasonNumber, episodeNumber }
  const hasMediaGroup = mediaProvider !== undefined || mediaId !== undefined ||
    seasonNumber !== undefined || episodeNumber !== undefined
  if (hasMediaGroup) {
    const shape = MEDIA_COORDINATE_SHAPES[contentKind]
    if (!shape) throw new Error(`import identity ${contentKind} cannot use media coordinates`)
    if (!shape.providers.includes(mediaProvider)) {
      throw new Error(`import identity ${contentKind} coordinates require one of ${shape.providers.join(', ')}`)
    }
    if (mediaId === undefined) throw new Error(`import identity ${contentKind} coordinates require mediaId`)
    for (const [name, value] of Object.entries(ordinals)) {
      const required = shape.ordinals.includes(name)
      if (required && value === undefined) {
        throw new Error(`import identity ${contentKind} coordinates require ${name}`)
      }
      // A coordinate a kind does not have is refused, not stored empty: a track
      // with a season number is a mistake someone should hear about.
      if (!required && value !== undefined) {
        throw new Error(`import identity ${contentKind} coordinates cannot carry ${name}`)
      }
    }
  }

  if (contentFingerprint !== undefined && !SHA256_FINGERPRINT_PATTERN.test(contentFingerprint)) {
    throw new Error('import identity contentFingerprint must be a lowercase SHA-256 fingerprint')
  }

  if (hasSourceGroup) return `${sourceProvider}:${contentKind}:${sourceVideoId}`
  // The tmdb spellings below are byte-identical to the ones this function has
  // always produced. They are durable idempotency identities recorded in
  // published claims, so a tidier scheme would orphan every import already in
  // the network and re-fetch all of it.
  if (hasMediaGroup && contentKind === 'episode') {
    return `${mediaProvider}:episode:show:${mediaId}:s${seasonNumber}:e${episodeNumber}`
  }
  if (hasMediaGroup) return `${mediaProvider}:${contentKind}:${mediaId}`
  if (contentFingerprint !== undefined) return `fingerprint:${contentFingerprint}`
  throw new Error('import identity is insufficient or ambiguous')
}

const SOURCE_IDENTITY_FIELDS = new Set(['provider', 'sourceId', 'identityUrl'])

export function channelSourceIdentityKey (source) {
  const input = assertAllowedFields(source, SOURCE_IDENTITY_FIELDS, 'channel source identity')
  optionalString(input.provider, 'provider', MAX_PROVIDER_LENGTH, PROVIDER_PATTERN)
  const sourceId = optionalString(input.sourceId, 'sourceId', MAX_ID_LENGTH)
  const identityUrl = optionalString(input.identityUrl, 'identityUrl', MAX_URL_LENGTH)
  if (sourceId !== undefined) return `id:${sourceId}`
  if (identityUrl !== undefined) {
    return `url:sha256:${sha256Hex(b4a.from(identityUrl))}`
  }
  throw new Error('channel source requires sourceId or identityUrl')
}

const CHANNEL_SOURCE_FIELDS = new Set([
  'provider',
  'identityKey',
  'sourceId',
  'identityUrl',
  'handle',
  'displayName',
  'createdAt',
  'updatedAt'
])

export function normalizeChannelSource (source) {
  const input = assertAllowedFields(source, CHANNEL_SOURCE_FIELDS, 'channel source')
  const provider = requiredString(input.provider, 'provider', MAX_PROVIDER_LENGTH, PROVIDER_PATTERN)
  const sourceId = optionalString(input.sourceId, 'sourceId', MAX_ID_LENGTH)
  const identityUrl = optionalString(input.identityUrl, 'identityUrl', MAX_URL_LENGTH)
  const identityKey = channelSourceIdentityKey({ sourceId, identityUrl })
  const suppliedIdentityKey = optionalString(input.identityKey, 'identityKey', MAX_IDENTITY_KEY_LENGTH)
  if (suppliedIdentityKey !== undefined && suppliedIdentityKey !== identityKey) {
    throw new Error('identityKey does not match channel source identity')
  }

  const out = { provider, identityKey }
  if (sourceId !== undefined) out.sourceId = sourceId
  if (identityUrl !== undefined) out.identityUrl = identityUrl
  assignString(out, input, 'handle', MAX_HANDLE_LENGTH)
  assignString(out, input, 'displayName', MAX_DISPLAY_LENGTH)
  assignPersistedInteger(out, input, 'createdAt')
  assignPersistedInteger(out, input, 'updatedAt')
  return out
}

const MAX_CONTENT_ARTWORK_ENTRIES = 8

const CHANNEL_ARTWORK_FIELDS = new Set([
  'role',
  'blobId',
  'blobsCoreKey',
  'mimeType',
  'remoteUrl',
  'updatedAt'
])

// Cover art reaches a consumer only as publisher-signed metadata, and it
// originates in operator form input. Every entry is validated with the same
// role and URL rules as channel artwork before it can be signed into a claim.
export function normalizeContentArtworkList (artwork) {
  if (!Array.isArray(artwork)) throw new Error('artwork must be an array')
  if (artwork.length > MAX_CONTENT_ARTWORK_ENTRIES) {
    throw new Error(`artwork must hold at most ${MAX_CONTENT_ARTWORK_ENTRIES} entries`)
  }
  const out = []
  const seenRoles = new Set()
  for (const entry of artwork) {
    const normalized = normalizeChannelArtwork(entry, normalizeContentArtworkRole)
    // Content artwork is published through the media-graph content-artwork
    // struct, which carries no updatedAt. Dropping it here keeps a claim from
    // signing a field the wire format cannot represent.
    delete normalized.updatedAt
    if (normalized.blobId === undefined && normalized.remoteUrl === undefined) {
      throw new Error('artwork requires either blobId or remoteUrl')
    }
    if (seenRoles.has(normalized.role)) throw new Error(`artwork role ${normalized.role} is duplicated`)
    seenRoles.add(normalized.role)
    out.push(normalized)
  }
  return out
}

export function normalizeChannelArtwork (artwork, normalizeRole = normalizeArtworkRole) {
  const input = assertAllowedFields(artwork, CHANNEL_ARTWORK_FIELDS, 'channel artwork')
  const out = { role: normalizeRole(input.role) }
  assignString(out, input, 'blobId', MAX_ID_LENGTH)
  assignString(out, input, 'blobsCoreKey', MAX_ID_LENGTH)
  assignString(out, input, 'mimeType', MAX_MIME_TYPE_LENGTH)
  assignString(out, input, 'remoteUrl', MAX_URL_LENGTH)
  assignPersistedInteger(out, input, 'updatedAt')
  return out
}

function normalizeWriterKey (value, name) {
  return requiredString(value, name, 64, WRITER_KEY_PATTERN).toLowerCase()
}

function normalizeJobId (value, name) {
  return requiredString(value, name, MAX_JOB_ID_LENGTH, JOB_ID_PATTERN)
}

export function deriveImportClaimantId (writerKeyHex, durableJobId) {
  const normalizedWriterKey = normalizeWriterKey(writerKeyHex, 'writerKeyHex')
  const jobId = normalizeJobId(durableJobId, 'durableJobId')
  const payload = b4a.concat([
    CLAIM_DOMAIN,
    b4a.from(normalizedWriterKey, 'hex'),
    ZERO_BYTE,
    b4a.from(jobId)
  ])
  return sha256Hex(payload)
}

const IMPORT_CLAIM_FIELDS = new Set([
  'identityKey',
  'claimantId',
  'jobId',
  'writerKey',
  'videoId',
  'state',
  'createdAt',
  'updatedAt',
  'releasedAt'
])

export function normalizeImportClaim (claim) {
  const input = assertAllowedFields(claim, IMPORT_CLAIM_FIELDS, 'import claim')
  const identityKey = requiredString(input.identityKey, 'identityKey', MAX_IDENTITY_KEY_LENGTH)
  const claimantId = requiredString(input.claimantId, 'claimantId', 64, CLAIMANT_ID_PATTERN)
  const jobId = normalizeJobId(input.jobId, 'jobId')
  const writerKey = normalizeWriterKey(input.writerKey, 'writerKey')
  if (claimantId !== deriveImportClaimantId(writerKey, jobId)) {
    throw new Error('claimantId must match the derived writerKey and jobId')
  }

  const out = { identityKey, claimantId, jobId, writerKey }
  assignString(out, input, 'videoId', MAX_ID_LENGTH)
  if (input.state !== undefined && input.state !== null) out.state = normalizeSetValue(input.state, CLAIM_STATES, 'state')
  assignInteger(out, input, 'createdAt')
  assignInteger(out, input, 'updatedAt')
  assignInteger(out, input, 'releasedAt')
  if (out.state === 'released' && out.releasedAt === undefined) {
    throw new Error('releasedAt is required for a released import claim')
  }
  return out
}

export function resolveClaimWinner (claims = []) {
  if (!Array.isArray(claims)) throw new Error('claims must be an array')
  let winner = null
  for (const claim of claims) {
    if (claim === null || typeof claim !== 'object' || claim.state === 'released') continue
    if (typeof claim.claimantId !== 'string' || claim.claimantId.length === 0) continue
    if (winner === null || claim.claimantId < winner.claimantId) winner = claim
  }
  return winner
}
