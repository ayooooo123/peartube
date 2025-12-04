/**
 * PearTube - Main App Component
 */

import React, { useState, useEffect, useRef } from 'react';
import { rpc, type Video } from './lib/rpc';
import { useAppStore, type AppStoreState } from './state/appStore';
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

export default function App() {
  const { state, dispatch } = useAppStore();
  const stateRef = useRef(state);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Onboarding state
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newIdentityName, setNewIdentityName] = useState('');
  const [createdMnemonic, setCreatedMnemonic] = useState<string | null>(null);
  const [showRecoverForm, setShowRecoverForm] = useState(false);
  const [recoverMnemonic, setRecoverMnemonic] = useState('');
  const [recoverName, setRecoverName] = useState('');

  // ---- Simple hash-based router ----
  function navigate(path: string) {
    const normalized = path.startsWith('#') ? path : `#${path.startsWith('/') ? path.slice(1) : path}`;
    window.location.hash = normalized || '#/';
  }

  function parseRoute(hash: string) {
    const raw = hash.replace(/^#/, '') || '/';
    const path = raw.startsWith('/') ? raw : `/${raw}`;
    const parts = path.split('/').filter(Boolean);

    if (parts.length === 0) return { view: 'home' as View };
    const [first, second, third] = parts;

    switch (first) {
      case 'studio':
        return { view: 'studio' as View };
      case 'subscriptions':
        return { view: 'subscriptions' as View };
      case 'settings':
        return { view: 'settings' as View };
      case 'channel':
        return { view: 'channel' as View, driveKey: second };
      case 'watch':
        return { view: 'watch' as View, driveKey: second, videoId: third };
      case 'onboarding':
        return { view: 'onboarding' as View };
      default:
        return { view: 'home' as View };
    }
  }

  function applyRoute(hash: string, snapshot: AppStoreState) {
    const route = parseRoute(hash);
    let view = route.view;

    // Gate onboarding if no identity
    if (!snapshot.identity && view !== 'onboarding') {
      view = 'onboarding';
    }

    dispatch({ type: 'setView', payload: view });

    if (view === 'channel' && route.driveKey) {
      dispatch({ type: 'setViewingChannel', payload: route.driveKey });
    } else {
      dispatch({ type: 'setViewingChannel', payload: null });
    }

    if (view === 'watch' && route.driveKey && route.videoId) {
      const found =
        snapshot.videos.find(v => v.id === route.videoId && v.channelKey === route.driveKey) ||
        snapshot.videos.find(v => v.id === route.videoId);

      const placeholder: Video = found || {
        id: route.videoId,
        title: 'Loading...',
        description: '',
        path: '', // will be fetched via listVideos
        mimeType: '',
        size: 0,
        uploadedAt: Date.now(),
        channelKey: route.driveKey,
      };

      const related = snapshot.videos.filter(v => v.id !== route.videoId).slice(0, 10);

      dispatch({
        type: 'setCurrentVideo',
        payload: { video: placeholder, driveKey: route.driveKey, related },
      });
    } else {
      dispatch({ type: 'setCurrentVideo', payload: { video: null, driveKey: null, related: [] } });
    }
  }

  useEffect(() => {
    const syncRoute = () => applyRoute(window.location.hash, stateRef.current);
    window.addEventListener('hashchange', syncRoute);

    (async () => {
      await loadInitialData();
      await loadPublicFeed();
      syncRoute();
    })();

    // Apply route on first render
    syncRoute();

    return () => {
      window.removeEventListener('hashchange', syncRoute);
    };
  }, []);

  async function loadInitialData() {
    try {
      dispatch({ type: 'setLoading', payload: true });
      dispatch({ type: 'setError', payload: null });

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

      dispatch({ type: 'setStatus', payload: statusData });
      dispatch({ type: 'setIdentity', payload: activeIdentity });
      dispatch({ type: 'setVideos', payload: videos });
      dispatch({ type: 'setChannelNames', payload: channelNames });
      dispatch({ type: 'setSubscriptions', payload: subscriptions });
      dispatch({ type: 'setLoading', payload: false });

      const snapshot: AppStoreState = {
        ...stateRef.current,
        status: statusData,
        identity: activeIdentity,
        videos,
        channelNames,
        subscriptions,
        loading: false,
      };
      stateRef.current = snapshot;
      applyRoute(window.location.hash || (activeIdentity ? '#/' : '#/onboarding'), snapshot);
    } catch (err: any) {
      console.error('[App] loadInitialData error:', err);
      dispatch({ type: 'setLoading', payload: false });
      dispatch({ type: 'setError', payload: err.message || 'Failed to load data' });
    }
  }

  async function handleCreateIdentity(e?: React.FormEvent) {
    e?.preventDefault();
    if (!newIdentityName.trim()) return;

    try {
      dispatch({ type: 'setLoading', payload: true });
      dispatch({ type: 'setError', payload: null });

      const result = await rpc.createIdentity(newIdentityName);

      if (result.success && result.mnemonic) {
        setCreatedMnemonic(result.mnemonic);
      }

      setNewIdentityName('');
      setShowCreateForm(false);
      await loadInitialData();
    } catch (err: any) {
      dispatch({ type: 'setLoading', payload: false });
      dispatch({ type: 'setError', payload: err.message || 'Failed to create identity' });
    }
  }

  async function handleRecoverIdentity(e?: React.FormEvent) {
    e?.preventDefault();
    if (!recoverMnemonic.trim()) return;

    try {
      dispatch({ type: 'setLoading', payload: true });
      dispatch({ type: 'setError', payload: null });

      await rpc.recoverIdentity(recoverMnemonic, recoverName || undefined);

      setRecoverMnemonic('');
      setRecoverName('');
      setShowRecoverForm(false);
      await loadInitialData();
      navigate('/');
      navigate('/');
    } catch (err: any) {
      dispatch({ type: 'setLoading', payload: false });
      dispatch({ type: 'setError', payload: err.message || 'Failed to recover identity' });
    }
  }

  function handleNavigate(id: string) {
    if (id === 'home') navigate('/'); 
    else if (id === 'subscriptions') navigate('/subscriptions');
    else if (id === 'studio') navigate('/studio');
    else if (id === 'settings') navigate('/settings');
    else if (id === 'channel' && state.identity?.driveKey) {
      navigate(`/channel/${state.identity.driveKey}`);
    }
  }

  function handleVideoClick(video: Video) {
    const channelKey = video.channelKey || state.identity?.driveKey || '';
    const related = state.videos.filter(v => v.id !== video.id).slice(0, 10);
    dispatch({ type: 'setCurrentVideo', payload: { video, driveKey: channelKey, related } });
    navigate(`/watch/${channelKey}/${video.id}`);
  }

  function handleChannelClick(driveKey: string) {
    navigate(`/channel/${driveKey}`);
  }

  function handleSearch(query: string) {
    console.log('Search:', query);
    // TODO: Implement search
  }

  async function loadPublicFeed() {
    dispatch({ type: 'setFeedLoading', payload: true });
    try {
      console.log('[Home] Loading public feed...');
      const result = await rpc.getPublicFeed();
      console.log('[Home] Public feed result:', result);

      dispatch({ type: 'setPublicFeed', payload: result.entries });
      dispatch({ type: 'setPeerCount', payload: result.stats.peerCount });
      dispatch({ type: 'setFeedLoading', payload: false });

      // Lazy load metadata for first 10 channels
      for (const entry of result.entries.slice(0, 10)) {
        if (!stateRef.current.channelMetadata[entry.driveKey]) {
          try {
            const meta = await rpc.getChannelMetadata(entry.driveKey);
            const nextMeta = { ...stateRef.current.channelMetadata, [entry.driveKey]: meta };
            stateRef.current = { ...stateRef.current, channelMetadata: nextMeta };
            dispatch({ type: 'setChannelMetadata', payload: nextMeta });
          } catch (err) {
            console.error('[Home] Failed to load metadata for', entry.driveKey.slice(0, 8), err);
          }
        }
      }
    } catch (err: any) {
      console.error('[Home] Failed to load public feed:', err);
      dispatch({ type: 'setFeedLoading', payload: false });
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
              onClose={() => dispatch({ type: 'setError', payload: null })}
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
      onUploadClick={() => navigate('/studio')}
      onProfileClick={() => navigate('/settings')}
      onSubscriptionClick={handleChannelClick}
    >
      {state.error && (
        <Alert
          variant="error"
          onClose={() => dispatch({ type: 'setError', payload: null })}
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
          onBack={() => navigate('/')}
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
          onLogout={() => {
            dispatch({ type: 'setIdentity', payload: null });
            dispatch({ type: 'setVideos', payload: [] });
            dispatch({ type: 'setSubscriptions', payload: [] });
            dispatch({ type: 'setChannelNames', payload: {} });
            dispatch({ type: 'setCurrentVideo', payload: { video: null, driveKey: null, related: [] } });
            dispatch({ type: 'setViewingChannel', payload: null });
            dispatch({ type: 'setView', payload: 'onboarding' });
            navigate('/onboarding');
          }}
        />
      )}

      {state.view === 'channel' && state.viewingChannelKey && (
        <ChannelPage
          driveKey={state.viewingChannelKey}
          identity={state.identity}
          onBack={() => navigate('/')}
          onVideoClick={handleVideoClick}
        />
      )}
    </AppLayout>
  );
}
