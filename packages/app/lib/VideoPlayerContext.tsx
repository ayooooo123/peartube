import { createContext, useContext, useState, useCallback, useRef, useEffect, useMemo, ReactNode } from 'react'
import { Platform, AppState, AppStateStatus } from 'react-native'
import type { VideoData, VideoStats } from '@peartube/core'
import * as MediaSession from '../modules/expo-media-session/src'

// Re-export types for backwards compatibility
export type { VideoData, VideoStats } from '@peartube/core'

// Simple event emitter for video stats (allows RPC handler to push stats to context)
type VideoStatsListener = (driveKey: string, videoPath: string, stats: VideoStats) => void
const statsListeners = new Set<VideoStatsListener>()

export const videoStatsEventEmitter = {
  emit: (driveKey: string, videoPath: string, stats: VideoStats) => {
    console.log('[VideoStatsEmitter] Emitting stats for', videoPath?.slice(0, 30))
    statsListeners.forEach(listener => listener(driveKey, videoPath, stats))
  },
  subscribe: (listener: VideoStatsListener) => {
    statsListeners.add(listener)
    return () => statsListeners.delete(listener)
  }
}

// Event emitter for video load events (triggers prefetch in _layout.tsx)
type VideoLoadListener = (video: VideoData) => void
const loadListeners = new Set<VideoLoadListener>()

export const videoLoadEventEmitter = {
  emit: (video: VideoData) => {
    console.log('[VideoLoadEmitter] Video loaded:', video.title)
    loadListeners.forEach(listener => listener(video))
  },
  subscribe: (listener: VideoLoadListener) => {
    loadListeners.add(listener)
    return () => loadListeners.delete(listener)
  }
}

// Playback active state emitter - used by _layout.tsx to decide whether to suspend network
let isPlaybackActive = false
export const playbackActiveEmitter = {
  get isActive() { return isPlaybackActive },
  set(active: boolean) { isPlaybackActive = active },
}

// Player mode
export type PlayerMode = 'hidden' | 'mini' | 'fullscreen'

interface VideoPlayerContextType {
  // Current video
  currentVideo: VideoData | null
  videoUrl: string | null

  // Player state
  isPlaying: boolean
  isLoading: boolean
  playerMode: PlayerMode
  videoStats: VideoStats | null
  playbackSession: number
  isInPipMode: boolean
  setIsInPipMode: (value: boolean) => void
  pipWindowSize: { width: number; height: number } | null
  setPipWindowSize: (value: { width: number; height: number } | null) => void
  
  // Unified PiP gating - single source of truth for whether PiP should be enabled
  shouldEnablePip: boolean

  // Video dimensions (from VLC onNewVideoLayout)
  videoAspectRatio: number | null

  // Playback position
  currentTime: number
  duration: number
  progress: number // 0-1 percentage

  // Playback speed
  playbackRate: number

  // VLC seek position (0-1) - passed as prop to VLCPlayer
  vlcSeekPosition: number | undefined

  // VLC player ref - set by VideoPlayerOverlay
  playerRef: React.MutableRefObject<any>

  // Actions
  loadAndPlayVideo: (video: VideoData, url: string) => void
  pauseVideo: () => void
  resumeVideo: () => void
  closeVideo: () => void
  minimizePlayer: () => void
  maximizePlayer: () => void
  seekTo: (time: number) => void
  seekBy: (delta: number) => void
  setPlaybackRate: (rate: number) => void
  setVideoStats: (stats: VideoStats | null) => void
  setIsLoading: (loading: boolean) => void

  // Called by VLCPlayer callbacks
  onProgress: (data: { currentTime: number; duration: number }) => void
  onPlaying: () => void
  onPaused: () => void
  onBuffering: (data: { isBuffering: boolean }) => void
  onEnded: () => void
  onError: (error: any) => void
  onVideoStateChange: (data: { type?: string; mVideoWidth?: number; mVideoHeight?: number }) => void
}

const VideoPlayerContext = createContext<VideoPlayerContextType | null>(null)

export function useVideoPlayerContext() {
  const ctx = useContext(VideoPlayerContext)
  if (!ctx) throw new Error('useVideoPlayerContext must be used within VideoPlayerProvider')
  return ctx
}

interface VideoPlayerProviderProps {
  children: ReactNode
}

export function VideoPlayerProvider({ children }: VideoPlayerProviderProps) {
  // Video state
  const [currentVideo, setCurrentVideo] = useState<VideoData | null>(null)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [playerMode, setPlayerMode] = useState<PlayerMode>('hidden')
  const [videoStats, setVideoStats] = useState<VideoStats | null>(null)
  const [playbackSession, setPlaybackSession] = useState(0)
  const [isInPipMode, setIsInPipMode] = useState(false)
  const [pipWindowSize, setPipWindowSize] = useState<{ width: number; height: number } | null>(null)
  const [videoAspectRatio, setVideoAspectRatio] = useState<number | null>(null)

  // Playback position state
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)

  // Playback speed state
  const [playbackRate, setPlaybackRateState] = useState(1)

  // VLC seek position (0-1) - used as a prop, not a ref method
  // Use undefined when not seeking so the prop isn't passed to VLC
  const [seekPosition, setSeekPosition] = useState<number | undefined>(undefined)

  // VLC player ref - will be set by VideoPlayerOverlay
  const playerRef = useRef<any>(null)

  // Ref for current video - updated synchronously to avoid race conditions with stats events
  const currentVideoRef = useRef<VideoData | null>(null)

  // Background playback tracking refs
  const wasPlayingWhenBackgroundedRef = useRef(false)
  const isBackgroundedRef = useRef(false)
  const isInPipModeRef = useRef(false)
  const wasPlayingWhenPipEnteredRef = useRef(false)
  const playerModeBeforePipRef = useRef<PlayerMode>('fullscreen')
  const lastPipEventTimeRef = useRef(0)
  const pipStateUpdateRafRef = useRef<number | null>(null)
  const currentTimeRef = useRef(0)
  const durationRef = useRef(0)
  const isPlayingRef = useRef(false)
  const playbackRateRef = useRef(1)
  
  // Throttled UI state update interval (ms) - ~4fps for seek bar updates
  const UI_UPDATE_INTERVAL = 250
  const lastUIUpdateRef = useRef(0)

  // Refs are now the source of truth for high-frequency values
  // State is only updated at throttled intervals for UI components
  useEffect(() => {
    isPlayingRef.current = isPlaying
    playbackActiveEmitter.set(currentVideo !== null && (isPlaying || isInPipMode))
  }, [isPlaying, currentVideo, isInPipMode])
  useEffect(() => { playbackRateRef.current = playbackRate }, [playbackRate])

  const mediaSessionActiveRef = useRef(false)
  const setMediaSessionActive = useCallback((active: boolean) => {
    if (Platform.OS === 'web') return
    if (mediaSessionActiveRef.current === active) return
    mediaSessionActiveRef.current = active
    if (active) {
      console.log('[VideoPlayerContext] Activating media session')
    } else {
      console.log('[VideoPlayerContext] Deactivating media session')
    }
    MediaSession.setActive(active).catch((e) => {
      console.warn('[VideoPlayerContext] Failed to set media session active:', e)
    })
  }, [])

  // Activate media session while a video is loaded (keeps lock screen controls visible)
  useEffect(() => {
    if (Platform.OS === 'web') return
    const shouldBeActive = currentVideo !== null
    setMediaSessionActive(shouldBeActive)
  }, [currentVideo, setMediaSessionActive])

  // Keep Now Playing metadata up to date for lock screen/notification
  useEffect(() => {
    if (Platform.OS === 'web') return
    if (!currentVideo) return
    MediaSession.setNowPlaying({
      title: currentVideo.title || 'Video',
      artist: currentVideo.channel?.name || 'PearTube',
      duration,
      artworkUrl: currentVideo.thumbnailUrl ?? undefined,
    }).catch(() => {})
  }, [currentVideo?.id, currentVideo?.title, currentVideo?.thumbnailUrl, currentVideo?.channel?.name, duration])

  // Ensure playback state reflects play/pause changes even if VLC events lag
  useEffect(() => {
    if (Platform.OS === 'web') return
    if (!mediaSessionActiveRef.current) return
    MediaSession.setPlaybackState({
      isPlaying,
      position: currentTimeRef.current,
      duration: durationRef.current,
      rate: playbackRateRef.current,
    }).catch(() => {})
  }, [isPlaying])

  // AppState listener for background/foreground transitions (mobile only)
  useEffect(() => {
    if (Platform.OS === 'web') return

    const handleAppStateChange = async (nextState: AppStateStatus) => {
      const goingToBackground = nextState === 'background' || nextState === 'inactive'
      const comingToForeground = nextState === 'active'

      if (goingToBackground && !isBackgroundedRef.current) {
        isBackgroundedRef.current = true
        wasPlayingWhenBackgroundedRef.current = isPlayingRef.current
        console.log('[VideoPlayerContext] Going to background, wasPlaying:', isPlayingRef.current)
      } else if (comingToForeground && isBackgroundedRef.current) {
        isBackgroundedRef.current = false
        console.log('[VideoPlayerContext] Coming to foreground, wasPlaying:', wasPlayingWhenBackgroundedRef.current)

        if (wasPlayingWhenBackgroundedRef.current && durationRef.current > 0) {
          const seekValue = currentTimeRef.current / durationRef.current
          setSeekPosition(seekValue)
          setTimeout(() => setSeekPosition(undefined), 100)
        }
      }
    }

    const subscription = AppState.addEventListener('change', handleAppStateChange)
    return () => subscription.remove()
  }, [])

  // MediaSession remote command listener (mobile only)
  useEffect(() => {
    if (Platform.OS === 'web') return

    const subscription = MediaSession.addRemoteCommandListener((event) => {
      console.log('[VideoPlayerContext] Remote command received:', event.command)
      const resumeFromRemote = () => {
        if (Platform.OS === 'ios' && durationRef.current > 0) {
          const seekValue = currentTimeRef.current / durationRef.current
          setSeekPosition(seekValue)
          setTimeout(() => {
            setSeekPosition(undefined)
            setIsPlaying(true)
          }, 100)
        } else {
          setIsPlaying(true)
        }
      }
      switch (event.command) {
        case 'play':
          console.log('[VideoPlayerContext] Setting isPlaying = true')
          try { playerRef.current?.resume?.(true) } catch {}
          resumeFromRemote()
          break
        case 'pause':
          console.log('[VideoPlayerContext] Setting isPlaying = false')
          try { playerRef.current?.resume?.(false) } catch {}
          setIsPlaying(false)
          break
        case 'stop':
          console.log('[VideoPlayerContext] Stopping playback')
          try { playerRef.current?.resume?.(false) } catch {}
          setIsPlaying(false)
          break
        case 'togglePlayPause':
          console.log('[VideoPlayerContext] Toggling play/pause')
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
            setSeekPosition(newTime / durationRef.current)
            setCurrentTime(newTime)
            setTimeout(() => setSeekPosition(undefined), 100)
          }
          break
        case 'skipBackward':
          if (durationRef.current > 0) {
            const newTime = Math.max(currentTimeRef.current - 10, 0)
            setSeekPosition(newTime / durationRef.current)
            setCurrentTime(newTime)
            setTimeout(() => setSeekPosition(undefined), 100)
          }
          break
        case 'seekTo':
          if (event.position !== undefined && durationRef.current > 0) {
            setSeekPosition(event.position / durationRef.current)
            setCurrentTime(event.position)
            setTimeout(() => setSeekPosition(undefined), 100)
          }
          break
      }
    })

    return () => subscription.remove()
  }, [])

  // Audio interruption listener (iOS only) - Android relies on remote commands from AudioFocus
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
  }, [])

  // Route change listener (headphone unplug) - mobile only
  useEffect(() => {
    if (Platform.OS === 'web') return

    const subscription = MediaSession.addAudioRouteChangeListener((event: MediaSession.AudioRouteChangeEvent) => {
      if (event.reason === 'oldDeviceUnavailable') {
        setIsPlaying(false)
      }
    })

    return () => subscription.remove()
  }, [])

  useEffect(() => {
    if (Platform.OS !== 'android') return

    const subscription = MediaSession.addPictureInPictureListener((event: MediaSession.PictureInPictureEvent & {
      currentTimeMs?: number
      durationMs?: number
      isPlaying?: boolean
    }) => {
      const now = Date.now()
      const wasInPip = isInPipModeRef.current

      console.log('[VideoPlayerContext] PiP event raw:', event.isInPictureInPicture, 'wasInPip:', wasInPip, 'width:', event.width, 'height:', event.height)

      // Only debounce if BOTH boolean AND dimensions are identical
      // This ensures dimension changes are always processed, even if boolean is the same
      const sameState = event.isInPictureInPicture === wasInPip
      const sameDimensions = event.width === pipWindowSize?.width && event.height === pipWindowSize?.height
      const tooSoon = now - lastPipEventTimeRef.current < 100

      if (sameState && sameDimensions && tooSoon) {
        console.log('[VideoPlayerContext] PiP event debounced (identical state+dimensions)')
        return
      }
      lastPipEventTimeRef.current = now

      // Update ref immediately to prevent race conditions
      isInPipModeRef.current = event.isInPictureInPicture

      // Update state immediately - RAF doesn't fire in PiP/background mode
      setIsInPipMode(event.isInPictureInPicture)
      if (event.isInPictureInPicture && event.width && event.height) {
        setPipWindowSize({ width: event.width, height: event.height })
      } else if (!event.isInPictureInPicture) {
        setPipWindowSize(null)
      }

      console.log('[VideoPlayerContext] PiP mode changed:', event.isInPictureInPicture, 'wasPlaying:', wasPlayingWhenBackgroundedRef.current)

      // Use setTimeout instead of RAF - RAF doesn't fire in PiP/background mode
      setTimeout(() => {

        if (event.isInPictureInPicture) {
          const wasPlaying = isPlayingRef.current || wasPlayingWhenBackgroundedRef.current
          wasPlayingWhenPipEnteredRef.current = wasPlaying
          // Save the current playerMode to restore on PiP exit
          playerModeBeforePipRef.current = playerMode
          console.log('[VideoPlayerContext] Entering PiP, wasPlaying:', wasPlaying, 'playerMode:', playerMode)
          if (wasPlaying) {
            setTimeout(() => {
              console.log('[VideoPlayerContext] Resuming playback in PiP')
              setIsPlaying(true)
            }, 150)
          }
        } else if (wasInPip) {
          // Restore the playerMode that was active before PiP entry
          const modeToRestore = playerModeBeforePipRef.current
          console.log('[VideoPlayerContext] Exiting PiP, restoring playerMode:', modeToRestore)

          // Single-player architecture: same player continues, position is already synced
          setPlayerMode(modeToRestore)

          // Resume playback if was playing when entering PiP
          const shouldPlay = wasPlayingWhenPipEnteredRef.current
          if (shouldPlay) {
            setTimeout(() => {
              console.log('[VideoPlayerContext] Resuming playback after PiP exit')
              setIsPlaying(true)
            }, 100)
          }
        }
      })
    })

    return () => {
      subscription.remove()
    }
  }, [])

  // Subscribe to video stats events from backend
  useEffect(() => {
    const unsubscribe = videoStatsEventEmitter.subscribe((driveKey, videoPath, stats) => {
      // Use ref for synchronous access (state may not be updated yet)
      const video = currentVideoRef.current
      console.log('[VideoPlayerContext] Stats event received, checking match:', {
        videoPath,
        driveKey,
        currentPath: video?.path,
        currentKey: video?.channelKey
      })
      // Only update if this is for the current video.
      // Some layers identify a video by full drive path (`/videos/<id>.<ext>`) while others may use an id.
      // Normalize both before comparison so mobile/desktop stay consistent.
      const extractVideoId = (idOrPath?: string | null) => {
        if (!idOrPath) return null
        const cleaned = idOrPath.split('?')[0]?.split('#')[0] || idOrPath
        // Path case: /videos/<id>.<ext> or videos/<id>.<ext>
        const m = cleaned.match(/(?:^|\/)videos\/([^.\/]+)(?:\.[^\/]+)?$/)
        if (m?.[1]) return m[1]
        // Fallback: take basename then strip extension if present (e.g. abc.mp4)
        const base = cleaned.split('/').pop() || cleaned
        return base.replace(/\.[^./]+$/, '')
      }

      const currentKey = (video as any)?.channelKey || (video as any)?.driveKey || null
      const currentId = extractVideoId((video as any)?.id) ?? extractVideoId(video?.path)
      const incomingId = extractVideoId(videoPath)

      const sameVideo =
        Boolean(video) &&
        (currentKey ? currentKey === driveKey : true) &&
        (
          // Exact path match
          video?.path === videoPath ||
          // Id-based match
          (currentId && incomingId && currentId === incomingId)
        )

      if (sameVideo) {
        console.log('[VideoPlayerContext] Received stats event:', stats.progress + '%')
        setVideoStats(stats)
        // Drop the "connecting" overlay once stats show real activity.
        setIsLoading((prev) => {
          if (!prev) return prev
          if (!stats) return prev
          if (stats.isComplete) return false
          if (typeof stats.progress === 'number' && stats.progress > 0) return false
          if (stats.status && stats.status !== 'connecting' && stats.status !== 'resolving') return false
          return prev
        })
      }
    })
    return () => { unsubscribe() }
  }, [])

  // Load and play a new video (triggers overlay to fullscreen)
  const loadAndPlayVideo = useCallback((video: VideoData, url: string) => {
    console.log('[VideoPlayerContext] Loading video:', video.title, 'URL:', url)
    // Stop any existing playback before swapping sources to avoid overlap.
    try {
      playerRef.current?.stop?.()
      playerRef.current?.pause?.()
    } catch {}
    setPlaybackSession((prev) => prev + 1)
    // Update ref synchronously FIRST (before emitting event)
    currentVideoRef.current = video
    setCurrentVideo(video)
    setVideoUrl(url)
    setIsPlaying(true)
    setPlayerMode('fullscreen')
    setVideoStats(null)
    setIsLoading(true)
    setCurrentTime(0)
    setDuration(0)
    setVideoAspectRatio(null)
    // Emit load event so _layout.tsx can trigger prefetch
    videoLoadEventEmitter.emit(video)
  }, [])

  // Pause video
  const pauseVideo = useCallback(() => {
    console.log('[VideoPlayerContext] Pausing video')
    if (Platform.OS === 'web') {
      try {
        playerRef.current?.pause?.()
      } catch {}
    }
    setIsPlaying(false)
  }, [])

  const resumeVideo = useCallback(() => {
    console.log('[VideoPlayerContext] Resuming video')

    // On iOS, do a seek while still paused to reinitialize audio, then resume
    // This avoids visible jitter since video isn't playing during the seek
    if (Platform.OS === 'ios' && durationRef.current > 0) {
      const seekValue = currentTimeRef.current / durationRef.current
      setSeekPosition(seekValue)

      setTimeout(() => {
        setSeekPosition(undefined)
        setIsPlaying(true)
      }, 100)
    } else {
      setIsPlaying(true)
      if (Platform.OS === 'web') {
        try {
          playerRef.current?.play?.()
        } catch {}
      }
    }
  }, [])

  const closeVideo = useCallback(() => {
    console.log('[VideoPlayerContext] Closing video')
    try {
      playerRef.current?.stop?.()
      playerRef.current?.pause?.()
    } catch {}
    currentVideoRef.current = null
    setCurrentVideo(null)
    setVideoUrl(null)
    setIsPlaying(false)
    setPlayerMode('hidden')
    setVideoStats(null)
    setCurrentTime(0)
    setDuration(0)
    if (Platform.OS !== 'web') {
      MediaSession.clearNowPlaying().catch(() => {})
      setMediaSessionActive(false)
    }
    mediaSessionActiveRef.current = false
  }, [setMediaSessionActive])

  const minimizePlayer = useCallback(() => {
    console.log('[VideoPlayerContext] Minimizing to in-app mini player')
    setPlayerMode('mini')
  }, [])

  // Maximize from mini player
  const maximizePlayer = useCallback(() => {
    console.log('[VideoPlayerContext] Maximizing player')
    setPlayerMode('fullscreen')
  }, [])

  const seekTo = useCallback((time: number) => {
    const dur = durationRef.current
    if (dur <= 0) return
    const clampedTime = Math.max(0, Math.min(time, dur))
    if (Platform.OS === 'web') {
      try {
        playerRef.current?.seek?.(clampedTime)
      } catch {}
      currentTimeRef.current = clampedTime
      setCurrentTime(clampedTime)
      return
    }
    const seekValue = clampedTime / dur
    console.log('[VideoPlayerContext] Seeking to:', clampedTime, 'seconds, seek prop:', seekValue)
    setSeekPosition(seekValue)
    currentTimeRef.current = clampedTime
    setCurrentTime(clampedTime)
    setTimeout(() => setSeekPosition(undefined), 100)
  }, [])

  const seekBy = useCallback((delta: number) => {
    const dur = durationRef.current
    if (dur <= 0) return
    const newTime = Math.max(0, Math.min(currentTimeRef.current + delta, dur))
    if (Platform.OS === 'web') {
      try {
        playerRef.current?.seek?.(newTime)
      } catch {}
      currentTimeRef.current = newTime
      setCurrentTime(newTime)
      return
    }
    const seekValue = newTime / dur
    console.log('[VideoPlayerContext] Seeking by:', delta, 'to:', newTime, 'seek prop:', seekValue)
    setSeekPosition(seekValue)
    currentTimeRef.current = newTime
    setCurrentTime(newTime)
    setTimeout(() => setSeekPosition(undefined), 100)
  }, [])

  // Set playback speed
  const setPlaybackRate = useCallback((rate: number) => {
    console.log('[VideoPlayerContext] Setting playback rate:', rate)
    setPlaybackRateState(rate)
    // VLC handles this via the rate prop
  }, [])

  const lastMediaSessionUpdateRef = useRef(0)
  const onProgress = useCallback((data: { currentTime: number; duration: number }) => {
    const timeS = data.currentTime / 1000
    const durationS = data.duration > 0 ? data.duration / 1000 : 0
    
    currentTimeRef.current = timeS
    if (durationS > 0) {
      durationRef.current = durationS
    }
    
    if (data.currentTime > 0) {
      setIsLoading((prev) => (prev ? false : prev))
    }
    
    const now = Date.now()
    const shouldUpdateUI = now - lastUIUpdateRef.current >= UI_UPDATE_INTERVAL
    if (shouldUpdateUI) {
      lastUIUpdateRef.current = now
      setCurrentTime(timeS)
      if (durationS > 0) {
        setDuration(durationS)
      }
    }
    
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
  }, [])

  const onPlaying = useCallback(() => {
    console.log('[VideoPlayerContext] VLC playing')
    setIsLoading(false)
    setIsPlaying(true)
    if (Platform.OS !== 'web') {
      MediaSession.setPlaybackState({
        isPlaying: true,
        position: currentTimeRef.current,
        duration: durationRef.current,
        rate: playbackRateRef.current,
      }).catch(() => {})
    }
  }, [])

  const onPaused = useCallback(() => {
    console.log('[VideoPlayerContext] VLC paused')
    setIsPlaying(false)
    if (Platform.OS !== 'web') {
      MediaSession.setPlaybackState({
        isPlaying: false,
        position: currentTimeRef.current,
        duration: durationRef.current,
        rate: playbackRateRef.current,
      }).catch(() => {})
    }
  }, [])

  const onBuffering = useCallback((data: { isBuffering: boolean }) => {
    console.log('[VideoPlayerContext] VLC buffering:', data?.isBuffering)
    // Only show loading when actually buffering, hide when buffering stops
    if (data?.isBuffering !== undefined) {
      setIsLoading(data.isBuffering)
    }
  }, [])

  const onEnded = useCallback(() => {
    console.log('[VideoPlayerContext] VLC ended')
    setIsPlaying(false)
    if (Platform.OS !== 'web') {
      MediaSession.setPlaybackState({
        isPlaying: false,
        position: durationRef.current,
        duration: durationRef.current,
        rate: playbackRateRef.current,
      }).catch(() => {})
    }
  }, [])

  const onError = useCallback((error: any) => {
    console.error('[VideoPlayerContext] VLC error:', error)
    setIsLoading(false)
  }, [])

  const onVideoStateChange = useCallback((data: { type?: string; mVideoWidth?: number; mVideoHeight?: number }) => {
    if (data.type === 'onNewVideoLayout' && data.mVideoWidth && data.mVideoHeight && data.mVideoWidth > 0 && data.mVideoHeight > 0) {
      const aspectRatio = data.mVideoWidth / data.mVideoHeight
      console.log('[VideoPlayerContext] Video dimensions:', data.mVideoWidth, 'x', data.mVideoHeight, '- aspect ratio:', aspectRatio.toFixed(3))
      setVideoAspectRatio(aspectRatio)
      if (Platform.OS === 'android') {
        // VLC Android approach: Set PiP aspect ratio from actual video dimensions
        // This prevents zoom/stretch - Android will letterbox if needed
        MediaSession.setPictureInPictureAspectRatio(data.mVideoWidth, data.mVideoHeight).catch(() => {})
      }
    }
  }, [])

  const progress = duration > 0 ? currentTime / duration : 0
  
  const shouldEnablePip = useMemo(() => {
    if (Platform.OS !== 'android') return false
    if (!currentVideo) return false
    if (playerMode !== 'fullscreen') return false
    if (isInPipMode) return false
    return true
  }, [currentVideo, playerMode, isInPipMode])

  const contextValue: VideoPlayerContextType = {
    currentVideo,
    videoUrl,
    isPlaying,
    isLoading,
    playerMode,
    videoStats,
    currentTime,
    duration,
    progress,
    playbackRate,
    playbackSession,
    isInPipMode,
    setIsInPipMode,
    pipWindowSize,
    setPipWindowSize,
    shouldEnablePip,
    videoAspectRatio,
    vlcSeekPosition: seekPosition,
    playerRef,
    loadAndPlayVideo,
    pauseVideo,
    resumeVideo,
    closeVideo,
    minimizePlayer,
    maximizePlayer,
    seekTo,
    seekBy,
    setPlaybackRate,
    setVideoStats,
    setIsLoading,
    onProgress,
    onPlaying,
    onPaused,
    onBuffering,
    onEnded,
    onError,
    onVideoStateChange,
  }

  return (
    <VideoPlayerContext.Provider value={contextValue}>
      {children}
    </VideoPlayerContext.Provider>
  )
}
