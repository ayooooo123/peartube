/**
 * useLandscapeMode - Orientation management for fullscreen video
 *
 * Handles entering/exiting landscape fullscreen mode with proper
 * status bar and orientation lock management.
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { Platform, StatusBar } from 'react-native'
import * as ScreenOrientation from 'expo-screen-orientation'
import type { SharedValue } from 'react-native-reanimated'

interface UseLandscapeModeProps {
  isLandscapeFullscreenShared: SharedValue<boolean>
  showControlsTemporarily: () => void
  // Layout deps for exit gate stability check
  screenWidth: number
  screenHeight: number
  insetTop: number
  insetBottom: number
  reportedTabBarHeight: number
  reportedTabBarPadding: number
  isWindowLandscape: boolean
}

export function useLandscapeMode({
  isLandscapeFullscreenShared,
  showControlsTemporarily,
  screenWidth,
  screenHeight,
  insetTop,
  insetBottom,
  reportedTabBarHeight,
  reportedTabBarPadding,
  isWindowLandscape,
}: UseLandscapeModeProps) {
  const [isLandscapeFullscreen, setIsLandscapeFullscreen] = useState(false)
  const [pendingLandscapeExit, setPendingLandscapeExit] = useState(false)

  // Exit gate refs for stable layout detection
  const exitGateTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const exitGateLastSnapshotRef = useRef<string | null>(null)
  const exitGateStableCountRef = useRef(0)
  const exitGateAttemptsRef = useRef(0)

  // Toggle landscape fullscreen
  const toggleLandscapeFullscreen = useCallback(async () => {
    if (Platform.OS === 'web') return

    try {
      if (pendingLandscapeExit) return

      if (isLandscapeFullscreen) {
        // Exit fullscreen - return to portrait
        // Important: don't flip the React/Shared flags until the window has remeasured
        setPendingLandscapeExit(true)
        await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP)
      } else {
        // Enter fullscreen - force landscape
        StatusBar.setHidden(true)
        await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE)
        isLandscapeFullscreenShared.value = true
        setIsLandscapeFullscreen(true)
        setPendingLandscapeExit(false)
        showControlsTemporarily()
      }
    } catch (err) {
      console.error('[useLandscapeMode] Failed to change orientation:', err)
      // If the orientation lock failed, force state to a consistent "not landscape" config
      isLandscapeFullscreenShared.value = false
      setIsLandscapeFullscreen(false)
      setPendingLandscapeExit(false)
      StatusBar.setHidden(false)
    }
  }, [isLandscapeFullscreen, pendingLandscapeExit, showControlsTemporarily, isLandscapeFullscreenShared])

  // Exit gate effect - waits for stable layout before completing exit
  useEffect(() => {
    if (!pendingLandscapeExit) return
    if (isWindowLandscape) return

    // Ensure status bar is restored before we reveal portrait content
    StatusBar.setHidden(false)

    // Wait for a stable snapshot of layout inputs before clearing landscape flags
    if (exitGateTimeoutRef.current) clearTimeout(exitGateTimeoutRef.current)
    exitGateLastSnapshotRef.current = null
    exitGateStableCountRef.current = 0
    exitGateAttemptsRef.current = 0

    const tick = () => {
      exitGateAttemptsRef.current += 1

      const snapshot = JSON.stringify({
        screenWidth,
        screenHeight,
        insetTop,
        insetBottom,
        tabBarHeight: reportedTabBarHeight,
        tabBarPadding: reportedTabBarPadding,
      })

      if (exitGateLastSnapshotRef.current === snapshot) {
        exitGateStableCountRef.current += 1
      } else {
        exitGateLastSnapshotRef.current = snapshot
        exitGateStableCountRef.current = 0
      }

      // Require 2 consecutive stable ticks, but also cap total wait to ~400ms
      if (exitGateStableCountRef.current >= 2 || exitGateAttemptsRef.current >= 8) {
        isLandscapeFullscreenShared.value = false
        setIsLandscapeFullscreen(false)
        setPendingLandscapeExit(false)
        exitGateTimeoutRef.current = null
        return
      }

      exitGateTimeoutRef.current = setTimeout(tick, 50)
    }

    // Kick off on next tick
    exitGateTimeoutRef.current = setTimeout(tick, 0)

    return () => {
      if (exitGateTimeoutRef.current) {
        clearTimeout(exitGateTimeoutRef.current)
        exitGateTimeoutRef.current = null
      }
    }
  }, [
    pendingLandscapeExit,
    isWindowLandscape,
    screenWidth,
    screenHeight,
    insetTop,
    insetBottom,
    reportedTabBarHeight,
    reportedTabBarPadding,
    isLandscapeFullscreenShared,
  ])

  // Clean up orientation on unmount
  useEffect(() => {
    return () => {
      if (isLandscapeFullscreenShared.value) {
        // Return to portrait when video player unmounts
        ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP)
        StatusBar.setHidden(false)
      }
    }
  }, [isLandscapeFullscreenShared])

  // Exit landscape when player mode changes to mini or hidden
  const exitOnModeChange = useCallback((playerMode: string) => {
    if ((playerMode === 'mini' || playerMode === 'hidden') && isLandscapeFullscreen) {
      if (!pendingLandscapeExit) {
        setPendingLandscapeExit(true)
        ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch((err) => {
          console.error('[useLandscapeMode] Failed to lock portrait on mode change:', err)
          isLandscapeFullscreenShared.value = false
          setIsLandscapeFullscreen(false)
          setPendingLandscapeExit(false)
          StatusBar.setHidden(false)
        })
      }
    }
  }, [isLandscapeFullscreen, pendingLandscapeExit, isLandscapeFullscreenShared])

  return {
    isLandscapeFullscreen,
    pendingLandscapeExit,
    toggleLandscapeFullscreen,
    exitOnModeChange,
  }
}
