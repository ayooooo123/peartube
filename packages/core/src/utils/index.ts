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
  // Brand — violet, the accent a media catalog is expected to wear
  primary: '#7b5bf5',
  primaryHover: '#9b7ff9',
  primaryLight: 'rgba(123, 91, 245, 0.18)',
  primaryDeep: '#5b3fd6',
  // Readable text/icon color on top of primary fills
  onPrimary: '#ffffff',

  // Network/peer presence — teal, used only for swarm/peer ambient UI
  swarm: '#2dd4bf',
  swarmGlow: 'rgba(45, 212, 191, 0.35)',
  swarmDim: 'rgba(45, 212, 191, 0.12)',

  // Accent
  accent: '#8b6df7',
  accentHover: '#a78bfa',

  // Status
  success: '#27a644',
  successLight: 'rgba(39, 166, 68, 0.18)',
  warning: '#d6a243',
  warningLight: 'rgba(214, 162, 67, 0.18)',
  error: '#ef6262',
  errorLight: 'rgba(239, 98, 98, 0.18)',
  red: '#ef6262',

  // Backgrounds — deep blue-violet near-blacks
  bg: '#0b0b12',
  bgElevated: '#14141e',
  bgSecondary: '#14141e', // Alias for bgElevated
  bgHover: '#1c1c2a',
  bgActive: '#252537',
  bgOverlay: 'rgba(0, 0, 0, 0.85)',
  bgCard: 'rgba(255,255,255,0.035)',

  // Surfaces
  surface: 'rgba(255,255,255,0.035)',
  surfaceHover: 'rgba(255,255,255,0.055)',
  surfaceBorder: 'rgba(255,255,255,0.08)',

  // Glass surfaces
  glass: 'rgba(255,255,255,0.05)',
  glassBorder: 'rgba(255,255,255,0.09)',
  glassHighlight: 'rgba(155, 127, 249, 0.07)',

  // Text
  text: '#f7f8f8', // Alias for textPrimary
  textPrimary: '#f7f8f8',
  textSecondary: '#d0d6e0',
  textMuted: '#8a8f98',
  textDisabled: '#62666d',

  // Borders
  border: 'rgba(255,255,255,0.08)',
  borderLight: 'rgba(255,255,255,0.12)',
  borderFocus: '#a78bfa',
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
