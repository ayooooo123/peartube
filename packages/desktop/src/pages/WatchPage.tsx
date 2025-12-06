/**
 * Watch Page - Video Player with Details (YouTube-style layout)
 */

import React from 'react';
import { colors, spacing, radius } from '../lib/theme';
import { rpc } from '../lib/rpc';
import { useP2PVideo, type Video, type Channel, type VideoStats } from '@peartube/core';
import { useAppStore } from '../state/appStore';
import { Column, Row, Text, Button, Avatar, Card, TextArea, Divider, IconButton } from '../components/ui';
import { VideoCard } from '../components/VideoCard';

// P2P Stats Bar Component - YouTube-inspired design
const P2PStatsBar: React.FC<{ stats: VideoStats | null; videoSize: number }> = ({ stats, videoSize }) => {
  if (!stats) return null;

  const formatBytes = (bytes: number) => {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  const getStatusLabel = () => {
    if (stats.isComplete) return 'Cached';
    switch (stats.status) {
      case 'connecting': return 'Connecting...';
      case 'resolving': return 'Resolving...';
      case 'downloading': return 'Downloading';
      case 'complete': return 'Cached';
      case 'error': return 'Error';
      default: return 'Loading...';
    }
  };

  const getStatusColor = () => {
    if (stats.isComplete || stats.status === 'complete') return '#4ade80';
    if (stats.status === 'downloading') return '#3b82f6';
    if (stats.status === 'error') return '#ef4444';
    return colors.textMuted;
  };

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: spacing.md,
      padding: `${spacing.sm}px ${spacing.md}px`,
      backgroundColor: colors.bgCard,
      borderRadius: radius.md,
      marginTop: spacing.sm,
      flexWrap: 'wrap',
    }}>
      {/* Status Indicator */}
      <div style={{ display: 'flex', alignItems: 'center', gap: spacing.xs }}>
        <div style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          backgroundColor: getStatusColor(),
        }} />
        <span style={{ color: getStatusColor(), fontSize: 13, fontWeight: 500 }}>
          {getStatusLabel()}
        </span>
      </div>

      {/* Progress Bar (only show when downloading) */}
      {!stats.isComplete && stats.status === 'downloading' && (
        <div style={{
          flex: 1,
          minWidth: 100,
          maxWidth: 200,
          height: 4,
          backgroundColor: colors.border,
          borderRadius: 2,
          overflow: 'hidden',
        }}>
          <div style={{
            width: `${stats.progress}%`,
            height: '100%',
            backgroundColor: '#3b82f6',
            transition: 'width 0.3s ease',
          }} />
        </div>
      )}

      {/* Size Info */}
      <span style={{ color: colors.textSecondary, fontSize: 13 }}>
        {formatBytes(stats.downloadedBytes)} / {formatBytes(stats.totalBytes || videoSize)}
      </span>

      {/* Blocks */}
      <span style={{ color: colors.textMuted, fontSize: 12 }}>
        {stats.downloadedBlocks} / {stats.totalBlocks} blocks
      </span>

      {/* Peer Count */}
      <span style={{ color: colors.textMuted, fontSize: 12 }}>
        {stats.peerCount} {stats.peerCount === 1 ? 'peer' : 'peers'}
      </span>

      {/* Download Speed (when downloading) */}
      {!stats.isComplete && parseFloat(stats.speedMBps) > 0 && (
        <span style={{ color: '#3b82f6', fontSize: 12, fontWeight: 500 }}>
          ↓ {stats.speedMBps} MB/s
        </span>
      )}

      {/* Upload Speed */}
      {stats.uploadSpeedMBps && parseFloat(stats.uploadSpeedMBps) > 0 && (
        <span style={{ color: '#4ade80', fontSize: 12, fontWeight: 500 }}>
          ↑ {stats.uploadSpeedMBps} MB/s
        </span>
      )}

      {/* Progress Percentage */}
      {!stats.isComplete && (
        <span style={{ color: colors.textSecondary, fontSize: 13, fontWeight: 500 }}>
          {stats.progress}%
        </span>
      )}
    </div>
  );
};

interface WatchPageProps {
  video: Video;
  driveKey: string;
  relatedVideos?: Video[];
  channelNames?: Record<string, string>;
  onBack: () => void;
  onVideoClick: (video: Video) => void;
  onChannelClick: (driveKey: string) => void;
}

export const WatchPage: React.FC<WatchPageProps> = ({
  video,
  driveKey,
  relatedVideos = [],
  channelNames = {},
  onBack: _onBack,
  onVideoClick,
  onChannelClick,
}) => {
  const { state, actions } = useAppStore();
  const [videoUrl, setVideoUrl] = React.useState<string | null>(null);
  const [channel, setChannel] = React.useState<Channel | null>(null);
  const [liked, setLiked] = React.useState(false);
  const [subscribed, setSubscribed] = React.useState(false);
  const [showFullDescription, setShowFullDescription] = React.useState(false);
  const [theaterMode, setTheaterMode] = React.useState(false);

  const videoService = React.useMemo(() => ({
    getVideoUrl: (key: string, path: string) => rpc.getVideoUrl(key, path),
    prefetchVideo: (key: string, path: string) => rpc.prefetchVideo(key, path),
    getVideoStats: (key: string, path: string) => rpc.getVideoStats(key, path),
  }), []);

  const {
    url,
    status: videoStatus,
    stats: videoStats,
    error: videoError,
  } = useP2PVideo(videoService, driveKey, video.path, { pollInterval: 500 });

  const isLoading = React.useMemo(
    () => videoStatus === 'idle' || videoStatus === 'loading' || (videoStatus === 'prefetching' && !videoUrl),
    [videoStatus, videoUrl]
  );

  React.useEffect(() => {
    setVideoUrl(url);
  }, [url]);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const channelData = await rpc.getChannel(driveKey);
        if (!cancelled) setChannel(channelData);
      } catch (err) {
        console.error('Failed to load channel:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [driveKey]);

  React.useEffect(() => {
    const isSubbed = state.subscriptions.some((s) => s.driveKey === driveKey);
    setSubscribed(isSubbed);
  }, [driveKey, state.subscriptions]);

  const handleSubscribe = async () => {
    try {
      const ok = await actions.subscribe(driveKey);
      if (ok) setSubscribed(true);
    } catch (err) {
      console.error('Failed to subscribe:', err);
    }
  };

  // Video player component (reused in both modes)
  const VideoPlayer = (
    <div style={{
      width: '100%',
      aspectRatio: '16/9',
      backgroundColor: '#000',
      borderRadius: theaterMode ? 0 : radius.lg,
      overflow: 'hidden',
    }}>
      {videoError ? (
        <div style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: colors.textMuted,
          padding: spacing.lg,
          textAlign: 'center',
        }}>
          <Text color="secondary">Unable to load video. {videoError.message || 'Please try again.'}</Text>
        </div>
      ) : isLoading ? (
        <div style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
          <div style={{
            width: 48,
            height: 48,
            border: `3px solid ${colors.border}`,
            borderTopColor: colors.primary,
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
          }} />
        </div>
      ) : (
        <video
          src={videoUrl || undefined}
          controls
          autoPlay
          playsInline
          style={{
            width: '100%',
            height: '100%',
            outline: 'none',
          }}
          onMouseDown={(e) => e.stopPropagation()}
        />
      )}
    </div>
  );

  // Video info section (reused in both modes)
  const VideoInfo = (
    <>
      {/* Video Title */}
      <Text size="xl" weight="bold" style={{ marginBottom: spacing.sm }}>
        {video.title}
      </Text>

      {/* P2P Stats Bar */}
      <P2PStatsBar stats={videoStats} videoSize={video.size} />

      {/* Video Actions */}
      <Row justify="space-between" align="center" style={{ marginBottom: spacing.lg, flexWrap: 'wrap', gap: spacing.sm }}>
        <Row gap={spacing.sm}>
          <Text color="secondary">{formatFileSize(video.size)}</Text>
          <Text color="muted">•</Text>
          <Text color="secondary">{formatDate(video.uploadedAt)}</Text>
        </Row>
        <Row gap={spacing.xs}>
          <Button
            variant={liked ? 'primary' : 'secondary'}
            icon={liked ? '👍' : '👍'}
            onClick={() => setLiked(!liked)}
          >
            Like
          </Button>
          <Button variant="secondary" icon="↗️">
            Share
          </Button>
          <Button variant="secondary" icon="📥">
            Save
          </Button>
          <Button
            variant={theaterMode ? 'primary' : 'secondary'}
            onClick={() => setTheaterMode(!theaterMode)}
            title={theaterMode ? 'Exit theater mode' : 'Theater mode'}
          >
            {theaterMode ? '⊡' : '⊟'}
          </Button>
          <IconButton icon="⋮" />
        </Row>
      </Row>

      <Divider />

      {/* Channel Info */}
      <Row gap={spacing.md} align="center" style={{ padding: `${spacing.lg}px 0` }}>
        <div
          onClick={() => onChannelClick(driveKey)}
          style={{ cursor: 'pointer' }}
        >
          <Avatar name={channel?.name} size="lg" />
        </div>
        <Column gap={spacing.xs} style={{ flex: 1 }}>
          <Text
            weight="semibold"
            style={{ cursor: 'pointer' }}
            onClick={() => onChannelClick(driveKey)}
          >
            {channel?.name || 'Channel'}
          </Text>
          <Text size="sm" color="muted">P2P Channel</Text>
        </Column>
        <Button
          variant={subscribed ? 'secondary' : 'primary'}
          onClick={handleSubscribe}
          disabled={subscribed}
        >
          {subscribed ? 'Subscribed' : 'Subscribe'}
        </Button>
      </Row>

      {/* Description */}
      <Card style={{ marginBottom: spacing.xl }}>
        <div style={{
          maxHeight: showFullDescription ? undefined : 100,
          overflow: 'hidden',
        }}>
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
            {video.description || 'No description'}
          </Text>
        </div>
        {video.description && video.description.length > 200 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowFullDescription(!showFullDescription)}
            style={{ marginTop: spacing.sm }}
          >
            {showFullDescription ? 'Show less' : 'Show more'}
          </Button>
        )}
      </Card>

      {/* Comments Section */}
      <Column gap={spacing.md}>
        <Text size="lg" weight="semibold">Comments</Text>
        <Card>
          <Row gap={spacing.md}>
            <Avatar size="sm" />
            <TextArea
              placeholder="Add a comment..."
              style={{ minHeight: 60 }}
            />
          </Row>
          <Row justify="flex-end" gap={spacing.sm} style={{ marginTop: spacing.md }}>
            <Button variant="ghost">Cancel</Button>
            <Button variant="primary">Comment</Button>
          </Row>
        </Card>

        <div style={{
          padding: spacing.xl,
          textAlign: 'center',
          color: colors.textMuted,
        }}>
          <Text color="muted">No comments yet. Be the first!</Text>
        </div>
      </Column>
    </>
  );

  // Related videos section
  const RelatedVideos = (
    <Column gap={spacing.sm}>
      <Text weight="semibold" style={{ marginBottom: spacing.sm }}>
        Related Videos
      </Text>
      {relatedVideos.length > 0 ? (
        relatedVideos.map((v) => (
          <VideoCard
            key={v.id}
            video={v}
            channelName={channelNames[v.channelKey]}
            onClick={() => onVideoClick(v)}
            variant="compact"
          />
        ))
      ) : (
        <Text color="muted" size="sm">No related videos</Text>
      )}
    </Column>
  );

  const content = (
    <>
      {/* Main Content Area */}
      <div style={{
        flex: '1 1 0%',
        minWidth: 0,
        overflow: 'auto',
        padding: spacing.lg,
      }}>
        {/* Video Player */}
        {VideoPlayer}

        {/* Spacer */}
        <div style={{ height: spacing.lg }} />

        {/* Video Info */}
        {VideoInfo}
      </div>

      {/* Sidebar - Related Videos */}
      <Column style={{
        flex: '0 0 360px',
        borderLeft: `1px solid ${colors.border}`,
        overflow: 'auto',
        padding: spacing.md,
      }}>
        {RelatedVideos}
      </Column>
    </>
  );

  // Theater mode: full width video, content below
  if (theaterMode) {
    return (
      <div style={{
        height: '100%',
        overflow: 'auto',
        padding: spacing.lg,
        backgroundColor: colors.bg,
      }}>
        <Column style={{ maxWidth: 1440, margin: '0 auto', gap: spacing.lg }}>
          <div style={{ width: '100%', backgroundColor: '#000' }}>
            {VideoPlayer}
          </div>
          <Column style={{ gap: spacing.lg }}>
            {VideoInfo}
            <Column style={{ borderTop: `1px solid ${colors.border}`, paddingTop: spacing.md }}>
              {RelatedVideos}
            </Column>
          </Column>
        </Column>
      </div>
    );
  }

  // Default mode: side-by-side layout like YouTube
  return (
    <div style={{
      height: '100%',
      overflow: 'auto',
      padding: spacing.lg,
      backgroundColor: colors.bg,
    }}>
      <Row style={{ height: '100%', maxWidth: 1440, margin: '0 auto', gap: spacing.lg }}>
        {content}
      </Row>
    </div>
  );
};

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export default WatchPage;
