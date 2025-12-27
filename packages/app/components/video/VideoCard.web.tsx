/**
 * Video Card - Desktop video thumbnail card
 *
 * Features:
 * - Larger thumbnail with hover effect (scale 1.02)
 * - Duration badge bottom-right
 * - Title (2 lines, line-clamp)
 * - Channel name + time ago
 * - Hover: subtle scale animation
 */
import React, { useState } from 'react'
import { colors } from '@/lib/colors'

export interface VideoCardProps {
  id: string
  title: string
  thumbnailUrl?: string
  channelName: string
  channelAvatarUrl?: string
  views?: number
  uploadedAt?: string
  duration?: number
  onPress?: () => void
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`
}

function formatViews(views: number): string {
  if (views >= 1000000) {
    return `${(views / 1000000).toFixed(1)}M views`
  }
  if (views >= 1000) {
    return `${(views / 1000).toFixed(1)}K views`
  }
  return `${views} views`
}

function formatTimeAgo(dateString: string): string {
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return '1 day ago'
  if (diffDays < 7) return `${diffDays} days ago`
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`
  if (diffDays < 365) return `${Math.floor(diffDays / 30)} months ago`
  return `${Math.floor(diffDays / 365)} years ago`
}

export function VideoCardDesktop({
  id,
  title,
  thumbnailUrl,
  channelName,
  channelAvatarUrl,
  views,
  uploadedAt,
  duration,
  onPress,
}: VideoCardProps) {
  const [isHovered, setIsHovered] = useState(false)
  const [imageError, setImageError] = useState(false)

  console.log('[VideoCard.web] Rendering:', id, 'thumbnailUrl:', thumbnailUrl?.slice(0, 50))

  return (
    <article
      style={{
        ...styles.card,
        transform: isHovered ? 'scale(1.02)' : 'scale(1)',
      }}
      onClick={onPress}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onPress?.()
        }
      }}
    >
      {/* Thumbnail */}
      <div style={styles.thumbnailContainer}>
        {thumbnailUrl && !imageError ? (
          <img
            src={thumbnailUrl}
            alt={title}
            style={styles.thumbnail}
            loading="lazy"
            onError={() => {
              console.log('[VideoCard.web] Image load error for:', id)
              setImageError(true)
            }}
            onLoad={() => {
              console.log('[VideoCard.web] Image loaded for:', id)
            }}
          />
        ) : (
          <div style={styles.thumbnailPlaceholder}>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke={colors.primary} strokeWidth="1">
              <polygon points="5 3 19 12 5 21 5 3" fill={colors.primary} />
            </svg>
          </div>
        )}

        {/* Duration badge */}
        {duration !== undefined && (
          <span style={styles.durationBadge}>
            {formatDuration(duration)}
          </span>
        )}
      </div>

      {/* Info section */}
      <div style={styles.info}>
        {/* Channel avatar */}
        <div style={styles.avatarContainer}>
          {channelAvatarUrl ? (
            <img
              src={channelAvatarUrl}
              alt={channelName}
              style={styles.avatar}
            />
          ) : (
            <div style={styles.avatarPlaceholder}>
              {channelName.charAt(0).toUpperCase()}
            </div>
          )}
        </div>

        {/* Text content */}
        <div style={styles.textContent}>
          <h3 style={styles.title}>{title}</h3>
          <p style={styles.channelName}>{channelName}</p>
          <p style={styles.meta}>
            {views !== undefined && formatViews(views)}
            {views !== undefined && uploadedAt && ' • '}
            {uploadedAt && formatTimeAgo(uploadedAt)}
          </p>
        </div>
      </div>
    </article>
  )
}

// VideoData interface matching the native version
export interface VideoData {
  id: string
  title: string
  path?: string
  size?: number
  uploadedAt?: number
  createdAt?: number
  channelKey?: string
  driveKey?: string
  publicBeeKey?: string | null
  thumbnailUrl?: string | null
  thumbnail?: string | null
  duration?: number
  description?: string
  mimeType?: string
  category?: string
  score?: number
  channel?: {
    name: string
    avatarUrl?: string
  }
}

interface VideoCardWrapperProps {
  video: VideoData
  onPress: () => void
  showChannelInfo?: boolean
}

// Wrapper to match the native VideoCard interface
export function VideoCard({ video, onPress, showChannelInfo = true }: VideoCardWrapperProps) {
  const channelKey = video.channelKey || video.driveKey
  const channelName = video.channel?.name || `Channel ${channelKey?.slice(0, 8) || 'Unknown'}`
  const timeAgo = video.uploadedAt || video.createdAt
    ? new Date(video.uploadedAt || video.createdAt!).toISOString()
    : undefined

  return (
    <VideoCardDesktop
      id={video.id}
      title={video.title}
      thumbnailUrl={video.thumbnailUrl || video.thumbnail || undefined}
      channelName={showChannelInfo ? channelName : ''}
      channelAvatarUrl={video.channel?.avatarUrl}
      uploadedAt={timeAgo}
      duration={video.duration}
      onPress={onPress}
    />
  )
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    display: 'flex',
    flexDirection: 'column',
    cursor: 'pointer',
    transition: 'transform 0.15s ease',
    outline: 'none',
    borderRadius: 12,
    overflow: 'hidden',
  },
  thumbnailContainer: {
    position: 'relative',
    width: '100%',
    aspectRatio: '16 / 9',
    backgroundColor: colors.bgSecondary,
    borderRadius: 12,
    overflow: 'hidden',
  },
  thumbnail: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
  },
  thumbnailPlaceholder: {
    width: '100%',
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgSecondary,
  },
  durationBadge: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    padding: '2px 6px',
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    borderRadius: 4,
    fontSize: 12,
    fontWeight: 500,
    color: colors.text,
  },
  info: {
    display: 'flex',
    gap: 12,
    marginTop: 12,
  },
  avatarContainer: {
    flexShrink: 0,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    objectFit: 'cover',
  },
  avatarPlaceholder: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.primary,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 14,
    fontWeight: 600,
    color: '#ffffff',
  },
  textContent: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    margin: 0,
    fontSize: 14,
    fontWeight: 500,
    color: colors.text,
    lineHeight: 1.4,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
  channelName: {
    margin: '4px 0 0',
    fontSize: 13,
    color: colors.textSecondary,
  },
  meta: {
    margin: '2px 0 0',
    fontSize: 13,
    color: colors.textMuted,
  },
}

export default VideoCardDesktop
