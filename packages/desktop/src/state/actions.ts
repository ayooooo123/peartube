/**
 * App Store Actions
 *
 * Async actions that interact with RPC and dispatch state updates.
 * These can be shared across components and eventually mirrored to mobile.
 */

import { rpc } from '../lib/rpc';
import type { Video, Identity, PublicFeedEntry, ChannelMetadata, BackendStatus } from '@peartube/core';

// Action dispatch type - mirrors reducer actions
type Dispatch = React.Dispatch<any>;

export interface AppActions {
  loadInitialData: () => Promise<void>;
  loadPublicFeed: () => Promise<void>;
  loadFeedVideos: () => Promise<void>;
  loadVideos: (channelKey: string) => Promise<Video[]>;
  createIdentity: (name: string) => Promise<{ success: boolean; mnemonic?: string }>;
  recoverIdentity: (mnemonic: string, name?: string) => Promise<boolean>;
  subscribe: (driveKey: string) => Promise<boolean>;
  prefetchVideo: (driveKey: string, videoPath: string) => Promise<boolean>;
  refreshFeed: () => Promise<void>;
}

/**
 * Creates bound actions for the app store
 */
export function createActions(
  dispatch: Dispatch,
  getState: () => any
): AppActions {

  async function loadInitialData() {
    try {
      dispatch({ type: 'setLoading', payload: true });
      dispatch({ type: 'setError', payload: null });

      const [statusData, identitiesData] = await Promise.all([
        rpc.getStatus(),
        rpc.getIdentities(),
      ]);

      const activeIdentity = identitiesData.find(i => i.isActive) || null;

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
              console.error('[Actions] Failed to load videos from', sub.driveKey, err);
            }
          }

          // Also load own channel videos
          if (activeIdentity.driveKey) {
            try {
              const ownVideos = await rpc.listVideos(activeIdentity.driveKey);
              videos = [...videos, ...ownVideos.map(v => ({ ...v, channelKey: activeIdentity.driveKey! }))];
              channelNames[activeIdentity.driveKey] = activeIdentity.name || 'My Channel';
            } catch (err) {
              console.error('[Actions] Failed to load own videos', err);
            }
          }

          // Sort by upload date
          videos.sort((a, b) => b.uploadedAt - a.uploadedAt);
        } catch (err) {
          console.error('[Actions] Failed to load subscriptions:', err);
        }
      }

      dispatch({ type: 'setStatus', payload: statusData });
      dispatch({ type: 'setIdentity', payload: activeIdentity });
      dispatch({ type: 'setVideos', payload: videos });
      dispatch({ type: 'setChannelNames', payload: channelNames });
      dispatch({ type: 'setSubscriptions', payload: subscriptions });
      dispatch({ type: 'setLoading', payload: false });
    } catch (err: any) {
      console.error('[Actions] loadInitialData error:', err);
      dispatch({ type: 'setLoading', payload: false });
      dispatch({ type: 'setError', payload: err.message || 'Failed to load data' });
    }
  }

  async function loadPublicFeed() {
    dispatch({ type: 'setFeedLoading', payload: true });
    try {
      console.log('[Actions] Loading public feed...');
      const result = await rpc.getPublicFeed();
      console.log('[Actions] Public feed result:', result);

      dispatch({ type: 'setPublicFeed', payload: result.entries });
      dispatch({ type: 'setPeerCount', payload: result.stats.peerCount });
      dispatch({ type: 'setFeedLoading', payload: false });

      // Lazy load metadata for first 10 channels
      const state = getState();
      for (const entry of result.entries.slice(0, 10)) {
        if (!state.channelMetadata[entry.driveKey]) {
          try {
            const meta = await rpc.getChannelMetadata(entry.driveKey);
            const currentState = getState();
            const nextMeta = { ...currentState.channelMetadata, [entry.driveKey]: meta };
            dispatch({ type: 'setChannelMetadata', payload: nextMeta });
          } catch (err) {
            console.error('[Actions] Failed to load metadata for', entry.driveKey.slice(0, 8), err);
          }
        }
      }

      // Load videos from discovered channels
      await loadFeedVideos();
    } catch (err: any) {
      console.error('[Actions] Failed to load public feed:', err);
      dispatch({ type: 'setFeedLoading', payload: false });
    }
  }

  async function loadFeedVideos() {
    const state = getState();
    if (state.publicFeed.length === 0) return;

    dispatch({ type: 'setFeedVideosLoading', payload: true });
    const allVideos: Video[] = [];

    // Limit to first 15 channels to avoid overloading
    for (const entry of state.publicFeed.slice(0, 15)) {
      const channelKey = entry.driveKey;
      if (!channelKey) continue;

      try {
        const channelVideos = await rpc.listVideos(channelKey);
        const currentState = getState();
        const channelName = currentState.channelMetadata[channelKey]?.name || 'Unknown';

        const videosWithChannel = channelVideos.map(v => ({
          ...v,
          channelKey,
          channelName,
        }));
        allVideos.push(...videosWithChannel);
      } catch (err) {
        console.log('[Actions] Failed to load videos from channel:', channelKey.slice(0, 8));
      }
    }

    // Sort by uploadedAt descending, limit to 50 videos
    const sorted = allVideos
      .sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0))
      .slice(0, 50);

    dispatch({ type: 'setFeedVideos', payload: sorted });
    dispatch({ type: 'setFeedVideosLoading', payload: false });
  }

  async function loadVideos(channelKey: string): Promise<Video[]> {
    try {
      const videos = await rpc.listVideos(channelKey);
      return videos;
    } catch (err) {
      console.error('[Actions] Failed to load videos for', channelKey, err);
      return [];
    }
  }

  async function createIdentity(name: string): Promise<{ success: boolean; mnemonic?: string }> {
    try {
      dispatch({ type: 'setLoading', payload: true });
      dispatch({ type: 'setError', payload: null });

      const result = await rpc.createIdentity(name);

      // Reload data after creating identity
      await loadInitialData();

      return { success: result.success, mnemonic: result.mnemonic };
    } catch (err: any) {
      dispatch({ type: 'setLoading', payload: false });
      dispatch({ type: 'setError', payload: err.message || 'Failed to create identity' });
      return { success: false };
    }
  }

  async function recoverIdentity(mnemonic: string, name?: string): Promise<boolean> {
    try {
      dispatch({ type: 'setLoading', payload: true });
      dispatch({ type: 'setError', payload: null });

      await rpc.recoverIdentity(mnemonic, name);

      // Reload data after recovery
      await loadInitialData();

      return true;
    } catch (err: any) {
      dispatch({ type: 'setLoading', payload: false });
      dispatch({ type: 'setError', payload: err.message || 'Failed to recover identity' });
      return false;
    }
  }

  async function subscribe(driveKey: string): Promise<boolean> {
    try {
      const result = await rpc.subscribeChannel(driveKey);
      if (result.success) {
        // Reload subscriptions
        const subs = await rpc.getSubscriptions();
        dispatch({ type: 'setSubscriptions', payload: subs });
      }
      return result.success;
    } catch (err: any) {
      console.error('[Actions] Failed to subscribe:', err);
      dispatch({ type: 'setError', payload: err.message || 'Failed to subscribe' });
      return false;
    }
  }

  async function prefetchVideo(driveKey: string, videoPath: string): Promise<boolean> {
    try {
      const result = await rpc.prefetchVideo(driveKey, videoPath);
      return result.success;
    } catch (err: any) {
      console.error('[Actions] Failed to prefetch video:', err);
      return false;
    }
  }

  async function refreshFeed() {
    try {
      await rpc.refreshFeed();
      await loadPublicFeed();
    } catch (err: any) {
      console.error('[Actions] Failed to refresh feed:', err);
    }
  }

  return {
    loadInitialData,
    loadPublicFeed,
    loadFeedVideos,
    loadVideos,
    createIdentity,
    recoverIdentity,
    subscribe,
    prefetchVideo,
    refreshFeed,
  };
}
