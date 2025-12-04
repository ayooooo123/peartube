/**
 * Subscriptions Page - Manage channel subscriptions
 */

import React from 'react';
import { colors, spacing, radius } from '../lib/theme';
import { rpc } from '../lib/rpc';
import { Column, Row, Text, Button, Input, Card, Avatar, Alert, EmptyState } from '../components/ui';

interface SubscriptionsPageProps {
  subscriptions: { driveKey: string; name: string }[];
  onChannelClick: (driveKey: string) => void;
}

export const SubscriptionsPage: React.FC<SubscriptionsPageProps> = ({
  subscriptions,
  onChannelClick,
}) => {
  const [showSubscribe, setShowSubscribe] = React.useState(false);
  const [newDriveKey, setNewDriveKey] = React.useState('');
  const [subscribing, setSubscribing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [localSubs, setLocalSubs] = React.useState(subscriptions);

  React.useEffect(() => {
    setLocalSubs(subscriptions);
  }, [subscriptions]);

  async function handleSubscribe(e?: React.FormEvent) {
    e?.preventDefault();
    if (!newDriveKey.trim()) return;

    try {
      setSubscribing(true);
      setError(null);

      await rpc.subscribeChannel(newDriveKey.trim());

      // Add to local list temporarily
      setLocalSubs(prev => [...prev, { driveKey: newDriveKey.trim(), name: 'Loading...' }]);

      setNewDriveKey('');
      setShowSubscribe(false);
    } catch (err: any) {
      setError(err.message || 'Failed to subscribe');
    } finally {
      setSubscribing(false);
    }
  }

  return (
    <Column style={{ padding: spacing.xl }}>
      {/* Header */}
      <Row justify="space-between" align="center" style={{ marginBottom: spacing.xl }}>
        <Column gap={spacing.xs}>
          <Text size="xxl" weight="bold">Subscriptions</Text>
          <Text color="secondary">{localSubs.length} channels</Text>
        </Column>
        <Button
          variant={showSubscribe ? 'secondary' : 'primary'}
          onClick={() => setShowSubscribe(!showSubscribe)}
        >
          {showSubscribe ? 'Cancel' : '+ Subscribe'}
        </Button>
      </Row>

      {error && (
        <Alert
          variant="error"
          onClose={() => setError(null)}
          style={{ marginBottom: spacing.lg }}
        >
          {error}
        </Alert>
      )}

      {/* Subscribe Form */}
      {showSubscribe && (
        <Card style={{ marginBottom: spacing.xl }}>
          <Text weight="semibold" style={{ marginBottom: spacing.md }}>
            Subscribe to Channel
          </Text>
          <Text size="sm" color="muted" style={{ marginBottom: spacing.md }}>
            Enter the channel's drive key to subscribe
          </Text>
          <Input
            value={newDriveKey}
            onChange={(e) => setNewDriveKey(e.target.value)}
            placeholder="Enter 64-character hex drive key..."
            style={{ fontFamily: 'monospace', marginBottom: spacing.md }}
          />
          <Row justify="flex-end" gap={spacing.sm}>
            <Button
              variant="ghost"
              onClick={() => {
                setShowSubscribe(false);
                setNewDriveKey('');
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => handleSubscribe()}
              disabled={!newDriveKey.trim() || subscribing}
              loading={subscribing}
            >
              Subscribe
            </Button>
          </Row>
        </Card>
      )}

      {/* Subscriptions List */}
      {localSubs.length === 0 ? (
        <EmptyState
          icon="📺"
          title="No subscriptions yet"
          description="Subscribe to channels to see their videos in your feed"
          action={
            <Button
              variant="primary"
              onClick={() => setShowSubscribe(true)}
              style={{ marginTop: spacing.lg }}
            >
              Subscribe to a Channel
            </Button>
          }
        />
      ) : (
        <Column gap={spacing.sm}>
          {localSubs.map((channel) => (
            <ChannelRow
              key={channel.driveKey}
              channel={channel}
              onClick={() => onChannelClick(channel.driveKey)}
            />
          ))}
        </Column>
      )}
    </Column>
  );
};

interface ChannelRowProps {
  channel: { driveKey: string; name: string };
  onClick: () => void;
}

const ChannelRow: React.FC<ChannelRowProps> = ({ channel, onClick }) => {
  const [hovered, setHovered] = React.useState(false);

  return (
    <Row
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      gap={spacing.md}
      align="center"
      style={{
        padding: spacing.md,
        borderRadius: radius.md,
        backgroundColor: hovered ? colors.bgHover : 'transparent',
        cursor: 'pointer',
        transition: 'background-color 0.1s ease',
      }}
    >
      <Avatar name={channel.name} size="lg" />
      <Column gap={spacing.xs} style={{ flex: 1, minWidth: 0 }}>
        <Text weight="medium">{channel.name || 'Unknown Channel'}</Text>
        <Text
          size="sm"
          color="muted"
          style={{
            fontFamily: 'monospace',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {channel.driveKey.slice(0, 16)}...{channel.driveKey.slice(-8)}
        </Text>
      </Column>
      <Text color="muted" style={{ opacity: hovered ? 1 : 0.5 }}>
        {'›'}
      </Text>
    </Row>
  );
};

export default SubscriptionsPage;
