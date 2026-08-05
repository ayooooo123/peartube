/**
 * Shared formatting utilities.
 *
 * Canonical source for formatBytes, formatTimeAgo, formatDuration, formatViews.
 * Import from here instead of re-implementing per-file.
 */

/**
 * Format a byte count to a human-readable string (e.g. "1.5 MB", "2.3 GB").
 * Accepts number, string, null, or undefined for maximum caller flexibility.
 */
export function formatBytes(bytes: number | string | null | undefined): string {
  const n = typeof bytes === 'string' ? Number(bytes) : bytes
  if (n == null || isNaN(n) || n <= 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/**
 * Byte count for a metadata line, or null when the size is genuinely unknown.
 *
 * A title whose signed manifest never reached this device has no size, which is
 * not the same as a zero-byte file: "0 B" beside a video that is playing is a
 * plain lie, so callers omit the segment instead.
 */
export function formatSizeLabel(bytes: number | string | null | undefined): string | null {
  const n = typeof bytes === 'string' ? Number(bytes) : bytes
  if (n == null || !Number.isFinite(n) || n <= 0) return null
  return formatBytes(n)
}

/**
 * Format a timestamp (ms since epoch, or ISO date string) to a relative
 * time-ago string like "5m ago", "2h ago", "3d ago".
 */
export function formatTimeAgo(timestamp: number | string | null | undefined): string {
  if (timestamp == null) return 'recently'
  const ms = typeof timestamp === 'string' ? new Date(timestamp).getTime() : timestamp
  if (isNaN(ms) || ms <= 0) return 'recently'

  const seconds = Math.floor((Date.now() - ms) / 1000)
  if (seconds < 0) return 'recently'
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

/**
 * Format a duration in seconds to "m:ss" or "h:mm:ss".
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || isNaN(seconds) || seconds <= 0) return '0:00'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  return `${m}:${s.toString().padStart(2, '0')}`
}

/**
 * Format a view count to a compact string like "1.2K", "3.4M".
 */
export function formatViews(views: number | null | undefined): string {
  if (!views || views <= 0) return '0 views'
  if (views === 1) return '1 view'
  if (views < 1000) return `${views} views`
  if (views < 1_000_000) return `${(views / 1000).toFixed(1)}K views`
  return `${(views / 1_000_000).toFixed(1)}M views`
}

/**
 * Movie/TV coordinates a video (or feed preview entry) may carry. Videos
 * without them are plain uploads and render with no content badge.
 */
export interface ContentCoordinates {
  contentKind?: string | null
  seasonNumber?: number | null
  episodeNumber?: number | null
  classification?: {
    type?: string | null
    year?: number | null
    season?: number | null
    episode?: number | null
  } | null
}

/**
 * Canonical content-type badge: "Movie", "Movie · 1999", or "S01E03".
 * Accepts unknown (feed entries arrive untyped); returns null for plain videos
 * so callers can skip rendering entirely.
 */
export function formatContentBadge(video: unknown): string | null {
  if (!video || typeof video !== 'object') return null
  // Structural read of optional fields after the object guard above.
  const v = video as ContentCoordinates
  const kind = v.contentKind ||
    (v.classification?.type === 'movie' ? 'movie' : v.classification?.type === 'tv' ? 'episode' : null)
  if (kind === 'movie') {
    const year = v.classification?.year
    return year ? `Movie · ${year}` : 'Movie'
  }
  if (kind === 'episode') {
    const season = v.seasonNumber ?? v.classification?.season
    const episode = v.episodeNumber ?? v.classification?.episode
    if (season && episode) return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
  }
  return null
}
