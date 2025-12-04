// RPC command IDs for bare-rpc (mobile)
export const RPC = {
  // Identity
  CREATE_IDENTITY: 0,
  GET_IDENTITY: 1,
  UPDATE_IDENTITY: 2,

  // Videos
  LIST_VIDEOS: 20,
  GET_VIDEO: 21,
  DELETE_VIDEO: 22,
  UPLOAD_VIDEO: 23,

  // Channels
  SUBSCRIBE_CHANNEL: 30,
  UNSUBSCRIBE_CHANNEL: 31,
  LIST_SUBSCRIPTIONS: 32,
  GET_CHANNEL: 33,

  // Public Feed (P2P Discovery)
  GET_PUBLIC_FEED: 40,
  PUBLIC_FEED_RESPONSE: 41,
  REFRESH_FEED: 42,
  SUBMIT_TO_FEED: 43,
  HIDE_CHANNEL: 44,
  GET_CHANNEL_META: 45,

  // Events
  EVENT_READY: 100,
  EVENT_ERROR: 101,
  EVENT_PROGRESS: 102,
  EVENT_SYNC: 103,
  EVENT_FEED_UPDATE: 104,
} as const;

/**
 * Hardcoded hyperswarm topic for public feed discovery
 * All peers join this topic to exchange channel listings
 */
export const PUBLIC_FEED_TOPIC = 'peartube-public-feed-v1';

// String-based RPC methods for pear-pipe (desktop)
export const RPC_METHODS = {
  createIdentity: 'createIdentity',
  getIdentity: 'getIdentity',
  updateIdentity: 'updateIdentity',
  listVideos: 'listVideos',
  getVideo: 'getVideo',
  deleteVideo: 'deleteVideo',
  uploadVideo: 'uploadVideo',
  subscribeChannel: 'subscribeChannel',
  unsubscribeChannel: 'unsubscribeChannel',
  getSubscriptions: 'getSubscriptions',
  getChannel: 'getChannel',
  // Public Feed methods
  getPublicFeed: 'getPublicFeed',
  refreshFeed: 'refreshFeed',
  submitToFeed: 'submitToFeed',
  hideChannel: 'hideChannel',
  getChannelMeta: 'getChannelMeta',
} as const;

// Design tokens
export const colors = {
  primary: '#9147ff',
  primaryHover: '#772ce8',
  bg: '#0e0e10',
  bgElevated: '#18181b',
  bgCard: '#1f1f23',
  text: '#efeff1',
  textSecondary: '#adadb8',
  textMuted: '#7a7a85',
  border: '#303035',
  error: '#ff5252',
  success: '#00c853',
  warning: '#ffab00',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

export const fontSize = {
  xs: 11,
  sm: 12,
  md: 14,
  lg: 16,
  xl: 18,
  xxl: 24,
  xxxl: 32,
} as const;

export const borderRadius = {
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
  full: 9999,
} as const;
