/**
 * Shared App Store (Desktop)
 *
 * Central place to keep identity, subscriptions, videos, and feed state so UI can stay thin.
 * Mirrors the data we also need on mobile; platform-specific adapters provide IO.
 */

import React, { createContext, useContext, useReducer, ReactNode } from 'react';
import type { BackendStatus, Identity, Video, PublicFeedEntry, ChannelMetadata } from '../lib/rpc';

export type AppStoreState = {
  status: BackendStatus | null;
  identity: Identity | null;
  videos: Video[];
  channelNames: Record<string, string>;
  subscriptions: { driveKey: string; name: string }[];
  loading: boolean;
  error: string | null;
  publicFeed: PublicFeedEntry[];
  channelMetadata: Record<string, ChannelMetadata>;
  feedLoading: boolean;
  peerCount: number;
  // View-specific state (still kept here for now)
  view: 'home' | 'watch' | 'studio' | 'subscriptions' | 'settings' | 'channel' | 'onboarding';
  currentVideo: Video | null;
  currentVideoKey: string | null;
  relatedVideos: Video[];
  viewingChannelKey: string | null;
};

type Action =
  | { type: 'setStatus'; payload: BackendStatus | null }
  | { type: 'setIdentity'; payload: Identity | null }
  | { type: 'setVideos'; payload: Video[] }
  | { type: 'upsertVideo'; payload: Video }
  | { type: 'setChannelNames'; payload: Record<string, string> }
  | { type: 'setSubscriptions'; payload: { driveKey: string; name: string }[] }
  | { type: 'setLoading'; payload: boolean }
  | { type: 'setError'; payload: string | null }
  | { type: 'setPublicFeed'; payload: PublicFeedEntry[] }
  | { type: 'setChannelMetadata'; payload: Record<string, ChannelMetadata> }
  | { type: 'setFeedLoading'; payload: boolean }
  | { type: 'setPeerCount'; payload: number }
  | { type: 'setView'; payload: AppStoreState['view'] }
  | { type: 'setCurrentVideo'; payload: { video: Video | null; driveKey: string | null; related?: Video[] } }
  | { type: 'setViewingChannel'; payload: string | null };

const initialState: AppStoreState = {
  status: null,
  identity: null,
  videos: [],
  channelNames: {},
  subscriptions: [],
  loading: true,
  error: null,
  publicFeed: [],
  channelMetadata: {},
  feedLoading: false,
  peerCount: 0,
  view: 'home',
  currentVideo: null,
  currentVideoKey: null,
  relatedVideos: [],
  viewingChannelKey: null,
};

function reducer(state: AppStoreState, action: Action): AppStoreState {
  switch (action.type) {
    case 'setStatus':
      return { ...state, status: action.payload };
    case 'setIdentity':
      return { ...state, identity: action.payload };
    case 'setVideos':
      return { ...state, videos: action.payload };
    case 'upsertVideo': {
      const existing = state.videos.filter(v => v.id !== action.payload.id);
      return { ...state, videos: [action.payload, ...existing] };
    }
    case 'setChannelNames':
      return { ...state, channelNames: action.payload };
    case 'setSubscriptions':
      return { ...state, subscriptions: action.payload };
    case 'setLoading':
      return { ...state, loading: action.payload };
    case 'setError':
      return { ...state, error: action.payload };
    case 'setPublicFeed':
      return { ...state, publicFeed: action.payload };
    case 'setChannelMetadata':
      return { ...state, channelMetadata: action.payload };
    case 'setFeedLoading':
      return { ...state, feedLoading: action.payload };
    case 'setPeerCount':
      return { ...state, peerCount: action.payload };
    case 'setView':
      return { ...state, view: action.payload };
    case 'setCurrentVideo':
      return {
        ...state,
        currentVideo: action.payload.video,
        currentVideoKey: action.payload.driveKey,
        relatedVideos: action.payload.related ?? state.relatedVideos,
      };
    case 'setViewingChannel':
      return { ...state, viewingChannelKey: action.payload };
    default:
      return state;
  }
}

const AppStoreContext = createContext<{
  state: AppStoreState;
  dispatch: React.Dispatch<Action>;
}>({
  state: initialState,
  dispatch: () => {},
});

export const AppStoreProvider = ({ children }: { children: ReactNode }) => {
  const [state, dispatch] = useReducer(reducer, initialState);
  return (
    <AppStoreContext.Provider value={{ state, dispatch }}>
      {children}
    </AppStoreContext.Provider>
  );
};

export const useAppStore = () => useContext(AppStoreContext);
