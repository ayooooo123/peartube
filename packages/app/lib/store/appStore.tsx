/**
 * Shared App Store (Mobile)
 *
 * Mirrors desktop's appStore pattern for consistent state management.
 * Platform-specific RPC calls are abstracted through actions.
 */

import React, { createContext, useContext, useReducer, useMemo, ReactNode } from 'react';
import type { Identity, Video, VideoData, MediaCatalogState, ChannelMetadata, VideoStats } from '@peartube/core';

export type AppStoreState = {
  // Connection status
  ready: boolean;
  loading: boolean;
  error: string | null;

  // Identity & channel
  identity: Identity | null;

  // Videos & content
  videos: Video[];
  channelNames: Record<string, string>;

  // Subscriptions
  subscriptions: { driveKey: string; name: string }[];

  // Resolved media entities
  mediaCatalog: MediaCatalogState;
  channelMetadata: Record<string, ChannelMetadata>;

  // Platform-specific
  blobServerPort: number | null;

  // Current video (player state)
  currentVideo: VideoData | null;
  currentVideoKey: string | null;
  videoStats: VideoStats | null;
};

type Action =
  | { type: 'setReady'; payload: boolean }
  | { type: 'setLoading'; payload: boolean }
  | { type: 'setError'; payload: string | null }
  | { type: 'setIdentity'; payload: Identity | null }
  | { type: 'setVideos'; payload: Video[] }
  | { type: 'upsertVideo'; payload: Video }
  | { type: 'setChannelNames'; payload: Record<string, string> }
  | { type: 'setSubscriptions'; payload: { driveKey: string; name: string }[] }
  | { type: 'setMediaCatalog'; payload: MediaCatalogState }
  | { type: 'setChannelMetadata'; payload: Record<string, ChannelMetadata> }
  | { type: 'setBlobServerPort'; payload: number | null }
  | { type: 'setCurrentVideo'; payload: { video: VideoData | null; driveKey: string | null } }
  | { type: 'setVideoStats'; payload: VideoStats | null };

const initialState: AppStoreState = {
  ready: false,
  loading: true,
  error: null,
  identity: null,
  videos: [],
  channelNames: {},
  subscriptions: [],
  mediaCatalog: {
    status: 'idle',
    items: [],
    refreshing: false,
    loadingMore: false,
  },
  channelMetadata: {},
  blobServerPort: null,
  currentVideo: null,
  currentVideoKey: null,
  videoStats: null,
};

function reducer(state: AppStoreState, action: Action): AppStoreState {
  switch (action.type) {
    case 'setReady':
      return { ...state, ready: action.payload };
    case 'setLoading':
      return { ...state, loading: action.payload };
    case 'setError':
      return { ...state, error: action.payload };
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
    case 'setMediaCatalog':
      return { ...state, mediaCatalog: action.payload };
    case 'setChannelMetadata':
      return { ...state, channelMetadata: action.payload };
    case 'setBlobServerPort':
      return { ...state, blobServerPort: action.payload };
    case 'setCurrentVideo':
      return {
        ...state,
        currentVideo: action.payload.video,
        currentVideoKey: action.payload.driveKey,
      };
    case 'setVideoStats':
      return { ...state, videoStats: action.payload };
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

  const contextValue = useMemo(() => ({ state, dispatch }), [state]);

  return (
    <AppStoreContext.Provider value={contextValue}>
      {children}
    </AppStoreContext.Provider>
  );
};

export const useAppStore = () => useContext(AppStoreContext);
