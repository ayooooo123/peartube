/**
 * Unified RPC Command IDs
 *
 * Single source of truth for all command IDs used by mobile (bare-rpc) and desktop (pear-pipe).
 * Mobile uses numeric command IDs, desktop uses both command IDs and method strings.
 */
export const CMD = {
  // Identity (0-1)
  CREATE_IDENTITY: 0,
  GET_IDENTITY: 1,

  // Channel (2-3)
  GET_CHANNEL: 2,
  UPDATE_CHANNEL: 3,

  // Videos (4-7)
  LIST_VIDEOS: 4,
  GET_VIDEO_URL: 5,
  GET_VIDEO_DATA: 6,
  UPLOAD_VIDEO: 7,

  // Subscriptions (8-11)
  SUBSCRIBE_CHANNEL: 8,
  UNSUBSCRIBE_CHANNEL: 9,
  LIST_SUBSCRIPTIONS: 10,
  JOIN_CHANNEL: 11,

  // Public Feed (12-17)
  GET_PUBLIC_FEED: 12,
  REFRESH_FEED: 13,
  SUBMIT_TO_FEED: 14,
  HIDE_CHANNEL: 15,
  GET_CHANNEL_META: 16,
  GET_SWARM_STATUS: 17,

  // Video Prefetch (18)
  PREFETCH_VIDEO: 18,

  // Seeding (19-23)
  GET_SEEDING_STATUS: 19,
  SET_SEEDING_CONFIG: 20,
  PIN_CHANNEL: 21,
  UNPIN_CHANNEL: 22,
  GET_PINNED_CHANNELS: 23,

  // Video Stats (24)
  GET_VIDEO_STATS: 24,

  // Thumbnails/Metadata (25-27)
  GET_VIDEO_THUMBNAIL: 25,
  GET_VIDEO_METADATA: 26,
  SET_VIDEO_THUMBNAIL: 27,

  // Desktop-specific (50-59)
  GET_STATUS: 50,
  GET_IDENTITIES: 51,
  SET_ACTIVE_IDENTITY: 52,
  RECOVER_IDENTITY: 53,
  PICK_VIDEO_FILE: 54,
  GET_BLOB_SERVER_PORT: 55,
  GET_SUBSCRIPTIONS: 56,

  // Events from backend (100+)
  EVENT_READY: 100,
  EVENT_ERROR: 101,
  EVENT_UPLOAD_PROGRESS: 102,
  EVENT_FEED_UPDATE: 103,
  EVENT_LOG: 104,
  EVENT_VIDEO_STATS: 105,
} as const;

// Legacy alias for backwards compatibility
export const RPC = CMD;

/**
 * Hardcoded hyperswarm topic for public feed discovery
 * All peers join this topic to exchange channel listings
 */
export const PUBLIC_FEED_TOPIC = 'peartube-public-feed-v1';

/**
 * Protocol name for Protomux feed exchange
 */
export const FEED_PROTOCOL_NAME = 'peartube-feed';

// String-based RPC methods for pear-pipe (desktop)
// Maps method names to CMD IDs for the command-based approach
export const RPC_METHODS = {
  // Identity
  createIdentity: 'createIdentity',
  getIdentity: 'getIdentity',
  getIdentities: 'getIdentities',
  setActiveIdentity: 'setActiveIdentity',
  recoverIdentity: 'recoverIdentity',

  // Videos
  listVideos: 'listVideos',
  getVideoUrl: 'getVideoUrl',
  uploadVideo: 'uploadVideo',
  prefetchVideo: 'prefetchVideo',
  getVideoStats: 'getVideoStats',

  // Channel
  getChannel: 'getChannel',
  subscribeChannel: 'subscribeChannel',
  unsubscribeChannel: 'unsubscribeChannel',
  getSubscriptions: 'getSubscriptions',

  // Public Feed
  getPublicFeed: 'getPublicFeed',
  refreshFeed: 'refreshFeed',
  submitToFeed: 'submitToFeed',
  hideChannel: 'hideChannel',
  getChannelMeta: 'getChannelMeta',

  // Status
  getStatus: 'getStatus',
  getBlobServerPort: 'getBlobServerPort',

  // Desktop-specific
  pickVideoFile: 'pickVideoFile',
} as const;

// ============================================
// Design Tokens - Shared across all platforms
// ============================================

export const colors = {
  // Brand
  primary: '#9147ff',
  primaryHover: '#772ce8',
  primaryLight: 'rgba(145, 71, 255, 0.2)',

  // Accent
  accent: '#00f0b5',
  accentHover: '#00d9a4',

  // Status
  success: '#00c853',
  successLight: 'rgba(0, 200, 83, 0.2)',
  warning: '#ffb300',
  warningLight: 'rgba(255, 179, 0, 0.2)',
  error: '#ff5252',
  errorLight: 'rgba(255, 82, 82, 0.2)',

  // Backgrounds
  bg: '#0e0e10',
  bgElevated: '#18181b',
  bgSecondary: '#18181b', // Alias for bgElevated
  bgHover: '#1f1f23',
  bgActive: '#26262c',
  bgOverlay: 'rgba(0, 0, 0, 0.85)',
  bgCard: '#1f1f23',

  // Surfaces
  surface: '#1f1f23',
  surfaceHover: '#26262c',
  surfaceBorder: '#303035',

  // Text
  text: '#efeff1', // Alias for textPrimary
  textPrimary: '#efeff1',
  textSecondary: '#adadb8',
  textMuted: '#7a7a85',
  textDisabled: '#53535f',

  // Borders
  border: '#303035',
  borderLight: '#404045',
  borderFocus: '#9147ff',
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

// Alias for radius
export const radius = borderRadius;

export const fontWeight = {
  normal: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;

export const shadows = {
  sm: '0 1px 2px rgba(0, 0, 0, 0.3)',
  md: '0 4px 8px rgba(0, 0, 0, 0.4)',
  lg: '0 8px 16px rgba(0, 0, 0, 0.5)',
  xl: '0 16px 32px rgba(0, 0, 0, 0.6)',
} as const;

export const transitions = {
  fast: '0.1s ease',
  normal: '0.2s ease',
  slow: '0.3s ease',
} as const;

// Layout constants
export const layout = {
  sidebarWidth: 240,
  sidebarCollapsedWidth: 72,
  headerHeight: 56,
  maxContentWidth: 1800,
} as const;

// Z-index layers
export const zIndex = {
  base: 0,
  dropdown: 100,
  sticky: 200,
  modal: 300,
  tooltip: 400,
  toast: 500,
  overlay: 1000,
} as const;

// Bundled theme object
export const theme = {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  shadows,
  transitions,
  layout,
  zIndex,
} as const;

export type Theme = typeof theme;
