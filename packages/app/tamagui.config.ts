import { createTamagui, createTokens } from '@tamagui/core'
import { config as defaultConfig } from '@tamagui/config/v3'

// PearTube dark theme colors
const colors = {
  bg: '#0a0c0a',
  bgSecondary: '#111411',
  bgHover: '#1a1e1a',
  primary: '#a3e635',
  primaryHover: '#bef264',
  text: '#f7f8f8',
  textSecondary: '#d0d6e0',
  textMuted: '#8a8f98',
  border: 'rgba(255,255,255,0.08)',
  error: '#ef6262',
  success: '#27a644',
}

const tokens = createTokens({
  ...defaultConfig.tokens,
  color: {
    ...defaultConfig.tokens.color,
    // Background colors
    background: colors.bg,
    backgroundSecondary: colors.bgSecondary,
    backgroundHover: colors.bgHover,
    // Primary colors
    primary: colors.primary,
    primaryHover: colors.primaryHover,
    // Text colors
    text: colors.text,
    textSecondary: colors.textSecondary,
    textMuted: colors.textMuted,
    // Utility
    border: colors.border,
    error: colors.error,
    success: colors.success,
  },
})

export const tamaguiConfig = createTamagui({
  ...defaultConfig,
  tokens,
  themes: {
    dark: {
      background: colors.bg,
      backgroundHover: colors.bgHover,
      backgroundPress: colors.bgSecondary,
      backgroundFocus: colors.bgSecondary,
      color: colors.text,
      colorHover: colors.text,
      colorPress: colors.textSecondary,
      colorFocus: colors.text,
      borderColor: colors.border,
      borderColorHover: colors.primary,
      placeholderColor: colors.textMuted,
      // Primary button
      blue1: colors.primary,
      blue2: colors.primaryHover,
    },
  },
  defaultTheme: 'dark',
})

export type AppConfig = typeof tamaguiConfig

declare module '@tamagui/core' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface TamaguiCustomConfig extends AppConfig {}
}

export { colors }
