/**
 * Platform Context Provider
 *
 * Provides unified layout insets across all platforms:
 * - iOS/Android: Uses react-native-safe-area-context
 * - Pear Desktop: Uses fixed title bar values
 * - Web: No insets
 *
 * Usage:
 *   const { insets, platform, isDesktop } = usePlatform()
 */

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { Platform } from 'react-native'
import { useSafeAreaInsets, EdgeInsets } from 'react-native-safe-area-context'
import {
  PlatformType,
  LayoutInsets,
  detectPlatform,
  getPearInsets,
  isDesktop as checkIsDesktop,
  isMobile as checkIsMobile,
  isPearRuntime,
} from './platform'

interface PlatformContextValue {
  /** Current platform type */
  platform: PlatformType

  /** Layout insets (safe areas + title bar) */
  insets: LayoutInsets

  /** True if running on Pear Desktop */
  isDesktop: boolean

  /** True if running on iOS or Android */
  isMobile: boolean

  /** True if running in Pear Runtime */
  isPear: boolean

  /** True if running on web (including Pear) */
  isWeb: boolean
}

const PlatformContext = createContext<PlatformContextValue | null>(null)

export function usePlatform(): PlatformContextValue {
  const ctx = useContext(PlatformContext)
  if (!ctx) {
    throw new Error('usePlatform must be used within PlatformProvider')
  }
  return ctx
}

interface PlatformProviderProps {
  children: React.ReactNode
}

export function PlatformProvider({ children }: PlatformProviderProps) {
  // Get native safe area insets (returns zeros on web)
  const nativeInsets = useSafeAreaInsets()
  const [pearDetected, setPearDetected] = useState(() => isPearRuntime())

  useEffect(() => {
    if (pearDetected || Platform.OS !== 'web') return
    let cancelled = false
    let attempts = 0

    const check = () => {
      if (cancelled) return
      if (isPearRuntime()) {
        setPearDetected(true)
        return
      }
      attempts += 1
      if (attempts < 10) {
        setTimeout(check, 250)
      }
    }

    check()
    return () => {
      cancelled = true
    }
  }, [pearDetected])

  const value = useMemo<PlatformContextValue>(() => {
    let platform: PlatformType
    if (Platform.OS === 'ios') platform = 'ios'
    else if (Platform.OS === 'android') platform = 'android'
    else if (Platform.OS === 'web') {
      if (!pearDetected) platform = 'web'
      else {
        const ua = typeof navigator !== 'undefined' ? navigator.userAgent.toLowerCase() : ''
        if (ua.includes('mac')) platform = 'pear-macos'
        else if (ua.includes('win')) platform = 'pear-windows'
        else platform = 'pear-linux'
      }
    } else {
      platform = 'web'
    }
    const isPear = pearDetected
    const isDesktop = checkIsDesktop(platform)
    const isMobile = checkIsMobile(platform)
    const isWeb = Platform.OS === 'web'

    // Determine insets based on platform
    let insets: LayoutInsets

    if (isDesktop) {
      // Pear Desktop: Use fixed title bar height
      insets = getPearInsets(platform)
    } else if (isMobile) {
      // Native mobile: Use safe area insets
      insets = {
        top: nativeInsets.top,
        bottom: nativeInsets.bottom,
        left: nativeInsets.left,
        right: nativeInsets.right,
      }
    } else {
      // Regular web: No insets
      insets = { top: 0, bottom: 0, left: 0, right: 0 }
    }

    return {
      platform,
      insets,
      isDesktop,
      isMobile,
      isPear,
      isWeb,
    }
  }, [nativeInsets, pearDetected])

  return (
    <PlatformContext.Provider value={value}>
      {children}
    </PlatformContext.Provider>
  )
}
