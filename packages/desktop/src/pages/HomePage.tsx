/**
 * Home Page - Video Feed with Discover Section
 */

import React from 'react';
import { colors, spacing } from '../lib/theme';
import type { Video, ChannelMetadata } from '@peartube/core';
import { Column, Row, Text, Button } from '../components/ui';
import { VideoGrid, VideoCard } from '../components/VideoCard';

interface HomePageProps {
  videos: Video[];
  channelNames: Record<string, string>;
  onVideoClick: (video: Video) => void;
  loading?: boolean;
  // Public feed props
  feedVideos?: Video[];
  feedVideosLoading?: boolean;
  onChannelClick?: (driveKey: string) => void;
  onRefreshFeed?: () => void;
  feedLoading?: boolean;
  peerCount?: number;
}


export const HomePage: React.FC<HomePageProps> = ({
  videos,
  channelNames,
  onVideoClick,
  loading,
  feedVideos = [],
  feedVideosLoading,
  onChannelClick,
  onRefreshFeed,
  feedLoading,
  peerCount = 0,
}) => {
  const [activeFilter, setActiveFilter] = React.useState('all');

  const filters = [
    { id: 'all', label: 'All' },
    { id: 'subscriptions', label: 'From Subscriptions' },
    { id: 'recent', label: 'Recently Uploaded' },
  ];

  // Combine channel names with video's channelName
  const getChannelName = (video: Video) => {
    return (video as any).channelName || channelNames[video.channelKey || ''] || 'Unknown';
  };

  return (
    <Column style={{ padding: spacing.xl }}>
      {/* Discover Section - Videos from discovered channels */}
      <Column style={{ marginBottom: spacing.xl }}>
        <Row justify="space-between" align="center" style={{ marginBottom: spacing.md }}>
          <Row align="center" gap={spacing.sm}>
            <Text style={{ fontSize: 18, fontWeight: 600 }}>Discover</Text>
            <Text color="secondary" style={{ fontSize: 12 }}>
              ({peerCount} peer{peerCount !== 1 ? 's' : ''} connected)
            </Text>
          </Row>
          <Button
            variant="ghost"
            size="sm"
            onClick={onRefreshFeed}
            disabled={feedLoading || feedVideosLoading}
          >
            {feedLoading || feedVideosLoading ? 'Refreshing...' : '↻ Refresh'}
          </Button>
        </Row>

        {(feedLoading || feedVideosLoading) && feedVideos.length === 0 ? (
          <div style={{
            padding: spacing.xl,
            backgroundColor: colors.surface,
            borderRadius: 12,
            textAlign: 'center',
          }}>
            <Text color="secondary">Discovering videos...</Text>
          </div>
        ) : feedVideos.length > 0 ? (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: spacing.lg,
          }}>
            {feedVideos.map((video) => (
              <VideoCard
                key={`${video.channelKey}-${video.id}`}
                video={video}
                channelName={getChannelName(video)}
                onClick={() => onVideoClick(video)}
                variant="grid"
              />
            ))}
          </div>
        ) : (
          <div style={{
            padding: spacing.xl,
            backgroundColor: colors.surface,
            borderRadius: 12,
            textAlign: 'center',
          }}>
            <Text color="secondary">
              {peerCount === 0
                ? 'No peers connected. Waiting for network...'
                : 'No videos discovered yet. Create one in Studio!'}
            </Text>
          </div>
        )}
      </Column>

      {/* Filter Chips */}
      <Row gap={spacing.sm} style={{ marginBottom: spacing.xl, flexWrap: 'wrap' }}>
        {filters.map((filter) => (
          <Button
            key={filter.id}
            variant={activeFilter === filter.id ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setActiveFilter(filter.id)}
          >
            {filter.label}
          </Button>
        ))}
      </Row>

      {/* Your Videos */}
      <Text style={{ fontSize: 18, fontWeight: 600, marginBottom: spacing.md }}>Your Videos</Text>
      {loading ? (
        <Column align="center" justify="center" style={{ padding: spacing.xxxl }}>
          <div style={{
            width: 40,
            height: 40,
            border: `3px solid ${colors.border}`,
            borderTopColor: colors.primary,
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
          }} />
          <Text color="secondary" style={{ marginTop: spacing.lg }}>Loading videos...</Text>
        </Column>
      ) : videos.length === 0 ? (
        <div style={{
          padding: spacing.xxxl,
          backgroundColor: colors.surface,
          borderRadius: 12,
          textAlign: 'center',
        }}>
          <Text style={{ fontSize: 32, marginBottom: spacing.md }}>📺</Text>
          <Text weight="semibold" style={{ marginBottom: spacing.sm }}>No videos yet</Text>
          <Text color="secondary">Upload your first video from the Studio tab</Text>
        </div>
      ) : (
        <VideoGrid
          videos={videos}
          channelNames={channelNames}
          onVideoClick={onVideoClick}
          columns={4}
        />
      )}
    </Column>
  );
};

export default HomePage;
