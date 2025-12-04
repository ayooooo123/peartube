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
