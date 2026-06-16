const PLATFORM_LABELS = {
  youtube: 'YouTube',
  rumble: 'Rumble',
  odysee: 'Odysee',
  tiktok: 'TikTok',
  vimeo: 'Vimeo',
}

function titleCase(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  return text
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function toFiniteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function hasSourceMetadata(video = {}) {
  return Boolean(
    video?.sourcePlatform ||
    video?.sourcePlatformLabel ||
    video?.sourceUrl ||
    video?.sourceId ||
    video?.sourceCreatorName ||
    video?.sourceCreatorHandle
  )
}

export function formatSourceCount(value, singular, plural = `${singular}s`) {
  const count = toFiniteNumber(value)
  if (count === null || count < 0) return null
  const label = count === 1 ? singular : plural
  if (count < 1000) return `${count} ${label}`
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}K ${label}`
  if (count < 1_000_000_000) return `${(count / 1_000_000).toFixed(1)}M ${label}`
  return `${(count / 1_000_000_000).toFixed(1)}B ${label}`
}

export function formatSourceTimeAgo(timestamp, now = Date.now()) {
  const value = toFiniteNumber(timestamp)
  if (!value || value <= 0) return null
  const seconds = Math.floor((now - value) / 1000)
  if (!Number.isFinite(seconds) || seconds < 0) return null
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

export function getSourceMetadataDisplay(video = {}, options = {}) {
  const hasSource = hasSourceMetadata(video)
  const platformKey = String(video?.sourcePlatform || '').trim().toLowerCase()
  const platformLabel =
    video?.sourcePlatformLabel ||
    PLATFORM_LABELS[platformKey] ||
    titleCase(platformKey) ||
    'Source'
  const creatorLabel = video?.sourceCreatorHandle || video?.sourceCreatorName || ''
  const viewText = formatSourceCount(video?.sourceViewCount, 'view')
  const likeText = formatSourceCount(video?.sourceLikeCount, 'like')
  const commentText = formatSourceCount(video?.sourceCommentCount, 'comment')
  const publishedText = formatSourceTimeAgo(video?.sourcePublishedAt, options.now)
  const archivedText = formatSourceTimeAgo(video?.sourceArchivedAt, options.now)

  const compactParts = [creatorLabel, viewText, publishedText].filter(Boolean)
  const countParts = [viewText, likeText, commentText].filter(Boolean)
  const archiveLine = video?.sourceRelayId
    ? `Archived by ${video.sourceRelayId}`
    : archivedText
      ? `Archived ${archivedText}`
      : ''

  return {
    hasSource,
    platformKey,
    platformLabel,
    creatorLabel,
    compactLine: compactParts.join(' · '),
    detailCounts: countParts.join(' · '),
    publishedText,
    archivedText,
    archiveLine,
    sourceUrl: video?.sourceUrl || '',
    sourceDescription: video?.sourceDescription || video?.description || '',
  }
}
