/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Haptics policy wrapper — safe to import from web/desktop code.
 *
 * Conventions:
 *  - tabSwitch(): switching tabs / segments
 *  - reaction(): toggling a reaction or like
 *  - success(): completing something meaningful (subscribe, publish, pair)
 *  - warning(): destructive confirmation prompts
 */
import { Platform } from 'react-native'

type HapticsModule = typeof import('expo-haptics')

let haptics: HapticsModule | null = null
if (Platform.OS !== 'web') {
  try {
    haptics = require('expo-haptics')
  } catch {
    haptics = null
  }
}

export function tabSwitch(): void {
  haptics?.selectionAsync().catch(() => {})
}

export function reaction(): void {
  haptics?.impactAsync(haptics.ImpactFeedbackStyle.Light).catch(() => {})
}

export function success(): void {
  haptics?.notificationAsync(haptics.NotificationFeedbackType.Success).catch(() => {})
}

export function warning(): void {
  haptics?.notificationAsync(haptics.NotificationFeedbackType.Warning).catch(() => {})
}
