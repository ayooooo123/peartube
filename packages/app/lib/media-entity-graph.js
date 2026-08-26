import { isMediaSourcePlayable, selectMediaSource } from './media-source-selection.js'

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function nonArrayObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

function firstNonEmptyString(values, fallback = null) {
  for (const value of values) {
    if (nonEmptyString(value)) return value
  }
  return fallback
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function safePositiveNumber(value) {
  return finiteNumber(value) && value > 0 ? value : null
}

function metadata(entity) {
  return nonArrayObject(entity?.preferredMetadata)
    ? entity.preferredMetadata
    : nonArrayObject(entity?.metadata)
      ? entity.metadata
      : {}
}

// Year, runtime and genre reach the app only because the publisher's metadata
// claim carried them: a consumer holds no metadata-provider credentials and
// cannot look any of it up. A category nobody claimed is therefore left off the
// projected entity entirely rather than defaulted, so a caller can tell "the
// publisher said nothing" apart from "the publisher said none".
function describedCategories(entity) {
  const meta = metadata(entity)
  const out = {}
  for (const field of ['releaseYear', 'runtimeMinutes']) {
    const value = Number.isSafeInteger(entity?.[field]) ? entity[field] : meta[field]
    if (Number.isSafeInteger(value) && value > 0) out[field] = value
  }
  const overview = nonEmptyString(entity?.overview) ? entity.overview : meta.overview
  if (nonEmptyString(overview)) out.overview = overview
  const claimed = Array.isArray(entity?.genres) ? entity.genres : meta.genres
  const genres = asArray(claimed).filter(nonEmptyString)
  if (genres.length > 0) out.genres = genres
  return out
}

function classification(entity) {
  return nonArrayObject(entity?.classification)
    ? entity.classification
    : nonArrayObject(metadata(entity)?.classification)
      ? metadata(entity).classification
      : {}
}

function normalEntityKind(entity) {
  const kind = firstNonEmptyString([
    entity?.entityKind,
    entity?.kind,
    entity?.type,
  ], 'work')
  if (kind === 'resolved-work') return 'work'
  if (kind === 'creator') return 'agent'
  if (kind === 'series' || kind === 'season' || kind === 'album' || kind === 'playlist') return 'collection'
  return kind
}

function explicitContentKind(entity) {
  const meta = metadata(entity)
  const cls = classification(entity)
  const kind = firstNonEmptyString([
    entity?.contentKind,
    entity?.mediaKind,
    meta.contentKind,
    meta.mediaKind,
    cls.contentKind,
    cls.type,
  ], null)
  if (kind === 'tv') return 'episode'
  if (kind === 'track') return 'song'
  return kind
}

function entityTitle(entity) {
  const meta = metadata(entity)
  return firstNonEmptyString([
    meta.title,
    meta.name,
    entity?.title,
    entity?.name,
    entity?.label,
  ], 'Untitled media')
}

function entitySubtitle(entity, creatorName, sourceProviderName) {
  const meta = metadata(entity)
  return firstNonEmptyString([
    meta.subtitle,
    entity?.subtitle,
    meta.seriesTitle,
    entity?.seriesTitle,
    meta.albumTitle,
    entity?.albumTitle,
    creatorName,
    sourceProviderName,
  ], null)
}

function timestampValue(value) {
  if (finiteNumber(value)) return value
  if (!nonEmptyString(value)) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

function entityCreatedAt(entity) {
  const meta = metadata(entity)
  for (const value of [entity?.publishedAt, entity?.uploadedAt, entity?.createdAt, entity?.updatedAt, meta.publishedAt, meta.releaseDate, meta.airDate]) {
    const timestamp = timestampValue(value)
    if (timestamp !== null) return value
  }
  return null
}

function roleName(contribution) {
  return firstNonEmptyString([
    contribution?.role,
    contribution?.contributionRole,
    contribution?.kind,
  ], 'creator')
}

function agentName(contribution) {
  return firstNonEmptyString([
    contribution?.creditedName,
    contribution?.agentName,
    contribution?.name,
    contribution?.agent?.name,
    contribution?.agent?.preferredMetadata?.name,
    contribution?.agent?.preferredMetadata?.title,
  ], null)
}

function normalizeContributions(entity) {
  const raw = [
    ...asArray(entity?.contributions),
    ...asArray(entity?.creatorRoles),
    ...asArray(entity?.contributors),
  ]
  const contributions = []
  const seen = new Set()
  for (const entry of raw) {
    if (!nonArrayObject(entry)) continue
    const name = agentName(entry)
    if (!nonEmptyString(name)) continue
    const role = roleName(entry)
    const key = `${role}:${name}`
    if (seen.has(key)) continue
    seen.add(key)
    contributions.push({
      role,
      name,
      agentId: firstNonEmptyString([entry.agentId, entry.agent?.localEntityId, entry.agent?.id], null),
      raw: entry,
    })
  }
  const directCreator = firstNonEmptyString([entity?.creatorName, metadata(entity)?.creatorName], null)
  if (directCreator && !seen.has(`creator:${directCreator}`)) contributions.push({ role: 'creator', name: directCreator, agentId: null, raw: null })
  return contributions
}

function normalizeArtworkEntry(entry) {
  if (!nonArrayObject(entry)) return null
  const role = firstNonEmptyString([entry.role, entry.kind, entry.purpose, entry.type], 'thumbnail')
  const url = firstNonEmptyString([entry.url, entry.remoteUrl, entry.thumbnailUrl, entry.uri], null)
  const blobId = firstNonEmptyString([entry.blobId, entry.assetId], null)
  const blobsCoreKey = firstNonEmptyString([entry.blobsCoreKey, entry.coreKey], null)
  if (!url && !(blobId && blobsCoreKey)) return null
  return {
    role,
    url,
    remoteUrl: url,
    blobId,
    blobsCoreKey,
    mimeType: firstNonEmptyString([entry.mimeType, entry.contentType], null),
    raw: entry,
  }
}

function normalizeArtwork(entity) {
  const meta = metadata(entity)
  const entries = []
  for (const entry of asArray(entity?.artwork)) {
    const normalized = normalizeArtworkEntry(entry)
    if (normalized) entries.push(normalized)
  }
  for (const entry of asArray(meta.artwork)) {
    const normalized = normalizeArtworkEntry(entry)
    if (normalized) entries.push(normalized)
  }
  for (const [role, value] of [
    ['poster', entity?.posterUrl || meta.posterUrl],
    ['backdrop', entity?.backdropUrl || meta.backdropUrl],
    ['still', entity?.stillUrl || meta.stillUrl],
    ['thumbnail', entity?.thumbnailUrl || entity?.thumbnail || meta.thumbnailUrl || meta.thumbnail],
    ['avatar', entity?.avatarUrl || meta.avatarUrl],
    ['banner', entity?.bannerUrl || meta.bannerUrl],
  ]) {
    if (nonEmptyString(value)) entries.push({ role, url: value, remoteUrl: value, blobId: null, blobsCoreKey: null, mimeType: null, raw: null })
  }
  return entries
}

function artworkUrl(artwork, roles) {
  for (const role of roles) {
    for (const entry of artwork) {
      if (entry.role === role && nonEmptyString(entry.url)) return entry.url
      if (entry.role === role && nonEmptyString(entry.remoteUrl)) return entry.remoteUrl
    }
  }
  return null
}

function provenanceClaimKey(entry) {
  return [
    entry?.claimId || entry?.id || '',
    entry?.evidenceId || entry?.evidenceHash || '',
    entry?.publisherId || '',
    entry?.publisherName || '',
    entry?.publicationId || '',
    entry?.renditionId || '',
    entry?.role || '',
    entry?.evidence ? JSON.stringify(entry.evidence) : '',
  ].join(':')
}

function mediaSourceMergeKey(source) {
  return [
    source?.publicationId || '',
    source?.renditionId || '',
    source?.playbackKey || '',
    source?.id || '',
    source?.videoId || '',
    source?.path || '',
  ].join(':')
}

function normalizeProvenance(entity, sourceSelection) {
  const raw = [...asArray(entity?.provenance)]
  for (const source of sourceSelection.sources) {
    raw.push({
      publisherId: source.publisherId,
      publisherName: source.publisherName,
      publicationId: source.publicationId,
      renditionId: source.renditionId,
      role: 'publication-source',
    })
  }
  const provenance = []
  const seen = new Set()
  for (const entry of raw) {
    if (!nonArrayObject(entry)) continue
    const key = provenanceClaimKey(entry)
    if (seen.has(key)) continue
    seen.add(key)
    provenance.push(entry)
  }
  return provenance
}

function entityId(entity, index = 0) {
  const kind = normalEntityKind(entity)
  const meta = metadata(entity)
  return firstNonEmptyString([
    entity?.localEntityId,
    entity?.entityId,
    entity?.workId,
    entity?.collectionId,
    entity?.agentId,
    entity?.id,
    meta.localEntityId,
    meta.workId,
  ], `${kind}:legacy:${index}`)
}

function sourceProviderFromSelection(selection) {
  return firstNonEmptyString(selection.sources.map((source) => source.publisherName), null)
}

function normalizeGraphEntity(entity, index = 0, options = {}) {
  if (!nonArrayObject(entity)) return null
  const localEntityId = entityId(entity, index)
  const entityKind = normalEntityKind(entity)
  const mediaKind = explicitContentKind(entity) || (entityKind === 'collection' ? 'collection' : entityKind === 'agent' ? 'creator' : 'video')
  const contributions = normalizeContributions(entity)
  const creatorName = firstNonEmptyString(contributions.map((entry) => entry.name), null)
  const sourceSelection = selectMediaSource(entity, options.sourcePolicy || {})
  const sourceProviderName = sourceProviderFromSelection(sourceSelection)
  const artwork = normalizeArtwork(entity)
  const title = entityTitle(entity)
  const selected = sourceSelection.selectedSource
  const meta = metadata(entity)
  const cls = classification(entity)

  return {
    id: localEntityId,
    localEntityId,
    entityKind,
    mediaKind,
    contentKind: mediaKind,
    title,
    subtitle: entitySubtitle(entity, creatorName, sourceProviderName),
    creatorName,
    creatorRoles: contributions,
    publisherName: sourceProviderName,
    sourceProviderName,
    sourceCount: sourceSelection.sourceCount,
    selectedSource: selected,
    alternateSources: sourceSelection.alternateSources,
    sources: sourceSelection.sources,
    provenance: normalizeProvenance(entity, sourceSelection),
    conflicts: asArray(entity?.conflicts),
    archiveStatus: entity?.archiveStatus || entity?.retentionStatus || selected?.archiveStatus || null,
    availabilityStatus: selected?.availabilityStatus || null,
    artwork,
    posterUrl: artworkUrl(artwork, ['poster', 'album', 'thumbnail', 'still']),
    backdropUrl: artworkUrl(artwork, ['backdrop', 'banner', 'still', 'poster', 'thumbnail']),
    stillUrl: artworkUrl(artwork, ['still', 'thumbnail', 'backdrop', 'poster']),
    thumbnailUrl: artworkUrl(artwork, ['thumbnail', 'still', 'poster', 'backdrop', 'avatar']),
    thumbnail: artworkUrl(artwork, ['thumbnail', 'still', 'poster', 'backdrop', 'avatar']),
    playbackKey: selected?.playbackKey || `${localEntityId}:unavailable`,
    channelKey: selected?.channelKey || selected?.publisherId || null,
    driveKey: selected?.driveKey || selected?.channelKey || null,
    videoId: selected?.videoId || selected?.publicationId || null,
    path: selected?.path || null,
    publicBeeKey: selected?.publicBeeKey || null,
    publicationId: selected?.publicationId || null,
    renditionId: selected?.renditionId || null,
    duration: safePositiveNumber(entity?.duration ?? entity?.durationSec ?? meta.duration ?? meta.durationSec) || null,
    durationSec: safePositiveNumber(entity?.durationSec ?? entity?.duration ?? meta.durationSec ?? meta.duration) || null,
    seasonNumber: Number.isSafeInteger(entity?.seasonNumber) ? entity.seasonNumber : Number.isSafeInteger(meta.seasonNumber) ? meta.seasonNumber : Number.isSafeInteger(cls.season) ? cls.season : null,
    episodeNumber: Number.isSafeInteger(entity?.episodeNumber) ? entity.episodeNumber : Number.isSafeInteger(meta.episodeNumber) ? meta.episodeNumber : Number.isSafeInteger(cls.episode) ? cls.episode : null,
    trackNumber: Number.isSafeInteger(entity?.trackNumber) ? entity.trackNumber : Number.isSafeInteger(meta.trackNumber) ? meta.trackNumber : null,
    collectionRefs: asArray(entity?.collectionRefs),
    collections: asArray(entity?.collections),
    createdAt: entityCreatedAt(entity),
    ...describedCategories(entity),
    progress: finiteNumber(entity?.progress) ? Math.max(0, Math.min(1, entity.progress)) : 0,
    item: { ...entity, selectedSource: selected, alternateSources: sourceSelection.alternateSources },
  }
}

function mergeArraysByKey(existing, incoming, keyFn) {
  const seen = new Set(existing.map(keyFn))
  for (const item of incoming) {
    const key = keyFn(item)
    if (seen.has(key)) continue
    seen.add(key)
    existing.push(item)
  }
}

function mergeProjectedEntity(existing, incoming) {
  if (!existing.title && incoming.title) existing.title = incoming.title
  if (!existing.subtitle && incoming.subtitle) existing.subtitle = incoming.subtitle
  if (!existing.creatorName && incoming.creatorName) existing.creatorName = incoming.creatorName
  if (!existing.publisherName && incoming.publisherName) existing.publisherName = incoming.publisherName
  if (!existing.sourceProviderName && incoming.sourceProviderName) existing.sourceProviderName = incoming.sourceProviderName
  for (const field of ['posterUrl', 'backdropUrl', 'stillUrl', 'thumbnailUrl', 'thumbnail', 'duration', 'durationSec', 'seasonNumber', 'episodeNumber', 'trackNumber', 'archiveStatus', 'availabilityStatus']) {
    if ((existing[field] === null || existing[field] === undefined || existing[field] === '') && incoming[field] !== null && incoming[field] !== undefined && incoming[field] !== '') existing[field] = incoming[field]
  }
  // Whichever publisher described the title wins over one that carried nothing,
  // and an entity that was never described keeps no key at all.
  for (const [field, value] of Object.entries(describedCategories(incoming))) {
    if (existing[field] === null || existing[field] === undefined) existing[field] = value
  }
  mergeArraysByKey(existing.sources, incoming.sources, mediaSourceMergeKey)
  mergeArraysByKey(existing.alternateSources, incoming.alternateSources, mediaSourceMergeKey)
  mergeArraysByKey(existing.provenance, incoming.provenance, provenanceClaimKey)
  mergeArraysByKey(existing.conflicts, incoming.conflicts, (entry) => entry.claimId || entry.id || JSON.stringify(entry))
  mergeArraysByKey(existing.artwork, incoming.artwork, (entry) => [entry.role, entry.url, entry.blobId, entry.blobsCoreKey].join(':'))
  mergeArraysByKey(existing.creatorRoles, incoming.creatorRoles, (entry) => `${entry.role}:${entry.name}`)
  const reselection = selectMediaSource({ sources: existing.sources })
  const selected = reselection.selectedSource
  existing.selectedSource = selected
  existing.alternateSources = reselection.alternateSources
  existing.sourceCount = reselection.sourceCount
  existing.playbackKey = selected?.playbackKey || existing.playbackKey
  existing.publicationId = selected?.publicationId || existing.publicationId
  existing.renditionId = selected?.renditionId || existing.renditionId
  if (selected?.publisherName) existing.publisherName = selected.publisherName
  if (selected?.sourceProviderName || selected?.publisherName) existing.sourceProviderName = selected.sourceProviderName || selected.publisherName
  if (selected?.availabilityStatus) existing.availabilityStatus = selected.availabilityStatus
  if (selected?.archiveStatus) existing.archiveStatus = selected.archiveStatus
  return existing
}

function collectionMemberKey(member) {
  if (!nonArrayObject(member)) return JSON.stringify(member)
  return firstNonEmptyString([
    member.localEntityId,
    member.workId,
    member.entityId,
    member.id,
    member.videoId,
    member.path,
  ], JSON.stringify(member))
}

function missingMemberKey(member) {
  if (!nonArrayObject(member)) return JSON.stringify(member)
  const position = nonArrayObject(member.position) ? member.position : {}
  return firstNonEmptyString([
    member.localEntityId,
    member.workId,
    member.entityId,
    member.id,
    `${position.season || ''}:${position.episode || ''}:${position.track || ''}:${member.reason || ''}`,
  ], JSON.stringify(member))
}

function mergeProjectedCollection(existing, incoming) {
  mergeProjectedEntity(existing, incoming)
  mergeArraysByKey(existing.items, incoming.items, collectionMemberKey)
  mergeArraysByKey(existing.missingMembers, incoming.missingMembers, missingMemberKey)
  existing.itemCount = Math.max(
    Number.isSafeInteger(existing.itemCount) ? existing.itemCount : 0,
    Number.isSafeInteger(incoming.itemCount) ? incoming.itemCount : 0,
    existing.items.length,
  )
  existing.completeness = {
    itemCount: existing.itemCount,
    missingCount: existing.missingMembers.length,
    hasTrustedStructure: Boolean(existing.completeness?.hasTrustedStructure || incoming.completeness?.hasTrustedStructure),
  }
  return existing
}

function legacyVideoToEntity(item, sourceName, index) {
  if (!nonArrayObject(item)) return null
  const id = firstNonEmptyString([item.id, item.videoId, item.path], null)
  const title = firstNonEmptyString([item.title], null)
  if (!id || !title) return null
  const channelKey = firstNonEmptyString([item.channelKey, item.driveKey, item.channel?.key], 'local')
  const publisherName = firstNonEmptyString([item.channelName, item.channel?.name, item.creatorName], null)
  return normalizeGraphEntity({
    localEntityId: `legacy:${channelKey}:${id}`,
    entityKind: 'work',
    contentKind: item.contentKind || item.classification?.type || 'video',
    title,
    subtitle: item.subtitle,
    creatorName: item.creatorName,
    posterUrl: item.posterUrl,
    backdropUrl: item.backdropUrl,
    stillUrl: item.stillUrl,
    thumbnailUrl: item.thumbnailUrl || item.thumbnail,
    thumbnail: item.thumbnail,
    artwork: asArray(item.artwork),
    classification: item.classification,
    category: item.category,
    profileKind: item.profileKind,
    seasonNumber: item.seasonNumber,
    episodeNumber: item.episodeNumber,
    duration: item.duration || item.durationSec,
    durationSec: item.durationSec || item.duration,
    progress: item.progress,
    publishedAt: item.publishedAt || item.uploadedAt || item.createdAt || item.updatedAt,
    provenance: [{ role: 'legacy-publication', publisherName, publisherId: channelKey, source: sourceName }],
    sources: [{ ...item, publisherName, publisherId: channelKey, sourceProviderName: publisherName }],
  }, index)
}

function normalizeCollection(entity, index) {
  const projected = normalizeGraphEntity({ ...entity, entityKind: 'collection' }, index)
  if (!projected) return null
  const items = asArray(entity.items || entity.members || entity.collectionItems)
  const missingMembers = asArray(entity.missingMembers || entity.missingSlots)
  return {
    ...projected,
    itemCount: Number.isSafeInteger(entity.itemCount) ? entity.itemCount : items.length,
    items,
    missingMembers,
    completeness: entity.completeness || {
      known: items.length,
      missing: missingMembers.length,
      hasTrustedStructure: missingMembers.length > 0 && entity.trustedStructure === true,
    },
  }
}

function normalizeAgent(entity, index) {
  const projected = normalizeGraphEntity({ ...entity, entityKind: 'agent', contentKind: 'creator' }, index)
  if (!projected) return null
  return {
    ...projected,
    contributions: asArray(entity.contributions),
    sourcePublisherCount: new Set(asArray(entity.contributions).map((entry) => entry.publisherId || entry.publisherName).filter(Boolean)).size,
  }
}

function graphEntityArrays(input = {}) {
  const mediaGraph = nonArrayObject(input.mediaGraph) ? input.mediaGraph : {}
  return {
    entities: [
      ...asArray(input.mediaEntities),
      ...asArray(input.resolvedEntities),
      ...asArray(mediaGraph.entities),
      ...asArray(mediaGraph.works),
      ...asArray(input.works),
    ],
    collections: [
      ...asArray(input.collections),
      ...asArray(mediaGraph.collections),
    ],
    agents: [
      ...asArray(input.agents),
      ...asArray(input.creators),
      ...asArray(mediaGraph.agents),
      ...asArray(mediaGraph.creators),
    ],
  }
}

function normalizeBoundedSource(source = {}, index = 0) {
  const publicationId = String(source.publicationId || source.id || `source:${index}`)
  const renditionId = source.renditionId == null ? null : String(source.renditionId)
  return {
    ...source,
    publicationId,
    renditionId,
    publisherId: source.publisherId ?? null,
    sourceProvider: source.sourceProvider ?? source.provider ?? null,
    playable: isMediaSourcePlayable({ ...source, publicationId, renditionId }),
    score: finiteNumber(source.score) ? source.score : 0,
    playbackRef: publicationId && renditionId ? { publicationId, renditionId } : null,
  }
}

function projectSingleMediaEntity(input) {
  const entity = input.entity || {}
  const sources = asArray(input.publications ?? input.sources).map(normalizeBoundedSource)
  const playable = sources
    .filter(source => source.playable && source.playbackRef)
    .sort((left, right) => right.score - left.score || left.publicationId.localeCompare(right.publicationId))
  const primarySource = playable[0] || null
  const collectionItems = asArray(input.collectionItems).map((item, index) => ({
    entityId: String(item.entityId || item.id || `item:${index}`),
    title: item.title ?? null,
    position: finiteNumber(item.position) ? item.position : index + 1,
    edition: item.edition ?? null,
    available: item.available !== false,
    sourceCount: asArray(item.sources).length,
    item,
  }))
  return {
    id: entity.entityId || input.entityId || null,
    title: entity.title || entity.metadata?.title || null,
    entity,
    sources,
    primarySource,
    playbackRef: primarySource?.playbackRef || null,
    creatorRoles: asArray(input.contributions).map(role => ({
      agentId: role.agentId ?? null,
      name: role.name ?? null,
      role: role.role ?? 'contributor',
      provenance: role.provenance ?? null,
    })),
    provenance: asArray(input.provenance),
    conflicts: asArray(input.conflicts),
    collection: {
      items: collectionItems,
      completeness: collectionItems.length === 0
        ? 'none'
        : collectionItems.every(item => item.available)
          ? 'complete'
          : 'partial',
    },
    ...describedCategories(entity),
    archiveStatus: input.archiveStatus || null,
  }
}

export function projectMediaEntityGraph(input = {}, options = {}) {
  if (nonArrayObject(input.entity)) return projectSingleMediaEntity(input)
  const includeLegacy = options.includeLegacy === true
  const arrays = graphEntityArrays(input)
  const byEntity = new Map()

  arrays.entities.forEach((entity, index) => {
    const projected = normalizeGraphEntity(entity, index, options)
    if (projected === null) return
    const key = projected.localEntityId
    if (byEntity.has(key)) mergeProjectedEntity(byEntity.get(key), projected)
    else byEntity.set(key, projected)
  })

  if (includeLegacy) {
    const legacyGroups = [
      ['feed', input.feedVideos],
      ['library', input.myVideos],
      ['recommended', input.recommendedVideos],
    ]
    for (const [sourceName, items] of legacyGroups) {
      asArray(items).forEach((item, index) => {
        const projected = legacyVideoToEntity(item, sourceName, index)
        if (projected === null) return
        const key = projected.localEntityId
        if (byEntity.has(key)) mergeProjectedEntity(byEntity.get(key), projected)
        else byEntity.set(key, projected)
      })
    }
  }

  const byCollection = new Map()
  arrays.collections.forEach((entity, index) => {
    const projected = normalizeCollection(entity, index)
    if (projected === null) return
    const key = projected.localEntityId
    if (byCollection.has(key)) mergeProjectedCollection(byCollection.get(key), projected)
    else byCollection.set(key, projected)
  })
  const collections = Array.from(byCollection.values())
  const agents = arrays.agents.map(normalizeAgent).filter((item) => item !== null)
  const mediaItems = Array.from(byEntity.values())
  const allItems = [...mediaItems, ...collections, ...agents]

  return {
    mediaItems,
    collections,
    agents,
    allItems,
    counts: {
      works: mediaItems.length,
      collections: collections.length,
      agents: agents.length,
      sources: mediaItems.reduce((total, item) => total + item.sourceCount, 0),
      conflicts: mediaItems.reduce((total, item) => total + item.conflicts.length, 0),
    },
  }
}
