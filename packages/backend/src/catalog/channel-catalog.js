import b4a from 'b4a'

const CURSOR_VERSION = 1
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const MAX_CURSOR_LENGTH = 2048
const MAX_CHANNEL_KEY_LENGTH = 256
const MAX_GROUP_ID_LENGTH = 64
const MAX_ITEM_ID_LENGTH = 256

const PROFILE_STRING_LIMITS = Object.freeze({
  channelKey: MAX_CHANNEL_KEY_LENGTH,
  name: 1024,
  description: 16_384,
  profileKind: 32,
  mediaProvider: 64,
  mediaId: 256,
  originalLanguage: 32,
})
const PROFILE_INTEGER_FIELDS = Object.freeze(['releaseDate', 'releaseYear', 'createdAt', 'updatedAt'])
const SOURCE_STRING_LIMITS = Object.freeze({
  provider: 64,
  identityKey: 1024,
  sourceId: 256,
  identityUrl: 2048,
  handle: 256,
  displayName: 256,
})
const ARTWORK_STRING_LIMITS = Object.freeze({
  role: 32,
  blobId: 256,
  blobsCoreKey: 256,
  mimeType: 128,
  remoteUrl: 2048,
})
const ITEM_STRING_LIMITS = Object.freeze({
  id: MAX_ITEM_ID_LENGTH,
  title: 4096,
  description: 16_384,
  contentKind: 32,
  sourceProvider: 64,
  sourceVideoId: 256,
  identityUrl: 2048,
  sourceCreatorId: 256,
  sourceCreatorUrl: 2048,
  mediaProvider: 64,
  mediaId: 256,
  blobId: 256,
  blobsCoreKey: 256,
  mimeType: 128,
  thumbnailUrl: 2048,
  thumbnailBlobId: 256,
  thumbnailBlobsCoreKey: 256,
  thumbnailMimeType: 128,
  provenanceVersion: 256,
  contentFingerprint: 128,
  publicationState: 64,
})
const ITEM_INTEGER_FIELDS = Object.freeze([
  'sourcePublishedAt',
  'seasonNumber',
  'episodeNumber',
  'originalAirDate',
  'duration',
  'uploadedAt',
])
const ITEM_WIRE_FIELDS = Object.freeze([
  'description',
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
  'duration',
  'blobId',
  'blobsCoreKey',
  'mimeType',
  'thumbnailUrl',
  'thumbnailBlobId',
  'thumbnailBlobsCoreKey',
  'thumbnailMimeType',
  'provenanceVersion',
  'contentFingerprint',
  'publicationState',
])
const PROFILE_KINDS = new Set(['standard', 'tvShow', 'movie', 'creator'])

class CatalogInputError extends Error {
  constructor (code, message) {
    super(message)
    this.name = 'CatalogInputError'
    this.code = code
  }
}

function failCursor () {
  throw new CatalogInputError('INVALID_CURSOR', 'Invalid catalog cursor')
}

function failInput (message) {
  throw new CatalogInputError('INVALID_CATALOG_INPUT', message)
}

function failLimit () {
  throw new CatalogInputError('INVALID_LIMIT', `Catalog page limit must be an integer between 1 and ${MAX_LIMIT}`)
}

function readOwnDataValues (value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) failInput(`${name} must be a plain object`)
  let prototype
  let keys
  try {
    prototype = Object.getPrototypeOf(value)
    keys = Reflect.ownKeys(value)
  } catch {
    failInput(`${name} cannot be inspected safely`)
  }
  if (prototype !== Object.prototype && prototype !== null) failInput(`${name} must be a plain object`)

  const values = Object.create(null)
  for (const key of keys) {
    let descriptor
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key)
    } catch {
      failInput(`${name} cannot be inspected safely`)
    }
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) failInput(`${name} properties must be data properties`)
    if (typeof key === 'string') values[key] = descriptor.value
  }
  return values
}

function readDenseArray (value, name) {
  if (!Array.isArray(value)) failInput(`${name} must be an array`)
  let prototype
  let keys
  let lengthDescriptor
  try {
    prototype = Object.getPrototypeOf(value)
    keys = Reflect.ownKeys(value)
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  } catch {
    failInput(`${name} cannot be inspected safely`)
  }
  if (prototype !== Array.prototype) failInput(`${name} must be a plain array`)
  if (lengthDescriptor === undefined || !Object.hasOwn(lengthDescriptor, 'value')) failInput(`${name} length must be a data property`)
  const length = lengthDescriptor.value
  if (!Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1 || keys[keys.length - 1] !== 'length') {
    failInput(`${name} must be dense`)
  }

  const result = new Array(length)
  for (let index = 0; index < length; index++) {
    if (keys[index] !== String(index)) failInput(`${name} must be dense`)
    let descriptor
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    } catch {
      failInput(`${name} cannot be inspected safely`)
    }
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) failInput(`${name} entries must be data properties`)
    result[index] = descriptor.value
  }
  return result
}

function isWellFormedUnicode (value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      if (++index >= value.length) return false
      const low = value.charCodeAt(index)
      if (low < 0xdc00 || low > 0xdfff) return false
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false
    }
  }
  return true
}

function containsControlCharacter (value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code >= 0x7f && code <= 0x9f) return true
  }
  return false
}

function isBoundedString (value, maxBytes, { nonEmpty = false, rejectControls = false } = {}) {
  return (
    typeof value === 'string' &&
    (!nonEmpty || value.length > 0) &&
    isWellFormedUnicode(value) &&
    (!rejectControls || !containsControlCharacter(value)) &&
    b4a.byteLength(value) <= maxBytes
  )
}

function optionalString (values, field, maxBytes, name, { nonEmpty = false, rejectControls = false } = {}) {
  const value = values[field]
  if (value === undefined || value === null) return undefined
  if (!isBoundedString(value, maxBytes, { nonEmpty, rejectControls })) {
    failInput(`${name}.${field} must be ${nonEmpty ? 'a non-empty ' : ''}well-formed string of at most ${maxBytes} UTF-8 bytes`)
  }
  return value
}

function optionalInteger (values, field, name) {
  const value = values[field]
  if (value === undefined || value === null) return undefined
  if (!Number.isSafeInteger(value) || value < 0) failInput(`${name}.${field} must be a non-negative safe integer`)
  return value
}

function snapshotStringRecord (record, name, limits, requiredFields = []) {
  const values = readOwnDataValues(record, name)
  const out = {}
  for (const [field, maxLength] of Object.entries(limits)) {
    const value = optionalString(values, field, maxLength, name, { nonEmpty: requiredFields.includes(field) })
    if (value !== undefined) out[field] = value
  }
  for (const field of requiredFields) {
    if (!Object.hasOwn(out, field)) failInput(`${name}.${field} is required`)
  }
  return Object.freeze(out)
}

function snapshotNestedRecords (value, name, limits, requiredFields) {
  if (value === undefined || value === null) return Object.freeze([])
  const entries = readDenseArray(value, name)
  return Object.freeze(entries.map((entry, index) => snapshotStringRecord(entry, `${name}[${index}]`, limits, requiredFields)))
}

function normalizeProfileFromValues (profile, overrideValues) {
  const values = readOwnDataValues(profile ?? {}, 'catalog profile')
  const out = {}
  for (const [field, maxLength] of Object.entries(PROFILE_STRING_LIMITS)) {
    const raw = field === 'channelKey' && overrideValues.channelKey !== undefined
      ? overrideValues.channelKey
      : values[field]
    const fieldValues = Object.create(null)
    fieldValues[field] = raw
    let value = optionalString(fieldValues, field, maxLength, 'catalog profile', { rejectControls: field === 'channelKey' })
    if (field === 'profileKind' && value === 'TV_SHOW') value = 'tvShow'
    if (field === 'profileKind' && value !== undefined && !PROFILE_KINDS.has(value)) {
      failInput(`catalog profile.profileKind is invalid: ${value}`)
    }
    if (value !== undefined) out[field] = value
  }
  for (const field of PROFILE_INTEGER_FIELDS) {
    const value = optionalInteger(values, field, 'catalog profile')
    if (value !== undefined) out[field] = value
  }
  if (!Object.hasOwn(out, 'channelKey')) out.channelKey = ''
  if (!Object.hasOwn(out, 'name')) out.name = ''

  const sources = overrideValues.sources !== undefined ? overrideValues.sources : values.sources
  const artwork = overrideValues.artwork !== undefined ? overrideValues.artwork : values.artwork
  out.sources = snapshotNestedRecords(sources, 'catalog profile.sources', SOURCE_STRING_LIMITS, ['provider', 'identityKey'])
  out.artwork = snapshotNestedRecords(artwork, 'catalog profile.artwork', ARTWORK_STRING_LIMITS, ['role'])
  return Object.freeze(out)
}

function snapshotCatalogProfile (profile, overrides = {}) {
  const overrideValues = readOwnDataValues(overrides, 'catalog profile overrides')
  return normalizeProfileFromValues(profile ?? {}, overrideValues)
}

function snapshotCatalogItem (item, index) {
  const name = `catalog videos[${index}]`
  const values = readOwnDataValues(item, name)
  const out = {}
  for (const [field, maxLength] of Object.entries(ITEM_STRING_LIMITS)) {
    const value = optionalString(values, field, maxLength, name, {
      nonEmpty: field === 'id',
      rejectControls: field === 'id',
    })
    if (value !== undefined) out[field] = value
  }
  if (!Object.hasOwn(out, 'id')) failInput(`${name}.id is required`)
  if (!Object.hasOwn(out, 'title')) out.title = ''
  for (const field of ITEM_INTEGER_FIELDS) {
    const value = optionalInteger(values, field, name)
    if (value !== undefined) out[field] = value
  }
  return Object.freeze(out)
}

function normalizedProfileKind (profile) {
  return profile.profileKind ?? 'standard'
}

function classifySnapshot (profile, item) {
  const profileKind = normalizedProfileKind(profile)
  const contentKind = item.contentKind

  if (profileKind === 'creator') {
    if (contentKind === 'video') return 'videos'
    if (contentKind === 'stream') return 'streams'
    if (contentKind === 'extra') return 'extras'
    return 'latest'
  }
  if (profileKind === 'tvShow') {
    if (contentKind === 'episode' && Number.isSafeInteger(item.seasonNumber)) return `season:${item.seasonNumber}`
    if (contentKind === 'extra') return 'extras'
    return 'latest'
  }
  if (profileKind === 'movie') {
    if (contentKind === 'movie') return 'movie'
    if (contentKind === 'trailer') return 'trailers'
    if (contentKind === 'extra') return 'extras'
    return 'latest'
  }
  return 'latest'
}

function snapshotCatalogItems (videos, profile) {
  const input = videos === undefined ? [] : readDenseArray(videos, 'catalog videos')
  const items = new Array(input.length)
  const ids = new Set()
  const counts = new Map()
  for (let index = 0; index < input.length; index++) {
    const item = snapshotCatalogItem(input[index], index)
    if (ids.has(item.id)) failInput(`catalog videos contains duplicate id: ${item.id}`)
    ids.add(item.id)
    items[index] = item
    const groupId = classifySnapshot(profile, item)
    counts.set(groupId, (counts.get(groupId) ?? 0) + 1)
  }
  return { items: Object.freeze(items), counts }
}

function effectivePublicationTime (item) {
  return item.sourcePublishedAt ?? item.uploadedAt ?? 0
}

function stableSortTuple (groupId, item) {
  if (groupId.startsWith('season:')) {
    return [item.episodeNumber ?? Number.MAX_SAFE_INTEGER, effectivePublicationTime(item), item.id]
  }
  return [effectivePublicationTime(item), item.id]
}

function compareStrings (left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareSnapshotItems (groupId, left, right) {
  if (groupId.startsWith('season:')) {
    const leftEpisode = left.episodeNumber ?? Number.MAX_SAFE_INTEGER
    const rightEpisode = right.episodeNumber ?? Number.MAX_SAFE_INTEGER
    if (leftEpisode !== rightEpisode) return leftEpisode - rightEpisode
    const leftTime = effectivePublicationTime(left)
    const rightTime = effectivePublicationTime(right)
    if (leftTime !== rightTime) return leftTime - rightTime
    return compareStrings(left.id, right.id)
  }
  const leftTime = effectivePublicationTime(left)
  const rightTime = effectivePublicationTime(right)
  if (leftTime !== rightTime) return rightTime - leftTime
  return compareStrings(left.id, right.id)
}

function compareSnapshotToTuple (groupId, item, tuple) {
  if (groupId.startsWith('season:')) {
    const episode = item.episodeNumber ?? Number.MAX_SAFE_INTEGER
    if (episode !== tuple[0]) return episode - tuple[0]
    const time = effectivePublicationTime(item)
    if (time !== tuple[1]) return time - tuple[1]
    return compareStrings(item.id, tuple[2])
  }
  const time = effectivePublicationTime(item)
  if (time !== tuple[0]) return tuple[0] - time
  return compareStrings(item.id, tuple[1])
}

function readCursorObject (value, exactKeys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  let prototype
  let keys
  try {
    prototype = Object.getPrototypeOf(value)
    keys = Reflect.ownKeys(value)
  } catch {
    return null
  }
  if (prototype !== Object.prototype && prototype !== null || keys.length !== exactKeys.length) return null
  const values = Object.create(null)
  for (const key of keys) {
    if (typeof key !== 'string' || !exactKeys.includes(key)) return null
    let descriptor
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key)
    } catch {
      return null
    }
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) return null
    values[key] = descriptor.value
  }
  return values
}

function readCursorArray (value, expectedLength) {
  if (!Array.isArray(value)) return null
  let prototype
  let keys
  let lengthDescriptor
  try {
    prototype = Object.getPrototypeOf(value)
    keys = Reflect.ownKeys(value)
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  } catch {
    return null
  }
  if (
    prototype !== Array.prototype ||
    lengthDescriptor === undefined ||
    !Object.hasOwn(lengthDescriptor, 'value') ||
    lengthDescriptor.value !== expectedLength ||
    keys.length !== expectedLength + 1 ||
    keys[expectedLength] !== 'length'
  ) return null

  const result = new Array(expectedLength)
  for (let index = 0; index < expectedLength; index++) {
    if (keys[index] !== String(index)) return null
    let descriptor
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    } catch {
      return null
    }
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) return null
    result[index] = descriptor.value
  }
  return result
}

function boundedCursorString (value, maxBytes) {
  return isBoundedString(value, maxBytes, { nonEmpty: true, rejectControls: true })
}

function validateSortTuple (groupId, value) {
  const expectedLength = groupId.startsWith('season:') ? 3 : 2
  const sort = readCursorArray(value, expectedLength)
  if (sort === null) failCursor()
  if (groupId.startsWith('season:')) {
    if (!Number.isSafeInteger(sort[0]) || sort[0] < 0 || !Number.isSafeInteger(sort[1]) || sort[1] < 0 || !boundedCursorString(sort[2], MAX_ITEM_ID_LENGTH)) failCursor()
  } else if (!Number.isSafeInteger(sort[0]) || sort[0] < 0 || !boundedCursorString(sort[1], MAX_ITEM_ID_LENGTH)) {
    failCursor()
  }
  return Object.freeze(sort)
}

function validateCursorPayload (value) {
  const payload = readCursorObject(value, ['v', 'channelKey', 'groupId', 'sort'])
  if (payload === null || payload.v !== CURSOR_VERSION) failCursor()
  if (!boundedCursorString(payload.channelKey, MAX_CHANNEL_KEY_LENGTH)) failCursor()
  if (!boundedCursorString(payload.groupId, MAX_GROUP_ID_LENGTH)) failCursor()
  return Object.freeze({
    v: CURSOR_VERSION,
    channelKey: payload.channelKey,
    groupId: payload.groupId,
    sort: validateSortTuple(payload.groupId, payload.sort),
  })
}

function toBase64Url (bytes) {
  return b4a.toString(bytes, 'base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function fromBase64Url (cursor) {
  if (!boundedCursorString(cursor, MAX_CURSOR_LENGTH) || !/^[A-Za-z0-9_-]+$/u.test(cursor)) failCursor()
  const remainder = cursor.length % 4
  if (remainder === 1) failCursor()
  const base64 = cursor.replaceAll('-', '+').replaceAll('_', '/') + (remainder === 0 ? '' : '='.repeat(4 - remainder))
  let bytes
  try {
    bytes = b4a.from(base64, 'base64')
  } catch {
    failCursor()
  }
  if (toBase64Url(bytes) !== cursor) failCursor()
  return bytes
}

function canonicalCursorBytes (payload) {
  return b4a.from(JSON.stringify({
    v: payload.v,
    channelKey: payload.channelKey,
    groupId: payload.groupId,
    sort: payload.sort,
  }))
}

function validateLimit (limit) {
  if (limit === undefined) return DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) failLimit()
  return limit
}

function summary (id, kind, title, itemCount, seasonNumber) {
  const value = { id, kind, title, itemCount }
  if (seasonNumber !== undefined) value.seasonNumber = seasonNumber
  return Object.freeze(value)
}

function buildSummariesFromCounts (profile, counts) {
  const profileKind = normalizedProfileKind(profile)
  if (profileKind === 'creator') {
    const groups = [summary('latest', 'latest', 'Latest', counts.get('latest') ?? 0)]
    if (counts.has('videos')) groups.push(summary('videos', 'videos', 'Videos', counts.get('videos')))
    if (counts.has('streams')) groups.push(summary('streams', 'streams', 'Streams', counts.get('streams')))
    if (counts.has('extras')) groups.push(summary('extras', 'extras', 'Extras', counts.get('extras')))
    return Object.freeze(groups)
  }
  if (profileKind === 'tvShow') {
    const groups = []
    for (const [groupId, itemCount] of counts) {
      if (!groupId.startsWith('season:')) continue
      const seasonNumber = Number(groupId.slice(7))
      groups.push(summary(groupId, 'season', `Season ${seasonNumber}`, itemCount, seasonNumber))
    }
    groups.sort((left, right) => left.seasonNumber - right.seasonNumber)
    if (counts.has('extras')) groups.push(summary('extras', 'extras', 'Extras', counts.get('extras')))
    if (counts.has('latest')) groups.push(summary('latest', 'latest', 'Latest', counts.get('latest')))
    return Object.freeze(groups)
  }
  if (profileKind === 'movie') {
    const groups = []
    if (counts.has('movie')) groups.push(summary('movie', 'movie', 'Movie', counts.get('movie')))
    if (counts.has('trailers')) groups.push(summary('trailers', 'trailers', 'Trailers', counts.get('trailers')))
    if (counts.has('extras')) groups.push(summary('extras', 'extras', 'Extras', counts.get('extras')))
    if (counts.has('latest')) groups.push(summary('latest', 'latest', 'Latest', counts.get('latest')))
    return Object.freeze(groups)
  }
  return Object.freeze([summary('latest', 'latest', 'Latest', counts.get('latest') ?? 0)])
}

function pageWireItem (item, channelKey, publicBeeKey) {
  const out = { id: item.id, title: item.title, channelKey }
  if (publicBeeKey !== undefined) out.publicBeeKey = publicBeeKey
  for (const field of ITEM_WIRE_FIELDS) {
    if (item[field] !== undefined) out[field] = item[field]
  }
  return Object.freeze(out)
}

function insertBounded (items, item, capacity, groupId) {
  let low = 0
  let high = items.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (compareSnapshotItems(groupId, items[middle], item) <= 0) low = middle + 1
    else high = middle
  }
  if (low >= capacity) return
  items.splice(low, 0, item)
  if (items.length > capacity) items.pop()
}

export function normalizeCatalogProfile (profile = {}, overrides = {}) {
  return snapshotCatalogProfile(profile, overrides)
}

export function classifyCatalogItem (profile = {}, item) {
  const profileSnapshot = snapshotCatalogProfile(profile)
  return classifySnapshot(profileSnapshot, snapshotCatalogItem(item, 0))
}

export function compareCatalogItems (groupId, left, right) {
  const leftSnapshot = snapshotCatalogItem(left, 0)
  const rightSnapshot = snapshotCatalogItem(right, 1)
  return compareSnapshotItems(groupId, leftSnapshot, rightSnapshot)
}

export function buildGroupSummaries (profile = {}, videos = []) {
  const profileSnapshot = snapshotCatalogProfile(profile)
  const { counts } = snapshotCatalogItems(videos, profileSnapshot)
  return buildSummariesFromCounts(profileSnapshot, counts)
}

export function encodeCatalogCursor (position) {
  const values = readCursorObject(position, ['channelKey', 'groupId', 'sort'])
  if (values === null) failCursor()
  const payload = validateCursorPayload({
    v: CURSOR_VERSION,
    channelKey: values.channelKey,
    groupId: values.groupId,
    sort: values.sort,
  })
  const cursor = toBase64Url(canonicalCursorBytes(payload))
  if (cursor.length > MAX_CURSOR_LENGTH) failCursor()
  return cursor
}

export function decodeCatalogCursor (cursor, expected) {
  const expectedValues = readCursorObject(expected, ['channelKey', 'groupId'])
  if (expectedValues === null) failCursor()
  const bytes = fromBase64Url(cursor)
  let parsed
  try {
    parsed = JSON.parse(b4a.toString(bytes))
  } catch {
    failCursor()
  }
  const payload = validateCursorPayload(parsed)
  if (!b4a.equals(bytes, canonicalCursorBytes(payload))) failCursor()
  if (payload.channelKey !== expectedValues.channelKey || payload.groupId !== expectedValues.groupId) failCursor()
  return payload.sort
}

export function buildChannelCatalog (input = {}) {
  const request = readOwnDataValues(input, 'catalog request')
  const profile = snapshotCatalogProfile(request.profile ?? {}, {
    channelKey: request.channelKey,
    sources: request.sources,
    artwork: request.artwork,
  })
  const { counts } = snapshotCatalogItems(request.videos, profile)
  return Object.freeze({ profile, groups: buildSummariesFromCounts(profile, counts) })
}

export function buildCatalogGroupPage (input = {}) {
  const request = readOwnDataValues(input, 'catalog page request')
  const limit = validateLimit(request.limit)
  const channelKeyValues = Object.create(null)
  channelKeyValues.channelKey = request.channelKey
  const channelKey = optionalString(channelKeyValues, 'channelKey', MAX_CHANNEL_KEY_LENGTH, 'catalog page request', {
    nonEmpty: true,
    rejectControls: true,
  })
  if (channelKey === undefined) failInput('catalog page request.channelKey is required')
  const publicBeeKeyValues = Object.create(null)
  publicBeeKeyValues.publicBeeKey = request.publicBeeKey
  const publicBeeKey = optionalString(publicBeeKeyValues, 'publicBeeKey', MAX_CHANNEL_KEY_LENGTH, 'catalog page request', {
    rejectControls: true,
  })
  const profile = snapshotCatalogProfile(request.profile ?? {})
  const { items: snapshots, counts } = snapshotCatalogItems(request.videos, profile)
  const groups = buildSummariesFromCounts(profile, counts)

  const groupIdValues = Object.create(null)
  groupIdValues.groupId = request.groupId
  const requestedGroup = optionalString(groupIdValues, 'groupId', MAX_GROUP_ID_LENGTH, 'catalog page request', {
    nonEmpty: true,
    rejectControls: true,
  }) ?? groups[0]?.id
  if (requestedGroup === undefined) {
    if (request.cursor !== undefined) failCursor()
    return Object.freeze({ group: undefined, items: Object.freeze([]), nextCursor: undefined })
  }
  const position = request.cursor === undefined
    ? undefined
    : decodeCatalogCursor(request.cursor, { channelKey, groupId: requestedGroup })
  const group = groups.find((candidate) => candidate.id === requestedGroup)
  if (group === undefined) throw new CatalogInputError('UNKNOWN_CATALOG_GROUP', `Unknown catalog group: ${requestedGroup}`)

  const selected = []
  for (const item of snapshots) {
    if (classifySnapshot(profile, item) !== requestedGroup) continue
    if (position !== undefined && compareSnapshotToTuple(requestedGroup, item, position) <= 0) continue
    insertBounded(selected, item, limit + 1, requestedGroup)
  }

  const hasMore = selected.length > limit
  if (hasMore) selected.pop()
  const items = Object.freeze(selected.map((item) => pageWireItem(item, channelKey, publicBeeKey)))
  const nextCursor = hasMore
    ? encodeCatalogCursor({ channelKey, groupId: requestedGroup, sort: stableSortTuple(requestedGroup, selected[selected.length - 1]) })
    : undefined
  return Object.freeze({ group, items, nextCursor })
}
