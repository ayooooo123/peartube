/**
 * Video Card Component - Used in grids and lists
 */

import React from 'react';
import { colors, spacing, radius, fontSize, fontWeight } from '../lib/theme';
import { type Video } from '../lib/rpc';
import { Column, Row, Text, Avatar } from './ui';

interface VideoCardProps {
  video: Video;
  channelName?: string;
  onClick: () => void;
  variant?: 'grid' | 'list' | 'compact';
  thumbnailUrl?: string;
}

export const VideoCard: React.FC<VideoCardProps> = ({
  video,
  channelName,
  onClick,
  variant = 'grid',
  thumbnailUrl,
}) => {
  const [hovered, setHovered] = React.useState(false);
  // Use thumbnailUrl prop or fall back to video.thumbnail
  const thumbUrl = thumbnailUrl || video.thumbnail;

  if (variant === 'list') {
    return (
      <Row
        gap={spacing.md}
        onClick={onClick}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          cursor: 'pointer',
          padding: spacing.sm,
          borderRadius: radius.md,
          backgroundColor: hovered ? colors.bgHover : 'transparent',
          transition: 'background-color 0.1s ease',
        }}
      >
        <Thumbnail
          size="small"
          hovered={hovered}
          thumbnailUrl={thumbUrl}
          duration={video.duration}
        />
        <Column gap={spacing.xs} style={{ flex: 1, minWidth: 0 }}>
          <Text weight="medium" truncate>{video.title}</Text>
          <Text size="sm" color="secondary">{channelName || 'Channel'}</Text>
          <Row gap={spacing.sm}>
            <Text size="xs" color="muted">{formatFileSize(video.size)}</Text>
            <Text size="xs" color="muted">•</Text>
            <Text size="xs" color="muted">{formatTimeAgo(video.uploadedAt)}</Text>
          </Row>
        </Column>
      </Row>
    );
  }

  if (variant === 'compact') {
    return (
      <Row
        gap={spacing.sm}
        onClick={onClick}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          cursor: 'pointer',
          padding: spacing.xs,
          borderRadius: radius.sm,
          backgroundColor: hovered ? colors.bgHover : 'transparent',
        }}
      >
        <Thumbnail size="tiny" hovered={hovered} thumbnailUrl={thumbUrl} duration={video.duration} />
        <Column gap={2} style={{ flex: 1, minWidth: 0 }}>
          <Text size="sm" weight="medium" truncate>{video.title}</Text>
          <Text size="xs" color="muted">{channelName}</Text>
        </Column>
      </Row>
    );
  }

  // Grid variant (default)
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        cursor: 'pointer',
        borderRadius: radius.lg,
        transition: 'transform 0.1s ease',
        transform: hovered ? 'scale(1.02)' : 'scale(1)',
      }}
    >
      <Thumbnail size="large" hovered={hovered} thumbnailUrl={thumbUrl} duration={video.duration} />
      <Row gap={spacing.md} style={{ marginTop: spacing.md }}>
        <Avatar name={channelName} size="sm" />
        <Column gap={spacing.xs} style={{ flex: 1, minWidth: 0 }}>
          <Text weight="medium" style={{
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            lineHeight: 1.3,
          }}>
            {video.title}
          </Text>
          <Text size="sm" color="secondary">{channelName || 'Unknown Channel'}</Text>
          <Row gap={spacing.sm}>
            <Text size="sm" color="muted">{formatFileSize(video.size)}</Text>
            <Text size="sm" color="muted">•</Text>
            <Text size="sm" color="muted">{formatTimeAgo(video.uploadedAt)}</Text>
          </Row>
        </Column>
      </Row>
    </div>
  );
};

// Thumbnail Component
interface ThumbnailProps {
  size: 'tiny' | 'small' | 'large';
  hovered: boolean;
  thumbnailUrl?: string;
  duration?: number;
}

const Thumbnail: React.FC<ThumbnailProps> = ({ size, hovered, thumbnailUrl, duration }) => {
  const [imageError, setImageError] = React.useState(false);
  const [imageLoaded, setImageLoaded] = React.useState(false);

  const dimensions = {
    tiny: { width: 120, aspectRatio: '16/9' },
    small: { width: 168, aspectRatio: '16/9' },
    large: { width: '100%', aspectRatio: '16/9' },
  };

  const showImage = thumbnailUrl && !imageError;
  const showPlaceholder = !thumbnailUrl || imageError || !imageLoaded;

  // Format duration from seconds to MM:SS or HH:MM:SS
  const formatDuration = (seconds?: number) => {
    if (!seconds) return '';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (hrs > 0) {
      return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div style={{
      width: dimensions[size].width,
      aspectRatio: dimensions[size].aspectRatio,
      backgroundColor: colors.surface,
      borderRadius: radius.md,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      position: 'relative',
      overflow: 'hidden',
      flexShrink: 0,
    }}>
      {/* Actual thumbnail image */}
      {showImage && (
        <img
          src={thumbnailUrl}
          alt=""
          style={{
            position: 'absolute',
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            opacity: imageLoaded ? 1 : 0,
            transition: 'opacity 0.2s ease',
          }}
          onLoad={() => setImageLoaded(true)}
          onError={() => setImageError(true)}
        />
      )}
      {/* Placeholder when no thumbnail or loading */}
      {showPlaceholder && (
        <span style={{
          fontSize: size === 'large' ? 48 : size === 'small' ? 32 : 24,
          opacity: 0.3,
        }}>
          ▶
        </span>
      )}
      {/* Duration badge */}
      {duration && duration > 0 && (
        <span style={{
          position: 'absolute',
          bottom: spacing.xs,
          right: spacing.xs,
          backgroundColor: 'rgba(0, 0, 0, 0.85)',
          color: colors.textPrimary,
          fontSize: fontSize.xs,
          fontWeight: fontWeight.medium,
          padding: `2px ${spacing.xs}px`,
          borderRadius: radius.sm,
        }}>
          {formatDuration(duration)}
        </span>
      )}
      {/* Hover overlay */}
      {hovered && (
        <div style={{
          position: 'absolute',
          inset: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.2)',
        }} />
      )}
    </div>
  );
};

// Video Grid Component
interface VideoGridProps {
  videos: Video[];
  channelNames?: Record<string, string>;
  onVideoClick: (video: Video) => void;
  columns?: number;
}

export const VideoGrid: React.FC<VideoGridProps> = ({
  videos,
  channelNames = {},
  onVideoClick,
  columns = 4,
}) => {
  if (videos.length === 0) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: spacing.xxxl,
        color: colors.textMuted,
      }}>
        <span style={{ fontSize: 64, marginBottom: spacing.lg }}>📺</span>
        <Text size="lg" weight="semibold" color="secondary">No videos yet</Text>
        <Text color="muted" style={{ marginTop: spacing.sm }}>
          Videos you upload or subscribe to will appear here
        </Text>
      </div>
    );
  }

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: `repeat(${columns}, 1fr)`,
      gap: spacing.xl,
    }}>
      {videos.map((video) => (
        <VideoCard
          key={video.id}
          video={video}
          channelName={channelNames[video.channelKey]}
          onClick={() => onVideoClick(video)}
          variant="grid"
        />
      ))}
    </div>
  );
};

// Utilities
function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export default VideoCard;
