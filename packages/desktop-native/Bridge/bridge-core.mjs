const SECTION_ORDER = Object.freeze([
  'home',
  'subscriptions',
  'library',
  'studio',
  'diagnostics',
])

const SECTION_CONFIG = Object.freeze({
  home: { sourceLimit: 8, videosPerChannel: 3 },
  subscriptions: { sourceLimit: 8, videosPerChannel: 3 },
  library: { sourceLimit: 4, videosPerChannel: 4 },
  studio: { sourceLimit: 4, videosPerChannel: 4 },
  diagnostics: { sourceLimit: 0, videosPerChannel: 0 },
})

const ACCENT_PALETTE = Object.freeze([
  '#FF7A59',
  '#4B65FF',
  '#12B886',
  '#E64980',
  '#F59F00',
  '#2F9E44',
  '#0C8599',
  '#C2255C',
])

function hashSeed(seed = '') {
  let hash = 0
  for (const char of String(seed)) {
    hash = ((hash << 5) - hash) + char.charCodeAt(0)
    hash |= 0
  }
  return Math.abs(hash)
}

export function pickAccentHex(seed) {
  return ACCENT_PALETTE[hashSeed(seed) % ACCENT_PALETTE.length]
}

export function formatDuration(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return 'Live'
  }

  const rounded = Math.max(1, Math.floor(seconds))
  const hours = Math.floor(rounded / 3600)
  const minutes = Math.floor((rounded % 3600) / 60)
  const secs = rounded % 60

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }

  return `${minutes}:${String(secs).padStart(2, '0')}`
}

function normalizeChannelName(source, meta, video) {
  return (
    meta?.name?.trim()
    || source.channelName?.trim()
    || video?.channelName?.trim()
    || `Channel ${source.channelKey.slice(0, 8)}`
  )
}

function normalizeSummary(meta, video) {
  return (
    video?.description?.trim()
    || meta?.description?.trim()
    || 'No description has been published for this video yet.'
  )
}

function normalizeTags(source, video, section) {
  const tags = new Set([
    section,
    source.sourceKind,
  ])

  if (video?.category) tags.add(video.category)
  return Array.from(tags).filter(Boolean)
}

function normalizeSearchTags(metadata) {
  const tags = ['search']
  if (metadata?.category) tags.push(metadata.category)
  return tags.filter(Boolean)
}

function getFeedEntryPriority(entry) {
  if (entry?.source === 'local') return 0
  if ((entry?.peerCount ?? 0) > 0) return 1
  if (entry?.publicBeeKey) return 2
  return 3
}

function normalizeSource(entry, sourceKind) {
  const channelKey = entry?.channelKey || entry?.driveKey
  if (!channelKey) return null

  return {
    channelKey,
    publicBeeKey: entry?.publicBeeKey || null,
    channelName: entry?.channelName || entry?.name || null,
    sourceKind,
    peerCount: entry?.peerCount ?? 0,
    source: entry?.source || null,
    previewVideos: Array.isArray(entry?.previewVideos) ? entry.previewVideos : [],
  }
}

function uniqueSources(entries, sourceKind) {
  const seen = new Set()
  const result = []

  for (const entry of entries || []) {
    const source = normalizeSource(entry, sourceKind)
    if (!source) continue
    const key = `${source.channelKey}:${source.publicBeeKey || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(source)
  }

  // Sort by priority: local > peer-seeded > publicBeeKey > fallback
  result.sort((a, b) => {
    const pa = getFeedEntryPriority(a)
    const pb = getFeedEntryPriority(b)
    return pa - pb
  })

  return result
}

function ensureSectionMap() {
  return Object.fromEntries(SECTION_ORDER.map((section) => [section, []]))
}

function cloneSections(sections = {}) {
  return Object.fromEntries(
    SECTION_ORDER.map((section) => [
      section,
      Array.isArray(sections?.[section]) ? sections[section].map((video) => ({ ...video })) : [],
    ])
  )
}

function deriveSnapshotStats(sections, state = {}) {
  const sectionVideos = SECTION_ORDER.flatMap((section) => sections?.[section] || [])
  const channelCount = new Set([
    ...sectionVideos.map((video) => video?.channelKey).filter(Boolean),
    ...(Array.isArray(state.subscriptionChannelKeys) ? state.subscriptionChannelKeys : []),
    ...(Array.isArray(state.identityChannelKeys) ? state.identityChannelKeys : []),
  ]).size

  return {
    homeCount: sections?.home?.length || 0,
    subscriptionCount: sections?.subscriptions?.length || 0,
    libraryCount: sections?.library?.length || 0,
    channelCount,
  }
}

function createEmptySnapshotState() {
  return {
    subscriptionChannelKeys: [],
    identityChannelKeys: [],
    activeIdentityName: null,
    activeIdentityChannelKey: null,
    activeChannelPublished: false,
  }
}

export function createEmptyBrowseSnapshot() {
  const sections = ensureSectionMap()
  const state = createEmptySnapshotState()

  return {
    generatedAt: Date.now(),
    sections,
    stats: deriveSnapshotStats(sections, state),
    state,
  }
}

function ensureVideoRecord(registry, videoKey, payload) {
  const existing = registry.get(videoKey)
  if (existing) return existing

  const created = { ...payload, sections: [] }
  registry.set(videoKey, created)
  return created
}

export function mergeVideoMetadata(video = {}, metadata = {}) {
  const preferMetadataString = (videoValue, metadataValue) => {
    if (typeof videoValue === 'string' && videoValue.trim().length > 0) return videoValue
    if (typeof metadataValue === 'string' && metadataValue.trim().length > 0) return metadataValue
    return videoValue ?? metadataValue ?? null
  }
  const preferMetadataDimension = (videoValue, metadataValue) => {
    if (Number.isFinite(videoValue) && videoValue > 0) return videoValue
    if (Number.isFinite(metadataValue) && metadataValue > 0) return metadataValue
    return null
  }

  return {
    ...video,
    title: preferMetadataString(video?.title, metadata?.title),
    description: preferMetadataString(video?.description, metadata?.description),
    duration: video?.duration ?? metadata?.duration ?? null,
    thumbnail: preferMetadataString(video?.thumbnail, metadata?.thumbnail),
    path: preferMetadataString(video?.path, metadata?.path),
    blobId: preferMetadataString(video?.blobId, metadata?.blobId),
    blobsCoreKey: preferMetadataString(video?.blobsCoreKey, metadata?.blobsCoreKey),
    mimeType: preferMetadataString(video?.mimeType, metadata?.mimeType),
    channelName: preferMetadataString(video?.channelName, metadata?.channelName),
    width: preferMetadataDimension(video?.width, metadata?.width),
    height: preferMetadataDimension(video?.height, metadata?.height),
  }
}

function videoToRecord(source, meta, video, section) {
  if (!video?.id) return null
  const videoKey = `${source.channelKey}:${video.id}`
  return {
    videoKey,
    id: videoKey,
    backendVideoID: video.id,
    channelKey: source.channelKey,
    publicBeeKey: source.publicBeeKey,
    title: video.title?.trim() || 'Untitled Video',
    channelName: normalizeChannelName(source, meta, video),
    durationText: formatDuration(video.duration),
    summary: normalizeSummary(meta, video),
    tags: normalizeTags(source, video, section),
    accentHex: pickAccentHex(source.channelKey),
    thumbnailURL: video.thumbnail || null,
    path: video.path || null,
    blobId: video.blobId || null,
    blobsCoreKey: video.blobsCoreKey || null,
    mimeType: video.mimeType || null,
    width: Number.isFinite(video.width) && video.width > 0 ? video.width : null,
    height: Number.isFinite(video.height) && video.height > 0 ? video.height : null,
  }
}

async function resolveSectionRecords(section, sources, config, fetchChannelData) {
  if (!config.sourceLimit || !config.videosPerChannel) return []

  const selectedSources = sources.slice(0, config.sourceLimit)
  const records = []

  // Fast path: use preview videos from feed entries when available.
  // This avoids a fetchChannelData round-trip for sources that already
  // include preview video data from the P2P gossip feed.
  const sourcesNeedingFetch = []
  for (const source of selectedSources) {
    if (source.previewVideos.length > 0) {
      for (const video of source.previewVideos.slice(0, config.videosPerChannel)) {
        const record = videoToRecord(source, {}, video, section)
        if (record) records.push(record)
      }
    } else {
      sourcesNeedingFetch.push(source)
    }
  }

  // Fetch remaining sources that didn't have preview data
  if (sourcesNeedingFetch.length > 0) {
    const resolvedSources = await Promise.all(
      sourcesNeedingFetch.map(async (source) => ({
        source,
        result: await fetchChannelData(source),
      }))
    )

    for (const { source, result } of resolvedSources) {
      const meta = result?.channelMeta || {}
      const videos = Array.isArray(result?.videos) ? result.videos.slice(0, config.videosPerChannel) : []
      for (const video of videos) {
        const record = videoToRecord(source, meta, video, section)
        if (record) records.push(record)
      }
    }
  }

  return records
}

export async function buildBrowseSnapshot({
  feedEntries = [],
  subscriptions = [],
  identities = [],
  fetchChannelData,
  activeChannelPublished = false,
}) {
  if (typeof fetchChannelData !== 'function') {
    throw new TypeError('buildBrowseSnapshot requires fetchChannelData')
  }

  const registry = new Map()
  const sectionMap = ensureSectionMap()

  const homeSources = uniqueSources(
    feedEntries.length > 0
      ? feedEntries
      : [...subscriptions, ...identities],
    feedEntries.length > 0 ? 'feed' : 'fallback'
  )
  const subscriptionSources = uniqueSources(subscriptions, 'subscription')
  const identitySources = uniqueSources(identities, 'identity')
  const activeIdentity = identities.find((identity) => identity?.isActive) || null
  const identityChannelKeys = Array.from(new Set(
    identities.map((identity) => identity?.channelKey || identity?.driveKey).filter(Boolean)
  ))
  const subscriptionChannelKeys = Array.from(new Set(
    subscriptions.map((entry) => entry?.channelKey || entry?.driveKey).filter(Boolean)
  ))

  const resolvedSections = await Promise.all([
    resolveSectionRecords('home', homeSources, SECTION_CONFIG.home, fetchChannelData),
    resolveSectionRecords('subscriptions', subscriptionSources, SECTION_CONFIG.subscriptions, fetchChannelData),
    resolveSectionRecords('library', identitySources, SECTION_CONFIG.library, fetchChannelData),
    resolveSectionRecords('studio', identitySources, SECTION_CONFIG.studio, fetchChannelData),
  ])

  for (const [section, records] of [
    ['home', resolvedSections[0]],
    ['subscriptions', resolvedSections[1]],
    ['library', resolvedSections[2]],
    ['studio', resolvedSections[3]],
  ]) {
    for (const record of records) {
      const normalized = ensureVideoRecord(registry, record.videoKey, record)

      if (!normalized.sections.includes(section)) {
        normalized.sections.push(section)
      }

      if (!sectionMap[section].includes(record.videoKey)) {
        sectionMap[section].push(record.videoKey)
      }
    }
  }

  const sections = Object.fromEntries(
    SECTION_ORDER.map((section) => [
      section,
      sectionMap[section].map((key) => registry.get(key)).filter(Boolean),
    ])
  )

  return {
    generatedAt: Date.now(),
    sections,
    stats: {
      homeCount: sections.home.length,
      subscriptionCount: sections.subscriptions.length,
      libraryCount: sections.library.length,
      channelCount: new Set([
        ...homeSources.map((entry) => entry.channelKey),
        ...subscriptionSources.map((entry) => entry.channelKey),
        ...identitySources.map((entry) => entry.channelKey),
      ]).size,
    },
    state: {
      subscriptionChannelKeys,
      identityChannelKeys,
      activeIdentityName: activeIdentity?.name?.trim() || null,
      activeIdentityChannelKey: activeIdentity?.channelKey || activeIdentity?.driveKey || null,
      activeChannelPublished: Boolean(activeChannelPublished),
    },
  }
}

export function buildIdentityMutationSnapshot({
  previousSnapshot = null,
  identities = [],
  activeChannelPublished = false,
}) {
  const baseSnapshot = previousSnapshot || createEmptyBrowseSnapshot()
  const sections = cloneSections(baseSnapshot.sections)
  const activeIdentity = identities.find((identity) => identity?.isActive) || identities.at(-1) || null
  const identityChannelKeys = Array.from(new Set(
    identities.map((identity) => identity?.channelKey || identity?.driveKey).filter(Boolean)
  ))
  const subscriptionChannelKeys = Array.from(new Set(
    Array.isArray(baseSnapshot.state?.subscriptionChannelKeys)
      ? baseSnapshot.state.subscriptionChannelKeys.filter(Boolean)
      : []
  ))
  const state = {
    subscriptionChannelKeys,
    identityChannelKeys,
    activeIdentityName: activeIdentity?.name?.trim() || null,
    activeIdentityChannelKey: activeIdentity?.channelKey || activeIdentity?.driveKey || null,
    activeChannelPublished: Boolean(activeChannelPublished),
  }

  return {
    generatedAt: Date.now(),
    sections,
    stats: deriveSnapshotStats(sections, state),
    state,
  }
}

export async function buildSearchResults({
  results = [],
  fetchChannelData,
}) {
  if (typeof fetchChannelData !== 'function') {
    throw new TypeError('buildSearchResults requires fetchChannelData')
  }

  const channelCache = new Map()

  async function resolveChannelMeta(source) {
    const cacheKey = `${source.channelKey}:${source.publicBeeKey || ''}`
    if (!channelCache.has(cacheKey)) {
      channelCache.set(cacheKey, Promise.resolve(fetchChannelData(source)).then((value) => value || {}))
    }
    return channelCache.get(cacheKey)
  }

  const shapedResults = []

  for (const result of results) {
    const metadata = typeof result?.metadata === 'string'
      ? JSON.parse(result.metadata)
      : (result?.metadata || {})

    const channelKey = metadata.channelKey || metadata.driveKey
    if (!channelKey || !result?.id) continue

    const source = {
      channelKey,
      publicBeeKey: metadata.publicBeeKey || null,
      channelName: metadata.channelName || null,
      sourceKind: 'search',
    }
    const channelData = await resolveChannelMeta(source)
    const channelMeta = channelData?.channelMeta || {}

    shapedResults.push({
      id: `${channelKey}:${result.id}`,
      backendVideoID: result.id,
      channelKey,
      publicBeeKey: source.publicBeeKey,
      title: metadata.title?.trim() || 'Untitled Video',
      channelName: normalizeChannelName(source, channelMeta, metadata),
      durationText: formatDuration(metadata.duration),
      summary: normalizeSummary(channelMeta, metadata),
      tags: normalizeSearchTags(metadata),
      accentHex: pickAccentHex(channelKey),
      sections: ['home'],
      thumbnailURL: metadata.thumbnail || null,
      path: metadata.path || null,
      blobId: metadata.blobId || null,
      blobsCoreKey: metadata.blobsCoreKey || null,
      mimeType: metadata.mimeType || null,
      width: Number.isFinite(metadata.width) && metadata.width > 0 ? metadata.width : null,
      height: Number.isFinite(metadata.height) && metadata.height > 0 ? metadata.height : null,
    })
  }

  return shapedResults
}

export function buildChannelWorkspaceVideos({
  channelKey,
  publicBeeKey = null,
  channelMeta = {},
  videos = [],
  sourceKind = 'identity',
  sections = ['studio', 'library'],
}) {
  if (!channelKey) return []

  const normalizedSections = Array.from(new Set(
    (Array.isArray(sections) ? sections : []).filter(Boolean)
  ))
  const primarySection = normalizedSections[0] || 'library'
  const source = {
    channelKey,
    publicBeeKey,
    channelName: channelMeta?.name || null,
    sourceKind,
  }

  return (Array.isArray(videos) ? videos : []).flatMap((video) => {
    if (!video?.id) return []

    return [{
      id: `${channelKey}:${video.id}`,
      backendVideoID: video.id,
      channelKey,
      publicBeeKey: video.publicBeeKey || publicBeeKey,
      title: video.title?.trim() || 'Untitled Video',
      channelName: normalizeChannelName(source, channelMeta, video),
      durationText: formatDuration(video.duration),
      summary: normalizeSummary(channelMeta, video),
      tags: normalizeTags(source, video, primarySection),
      accentHex: pickAccentHex(channelKey),
      sections: normalizedSections,
      thumbnailURL: video.thumbnail || null,
      path: video.path || null,
      blobId: video.blobId || null,
      blobsCoreKey: video.blobsCoreKey || null,
      mimeType: video.mimeType || null,
      width: Number.isFinite(video.width) && video.width > 0 ? video.width : null,
      height: Number.isFinite(video.height) && video.height > 0 ? video.height : null,
    }]
  })
}
