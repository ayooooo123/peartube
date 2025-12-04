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
}

export const VideoCard: React.FC<VideoCardProps> = ({
  video,
  channelName,
  onClick,
  variant = 'grid',
}) => {
  const [hovered, setHovered] = React.useState(false);

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
        <Thumbnail size="tiny" hovered={hovered} />
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
      <Thumbnail size="large" hovered={hovered} />
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
}

const Thumbnail: React.FC<ThumbnailProps> = ({ size, hovered }) => {
  const dimensions = {
    tiny: { width: 120, aspectRatio: '16/9' },
    small: { width: 168, aspectRatio: '16/9' },
    large: { width: '100%', aspectRatio: '16/9' },
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
      <span style={{
        fontSize: size === 'large' ? 48 : size === 'small' ? 32 : 24,
        opacity: 0.3,
      }}>
        ▶
      </span>
      {/* Duration badge */}
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
        0:00
      </span>
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
