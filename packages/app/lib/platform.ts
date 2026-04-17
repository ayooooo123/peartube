/**
 * Platform Detection and Layout Constants
 *
 * This module provides platform-aware layout values for:
 * - iOS (native): Uses safe area insets from react-native-safe-area-context
 * - Android (native): Uses safe area insets
 * - Pear Desktop (web): Fixed title bar height (28px on macOS, 38px on Windows)
 * - Regular Web: No insets needed
 *
 * Architecture:
 * - Platform detection happens once at module load
 * - Layout values are provided via React context (usePlatform hook)
 * - CSS variables are injected for styling
 */

import { Platform } from 'react-native'

// Platform types
export type PlatformType = 'ios' | 'android' | 'pear-macos' | 'pear-windows' | 'pear-linux' | 'web'

// Layout insets for different platforms
export interface LayoutInsets {
  top: number      // Space for status bar / title bar
  bottom: number   // Space for home indicator / bottom nav
  left: number     // Left safe area (notch devices)
  right: number    // Right safe area (notch devices)
}

// Pear title bar heights
const PEAR_TITLE_BAR_MACOS = 28
const PEAR_TITLE_BAR_WINDOWS = 38
const PEAR_TITLE_BAR_LINUX = 38

/**
 * Detect if running in Pear Runtime
 * Checks multiple indicators to reliably detect Pear desktop environment
 */
let _isPearCached: boolean | null = null

export function isPearRuntime(): boolean {
  if (_isPearCached === true) return true

  if (Platform.OS !== 'web') {
    _isPearCached = false
    return false
  }

  if (typeof window === 'undefined') {
    return false // Don't cache during SSR, re-check on client
  }

  // pear-runtime v2: the desktop shell (Electrobun) sets window.bridge
  // before the Expo bundle loads. This is the canonical desktop detection.
  const detected = !!(window as any).bridge
  if (detected) _isPearCached = true
  else if (_isPearCached === null) _isPearCached = false

  return detected
}

/**
 * Detect the current platform
 */
export function detectPlatform(): PlatformType {
  if (Platform.OS === 'ios') return 'ios'
  if (Platform.OS === 'android') return 'android'

  if (Platform.OS === 'web') {
    if (!isPearRuntime()) return 'web'

    // Detect OS within Pear
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent.toLowerCase() : ''
    if (ua.includes('mac')) return 'pear-macos'
    if (ua.includes('win')) return 'pear-windows'
    return 'pear-linux'
  }

  return 'web'
}

/**
 * Get layout insets for Pear desktop
 * These are fixed values since Pear injects the title bar via HTML
 */
export function getPearInsets(platform: PlatformType): LayoutInsets {
  switch (platform) {
    case 'pear-macos':
      return { top: PEAR_TITLE_BAR_MACOS, bottom: 0, left: 0, right: 0 }
    case 'pear-windows':
    case 'pear-linux':
      return { top: PEAR_TITLE_BAR_WINDOWS, bottom: 0, left: 0, right: 0 }
    default:
      return { top: 0, bottom: 0, left: 0, right: 0 }
  }
}

/**
 * Check if platform is desktop (Pear)
 */
export function isDesktop(platform: PlatformType): boolean {
  return platform.startsWith('pear-')
}

/**
 * Check if platform is mobile (iOS/Android)
 */
export function isMobile(platform: PlatformType): boolean {
  return platform === 'ios' || platform === 'android'
}

/**
 * Check if platform is native (iOS/Android, not web)
 */
export function isNative(): boolean {
  return Platform.OS !== 'web'
}

// Export singleton values for quick access
export const currentPlatform = detectPlatform()

// isPear is evaluated at module load, but isPearRuntime() is available
// for lazy evaluation in components (via usePlatform hook in PlatformProvider)
export const isPear = isPearRuntime()
