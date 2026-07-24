import { projectMediaEntityGraph } from './media-entity-graph.js'

const MOVIE_CLASSIFICATION = 'movie'
const SHOW_CLASSIFICATION = 'tv'
const EPISODE_KIND = 'episode'
const MUSIC_CREATOR_KINDS = new Set(['music', 'creator'])
const MUSIC_CREATOR_TYPES = new Set(['music', 'creator'])
const COLLECTION_KINDS = new Set(['collection', 'season', 'series', 'album', 'playlist'])
const MUSIC_CREATOR_CATEGORIES = new Set(['Music', 'music'])
const CREATOR_PROFILE_KINDS = new Set(['creator'])
const TIMESTAMP_FIELDS = ['uploadedAt', 'createdAt', 'updatedAt', 'indexedAt', 'addedAt', 'publishedAt']
const DEDUPE_KEY = Symbol('mediaHubDedupeKey')

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

function firstNonEmptyString(values, fallback) {
  for (const value of values) {
    if (nonEmptyString(value)) return value
  }
  return fallback
}

function nonArrayObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasUsefulValue(value) {
  if (typeof value === 'string') return value.length > 0
  return value !== null && value !== undefined
}

function mergeMissingField(target, source, field) {
  if (!hasUsefulValue(target[field]) && hasUsefulValue(source[field])) {
    target[field] = source[field]
  }
}

function fieldValueFromNormalizedOrSource(item, field) {
  if (hasUsefulValue(item?.[field])) return item[field]
  if (hasUsefulValue(item?.item?.[field])) return item.item[field]
  return undefined
}

function mergeMissingSourceField(existing, source, field) {
  if (!nonArrayObject(existing?.item) || hasUsefulValue(existing.item[field])) return
  const value = fieldValueFromNormalizedOrSource(source, field)
  if (hasUsefulValue(value)) existing.item[field] = value
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function positiveDuration(value) {
  return finiteNumber(value) && value > 0 ? value : null
}

function clampProgress(value) {
  if (!finiteNumber(value)) return 0
  if (value <= 0) return 0
  if (value >= 1) return 1
  return value
}

function progressFromPosition(position, duration) {
  const normalizedDuration = positiveDuration(duration)
  if (normalizedDuration === null || !finiteNumber(position)) return 0
  if (position <= 0) return 0
  if (position >= normalizedDuration) return 1
  return position / normalizedDuration
}

function timestampValueMs(value) {
  if (finiteNumber(value)) return value
  if (!nonEmptyString(value)) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

function timestampFromFields(item) {
  if (item === null || typeof item !== 'object') return null
  for (const field of TIMESTAMP_FIELDS) {
    const timestamp = timestampValueMs(item[field])
    if (timestamp !== null) return timestamp
  }
  return null
}

function timestampMs(item) {
  return timestampFromFields(item?.item) ?? timestampFromFields(item) ?? 0
}

function stablePlaybackSortKey(item) {
  if (nonEmptyString(item?.playbackKey)) return item.playbackKey
  return getMediaHubPlaybackKey(item?.item ?? item)
}

function sortNewest(items) {
  return items
    .map((item, index) => ({ item, index, timestamp: timestampMs(item), playbackKey: stablePlaybackSortKey(item) }))
    .sort((left, right) => {
      if (right.timestamp !== left.timestamp) return right.timestamp - left.timestamp
      if (left.playbackKey < right.playbackKey) return -1
      if (left.playbackKey > right.playbackKey) return 1
      return left.index - right.index
    })
    .map(({ item }) => item)
}

function limitItems(items, limit) {
  return limit > 0 && items.length > limit ? items.slice(0, limit) : items
}

function normalizeDuration(item) {
  const duration = item?.duration ?? item?.durationSec ?? item?.metadata?.duration ?? item?.metadata?.durationSec
  return positiveDuration(duration)
}

function normalizeProgress(item, duration) {
  if (finiteNumber(item?.progress)) return clampProgress(item.progress)
  const position = item?.position ?? item?.positionSec ?? item?.resumePosition ?? item?.resumePositionSec
  return progressFromPosition(position, duration)
}

function stableItemKey(item) {
  const selectedSource = nonArrayObject(item?.selectedSource) ? item.selectedSource : nonArrayObject(item?.item?.selectedSource) ? item.item.selectedSource : null
  if (selectedSource) {
    return firstNonEmptyString([
      selectedSource.videoId,
      selectedSource.path,
      selectedSource.publicationId,
      item?.videoId,
      item?.path,
      item?.id,
    ], null)
  }
  return firstNonEmptyString([item?.id, item?.videoId, item?.path], null)
}

function stableDedupeKey(item) {
  const itemKey = stableItemKey(item)
  if (itemKey === null) return null
  const channelKey = firstNonEmptyString([item?.channelKey, item?.driveKey, item?.channel?.key], 'local')
  return `${channelKey}:${itemKey}`
}

function isValidVideoItem(item) {
  return nonArrayObject(item) && stableItemKey(item) !== null && nonEmptyString(item.title)
}

function normalizeVideoItem(item, source) {
  if (!isValidVideoItem(item)) return null

  const playbackKey = getMediaHubPlaybackKey(item)
  const id = stableItemKey(item)
  const duration = normalizeDuration(item)
  const normalized = {
    id,
    source,
    playbackKey,
    channelKey: nonEmptyString(item?.channelKey) ? item.channelKey : null,
    driveKey: nonEmptyString(item?.driveKey) ? item.driveKey : null,
    videoId: nonEmptyString(item?.videoId) ? item.videoId : null,
    path: nonEmptyString(item?.path) ? item.path : null,
    publicBeeKey: nonEmptyString(item?.publicBeeKey) ? item.publicBeeKey : null,
    title: item.title,
    subtitle: firstNonEmptyString([item?.subtitle, item?.channelName, item?.channel?.name, item?.creatorName], null),
    channelName: nonEmptyString(item?.channelName) ? item.channelName : null,
    channel: nonArrayObject(item?.channel) ? item.channel : null,
    creatorName: nonEmptyString(item?.creatorName) ? item.creatorName : null,
    thumbnailUrl: firstNonEmptyString([item?.thumbnailUrl, item?.thumbnail, item?.stillUrl, item?.posterUrl, item?.backdropUrl], null),
    thumbnail: nonEmptyString(item?.thumbnail) ? item.thumbnail : null,
    posterUrl: firstNonEmptyString([item?.posterUrl, item?.thumbnailUrl, item?.thumbnail], null),
    backdropUrl: firstNonEmptyString([item?.backdropUrl, item?.stillUrl, item?.posterUrl, item?.thumbnailUrl, item?.thumbnail], null),
    stillUrl: firstNonEmptyString([item?.stillUrl, item?.thumbnailUrl, item?.thumbnail, item?.posterUrl], null),
    artwork: Array.isArray(item?.artwork) ? item.artwork.slice() : [],
    contentKind: hasUsefulValue(item?.contentKind) ? item.contentKind : hasUsefulValue(item?.mediaKind) ? item.mediaKind : null,
    mediaKind: hasUsefulValue(item?.mediaKind) ? item.mediaKind : hasUsefulValue(item?.contentKind) ? item.contentKind : null,
    entityKind: hasUsefulValue(item?.entityKind) ? item.entityKind : null,
    localEntityId: nonEmptyString(item?.localEntityId) ? item.localEntityId : null,
    classification: hasUsefulValue(item?.classification) ? item.classification : null,
    category: hasUsefulValue(item?.category) ? item.category : null,
    profileKind: hasUsefulValue(item?.profileKind) ? item.profileKind : null,
    duration,
    durationSec: positiveDuration(item?.durationSec) ?? null,
    seasonNumber: Number.isSafeInteger(item?.seasonNumber) ? item.seasonNumber : null,
    episodeNumber: Number.isSafeInteger(item?.episodeNumber) ? item.episodeNumber : null,
    trackNumber: Number.isSafeInteger(item?.trackNumber) ? item.trackNumber : null,
    sourceCount: Number.isSafeInteger(item?.sourceCount) ? item.sourceCount : 0,
    selectedSource: nonArrayObject(item?.selectedSource) ? item.selectedSource : null,
    alternateSources: Array.isArray(item?.alternateSources) ? item.alternateSources.slice() : [],
    sources: Array.isArray(item?.sources) ? item.sources.slice() : [],
    provenance: Array.isArray(item?.provenance) ? item.provenance.slice() : [],
    conflicts: Array.isArray(item?.conflicts) ? item.conflicts.slice() : [],
    archiveStatus: hasUsefulValue(item?.archiveStatus) ? item.archiveStatus : null,
    availabilityStatus: hasUsefulValue(item?.availabilityStatus) ? item.availabilityStatus : null,
    publisherName: firstNonEmptyString([item?.publisherName, item?.sourceProviderName], null),
    sourceProviderName: firstNonEmptyString([item?.sourceProviderName, item?.publisherName], null),
    publicationId: nonEmptyString(item?.publicationId) ? item.publicationId : null,
    renditionId: nonEmptyString(item?.renditionId) ? item.renditionId : null,
    creatorRoles: Array.isArray(item?.creatorRoles) ? item.creatorRoles.slice() : [],
    items: Array.isArray(item?.items) ? item.items.slice() : [],
    missingMembers: Array.isArray(item?.missingMembers) ? item.missingMembers.slice() : [],
    completeness: nonArrayObject(item?.completeness) ? { ...item.completeness } : null,
    contributions: Array.isArray(item?.contributions) ? item.contributions.slice() : [],
    sourcePublisherCount: Number.isSafeInteger(item?.sourcePublisherCount) ? item.sourcePublisherCount : null,
    progress: normalizeProgress(item, duration),
    createdAt: firstNonEmptyString([item?.createdAt, item?.publishedAt, item?.updatedAt, item?.indexedAt, item?.addedAt], null),
    item: { ...item },
  }
  normalized[DEDUPE_KEY] = stableDedupeKey(item)
  return normalized
}

function isValidContinueWatchingItem(item) {
  return nonArrayObject(item)
    && nonEmptyString(item.channelKey)
    && nonEmptyString(item.videoId)
    && nonEmptyString(item.title)
}

function normalizeContinueWatchingItem(item) {
  if (!isValidContinueWatchingItem(item)) return null

  const duration = positiveDuration(item?.durationSec ?? item?.duration)
  const playbackKey = getMediaHubPlaybackKey(item)
  const normalized = {
    id: item.videoId,
    source: 'continue-watching',
    playbackKey,
    channelKey: item.channelKey,
    videoId: item.videoId,
    publicBeeKey: nonEmptyString(item?.publicBeeKey) ? item.publicBeeKey : null,
    durationSec: positiveDuration(item?.durationSec) ?? null,
    positionSec: finiteNumber(item?.positionSec) ? item.positionSec : null,
    title: item.title,
    subtitle: firstNonEmptyString([item?.subtitle, item?.channelName, item?.channel?.name], null),
    thumbnailUrl: firstNonEmptyString([item?.thumbnailUrl, item?.thumbnail], null),
    thumbnail: nonEmptyString(item?.thumbnail) ? item.thumbnail : null,
    duration,
    progress: normalizeProgress(item, duration),
    createdAt: firstNonEmptyString([item?.updatedAt, item?.createdAt, item?.publishedAt], null),
    item: { ...item },
  }
  normalized[DEDUPE_KEY] = stableDedupeKey(item)
  return normalized
}

function mapVideos(items, source) {
  return asArray(items).map((item) => normalizeVideoItem(item, source)).filter((item) => item !== null)
}

function hasUsableClassification(value) {
  return nonArrayObject(value) && nonEmptyString(value.type)
}

function mergeMissingClassification(existing, item) {
  if (!hasUsableClassification(existing.classification) && hasUsableClassification(item.classification)) {
    existing.classification = item.classification
  }
}

function mergeMissingTimestampFields(existing, item) {
  for (const field of TIMESTAMP_FIELDS) {
    if (timestampValueMs(existing[field]) !== null) continue

    const normalizedValue = item[field]
    if (timestampValueMs(normalizedValue) !== null) {
      existing[field] = normalizedValue
      continue
    }

    const sourceValue = item.item?.[field]
    if (timestampValueMs(sourceValue) !== null) existing[field] = sourceValue
  }
}

function mergeMissingMediaFields(existing, item) {
  mergeMissingField(existing, item, 'thumbnailUrl')
  mergeMissingField(existing, item, 'thumbnail')
  mergeMissingField(existing, item, 'posterUrl')
  mergeMissingField(existing, item, 'backdropUrl')
  mergeMissingField(existing, item, 'stillUrl')
  mergeMissingField(existing, item, 'contentKind')
  mergeMissingField(existing, item, 'mediaKind')
  mergeMissingField(existing, item, 'entityKind')
  mergeMissingField(existing, item, 'localEntityId')
  mergeMissingClassification(existing, item)
  mergeMissingField(existing, item, 'category')
  mergeMissingField(existing, item, 'profileKind')
  mergeMissingField(existing, item, 'duration')
  mergeMissingField(existing, item, 'durationSec')
  mergeMissingField(existing, item, 'subtitle')
  mergeMissingField(existing, item, 'channelName')
  mergeMissingField(existing, item, 'channel')
  mergeMissingField(existing, item, 'creatorName')
  mergeMissingField(existing, item, 'publisherName')
  mergeMissingField(existing, item, 'sourceProviderName')
  mergeMissingField(existing, item, 'publicationId')
  mergeMissingField(existing, item, 'renditionId')
  mergeMissingField(existing, item, 'archiveStatus')
  mergeMissingField(existing, item, 'availabilityStatus')
  mergeMissingField(existing, item, 'seasonNumber')
  mergeMissingField(existing, item, 'episodeNumber')
  mergeMissingField(existing, item, 'trackNumber')
  mergeMissingField(existing, item, 'channelKey')
  mergeMissingField(existing, item, 'driveKey')
  mergeMissingField(existing, item, 'videoId')
  mergeMissingField(existing, item, 'path')
  mergeMissingField(existing, item, 'publicBeeKey')
  mergeMissingSourceField(existing, item, 'channelKey')
  mergeMissingSourceField(existing, item, 'driveKey')
  mergeMissingSourceField(existing, item, 'videoId')
  mergeMissingSourceField(existing, item, 'path')
  mergeMissingSourceField(existing, item, 'publicBeeKey')
  if (Array.isArray(existing.artwork) && existing.artwork.length === 0 && Array.isArray(item.artwork) && item.artwork.length > 0) existing.artwork = item.artwork.slice()
  if (Array.isArray(existing.provenance) && existing.provenance.length === 0 && Array.isArray(item.provenance) && item.provenance.length > 0) existing.provenance = item.provenance.slice()
  if (Array.isArray(existing.conflicts) && existing.conflicts.length === 0 && Array.isArray(item.conflicts) && item.conflicts.length > 0) existing.conflicts = item.conflicts.slice()
  if (Array.isArray(existing.alternateSources) && existing.alternateSources.length === 0 && Array.isArray(item.alternateSources) && item.alternateSources.length > 0) existing.alternateSources = item.alternateSources.slice()
  if (Array.isArray(existing.creatorRoles) && existing.creatorRoles.length === 0 && Array.isArray(item.creatorRoles) && item.creatorRoles.length > 0) existing.creatorRoles = item.creatorRoles.slice()
  mergeMissingTimestampFields(existing, item)
}

function dedupeByPlaybackKey(groups) {
  const byKey = new Map()
  const deduped = []
  for (const group of groups) {
    for (const item of group) {
      const dedupeKey = item[DEDUPE_KEY]
      if (dedupeKey === null) {
        deduped.push(item)
        continue
      }

      const existing = byKey.get(dedupeKey)
      if (existing === undefined) {
        byKey.set(dedupeKey, item)
        deduped.push(item)
        continue
      }
      mergeMissingMediaFields(existing, item)
    }
  }
  return deduped
}

function mediaFieldMatches(item, field, values) {
  return values.has(item?.item?.[field]) || values.has(item?.[field])
}

function classificationTypeMatches(item, values) {
  return values.has(item?.item?.classification?.type) || values.has(item?.classification?.type)
}

function isMusicOrCreatorItem(item) {
  return mediaFieldMatches(item, 'contentKind', MUSIC_CREATOR_KINDS)
    || classificationTypeMatches(item, MUSIC_CREATOR_TYPES)
    || mediaFieldMatches(item, 'category', MUSIC_CREATOR_CATEGORIES)
    || mediaFieldMatches(item, 'profileKind', CREATOR_PROFILE_KINDS)
}

function hasFeaturedThumbnail(item) {
  return nonEmptyString(item?.thumbnailUrl)
    || nonEmptyString(item?.thumbnail)
    || nonEmptyString(item?.posterUrl)
    || nonEmptyString(item?.backdropUrl)
    || nonEmptyString(item?.stillUrl)
    || nonEmptyString(item?.item?.thumbnailUrl)
    || nonEmptyString(item?.item?.thumbnail)
    || nonEmptyString(item?.item?.posterUrl)
    || nonEmptyString(item?.item?.backdropUrl)
    || nonEmptyString(item?.item?.stillUrl)
}

function isBetterFeaturedItem(candidate, selected) {
  if (selected === null) return true

  const candidateHasThumbnail = hasFeaturedThumbnail(candidate)
  const selectedHasThumbnail = hasFeaturedThumbnail(selected)
  if (candidateHasThumbnail !== selectedHasThumbnail) return candidateHasThumbnail

  const candidateTimestamp = timestampMs(candidate)
  const selectedTimestamp = timestampMs(selected)
  if (candidateTimestamp !== selectedTimestamp) return candidateTimestamp > selectedTimestamp

  const candidatePlaybackKey = stablePlaybackSortKey(candidate)
  const selectedPlaybackKey = stablePlaybackSortKey(selected)
  if (candidatePlaybackKey !== selectedPlaybackKey) return candidatePlaybackKey < selectedPlaybackKey

  return false
}

function selectFeatured(candidates) {
  let selected = null
  for (const item of candidates) {
    if (isBetterFeaturedItem(item, selected)) {
      selected = item
    }
  }
  return selected
}

function rail(id, title, items, options = {}) {
  const result = {
    id,
    title,
    subtitle: nonEmptyString(options.subtitle) ? options.subtitle : '',
    items,
  }
  if (Number.isSafeInteger(options.limit) && options.limit > 0) result.limit = options.limit
  return result
}

export function getMediaHubPlaybackKey(item) {
  if (nonEmptyString(item?.playbackKey)) return item.playbackKey
  const source = nonArrayObject(item?.item) ? item.item : null
  const channelKey = firstNonEmptyString([
    item?.channelKey,
    item?.driveKey,
    item?.channel?.key,
    source?.channelKey,
    source?.driveKey,
    source?.channel?.key,
  ], 'local')
  const itemKey = firstNonEmptyString([
    item?.id,
    item?.videoId,
    item?.path,
    source?.id,
    source?.videoId,
    source?.path,
  ], 'unknown')
  return `${channelKey}:${itemKey}`
}

function selectedSourceForPlayback(item) {
  if (nonArrayObject(item?.selectedSource)) return item.selectedSource
  if (nonArrayObject(item?.item?.selectedSource)) return item.item.selectedSource
  return null
}

export function getMediaHubPlayableSourceItem(item, options = {}) {
  const selectedSource = selectedSourceForPlayback(item)
  const rawSelected = nonArrayObject(selectedSource?.raw) ? selectedSource.raw : null
  const legacySource = !selectedSource && nonArrayObject(item?.item) ? item.item : item
  const source = selectedSource ? { ...rawSelected, ...selectedSource } : legacySource
  if (!nonArrayObject(source)) return source

  const id = firstNonEmptyString([
    source.videoId,
    source.path,
    source.id,
    selectedSource ? null : item?.videoId,
    selectedSource ? null : item?.id,
    selectedSource ? null : item?.path,
  ], null)
  const channelKey = firstNonEmptyString([
    source.channelKey,
    source.driveKey,
    source.channel?.key,
    selectedSource ? null : item?.channelKey,
    selectedSource ? null : item?.driveKey,
    options.fallbackChannelKey,
  ], '')
  const publicBeeKey = firstNonEmptyString([
    source.publicBeeKey,
    selectedSource ? null : item?.publicBeeKey,
    options.publicBeeKey,
  ], null)

  return {
    ...source,
    id,
    videoId: firstNonEmptyString([source.videoId, id], id),
    channelKey,
    driveKey: firstNonEmptyString([source.driveKey, channelKey], channelKey),
    publicBeeKey,
    title: firstNonEmptyString([source.title, item?.title], 'Untitled'),
    thumbnailUrl: firstNonEmptyString([source.thumbnailUrl, item?.thumbnailUrl, source.thumbnail, item?.thumbnail], null),
    thumbnail: firstNonEmptyString([source.thumbnail, item?.thumbnail, source.thumbnailUrl, item?.thumbnailUrl], null),
  }
}

export function isMovieItem(item) {
  return item?.contentKind === MOVIE_CLASSIFICATION || item?.mediaKind === MOVIE_CLASSIFICATION || item?.classification?.type === MOVIE_CLASSIFICATION
}

export function isShowItem(item) {
  return item?.contentKind === EPISODE_KIND || item?.mediaKind === EPISODE_KIND || item?.contentKind === SHOW_CLASSIFICATION || item?.mediaKind === SHOW_CLASSIFICATION || item?.classification?.type === SHOW_CLASSIFICATION
}

export function isCollectionItem(item) {
  return COLLECTION_KINDS.has(item?.entityKind) || COLLECTION_KINDS.has(item?.contentKind) || COLLECTION_KINDS.has(item?.mediaKind)
}

export function isCreatorItem(item) {
  return item?.entityKind === 'agent' || item?.contentKind === 'creator' || item?.mediaKind === 'creator' || item?.profileKind === 'creator'
}

export function buildMediaHubSections(input = {}) {
  const {
    feedVideos = [],
    myVideos = [],
    continueWatching = [],
    recommendedVideos = [],
    mediaGraph = null,
    mediaEntities = [],
    resolvedEntities = [],
    works = [],
    collections: graphCollections = [],
    agents = [],
    creators: graphCreators = [],
  } = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const graphProjection = projectMediaEntityGraph({ mediaGraph, mediaEntities, resolvedEntities, works, collections: graphCollections, agents, creators: graphCreators }, { includeLegacy: false })
  const graphItems = mapVideos(graphProjection.mediaItems, 'media-graph')
  const graphCollectionItems = mapVideos(graphProjection.collections, 'media-graph')
  const graphAgentItems = mapVideos(graphProjection.agents, 'media-graph')
  const recommendedItems = mapVideos(recommendedVideos, 'recommended')
  const feedItems = mapVideos(feedVideos, 'feed')
  const libraryItems = mapVideos(myVideos, 'library')
  const continueItems = asArray(continueWatching).map(normalizeContinueWatchingItem).filter((item) => item !== null)

  const feedRailItems = dedupeByPlaybackKey([feedItems])
  const libraryRailItems = dedupeByPlaybackKey([libraryItems])
  const mediaItems = dedupeByPlaybackKey([graphItems, recommendedItems, feedItems, libraryItems])
  const collectionItems = sortNewest(dedupeByPlaybackKey([graphCollectionItems]))
  const creatorItems = sortNewest(dedupeByPlaybackKey([graphAgentItems, mediaItems.filter(isCreatorItem)]))
  const allItems = sortNewest(mediaItems)
  const movies = sortNewest(allItems.filter(isMovieItem))
  const shows = sortNewest(allItems.filter(isShowItem))
  const newEpisodes = sortNewest(shows)
  const collections = limitItems(collectionItems, 12)
  const creators = limitItems(creatorItems, 12)
  const musicAndCreators = sortNewest(dedupeByPlaybackKey([allItems.filter(isMusicOrCreatorItem), creators]))
  const recentlySeeded = limitItems(sortNewest(feedRailItems), 18)
  const yourLibrary = limitItems(sortNewest(libraryRailItems), 12)
  const featured = selectFeatured(dedupeByPlaybackKey([mediaItems, continueItems]))

  return {
    featured: {
      id: 'featured',
      title: 'Featured from the swarm',
      item: featured,
    },
    continueWatching: rail('continue-watching', 'Continue watching', limitItems(sortNewest(continueItems), 10), { limit: 10 }),
    movies: rail('movies', 'Movies', movies, { subtitle: 'Feature-length media on your network' }),
    shows: rail('shows', 'Shows', shows, { subtitle: 'Episodes and series from peers' }),
    newEpisodes: rail('new-episodes', 'New episodes', newEpisodes),
    collections: rail('collections', 'Collections', collections, { subtitle: 'Seasons, albums, playlists, and curated sets from the graph', limit: 12 }),
    creators: rail('creators', 'Creators', creators, { subtitle: 'Agents and contributors resolved across publishers', limit: 12 }),
    musicAndCreators: rail('music-creators', 'Music & creators', musicAndCreators),
    recentlySeeded: rail('recently-seeded', 'Recently from the swarm', recentlySeeded, { limit: 18 }),
    yourLibrary: rail('your-library', 'Your library', yourLibrary, { limit: 12 }),
    allItems,
  }
}
