import React, { createContext, useContext, useEffect, useMemo, useState } from 'react'
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
  platform: PlatformType
  insets: LayoutInsets
  isDesktop: boolean
  isMobile: boolean
  isPear: boolean
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
  const [pearDetected, setPearDetected] = useState(() => isPearRuntime())

  useEffect(() => {
    if (pearDetected) return
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
    if (!pearDetected) {
      platform = 'web'
    } else {
      const ua = typeof navigator !== 'undefined' ? navigator.userAgent.toLowerCase() : ''
      if (ua.includes('mac')) platform = 'pear-macos'
      else if (ua.includes('win')) platform = 'pear-windows'
      else platform = 'pear-linux'
    }
    const isPear = pearDetected
    const isDesktop = checkIsDesktop(platform)
    const isMobile = checkIsMobile(platform)
    const isWeb = true

    let insets: LayoutInsets

    if (isDesktop) {
      insets = getPearInsets(platform)
    } else {
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
  }, [pearDetected])

  return (
    <PlatformContext.Provider value={value}>
      {children}
    </PlatformContext.Provider>
  )
}
