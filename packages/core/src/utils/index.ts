/**
 * PearTube shared design tokens (colors, spacing, type, theme), used across
 * all platforms. (The legacy numeric bare-rpc CMD/RPC_METHODS registry that
 * used to live here was unused — superseded by the HRPC schema's
 * APP_RPC_METHODS in @peartube/spec — and has been removed.)
 */

// ============================================
// Design Tokens - Shared across all platforms
// ============================================

export const colors = {
  // Brand — client application accent blue, the primary call-to-action fill
  primary: '#3f66ff',
  primaryHover: '#6b88ff',
  primaryLight: 'rgba(63, 102, 255, 0.18)',
  primaryDeep: '#2f4fd6',
  // Readable text/icon color on top of primary fills
  onPrimary: '#ffffff',

  // Network/peer presence — teal, used only for swarm/peer ambient UI.
  // Deliberately outside the client application palette: it signals P2P state, not brand.
  swarm: '#2dd4bf',
  swarmGlow: 'rgba(45, 212, 191, 0.35)',
  swarmDim: 'rgba(45, 212, 191, 0.12)',

  // Accent — client application has a single accent pair; `accent` mirrors `primary`
  // so legacy call sites that used it for emphasis stay on-brand.
  accent: '#3f66ff',
  accentHover: '#6b88ff',
  accentSecondary: '#ff9f1a',
  accentSecondaryLight: 'rgba(255, 159, 26, 0.18)',

  // Status
  success: '#2ecc71',
  successLight: 'rgba(46, 204, 113, 0.18)',
  warning: '#f1c40f',
  warningLight: 'rgba(241, 196, 15, 0.15)',
  error: '#e74c3c',
  errorLight: 'rgba(231, 76, 60, 0.18)',
  red: '#e74c3c',

  // Backgrounds — client application's near-black base with two lift steps
  bg: '#0b0b0f',
  base: '#0b0b0f', // Alias for bg, matching client application's `background.base`
  bgElevated: '#16161f',
  bgSecondary: '#16161f', // Alias for bgElevated
  bgHover: '#1f1f2a',
  bgActive: '#2b2f3c',
  bgOverlay: 'rgba(11, 11, 15, 0.85)',
  // Cards sit on the surface step. Solid, not translucent white: client application
  // poster cards are opaque panels, so stacking this over art no longer bleeds.
  bgCard: '#16161f',
  contrast: '#000000',

  // Surfaces
  surface: '#16161f',
  surfaceHover: '#1f1f2a',
  surfaceElevated: '#1f1f2a',
  surfaceModal: '#1f1f2a',
  surfaceBorder: '#2b2f3c',

  // Glass surfaces — translucent white washes for blurred/overlaid chrome
  glass: 'rgba(255, 255, 255, 0.08)',
  glassBorder: 'rgba(255, 255, 255, 0.12)',
  glassHighlight: 'rgba(63, 102, 255, 0.12)',
  // Fill for secondary action buttons laid over artwork or blur
  overlayButton: 'rgba(255, 255, 255, 0.12)',
  overlayMedium: 'rgba(255, 255, 255, 0.08)',
  // Base-tinted scrim for backdrops and sheets
  scrim: 'rgba(11, 11, 15, 0.72)',

  // Text
  text: '#ffffff', // Alias for textPrimary
  textPrimary: '#ffffff',
  textSecondary: '#c7cad6',
  textMuted: '#8c90a6',
  textDisabled: '#555866',
  // Dark theme only, so "inverse" is still white; kept for API parity.
  textInverse: '#ffffff',

  // Borders
  border: '#2b2f3c',
  borderSubtle: '#2b2f3c', // Alias for border
  borderLight: '#4a4f5e',
  borderEmphasis: '#4a4f5e', // Alias for borderLight
  borderFocus: '#3f66ff',
} as const;

export const spacing = {
  none: 0,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 40,
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
  none: 0,
  xs: 2,
  sm: 4,
  md: 8,
  lg: 12,
  card: 12, // Poster/card radius, named so call sites read intent
  xl: 16,
  pill: 999,
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
