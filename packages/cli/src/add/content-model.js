import { channelSourceIdentityKey, importIdentityKey as backendImportIdentityKey } from '@peartube/backend/structured-content'

// Video import claims key on the canonical `provider:contentKind:sourceVideoId`
// identity, distinct from a channel-source (creator profile) identity key.
export function deriveImportIdentityKey ({ contentKind = 'video', sourceProvider, sourceVideoId, mediaProvider, mediaId, seasonNumber, episodeNumber, contentFingerprint } = {}) {
  return backendImportIdentityKey({ contentKind, sourceProvider, sourceVideoId, mediaProvider, mediaId, seasonNumber, episodeNumber, contentFingerprint })
}

// Query parameters that never contribute to a stable content identity.
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'fbclid', 'mc_cid', 'mc_eid', 'igshid', 'si', 'feature',
  'pp', 'ab_channel', 'spm', '_ga'
])

// Parameters that identify content across providers and must survive normalization.
const IDENTITY_PARAMS = new Set(['v', 'list', 'p', 'video_id', 'clip'])

export function normalizeIdentityUrl (value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  let url
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  if (!/^https?:$/i.test(url.protocol)) return null

  url.protocol = url.protocol.toLowerCase()
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '')
  url.hash = ''
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
    url.port = ''
  }

  const kept = []
  for (const [key, val] of url.searchParams.entries()) {
    const lower = key.toLowerCase()
    if (TRACKING_PARAMS.has(lower)) continue
    if (IDENTITY_PARAMS.has(lower)) kept.push([key, val])
  }
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  url.search = ''
  for (const [key, val] of kept) url.searchParams.append(key, val)

  let out = url.toString()
  if (out.endsWith('/') && url.pathname === '/') out = out.slice(0, -1)
  return out
}

export function deriveContentIdentityKey ({ provider, sourceId = null, identityUrl = null } = {}) {
  const normalizedUrl = identityUrl ? normalizeIdentityUrl(identityUrl) || identityUrl : undefined
  return channelSourceIdentityKey({
    provider,
    sourceId: sourceId || undefined,
    identityUrl: normalizedUrl
  })
}

export function buildShowChannelDraft (show) {
  return freezeChannel({
    kind: 'channel',
    profileKind: 'tvShow',
    name: show.name || show.title || 'Untitled show',
    description: show.description || '',
    mediaProvider: show.mediaProvider || show.provider || 'tmdb',
    mediaId: show.mediaId != null ? String(show.mediaId) : null,
    sources: [],
    artwork: normalizeArtwork(show.artwork),
    channelTarget: { mode: 'new' }
  })
}

export function buildMovieChannelDraft (movie) {
  return freezeChannel({
    kind: 'channel',
    profileKind: 'movie',
    name: movie.title || movie.name || 'Untitled movie',
    description: movie.description || '',
    mediaProvider: movie.mediaProvider || movie.provider || 'tmdb',
    mediaId: movie.mediaId != null ? String(movie.mediaId) : null,
    sources: [],
    artwork: normalizeArtwork(movie.artwork),
    channelTarget: { mode: 'new' }
  })
}

export function buildDirectChannelDraft ({ name = 'My PearTube', description = '', channelTarget = { mode: 'new' } } = {}) {
  return freezeChannel({
    kind: 'channel',
    profileKind: 'creator',
    name,
    description,
    mediaProvider: null,
    mediaId: null,
    sources: [],
    artwork: [],
    channelTarget: normalizeChannelTarget(channelTarget)
  })
}

export function buildCreatorChannelDraft (creator, channelTarget = { mode: 'new' }) {
  const source = buildCreatorSource(creator)
  return freezeChannel({
    kind: 'channel',
    profileKind: 'creator',
    name: creator.name || creator.displayName || 'Creator',
    description: creator.biography || '',
    mediaProvider: creator.platform || creator.provider || null,
    mediaId: creator.sourceId != null ? String(creator.sourceId) : null,
    sources: source ? [source] : [],
    artwork: normalizeArtwork(creator.artwork),
    channelTarget: normalizeChannelTarget(channelTarget)
  })
}

export function buildEpisodeItemDraft (episode, source = {}) {
  return buildItemDraft({
    contentKind: 'episode',
    title: episode.title || null,
    seasonNumber: episode.seasonNumber ?? null,
    episodeNumber: episode.episodeNumber ?? null,
    sourcePublishedAt: episode.airDate || null,
    artwork: normalizeArtwork(episode.artwork),
    source
  })
}

export function buildMovieItemDraft (movie, source = {}) {
  return buildItemDraft({
    contentKind: 'movie',
    title: movie.title || movie.name || null,
    sourcePublishedAt: movie.releaseDate || null,
    artwork: normalizeArtwork(movie.artwork),
    source
  })
}

export function buildCreatorItemDraft (item, source = {}) {
  const merged = {
    provider: item.sourceProvider || source.provider,
    sourceVideoId: item.sourceVideoId || source.sourceVideoId,
    identityUrl: item.canonicalUrl || source.identityUrl,
    displayUrl: item.canonicalUrl || source.displayUrl,
    fetchUrl: item.canonicalUrl || source.fetchUrl
  }
  return buildItemDraft({
    contentKind: item.contentKind || 'video',
    title: item.title || null,
    sourcePublishedAt: item.sourcePublishedAt || null,
    artwork: normalizeArtwork(item.thumbnail ? [{ role: 'thumbnail', url: item.thumbnail }] : item.artwork),
    source: merged
  })
}

function buildItemDraft ({ contentKind, title, seasonNumber = null, episodeNumber = null, sourcePublishedAt = null, artwork = [], source = {} }) {
  const identityUrl = source.identityUrl ? normalizeIdentityUrl(source.identityUrl) : null
  const draft = {
    kind: 'item',
    contentKind,
    title,
    sourceProvider: source.provider || null,
    sourceVideoId: source.sourceVideoId != null ? String(source.sourceVideoId) : null,
    identityUrl,
    displayUrl: source.displayUrl || source.identityUrl || null,
    sourcePublishedAt,
    seasonNumber,
    episodeNumber,
    artwork
  }
  return Object.freeze(draft)
}

export function buildCreatorSource (creator) {
  if (!creator) return null
  const provider = creator.platform || creator.provider
  if (!provider) return null
  const identityUrl = creator.canonicalUrl ? normalizeIdentityUrl(creator.canonicalUrl) : null
  const sourceId = creator.sourceId != null ? String(creator.sourceId) : null
  if (!sourceId && !identityUrl) return null
  const source = { provider, sourceId, identityUrl, handle: creator.handle || null, displayName: creator.name || null }
  source.identityKey = deriveContentIdentityKey({ provider, sourceId, identityUrl })
  return source
}

// Runtime-only fields must never enter a persisted draft.
export function assertNoRuntimeFields (draft) {
  const forbidden = ['fetchUrl']
  const walk = (value) => {
    if (Array.isArray(value)) return value.every(walk)
    if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) {
        if (forbidden.includes(key)) return false
        if (!walk(value[key])) return false
      }
    }
    return true
  }
  return walk(draft)
}

function normalizeChannelTarget (channelTarget) {
  if (channelTarget && channelTarget.mode === 'existing' && channelTarget.channelKey) {
    return { mode: 'existing', channelKey: String(channelTarget.channelKey) }
  }
  return { mode: 'new' }
}

function normalizeArtwork (artwork) {
  if (!Array.isArray(artwork)) return []
  return artwork
    .filter((entry) => entry && (entry.url || entry.path))
    .map((entry) => ({
      role: entry.role || 'poster',
      provider: entry.provider || null,
      url: entry.url || null,
      path: entry.path || null
    }))
}

function freezeChannel (channel) {
  channel.sources = channel.sources.map((source) => Object.freeze({ ...source }))
  channel.artwork = channel.artwork.map((art) => Object.freeze({ ...art }))
  channel.channelTarget = Object.freeze({ ...channel.channelTarget })
  return Object.freeze(channel)
}
