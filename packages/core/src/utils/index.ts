/**
 * PearTube shared design tokens (colors, spacing, type, theme), used across
 * all platforms.
 *
 * "Grid" design language: OLED black base, lime accent, high-contrast
 * greys, hard 4px corners, 2px structural borders, monospace metadata.
 * Surfaces are always opaque — there is no glass, blur, or shadow lift.
 */

// ============================================
// Design Tokens - Shared across all platforms
// ============================================

export const colors = {
  // Brand — lime accent, the single call-to-action fill
  primary: '#d4ff3f',
  primaryHover: '#e2ff70',
  primaryLight: 'rgba(212, 255, 63, 0.14)',
  primaryDeep: '#a9d41c',
  // Readable text/icon color on top of primary fills
  onPrimary: '#000000',

  // Network/peer presence — electric cyan, used only for swarm/peer ambient UI.
  // Deliberately distinct from the accent: it signals P2P state, not a CTA.
  swarm: '#39d5ff',
  swarmGlow: 'rgba(57, 213, 255, 0.35)',
  swarmDim: 'rgba(57, 213, 255, 0.12)',

  // Accent mirrors primary; legacy call sites that used it for emphasis stay on-brand.
  accent: '#d4ff3f',
  accentHover: '#e2ff70',
  accentSecondary: '#39d5ff',
  accentSecondaryLight: 'rgba(57, 213, 255, 0.14)',

  // Status
  success: '#7dff8a',
  successLight: 'rgba(125, 255, 138, 0.14)',
  warning: '#ffc53f',
  warningLight: 'rgba(255, 197, 63, 0.14)',
  error: '#ff4d4d',
  errorLight: 'rgba(255, 77, 77, 0.14)',
  red: '#ff4d4d',

  // Backgrounds — true black base with two opaque lift steps
  bg: '#000000',
  base: '#000000', // Alias for bg
  bgElevated: '#0f0f0f',
  bgSecondary: '#0f0f0f', // Alias for bgElevated
  bgHover: '#1a1a1a',
  bgActive: '#262626',
  bgOverlay: 'rgba(0, 0, 0, 0.88)',
  // Cards are opaque panels one step above the base.
  bgCard: '#0f0f0f',
  contrast: '#000000',

  // Surfaces
  surface: '#0f0f0f',
  surfaceHover: '#1a1a1a',
  surfaceElevated: '#1a1a1a',
  surfaceModal: '#0f0f0f',
  surfaceBorder: '#262626',

  // Overlay chrome laid over artwork or video. Opaque black, never translucent white.
  glass: '#0f0f0f',
  glassBorder: '#262626',
  glassHighlight: '#d4ff3f',
  overlayButton: 'rgba(0, 0, 0, 0.72)',
  overlayMedium: 'rgba(0, 0, 0, 0.55)',
  // Base-tinted scrim for backdrops and sheets
  scrim: 'rgba(0, 0, 0, 0.8)',

  // Text
  text: '#f2f2f2', // Alias for textPrimary
  textPrimary: '#f2f2f2',
  textSecondary: '#a3a3a3',
  textMuted: '#6b6b6b',
  textDisabled: '#3d3d3d',
  // Dark theme only, so "inverse" is still light; kept for API parity.
  textInverse: '#f2f2f2',

  // Borders — structural 2px lines use `border`; emphasis/hover use `borderLight`
  border: '#262626',
  borderSubtle: '#1a1a1a',
  borderLight: '#3d3d3d',
  borderEmphasis: '#3d3d3d', // Alias for borderLight
  borderFocus: '#d4ff3f',
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

// Hard corners everywhere. `pill` is intentionally square: chips and
// buttons are rectangles in this language. `full` remains for avatars/dots.
export const borderRadius = {
  none: 0,
  xs: 0,
  sm: 2,
  md: 4,
  lg: 4,
  card: 4, // Poster/card radius, named so call sites read intent
  xl: 6,
  pill: 4,
  full: 9999,
} as const;

// Alias for radius
export const radius = borderRadius;

// Structural line weights
export const borderWidth = {
  hairline: 1,
  rule: 2,
} as const;

export const fontWeight = {
  normal: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;

// No elevation in this language. Kept as a typed surface so call sites that
// still read `shadows.*` resolve to a flat, shadowless value.
export const shadows = {
  sm: 'none',
  md: 'none',
  lg: 'none',
  xl: 'none',
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
  borderWidth,
  fontSize,
  fontWeight,
  shadows,
  transitions,
  layout,
  zIndex,
} as const;

export type Theme = typeof theme;
