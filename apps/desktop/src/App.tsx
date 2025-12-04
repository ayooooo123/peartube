/**
 * PearTube - Main App Component
 */

import React, { useState, useEffect } from 'react';
import { rpc, type BackendStatus, type Identity, type Video, type PublicFeedEntry, type ChannelMetadata } from './lib/rpc';
import { AppLayout } from './components/layout/AppLayout';
import { HomePage } from './pages/HomePage';
import { WatchPage } from './pages/WatchPage';
import { StudioPage } from './pages/StudioPage';
import { SubscriptionsPage } from './pages/SubscriptionsPage';
import { SettingsPage } from './pages/SettingsPage';
import { ChannelPage } from './pages/ChannelPage';
import { Column, Text, Button, Input, Card, Alert, Spinner, Row } from './components/ui';
import { colors, spacing, radius } from './lib/theme';

type View = 'home' | 'watch' | 'studio' | 'subscriptions' | 'settings' | 'channel' | 'onboarding';

interface AppState {
  view: View;
  status: BackendStatus | null;
  identity: Identity | null;
  videos: Video[];
  channelNames: Record<string, string>;
  subscriptions: { driveKey: string; name: string }[];
  loading: boolean;
  error: string | null;
  // Watch page state
  currentVideo: Video | null;
  currentVideoKey: string | null;
  relatedVideos: Video[];
  // Channel page state
  viewingChannelKey: string | null;
  // Public feed state
  publicFeed: PublicFeedEntry[];
  channelMetadata: Record<string, ChannelMetadata>;
  feedLoading: boolean;
  peerCount: number;
}

export default function App() {
  const [state, setState] = useState<AppState>({
    view: 'home',
    status: null,
    identity: null,
    videos: [],
    channelNames: {},
    subscriptions: [],
    loading: true,
    error: null,
    currentVideo: null,
    currentVideoKey: null,
    relatedVideos: [],
    viewingChannelKey: null,
    publicFeed: [],
    channelMetadata: {},
    feedLoading: false,
    peerCount: 0,
  });

  // Onboarding state
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newIdentityName, setNewIdentityName] = useState('');
  const [createdMnemonic, setCreatedMnemonic] = useState<string | null>(null);
  const [showRecoverForm, setShowRecoverForm] = useState(false);
  const [recoverMnemonic, setRecoverMnemonic] = useState('');
  const [recoverName, setRecoverName] = useState('');

  useEffect(() => {
    loadInitialData().then(() => {
      // Load public feed after initial data
      loadPublicFeed();
    });
  }, []);

  async function loadInitialData() {
    try {
      setState(s => ({ ...s, loading: true, error: null }));

      const [statusData, identitiesData] = await Promise.all([
        rpc.getStatus(),
        rpc.getIdentities(),
      ]);

      const activeIdentity = identitiesData.find(i => i.isActive) || null;

      // Load videos and subscriptions if we have an identity
      let videos: Video[] = [];
      let channelNames: Record<string, string> = {};
      let subscriptions: { driveKey: string; name: string }[] = [];

      if (activeIdentity) {
        try {
          const subs = await rpc.getSubscriptions();
          subscriptions = subs;

          // Load videos from subscribed channels
          for (const sub of subs) {
            try {
              const channelVideos = await rpc.listVideos(sub.driveKey);
              videos = [...videos, ...channelVideos.map(v => ({ ...v, channelKey: sub.driveKey }))];
              channelNames[sub.driveKey] = sub.name;
            } catch (err) {
              console.error('Failed to load videos from', sub.driveKey, err);
            }
          }

          // Also load own channel videos
          if (activeIdentity.driveKey) {
            try {
              const ownVideos = await rpc.listVideos(activeIdentity.driveKey);
              videos = [...videos, ...ownVideos.map(v => ({ ...v, channelKey: activeIdentity.driveKey! }))];
              channelNames[activeIdentity.driveKey] = activeIdentity.name || 'My Channel';
            } catch (err) {
              console.error('Failed to load own videos', err);
            }
          }

          // Sort by upload date
          videos.sort((a, b) => b.uploadedAt - a.uploadedAt);
        } catch (err) {
          console.error('Failed to load subscriptions:', err);
        }
      }

      setState(s => ({
        ...s,
        status: statusData,
        identity: activeIdentity,
        videos,
        channelNames,
        subscriptions,
        loading: false,
        view: activeIdentity ? 'home' : 'onboarding',
      }));
    } catch (err: any) {
      console.error('[App] loadInitialData error:', err);
      setState(s => ({
        ...s,
        loading: false,
        error: err.message || 'Failed to load data',
        view: 'onboarding',
      }));
    }
  }

  async function handleCreateIdentity(e?: React.FormEvent) {
    e?.preventDefault();
    if (!newIdentityName.trim()) return;

    try {
      setState(s => ({ ...s, loading: true, error: null }));

      const result = await rpc.createIdentity(newIdentityName);

      if (result.success && result.mnemonic) {
        setCreatedMnemonic(result.mnemonic);
      }

      setNewIdentityName('');
      setShowCreateForm(false);
      await loadInitialData();
    } catch (err: any) {
      setState(s => ({ ...s, loading: false, error: err.message || 'Failed to create identity' }));
    }
  }

  async function handleRecoverIdentity(e?: React.FormEvent) {
    e?.preventDefault();
    if (!recoverMnemonic.trim()) return;

    try {
      setState(s => ({ ...s, loading: true, error: null }));

      await rpc.recoverIdentity(recoverMnemonic, recoverName || undefined);

      setRecoverMnemonic('');
      setRecoverName('');
      setShowRecoverForm(false);
      await loadInitialData();
    } catch (err: any) {
      setState(s => ({ ...s, loading: false, error: err.message || 'Failed to recover identity' }));
    }
  }

  function handleNavigate(id: string) {
    if (id === 'home') setState(s => ({ ...s, view: 'home' }));
    else if (id === 'subscriptions') setState(s => ({ ...s, view: 'subscriptions' }));
    else if (id === 'studio') setState(s => ({ ...s, view: 'studio' }));
    else if (id === 'settings') setState(s => ({ ...s, view: 'settings' }));
    else if (id === 'channel' && state.identity?.driveKey) {
      setState(s => ({ ...s, view: 'channel', viewingChannelKey: state.identity!.driveKey! }));
    }
  }

  function handleVideoClick(video: Video) {
    const channelKey = video.channelKey || state.identity?.driveKey || '';
    const related = state.videos.filter(v => v.id !== video.id).slice(0, 10);
    setState(s => ({
      ...s,
      view: 'watch',
      currentVideo: video,
      currentVideoKey: channelKey,
      relatedVideos: related,
    }));
  }

  function handleChannelClick(driveKey: string) {
    setState(s => ({ ...s, view: 'channel', viewingChannelKey: driveKey }));
  }

  function handleSearch(query: string) {
    console.log('Search:', query);
    // TODO: Implement search
  }

  async function loadPublicFeed() {
    setState(s => ({ ...s, feedLoading: true }));
    try {
      console.log('[Home] Loading public feed...');
      const result = await rpc.getPublicFeed();
      console.log('[Home] Public feed result:', result);

      setState(s => ({
        ...s,
        publicFeed: result.entries,
        peerCount: result.stats.peerCount,
        feedLoading: false,
      }));

      // Lazy load metadata for first 10 channels
      for (const entry of result.entries.slice(0, 10)) {
        if (!state.channelMetadata[entry.driveKey]) {
          try {
            const meta = await rpc.getChannelMetadata(entry.driveKey);
            setState(s => ({
              ...s,
              channelMetadata: { ...s.channelMetadata, [entry.driveKey]: meta },
            }));
          } catch (err) {
            console.error('[Home] Failed to load metadata for', entry.driveKey.slice(0, 8), err);
          }
        }
      }
    } catch (err: any) {
      console.error('[Home] Failed to load public feed:', err);
      setState(s => ({ ...s, feedLoading: false }));
    }
  }

  // Loading state
  if (state.loading && !state.status) {
    return (
      <Column
        align="center"
        justify="center"
        style={{
          height: '100%',
          backgroundColor: colors.bg,
          color: colors.textPrimary,
        }}
      >
        <Spinner size="lg" />
        <Text style={{ marginTop: spacing.lg }}>Loading PearTube...</Text>
      </Column>
    );
  }

  // Onboarding - no identity yet
  if (state.view === 'onboarding' || !state.identity) {
    return (
      <Column
        align="center"
        justify="center"
        style={{
          height: '100%',
          backgroundColor: colors.bg,
          color: colors.textPrimary,
          padding: spacing.xl,
        }}
      >
        <Column align="center" style={{ maxWidth: 480, width: '100%' }}>
          <Text size="xxxl" weight="bold" style={{ marginBottom: spacing.sm }}>
            PearTube
          </Text>
          <Text color="secondary" style={{ marginBottom: spacing.xxl, textAlign: 'center' }}>
            Decentralized P2P Video Platform
          </Text>

          {state.error && (
            <Alert
              variant="error"
              onClose={() => setState(s => ({ ...s, error: null }))}
              style={{ marginBottom: spacing.lg, width: '100%' }}
            >
              {state.error}
            </Alert>
          )}

          {/* Mnemonic Display */}
          {createdMnemonic && (
            <Card style={{
              marginBottom: spacing.xl,
              width: '100%',
              backgroundColor: 'rgba(255, 193, 7, 0.1)',
              border: '2px solid rgba(255, 193, 7, 0.3)',
            }}>
              <Text weight="bold" style={{ marginBottom: spacing.sm }}>
                Save Your Recovery Phrase
              </Text>
              <Text size="sm" color="secondary" style={{ marginBottom: spacing.md }}>
                Write down these 12 words in order. You'll need them to recover your identity.
              </Text>
              <div style={{
                backgroundColor: 'rgba(0, 0, 0, 0.3)',
                padding: spacing.md,
                borderRadius: radius.md,
                fontFamily: 'monospace',
                marginBottom: spacing.md,
                wordBreak: 'break-word',
              }}>
                {createdMnemonic}
              </div>
              <Row gap={spacing.sm}>
                <Button
                  variant="secondary"
                  onClick={() => {
                    navigator.clipboard.writeText(createdMnemonic);
                  }}
                >
                  Copy
                </Button>
                <Button
                  variant="primary"
                  onClick={() => setCreatedMnemonic(null)}
                >
                  I've Saved It
                </Button>
              </Row>
            </Card>
          )}

          {!showCreateForm && !showRecoverForm && !createdMnemonic && (
            <Column gap={spacing.md} style={{ width: '100%' }}>
              <Button
                variant="primary"
                size="lg"
                onClick={() => setShowCreateForm(true)}
                style={{ width: '100%' }}
              >
                Create New Channel
              </Button>
              <Button
                variant="secondary"
                size="lg"
                onClick={() => setShowRecoverForm(true)}
                style={{ width: '100%' }}
              >
                Recover Existing Channel
              </Button>
            </Column>
          )}

          {/* Create Form */}
          {showCreateForm && (
            <Card style={{ width: '100%' }}>
              <Text weight="semibold" style={{ marginBottom: spacing.lg }}>
                Create New Channel
              </Text>
              <Input
                value={newIdentityName}
                onChange={(e) => setNewIdentityName(e.target.value)}
                placeholder="Enter channel name..."
                style={{ marginBottom: spacing.md }}
              />
              <Row gap={spacing.sm} justify="flex-end">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setShowCreateForm(false);
                    setNewIdentityName('');
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={() => handleCreateIdentity()}
                  disabled={!newIdentityName.trim() || state.loading}
                  loading={state.loading}
                >
                  Create
                </Button>
              </Row>
            </Card>
          )}

          {/* Recover Form */}
          {showRecoverForm && (
            <Card style={{ width: '100%' }}>
              <Text weight="semibold" style={{ marginBottom: spacing.lg }}>
                Recover Channel
              </Text>
              <Input
                value={recoverMnemonic}
                onChange={(e) => setRecoverMnemonic(e.target.value)}
                placeholder="Enter 12-word recovery phrase..."
                style={{ marginBottom: spacing.sm }}
              />
              <Input
                value={recoverName}
                onChange={(e) => setRecoverName(e.target.value)}
                placeholder="Channel name (optional)..."
                style={{ marginBottom: spacing.md }}
              />
              <Row gap={spacing.sm} justify="flex-end">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setShowRecoverForm(false);
                    setRecoverMnemonic('');
                    setRecoverName('');
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={() => handleRecoverIdentity()}
                  disabled={!recoverMnemonic.trim() || state.loading}
                  loading={state.loading}
                >
                  Recover
                </Button>
              </Row>
            </Card>
          )}

          {/* Status indicator */}
          {state.status && (
            <Row gap={spacing.md} style={{ marginTop: spacing.xxl, opacity: 0.6 }}>
              <Text size="sm">
                {state.status.connected ? '🟢' : '🔴'} {state.status.connected ? 'Connected' : 'Offline'}
              </Text>
              <Text size="sm">
                {state.status.peers} peers
              </Text>
            </Row>
          )}
        </Column>
      </Column>
    );
  }

  // Main app with layout
  return (
    <AppLayout
      activeNav={state.view}
      onNavigate={handleNavigate}
      onSearch={handleSearch}
      identity={state.identity}
      subscriptions={state.subscriptions}
      onUploadClick={() => setState(s => ({ ...s, view: 'studio' }))}
      onProfileClick={() => setState(s => ({ ...s, view: 'settings' }))}
      onSubscriptionClick={handleChannelClick}
    >
      {state.error && (
        <Alert
          variant="error"
          onClose={() => setState(s => ({ ...s, error: null }))}
          style={{ margin: spacing.lg }}
        >
          {state.error}
        </Alert>
      )}

      {state.view === 'home' && (
        <HomePage
          videos={state.videos}
          channelNames={state.channelNames}
          onVideoClick={handleVideoClick}
          loading={state.loading}
          discoveredChannels={state.publicFeed.map(e => ({
            driveKey: e.driveKey,
            name: state.channelMetadata[e.driveKey]?.name,
            videoCount: state.channelMetadata[e.driveKey]?.videoCount,
          }))}
          onChannelClick={handleChannelClick}
          onRefreshFeed={loadPublicFeed}
          feedLoading={state.feedLoading}
          peerCount={state.peerCount}
        />
      )}

      {state.view === 'watch' && state.currentVideo && state.currentVideoKey && (
        <WatchPage
          video={state.currentVideo}
          driveKey={state.currentVideoKey}
          relatedVideos={state.relatedVideos}
          channelNames={state.channelNames}
          onBack={() => setState(s => ({ ...s, view: 'home' }))}
          onVideoClick={handleVideoClick}
          onChannelClick={handleChannelClick}
        />
      )}

      {state.view === 'studio' && (
        <StudioPage
          identity={state.identity}
          onVideoClick={handleVideoClick}
        />
      )}

      {state.view === 'subscriptions' && (
        <SubscriptionsPage
          subscriptions={state.subscriptions}
          onChannelClick={handleChannelClick}
        />
      )}

      {state.view === 'settings' && (
        <SettingsPage
          identity={state.identity}
          status={state.status}
          onLogout={() => setState(s => ({ ...s, view: 'onboarding', identity: null }))}
        />
      )}

      {state.view === 'channel' && state.viewingChannelKey && (
        <ChannelPage
          driveKey={state.viewingChannelKey}
          identity={state.identity}
          onBack={() => setState(s => ({ ...s, view: 'home' }))}
          onVideoClick={handleVideoClick}
        />
      )}
    </AppLayout>
  );
}
