import { createTamagui, createTokens } from '@tamagui/core'
import { config as defaultConfig } from '@tamagui/config/v3'

// PearTube dark theme colors
const colors = {
  bg: '#0e0e10',
  bgSecondary: '#18181b',
  bgHover: '#26262c',
  primary: '#9147ff',
  primaryHover: '#772ce8',
  text: '#efeff1',
  textSecondary: '#adadb8',
  textMuted: '#848494',
  border: '#2f2f35',
  error: '#ff4444',
  success: '#00c853',
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
  interface TamaguiCustomConfig extends AppConfig {}
}

export { colors }
