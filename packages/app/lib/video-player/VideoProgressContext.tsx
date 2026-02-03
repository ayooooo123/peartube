/**
 * VideoProgressContext - High-frequency playback progress state (~4Hz updates)
 *
 * Split from VideoPlayerContext to prevent unnecessary re-renders.
 * Components that only need progress info (like SeekBar) should use this context
 * instead of the main VideoPlayerContext.
 */

import { createContext, useContext, useState, useCallback, useRef, ReactNode, useMemo } from 'react'
import { Platform } from 'react-native'
import * as MediaSession from '../../modules/expo-media-session/src'

interface VideoProgressContextType {
  // Playback position - high frequency updates (~4fps)
  currentTime: number
  duration: number
  progress: number // 0-1 percentage

  // Refs for synchronous access (callbacks need immediate values)
  currentTimeRef: React.MutableRefObject<number>
  durationRef: React.MutableRefObject<number>

  // Setter for components that need to update time (SeekBar)
  setCurrentTime: (time: number) => void
  setDuration: (duration: number) => void

  // Called by VLCPlayer onProgress callback
  onProgress: (data: { currentTime: number; duration: number }) => void
}

const VideoProgressContext = createContext<VideoProgressContextType | null>(null)

export function useVideoProgressContext() {
  const ctx = useContext(VideoProgressContext)
  if (!ctx) throw new Error('useVideoProgressContext must be used within VideoProgressProvider')
  return ctx
}

// Optional hook that returns null outside provider (for conditional usage)
export function useVideoProgressContextOptional() {
  return useContext(VideoProgressContext)
}

interface VideoProgressProviderProps {
  children: ReactNode
  // External refs/callbacks from parent context
  isPlayingRef: React.MutableRefObject<boolean>
  playbackRateRef: React.MutableRefObject<number>
  mediaSessionActiveRef: React.MutableRefObject<boolean>
  setIsLoading: (loading: boolean) => void
}

// Throttled UI state update interval (ms) - ~4fps for seek bar updates
const UI_UPDATE_INTERVAL = 250

export function VideoProgressProvider({
  children,
  isPlayingRef,
  playbackRateRef,
  mediaSessionActiveRef,
  setIsLoading
}: VideoProgressProviderProps) {
  // State for UI updates (throttled)
  const [currentTime, setCurrentTimeState] = useState(0)
  const [duration, setDurationState] = useState(0)

  // Refs for synchronous access (immediate values for callbacks)
  const currentTimeRef = useRef(0)
  const durationRef = useRef(0)
  const lastUIUpdateRef = useRef(0)
  const lastMediaSessionUpdateRef = useRef(0)

  const setCurrentTime = useCallback((time: number) => {
    currentTimeRef.current = time
    setCurrentTimeState(time)
  }, [])

  const setDuration = useCallback((dur: number) => {
    durationRef.current = dur
    setDurationState(dur)
  }, [])

  const onProgress = useCallback((data: { currentTime: number; duration: number }) => {
    const timeS = data.currentTime / 1000
    const durationS = data.duration > 0 ? data.duration / 1000 : 0

    // Always update refs immediately (for synchronous access)
    currentTimeRef.current = timeS
    if (durationS > 0) {
      durationRef.current = durationS
    }

    // Clear loading overlay once we have real progress
    if (data.currentTime > 0) {
      setIsLoading(false)
    }

    // Throttle state updates for UI
    const now = Date.now()
    const shouldUpdateUI = now - lastUIUpdateRef.current >= UI_UPDATE_INTERVAL
    if (shouldUpdateUI) {
      lastUIUpdateRef.current = now
      setCurrentTimeState(timeS)
      if (durationS > 0) {
        setDurationState(durationS)
      }
    }

    // Update media session less frequently (every 1s)
    const shouldUpdateMediaSession = Platform.OS !== 'web' &&
      mediaSessionActiveRef.current &&
      now - lastMediaSessionUpdateRef.current > 1000
    if (shouldUpdateMediaSession) {
      lastMediaSessionUpdateRef.current = now
      MediaSession.setPlaybackState({
        isPlaying: isPlayingRef.current,
        position: timeS,
        duration: durationS,
        rate: playbackRateRef.current,
      }).catch(() => {})
    }
  }, [setIsLoading, isPlayingRef, playbackRateRef, mediaSessionActiveRef])

  const progress = useMemo(() =>
    duration > 0 ? currentTime / duration : 0,
    [currentTime, duration]
  )

  const contextValue = useMemo<VideoProgressContextType>(() => ({
    currentTime,
    duration,
    progress,
    currentTimeRef,
    durationRef,
    setCurrentTime,
    setDuration,
    onProgress,
  }), [currentTime, duration, progress, setCurrentTime, setDuration, onProgress])

  return (
    <VideoProgressContext.Provider value={contextValue}>
      {children}
    </VideoProgressContext.Provider>
  )
}
