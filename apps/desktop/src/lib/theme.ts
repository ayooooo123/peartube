/**
 * PearTube Design System - Theme Tokens
 * Consistent design tokens for the entire application
 */

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
  bgHover: '#1f1f23',
  bgActive: '#26262c',
  bgOverlay: 'rgba(0, 0, 0, 0.85)',

  // Surfaces
  surface: '#1f1f23',
  surfaceHover: '#26262c',
  surfaceBorder: '#303035',

  // Text
  textPrimary: '#efeff1',
  textSecondary: '#adadb8',
  textMuted: '#7a7a85',
  textDisabled: '#53535f',

  // Borders
  border: '#303035',
  borderLight: '#404045',
  borderFocus: '#9147ff',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
};

export const radius = {
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
  full: 9999,
};

export const fontSize = {
  xs: 11,
  sm: 12,
  md: 14,
  lg: 16,
  xl: 18,
  xxl: 24,
  xxxl: 32,
};

export const fontWeight = {
  normal: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
};

export const shadows = {
  sm: '0 1px 2px rgba(0, 0, 0, 0.3)',
  md: '0 4px 8px rgba(0, 0, 0, 0.4)',
  lg: '0 8px 16px rgba(0, 0, 0, 0.5)',
  xl: '0 16px 32px rgba(0, 0, 0, 0.6)',
};

export const transitions = {
  fast: '0.1s ease',
  normal: '0.2s ease',
  slow: '0.3s ease',
};

// Layout constants
export const layout = {
  sidebarWidth: 240,
  sidebarCollapsedWidth: 72,
  headerHeight: 56,
  maxContentWidth: 1800,
};

// Z-index layers
export const zIndex = {
  dropdown: 100,
  sticky: 200,
  modal: 300,
  tooltip: 400,
  toast: 500,
};

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
};

export type Theme = typeof theme;
