/**
 * Channel Page - View any channel's profile and videos
 */

import React from 'react';
import { colors, spacing } from '../lib/theme';
import { rpc, type Channel, type Video, type Identity } from '../lib/rpc';
import { Column, Row, Text, Button, Card, Avatar, Spinner, Alert } from '../components/ui';
import { VideoCard } from '../components/VideoCard';

interface ChannelPageProps {
  driveKey: string;
  identity?: Identity | null;
  onBack: () => void;
  onVideoClick: (video: Video) => void;
}

export const ChannelPage: React.FC<ChannelPageProps> = ({
  driveKey,
  identity,
  onBack,
  onVideoClick,
}) => {
  const [channel, setChannel] = React.useState<Channel | null>(null);
  const [videos, setVideos] = React.useState<Video[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [subscribed, setSubscribed] = React.useState(false);

  const isOwnChannel = identity?.driveKey === driveKey;

  React.useEffect(() => {
    loadChannel();
  }, [driveKey]);

  async function loadChannel() {
    try {
      setLoading(true);
      setError(null);

      const [channelData, videosData] = await Promise.all([
        rpc.getChannel(driveKey),
        rpc.listVideos(driveKey),
      ]);

      setChannel(channelData);
      setVideos(videosData.map(v => ({ ...v, channelKey: driveKey })));
    } catch (err: any) {
      console.error('Failed to load channel:', err);
      setError(err.message || 'Failed to load channel');
    } finally {
      setLoading(false);
    }
  }

  async function handleSubscribe() {
    try {
      await rpc.subscribeChannel(driveKey);
      setSubscribed(true);
    } catch (err: any) {
      console.error('Failed to subscribe:', err);
    }
  }

  if (loading) {
    return (
      <Column
        align="center"
        justify="center"
        style={{ height: '100%', padding: spacing.xxxl }}
      >
        <Spinner size="lg" />
        <Text style={{ marginTop: spacing.lg }}>Loading channel...</Text>
      </Column>
    );
  }

  if (error) {
    return (
      <Column
        align="center"
        justify="center"
        style={{ height: '100%', padding: spacing.xxxl }}
      >
        <Alert variant="error" style={{ marginBottom: spacing.lg }}>
          {error}
        </Alert>
        <Button variant="secondary" onClick={onBack}>
          Go Back
        </Button>
      </Column>
    );
  }

  return (
    <Column style={{ height: '100%' }}>
      {/* Channel Banner */}
      <div style={{
        height: 200,
        backgroundColor: colors.surface,
        backgroundImage: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        position: 'relative',
      }}>
        <Button
          variant="ghost"
          onClick={onBack}
          style={{
            position: 'absolute',
            top: spacing.md,
            left: spacing.md,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
          }}
        >
          ← Back
        </Button>
      </div>

      {/* Channel Info */}
      <div style={{
        padding: `0 ${spacing.xl}px`,
        marginTop: -60,
        position: 'relative',
        zIndex: 1,
      }}>
        <Row gap={spacing.xl} align="flex-end" style={{ marginBottom: spacing.xl }}>
          <div style={{
            border: `4px solid ${colors.bg}`,
            borderRadius: '50%',
          }}>
            <Avatar name={channel?.name} size="xl" />
          </div>
          <Column gap={spacing.sm} style={{ flex: 1, paddingBottom: spacing.sm }}>
            <Text size="xxl" weight="bold">
              {channel?.name || 'Unknown Channel'}
            </Text>
            <Text color="secondary" style={{ fontFamily: 'monospace' }}>
              {driveKey.slice(0, 16)}...{driveKey.slice(-8)}
            </Text>
          </Column>
          {!isOwnChannel && (
            <Button
              variant={subscribed ? 'secondary' : 'primary'}
              onClick={handleSubscribe}
              disabled={subscribed}
              style={{ marginBottom: spacing.sm }}
            >
              {subscribed ? 'Subscribed' : 'Subscribe'}
            </Button>
          )}
        </Row>

        {channel?.description && (
          <Card style={{ marginBottom: spacing.xl }}>
            <Text size="sm" color="secondary" style={{ whiteSpace: 'pre-wrap' }}>
              {channel.description}
            </Text>
          </Card>
        )}

        {/* Videos Section */}
        <Row justify="space-between" align="center" style={{ marginBottom: spacing.lg }}>
          <Text size="lg" weight="semibold">
            Videos ({videos.length})
          </Text>
        </Row>

        {videos.length === 0 ? (
          <Card style={{ textAlign: 'center', padding: spacing.xxxl }}>
            <Text size="xxl">📺</Text>
            <Text size="lg" weight="semibold" style={{ marginTop: spacing.md }}>
              No videos yet
            </Text>
            <Text color="muted" style={{ marginTop: spacing.sm }}>
              {isOwnChannel
                ? 'Upload your first video to get started'
                : 'This channel hasn\'t uploaded any videos yet'}
            </Text>
          </Card>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: spacing.lg,
            paddingBottom: spacing.xl,
          }}>
            {videos.map((video) => (
              <VideoCard
                key={video.id}
                video={video}
                channelName={channel?.name}
                onClick={() => onVideoClick(video)}
                variant="grid"
              />
            ))}
          </div>
        )}
      </div>
    </Column>
  );
};

export default ChannelPage;
