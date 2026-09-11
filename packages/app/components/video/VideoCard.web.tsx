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
import { colors, spacing, radius } from '@/lib/colors'
import { formatDuration, formatViews, formatTimeAgo, formatContentBadge } from '@/lib/formatters'
import type { ContentCoordinates } from '@/lib/formatters'

export interface VideoCardProps {
  id: string
  title: string
  thumbnailUrl?: string
  channelName: string
  channelAvatarUrl?: string
  views?: number
  uploadedAt?: string
  duration?: number
  contentBadge?: string | null
  onPress?: () => void
  onChannelPress?: () => void
}
function VideoCardThumbnail({
  id,
  title,
  thumbnailUrl,
  duration,
}: {
  id?: string
  title: string
  thumbnailUrl?: string
  duration?: number
}) {
  const [imageError, setImageError] = useState(false)
  return (
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

      {duration !== undefined && (
        <span style={styles.durationBadge}>
          {formatDuration(duration)}
        </span>
      )}
    </div>
  )
}

function VideoCardAvatar({
  channelName,
  channelAvatarUrl,
  channelHovered,
  isInteractive,
  interactiveProps,
}: {
  channelName: string
  channelAvatarUrl?: string
  channelHovered: boolean
  isInteractive: boolean
  interactiveProps?: React.HTMLAttributes<HTMLDivElement> | null
}) {
  const hovered = channelHovered && isInteractive
  return (
    <div
      style={{
        ...styles.avatarContainer,
        cursor: isInteractive ? 'pointer' : undefined,
        opacity: hovered ? 0.8 : 1,
        transform: hovered ? 'scale(0.92)' : 'scale(1)',
        transition: 'opacity 0.15s ease, transform 0.15s ease',
      }}
      {...(interactiveProps ?? {})}
    >
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
  )
}

function VideoCardMeta({
  views,
  uploadedAt,
  contentBadge,
}: {
  views?: number
  uploadedAt?: string
  contentBadge?: string | null
}) {
  const hasViews = views !== undefined
  const hasUploadedAt = Boolean(uploadedAt)
  const hasPrimaryMeta = hasViews || hasUploadedAt

  return (
    <p style={styles.meta}>
      {hasViews && formatViews(views!)}
      {hasViews && hasUploadedAt && ' • '}
      {hasUploadedAt && formatTimeAgo(uploadedAt!)}
      {contentBadge && hasPrimaryMeta && ' • '}
      {contentBadge && <span style={styles.contentBadge}>{contentBadge}</span>}
    </p>
  )
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
  contentBadge,
  onPress,
  onChannelPress,
}: VideoCardProps) {
  const [isHovered, setIsHovered] = useState(false)
  const [channelHovered, setChannelHovered] = useState(false)

  const channelInteractiveProps = onChannelPress
    ? {
        onClick: (e: React.MouseEvent) => {
          e.stopPropagation()
          onChannelPress()
        },
        onMouseEnter: () => setChannelHovered(true),
        onMouseLeave: () => setChannelHovered(false),
      }
    : null

  return (
    <div
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
      <VideoCardThumbnail
        id={id}
        title={title}
        thumbnailUrl={thumbnailUrl}
        duration={duration}
      />

      <div style={styles.info}>
        <VideoCardAvatar
          channelName={channelName}
          channelAvatarUrl={channelAvatarUrl}
          channelHovered={channelHovered}
          isInteractive={Boolean(onChannelPress)}
          interactiveProps={channelInteractiveProps}
        />

        <div style={styles.textContent}>
          <h3 style={styles.title}>{title}</h3>
          <p
            style={{
              ...styles.channelName,
              cursor: onChannelPress ? 'pointer' : undefined,
              textDecoration: channelHovered && onChannelPress ? 'underline' : 'none',
            }}
            {...(channelInteractiveProps ?? {})}
          >
            {channelName}
          </p>
          <VideoCardMeta
            views={views}
            uploadedAt={uploadedAt}
            contentBadge={contentBadge}
          />
        </div>
      </div>
    </div>
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
  creatorName?: string | null
  score?: number
  contentKind?: string | null
  seasonNumber?: number | null
  episodeNumber?: number | null
  mediaProvider?: string | null
  mediaId?: string | null
  classification?: ContentCoordinates['classification']
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

interface VideoCardWrapperPropsExtended extends VideoCardWrapperProps {
  onChannelPress?: () => void
}

// Wrapper to match the native VideoCard interface
export function VideoCard({ video, onPress, showChannelInfo = true, onChannelPress }: VideoCardWrapperPropsExtended) {
  const channelKey = video.channelKey || video.driveKey
  const channelName = video.creatorName || video.channel?.name || `Channel ${channelKey?.slice(0, 8) || 'Unknown'}`
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
      contentBadge={formatContentBadge(video)}
      onPress={onPress}
      onChannelPress={onChannelPress}
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
    borderRadius: 4,
    overflow: 'hidden',
  },
  thumbnailContainer: {
    position: 'relative',
    width: '100%',
    aspectRatio: '16 / 9',
    backgroundColor: colors.surface,
    borderRadius: 4,
    overflow: 'hidden',
  },
  thumbnail: {
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    backgroundColor: colors.surface,
  },
  thumbnailPlaceholder: {
    width: '100%',
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  durationBadge: {
    position: 'absolute',
    bottom: spacing.sm,
    right: spacing.sm,
    padding: `${spacing.xs}px ${spacing.sm}px`,
    backgroundColor: colors.overlayButton,
    borderRadius: 4,
    fontSize: 12,
    fontWeight: 500,
    color: colors.text,
  },
  info: {
    display: 'flex',
    gap: spacing.md,
    marginTop: spacing.md,
  },
  avatarContainer: {
    flexShrink: 0,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 4,
    objectFit: 'cover',
  },
  avatarPlaceholder: {
    width: 36,
    height: 36,
    borderRadius: 4,
    backgroundColor: colors.primary,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 14,
    fontWeight: 600,
    color: colors.onPrimary,
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
    margin: `${spacing.xs}px 0 0`,
    fontSize: 13,
    color: colors.textSecondary,
  },
  meta: {
    margin: `${spacing.xs * 0.5}px 0 0`,
    fontSize: 13,
    color: colors.textMuted,
  },
  contentBadge: {
    color: colors.textSecondary,
    fontWeight: 600,
  },
}

export default VideoCardDesktop
