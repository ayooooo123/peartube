/**
 * Video Player Formatters
 *
 * Utility functions for formatting time, sizes, and dates in the video player.
 */

/**
 * Format file size in bytes to human-readable string
 * @param bytes - Size in bytes
 * @returns Formatted string (e.g., "1.5 MB", "2.3 GB")
 */
export function formatSize(bytes: number | undefined | null): string {
  if (!bytes || isNaN(bytes) || bytes <= 0) {
    return 'Unknown size'
  }
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/**
 * Format timestamp to relative time ago
 * @param timestamp - Unix timestamp in milliseconds
 * @returns Formatted string (e.g., "5m ago", "2h ago", "3d ago")
 */
export function formatTimeAgo(timestamp: number | undefined | null): string {
  if (!timestamp || isNaN(timestamp) || timestamp <= 0) {
    return 'recently'
  }
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (isNaN(seconds) || seconds < 0) return 'recently'
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

/**
 * Format duration in seconds to mm:ss format
 * @param seconds - Duration in seconds
 * @returns Formatted string (e.g., "3:45", "12:00")
 */
export function formatDuration(seconds: number): string {
  if (!seconds || isNaN(seconds)) return '0:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

/**
 * Format bytes for P2P stats display (simplified version)
 * @param bytes - Size in bytes
 * @returns Formatted string without "Unknown size" fallback
 */
export function formatSizeCompact(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
