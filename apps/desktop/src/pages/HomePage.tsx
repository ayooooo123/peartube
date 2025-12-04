/**
 * Home Page - Video Feed with Discover Section
 */

import React from 'react';
import { colors, spacing } from '../lib/theme';
import { type Video, type ChannelMetadata } from '../lib/rpc';
import { Column, Row, Text, Button } from '../components/ui';
import { VideoGrid } from '../components/VideoCard';

interface DiscoveredChannel {
  driveKey: string;
  name?: string;
  videoCount?: number;
}

interface HomePageProps {
  videos: Video[];
  channelNames: Record<string, string>;
  onVideoClick: (video: Video) => void;
  loading?: boolean;
  // Public feed props
  discoveredChannels?: DiscoveredChannel[];
  onChannelClick?: (driveKey: string) => void;
  onRefreshFeed?: () => void;
  feedLoading?: boolean;
  peerCount?: number;
}

// Channel card component for discover section
const ChannelCard: React.FC<{
  channel: DiscoveredChannel;
  onClick: () => void;
}> = ({ channel, onClick }) => {
  const initial = channel.name ? channel.name[0].toUpperCase() : '?';
  const displayName = channel.name || channel.driveKey.slice(0, 8) + '...';

  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: spacing.md,
        backgroundColor: colors.surface,
        borderRadius: 12,
        cursor: 'pointer',
        minWidth: 120,
        transition: 'transform 0.2s, background-color 0.2s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = colors.surfaceHover;
        e.currentTarget.style.transform = 'scale(1.02)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = colors.surface;
        e.currentTarget.style.transform = 'scale(1)';
      }}
    >
      {/* Avatar */}
      <div style={{
        width: 56,
        height: 56,
        borderRadius: '50%',
        backgroundColor: colors.primary,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: spacing.sm,
      }}>
        <Text style={{ fontSize: 24, fontWeight: 'bold', color: '#fff' }}>{initial}</Text>
      </div>
      {/* Name */}
      <Text style={{
        fontSize: 13,
        fontWeight: 500,
        textAlign: 'center',
        maxWidth: 100,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>
        {displayName}
      </Text>
      {/* Video count */}
      {channel.videoCount !== undefined && (
        <Text color="secondary" style={{ fontSize: 11, marginTop: 2 }}>
          {channel.videoCount} video{channel.videoCount !== 1 ? 's' : ''}
        </Text>
      )}
    </div>
  );
};

export const HomePage: React.FC<HomePageProps> = ({
  videos,
  channelNames,
  onVideoClick,
  loading,
  discoveredChannels = [],
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

  return (
    <Column style={{ padding: spacing.xl }}>
      {/* Discover Section */}
      <Column style={{ marginBottom: spacing.xl }}>
        <Row justify="space-between" align="center" style={{ marginBottom: spacing.md }}>
          <Row align="center" gap={spacing.sm}>
            <Text style={{ fontSize: 18, fontWeight: 600 }}>Discover Channels</Text>
            <Text color="secondary" style={{ fontSize: 12 }}>
              ({peerCount} peer{peerCount !== 1 ? 's' : ''} connected)
            </Text>
          </Row>
          <Button
            variant="ghost"
            size="sm"
            onClick={onRefreshFeed}
            disabled={feedLoading}
          >
            {feedLoading ? 'Refreshing...' : '↻ Refresh'}
          </Button>
        </Row>

        {discoveredChannels.length > 0 ? (
          <Row
            gap={spacing.md}
            style={{
              overflowX: 'auto',
              paddingBottom: spacing.sm,
            }}
          >
            {discoveredChannels.map((channel) => (
              <ChannelCard
                key={channel.driveKey}
                channel={channel}
                onClick={() => onChannelClick?.(channel.driveKey)}
              />
            ))}
          </Row>
        ) : (
          <div style={{
            padding: spacing.xl,
            backgroundColor: colors.surface,
            borderRadius: 12,
            textAlign: 'center',
          }}>
            <Text color="secondary">
              {feedLoading
                ? 'Looking for channels...'
                : peerCount === 0
                  ? 'No peers connected. Waiting for network...'
                  : 'No channels discovered yet. Create one in Studio!'}
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

      {/* Video Grid */}
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
