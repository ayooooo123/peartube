/**
 * VideoControlContext - Medium-frequency playback control state
 *
 * Contains play/pause state, loading indicators, player mode, and playback rate.
 * These values change on user interactions (taps, swipes) not during playback.
 */

import { createContext, useContext, useState, useCallback, useRef, ReactNode, useMemo, useEffect } from 'react'
import { Platform, AppState, AppStateStatus } from 'react-native'
import * as MediaSession from '../../modules/expo-media-session/src'
import type { PlayerMode } from './types'

// Export for subscribers
export const playbackActiveEmitter = {
  isActive: false,
  set(active: boolean) { this.isActive = active },
}

interface VideoControlContextType {
  // Player control state
  isPlaying: boolean
  isLoading: boolean
  playerMode: PlayerMode
  playbackRate: number
  playbackSession: number

  // PiP state (Android)
  isInPipMode: boolean
  setIsInPipMode: (value: boolean) => void
  pipWindowSize: { width: number; height: number } | null
  setPipWindowSize: (value: { width: number; height: number } | null) => void
  shouldEnablePip: boolean

  // Video dimensions
  videoAspectRatio: number | null

  seekPosition: number | undefined

  playerRef: React.MutableRefObject<any>

  // Refs for synchronous access
  isPlayingRef: React.MutableRefObject<boolean>
  playbackRateRef: React.MutableRefObject<number>
  playerModeRef: React.MutableRefObject<PlayerMode>
  mediaSessionActiveRef: React.MutableRefObject<boolean>

  // Actions
  setIsPlaying: (playing: boolean) => void
  setIsLoading: (loading: boolean) => void
  setPlayerMode: (mode: PlayerMode) => void
  setPlaybackRate: (rate: number) => void
  setVideoAspectRatio: (ratio: number | null) => void
  setSeekPosition: (pos: number | undefined) => void
  incrementPlaybackSession: () => void

  onPlaying: () => void
  onPaused: () => void
  onBuffering: (data: { isBuffering: boolean }) => void
  onEnded: () => void
  onError: (error: any) => void
  onVideoStateChange: (data: { type?: string; mVideoWidth?: number; mVideoHeight?: number }) => void
}

const VideoControlContext = createContext<VideoControlContextType | null>(null)

export function useVideoControlContext() {
  const ctx = useContext(VideoControlContext)
  if (!ctx) throw new Error('useVideoControlContext must be used within VideoControlProvider')
  return ctx
}

// Optional hook for conditional usage
export function useVideoControlContextOptional() {
  return useContext(VideoControlContext)
}

interface VideoControlProviderProps {
  children: ReactNode
  // For coordinating with other contexts
  currentTimeRef: React.MutableRefObject<number>
  durationRef: React.MutableRefObject<number>
  hasVideo: boolean
  videoUrlRef: React.MutableRefObject<string | null>
}

export function VideoControlProvider({
  children,
  currentTimeRef,
  durationRef,
  hasVideo,
  videoUrlRef,
}: VideoControlProviderProps) {
  // Core playback state
  const [isPlaying, setIsPlayingState] = useState(false)
  const [isLoading, setIsLoadingState] = useState(false)
  const [playerMode, setPlayerModeState] = useState<PlayerMode>('hidden')
  const [playbackRate, setPlaybackRateState] = useState(1)
  const [playbackSession, setPlaybackSession] = useState(0)

  // PiP state
  const [isInPipMode, setIsInPipModeState] = useState(false)
  const [pipWindowSize, setPipWindowSizeState] = useState<{ width: number; height: number } | null>(null)
  const [videoAspectRatio, setVideoAspectRatioState] = useState<number | null>(null)

  const [seekPosition, setSeekPositionState] = useState<number | undefined>(undefined)

  const playerRef = useRef<any>(null)

  // Refs for synchronous access
  const isPlayingRef = useRef(false)
  const playbackRateRef = useRef(1)
  const playerModeRef = useRef<PlayerMode>('hidden')
  const mediaSessionActiveRef = useRef(false)
  const isInPipModeRef = useRef(false)
  const wasPlayingWhenBackgroundedRef = useRef(false)
  const wasPlayingWhenPipEnteredRef = useRef(false)
  const isBackgroundedRef = useRef(false)
  const playerModeBeforePipRef = useRef<PlayerMode>('fullscreen')
  const lastPipEventTimeRef = useRef(0)

  // Keep refs in sync with state
  useEffect(() => {
    isPlayingRef.current = isPlaying
    playbackActiveEmitter.set(hasVideo && (isPlaying || isInPipMode))
  }, [isPlaying, hasVideo, isInPipMode])
  useEffect(() => { playbackRateRef.current = playbackRate }, [playbackRate])
  useEffect(() => { playerModeRef.current = playerMode }, [playerMode])
  useEffect(() => { isInPipModeRef.current = isInPipMode }, [isInPipMode])

  // Setters with ref sync
  const setIsPlaying = useCallback((playing: boolean) => {
    isPlayingRef.current = playing
    setIsPlayingState(playing)
  }, [])

  const setIsLoading = useCallback((loading: boolean) => {
    setIsLoadingState(prev => prev === loading ? prev : loading)
  }, [])

  const setPlayerMode = useCallback((mode: PlayerMode) => {
    playerModeRef.current = mode
    setPlayerModeState(mode)
  }, [])

  const setPlaybackRate = useCallback((rate: number) => {
    playbackRateRef.current = rate
    setPlaybackRateState(rate)
  }, [])

  const setIsInPipMode = useCallback((value: boolean) => {
    isInPipModeRef.current = value
    setIsInPipModeState(value)
  }, [])

  const setPipWindowSize = useCallback((value: { width: number; height: number } | null) => {
    setPipWindowSizeState(value)
  }, [])

  const setVideoAspectRatio = useCallback((ratio: number | null) => {
    setVideoAspectRatioState(ratio)
  }, [])

  const setSeekPosition = useCallback((pos: number | undefined) => {
    setSeekPositionState(pos)
  }, [])

  const incrementPlaybackSession = useCallback(() => {
    setPlaybackSession(prev => prev + 1)
  }, [])

  // Media session management
  const setMediaSessionActive = useCallback((active: boolean) => {
    if (Platform.OS === 'web') return
    if (mediaSessionActiveRef.current === active) return
    mediaSessionActiveRef.current = active
    MediaSession.setActive(active).catch(() => {})
  }, [])

  useEffect(() => {
    if (Platform.OS === 'web') return
    setMediaSessionActive(hasVideo)
  }, [hasVideo, setMediaSessionActive])

  // AppState listener for background/foreground transitions
  useEffect(() => {
    if (Platform.OS === 'web') return

    const handleAppStateChange = async (nextState: AppStateStatus) => {
      const goingToBackground = nextState === 'background' || nextState === 'inactive'
      const comingToForeground = nextState === 'active'

      if (goingToBackground && !isBackgroundedRef.current) {
        isBackgroundedRef.current = true
        wasPlayingWhenBackgroundedRef.current = isPlayingRef.current
      } else if (comingToForeground && isBackgroundedRef.current) {
        isBackgroundedRef.current = false
        if (wasPlayingWhenBackgroundedRef.current && durationRef.current > 0) {
          const seekValue = currentTimeRef.current / durationRef.current
          setSeekPositionState(seekValue)
          setTimeout(() => setSeekPositionState(undefined), 100)
        }
      }
    }

    const subscription = AppState.addEventListener('change', handleAppStateChange)
    return () => subscription.remove()
  }, [currentTimeRef, durationRef])

  // Remote command listener
  useEffect(() => {
    if (Platform.OS === 'web') return

    const subscription = MediaSession.addRemoteCommandListener((event) => {
      const resumeFromRemote = () => {
        if (Platform.OS === 'ios' && durationRef.current > 0) {
          const seekValue = currentTimeRef.current / durationRef.current
          setSeekPositionState(seekValue)
          setTimeout(() => {
            setSeekPositionState(undefined)
            setIsPlaying(true)
          }, 100)
        } else {
          setIsPlaying(true)
        }
      }

      switch (event.command) {
        case 'play':
          try { playerRef.current?.resume?.(true) } catch {}
          resumeFromRemote()
          break
        case 'pause':
          try { playerRef.current?.resume?.(false) } catch {}
          setIsPlaying(false)
          break
        case 'stop':
          try { playerRef.current?.resume?.(false) } catch {}
          setIsPlaying(false)
          break
        case 'togglePlayPause':
          if (isPlayingRef.current) {
            try { playerRef.current?.resume?.(false) } catch {}
            setIsPlaying(false)
          } else {
            try { playerRef.current?.resume?.(true) } catch {}
            resumeFromRemote()
          }
          break
        case 'skipForward':
          if (durationRef.current > 0) {
            const newTime = Math.min(currentTimeRef.current + 10, durationRef.current)
            setSeekPositionState(newTime / durationRef.current)
            setTimeout(() => setSeekPositionState(undefined), 100)
          }
          break
        case 'skipBackward':
          if (durationRef.current > 0) {
            const newTime = Math.max(currentTimeRef.current - 10, 0)
            setSeekPositionState(newTime / durationRef.current)
            setTimeout(() => setSeekPositionState(undefined), 100)
          }
          break
        case 'seekTo':
          if (event.position !== undefined && durationRef.current > 0) {
            setSeekPositionState(event.position / durationRef.current)
            setTimeout(() => setSeekPositionState(undefined), 100)
          }
          break
      }
    })

    return () => subscription.remove()
  }, [setIsPlaying, currentTimeRef, durationRef])

  // Audio interruption listener (iOS)
  useEffect(() => {
    if (Platform.OS !== 'ios') return

    const subscription = MediaSession.addAudioInterruptionListener((event) => {
      if (event.type === 'began') {
        wasPlayingWhenBackgroundedRef.current = isPlayingRef.current
        setIsPlaying(false)
      } else if (event.type === 'ended' && event.shouldResume) {
        if (wasPlayingWhenBackgroundedRef.current) {
          setIsPlaying(true)
        }
      }
    })

    return () => subscription.remove()
  }, [setIsPlaying])

  // Route change listener (headphone unplug)
  useEffect(() => {
    if (Platform.OS === 'web') return

    const subscription = MediaSession.addAudioRouteChangeListener((event) => {
      if (event.reason === 'oldDeviceUnavailable') {
        setIsPlaying(false)
      }
    })

    return () => subscription.remove()
  }, [setIsPlaying])

  // PiP listener (Android)
  useEffect(() => {
    if (Platform.OS !== 'android') return

    const subscription = MediaSession.addPictureInPictureListener((event: any) => {
      const now = Date.now()
      const wasInPip = isInPipModeRef.current

      const sameState = event.isInPictureInPicture === wasInPip
      const sameDimensions = event.width === pipWindowSize?.width && event.height === pipWindowSize?.height
      const tooSoon = now - lastPipEventTimeRef.current < 100

      if (sameState && sameDimensions && tooSoon) return
      lastPipEventTimeRef.current = now

      isInPipModeRef.current = event.isInPictureInPicture
      setIsInPipModeState(event.isInPictureInPicture)

      if (event.isInPictureInPicture && event.width && event.height) {
        setPipWindowSizeState({ width: event.width, height: event.height })
      } else if (!event.isInPictureInPicture) {
        setPipWindowSizeState(null)
      }

      if (event.isInPictureInPicture) {
        playerModeBeforePipRef.current = playerModeRef.current
      }

      setTimeout(() => {
        if (event.isInPictureInPicture) {
          const wasPlaying = isPlayingRef.current || wasPlayingWhenBackgroundedRef.current
          wasPlayingWhenPipEnteredRef.current = wasPlaying
          if (wasPlaying) {
            setTimeout(() => setIsPlayingState(true), 150)
          }
        } else if (wasInPip) {
          setIsPlayingState(false)
          wasPlayingWhenPipEnteredRef.current = false
          const modeToRestore = playerModeBeforePipRef.current
          setPlayerModeState(modeToRestore)
        }
      })
    })

    return () => subscription.remove()
  }, [pipWindowSize])

  const onPlaying = useCallback(() => {
    setIsLoadingState(false)
    setIsPlayingState(true)
    if (Platform.OS !== 'web') {
      MediaSession.setPlaybackState({
        isPlaying: true,
        position: currentTimeRef.current,
        duration: durationRef.current,
        rate: playbackRateRef.current,
      }).catch(() => {})
    }
  }, [currentTimeRef, durationRef])

  const onPaused = useCallback(() => {
    setIsPlayingState(false)
    if (Platform.OS !== 'web') {
      MediaSession.setPlaybackState({
        isPlaying: false,
        position: currentTimeRef.current,
        duration: durationRef.current,
        rate: playbackRateRef.current,
      }).catch(() => {})
    }
  }, [currentTimeRef, durationRef])

  const onBuffering = useCallback((data: { isBuffering: boolean }) => {
    if (data?.isBuffering !== undefined) {
      setIsLoadingState(data.isBuffering)
    }
  }, [])

  const onEnded = useCallback(() => {
    setIsPlayingState(false)
    if (Platform.OS !== 'web') {
      MediaSession.setPlaybackState({
        isPlaying: false,
        position: durationRef.current,
        duration: durationRef.current,
        rate: playbackRateRef.current,
      }).catch(() => {})
    }
  }, [durationRef])

  const onError = useCallback((error: any) => {
    console.error('[VideoControlContext] Player error:', error, 'URL:', videoUrlRef.current)
    setIsLoadingState(false)
  }, [videoUrlRef])

  const onVideoStateChange = useCallback((data: { type?: string; mVideoWidth?: number; mVideoHeight?: number }) => {
    if (data.type === 'onNewVideoLayout' && data.mVideoWidth && data.mVideoHeight && data.mVideoWidth > 0 && data.mVideoHeight > 0) {
      const aspectRatio = data.mVideoWidth / data.mVideoHeight
      setVideoAspectRatioState(aspectRatio)
      if (Platform.OS === 'android') {
        MediaSession.setPictureInPictureAspectRatio(data.mVideoWidth, data.mVideoHeight).catch(() => {})
      }
    }
  }, [])

  const shouldEnablePip = useMemo(() => {
    if (Platform.OS !== 'android') return false
    if (!hasVideo) return false
    if (playerMode !== 'fullscreen') return false
    if (isInPipMode) return false
    return true
  }, [hasVideo, playerMode, isInPipMode])

  const contextValue = useMemo<VideoControlContextType>(() => ({
    isPlaying,
    isLoading,
    playerMode,
    playbackRate,
    playbackSession,
    isInPipMode,
    setIsInPipMode,
    pipWindowSize,
    setPipWindowSize,
    shouldEnablePip,
    videoAspectRatio,
    seekPosition,
    playerRef,
    isPlayingRef,
    playbackRateRef,
    playerModeRef,
    mediaSessionActiveRef,
    setIsPlaying,
    setIsLoading,
    setPlayerMode,
    setPlaybackRate,
    setVideoAspectRatio,
    setSeekPosition,
    incrementPlaybackSession,
    onPlaying,
    onPaused,
    onBuffering,
    onEnded,
    onError,
    onVideoStateChange,
  }), [
    isPlaying, isLoading, playerMode, playbackRate, playbackSession,
    isInPipMode, setIsInPipMode, pipWindowSize, setPipWindowSize,
    shouldEnablePip, videoAspectRatio, seekPosition,
    setIsPlaying, setIsLoading, setPlayerMode, setPlaybackRate,
    setVideoAspectRatio, setSeekPosition, incrementPlaybackSession,
    onPlaying, onPaused, onBuffering, onEnded, onError, onVideoStateChange,
  ])

  return (
    <VideoControlContext.Provider value={contextValue}>
      {children}
    </VideoControlContext.Provider>
  )
}
