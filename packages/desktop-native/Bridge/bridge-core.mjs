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

function normalizeSource(entry, sourceKind) {
  const channelKey = entry?.channelKey || entry?.driveKey
  if (!channelKey) return null

  return {
    channelKey,
    publicBeeKey: entry?.publicBeeKey || null,
    channelName: entry?.channelName || entry?.name || null,
    sourceKind,
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

  return result
}

function ensureSectionMap() {
  return Object.fromEntries(SECTION_ORDER.map((section) => [section, []]))
}

function ensureVideoRecord(registry, videoKey, payload) {
  const existing = registry.get(videoKey)
  if (existing) return existing

  const created = { ...payload, sections: [] }
  registry.set(videoKey, created)
  return created
}

async function populateSection(section, sources, config, fetchChannelData, registry, sectionMap) {
  if (!config.sourceLimit || !config.videosPerChannel) return

  for (const source of sources.slice(0, config.sourceLimit)) {
    const result = await fetchChannelData(source)
    const meta = result?.channelMeta || {}
    const videos = Array.isArray(result?.videos) ? result.videos.slice(0, config.videosPerChannel) : []

    for (const video of videos) {
      if (!video?.id) continue

      const videoKey = `${source.channelKey}:${video.id}`
      const normalized = ensureVideoRecord(registry, videoKey, {
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
      })

      if (!normalized.sections.includes(section)) {
        normalized.sections.push(section)
      }

      if (!sectionMap[section].includes(videoKey)) {
        sectionMap[section].push(videoKey)
      }
    }
  }
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

  await populateSection('home', homeSources, SECTION_CONFIG.home, fetchChannelData, registry, sectionMap)
  await populateSection('subscriptions', subscriptionSources, SECTION_CONFIG.subscriptions, fetchChannelData, registry, sectionMap)
  await populateSection('library', identitySources, SECTION_CONFIG.library, fetchChannelData, registry, sectionMap)
  await populateSection('studio', identitySources, SECTION_CONFIG.studio, fetchChannelData, registry, sectionMap)

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
    })
  }

  return shapedResults
}
