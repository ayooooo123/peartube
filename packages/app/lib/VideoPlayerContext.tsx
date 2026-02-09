/**
 * VideoPlayerContext - Unified Video Player State Management
 *
 * PERFORMANCE NOTE: This context has been split into 3 separate contexts to reduce re-renders:
 * - VideoProgressContext: High-frequency progress updates (~4Hz)
 * - VideoControlContext: Medium-frequency control state (play/pause, mode)
 * - VideoMetaContext: Low-frequency video metadata
 *
 * For new components, prefer importing the specific context you need from './video-player':
 *   import { useVideoProgressContext } from '@/lib/video-player'  // For SeekBar
 *   import { useVideoControlContext } from '@/lib/video-player'   // For controls
 *   import { useVideoMetaContext } from '@/lib/video-player'      // For video info
 *
 * This file maintains backward compatibility by combining all contexts into one.
 */

import { createContext, useContext, useState, useCallback, useRef, useEffect, useMemo, ReactNode } from 'react'
import { Platform, AppState, AppStateStatus } from 'react-native'
import type { VideoData, VideoStats } from '@peartube/core'
import * as MediaSession from '../modules/expo-media-session/src'

// Re-export types for backwards compatibility
export type { VideoData, VideoStats } from '@peartube/core'

// Re-export split contexts for gradual migration
export {
  useVideoProgressContext,
  useVideoControlContext,
  useVideoMetaContext,
  videoStatsEventEmitter,
  videoLoadEventEmitter,
  playbackActiveEmitter,
} from './video-player'
export type { PlayerMode } from './video-player'

// Import emitters from split contexts for internal use
import {
  videoStatsEventEmitter as _videoStatsEventEmitter,
  videoLoadEventEmitter as _videoLoadEventEmitter,
  playbackActiveEmitter as _playbackActiveEmitter,
} from './video-player'

// Player mode (re-exported from video-player but defined here for legacy code)
type PlayerMode = 'hidden' | 'mini' | 'fullscreen'

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

  // Keep PiP window size in a ref so PiP listeners can read latest value
  // without having to re-subscribe to native events.
  const pipWindowSizeRef = useRef<{ width: number; height: number } | null>(null)

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

  // Ref for video URL - used for error debugging
  const videoUrlRef = useRef<string | null>(null)
  const lastClosedVideoRef = useRef<VideoData | null>(null)
  const lastClosedUrlRef = useRef<string | null>(null)
  const lastClosedTimeRef = useRef<number | null>(null)
  const remotePlayWhileBackgroundedRef = useRef(false)
  const pipExitShouldResumeRef = useRef(false)
  const pipExitExpectedPlayingRef = useRef(false)
  const pipExitResumeUntilRef = useRef(0)
  const pipExitReassertLoggedAtRef = useRef(0)
  const pendingSeekSecondsRef = useRef<number | null>(null)
  const seekConfirmRef = useRef<{ targetSeconds: number; startedAt: number } | null>(null)
  const seekClearTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Background playback tracking refs
  const wasPlayingWhenBackgroundedRef = useRef(false)
  const isBackgroundedRef = useRef(false)
  const isInPipModeRef = useRef(false)
  const wasPlayingWhenPipEnteredRef = useRef(false)
  const playerModeBeforePipRef = useRef<PlayerMode>('fullscreen')
  const playerModeRef = useRef<PlayerMode>(playerMode)  // Sync ref for PiP handler
  const lastPipEventTimeRef = useRef(0)
  const pipStateUpdateRafRef = useRef<number | null>(null)
  const pipTransitionTimeoutRef = useRef<NodeJS.Timeout | null>(null)
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
    _playbackActiveEmitter.set(currentVideo !== null && (isPlaying || isInPipMode))
  }, [isPlaying, currentVideo, isInPipMode])
  useEffect(() => { playbackRateRef.current = playbackRate }, [playbackRate])
  useEffect(() => { playerModeRef.current = playerMode }, [playerMode])
  useEffect(() => { pipWindowSizeRef.current = pipWindowSize }, [pipWindowSize])

  const reassertNativePlayAfterPipExit = useCallback((reason: string) => {
    if (Platform.OS !== 'android') return
    if (isInPipModeRef.current) return
    if (!pipExitExpectedPlayingRef.current) return
    const now = Date.now()
    if (now > pipExitResumeUntilRef.current) return

    // Some Android builds briefly pause the underlying player during the PiP->fullscreen
    // transition (surface re-attach / audio focus). If JS ignores the pause event to
    // keep UI stable, we still need to *reassert* play on the native player.
    try {
      playerRef.current?.play?.()
    } catch (e) {
      if (__DEV__) console.warn('[VideoPlayerContext] Failed to reassert play after PiP exit:', reason, e)
    }

    // Avoid log spam while still surfacing what happened.
    if (__DEV__ && now - pipExitReassertLoggedAtRef.current > 1000) {
      pipExitReassertLoggedAtRef.current = now
      console.log('[VideoPlayerContext] Reasserting play after PiP exit:', reason)
    }
  }, [])

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

  const restoreLastClosedVideo = useCallback((reason: string) => {
    if (!lastClosedVideoRef.current || !lastClosedUrlRef.current) return false
    console.log('[VideoPlayerContext] Restoring last closed video:', reason)
    currentVideoRef.current = lastClosedVideoRef.current
    videoUrlRef.current = lastClosedUrlRef.current
    setCurrentVideo(lastClosedVideoRef.current)
    setVideoUrl(lastClosedUrlRef.current)
    setPlaybackSession((prev) => prev + 1)
    setPlayerMode('fullscreen')
    setIsLoading(true)
    if (lastClosedTimeRef.current !== null) {
      pendingSeekSecondsRef.current = lastClosedTimeRef.current
    }
    setIsPlaying(true)
    return true
  }, [])

  const forceReloadPlayback = useCallback((reason: string) => {
    const video = currentVideoRef.current
    const url = videoUrlRef.current
    if (!video || !url) return false
    console.log('[VideoPlayerContext] Forcing playback reload:', reason)
    setPlaybackSession((prev) => prev + 1)
    setCurrentVideo(video)
    setVideoUrl(url)
    setPlayerMode('fullscreen')
    setIsLoading(true)
    pendingSeekSecondsRef.current = currentTimeRef.current
    setIsPlaying(true)
    return true
  }, [])

  const tryApplyPendingSeek = useCallback(() => {
    const pending = pendingSeekSecondsRef.current
    if (pending === null) return
    const durationValue = durationRef.current
    if (durationValue <= 0) return
    const seekValue = pending / durationValue
    setSeekPosition(seekValue)
    setCurrentTime(pending)
    pendingSeekSecondsRef.current = null
    setTimeout(() => setSeekPosition(undefined), 200)
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
  }, [currentVideo, duration])

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
         const wasInPip = isInPipModeRef.current
         console.log('[VideoPlayerContext] Coming to foreground, wasPlaying:', wasPlayingWhenBackgroundedRef.current, 'wasInPiP:', wasInPip)

         // IMPORTANT: Don't clear PiP state on foreground if we were in PiP.
         // When returning from PiP, Android can deliver the AppState "active" event
         // before the native PiP exit callback reaches JS. Clearing the ref here
         // makes the PiP exit handler think we were never in PiP, so it won't
         // restore playback state (leading to unintended pauses).
         if (!wasInPip) {
           console.log('[VideoPlayerContext] Clearing PiP state on foreground')
           isInPipModeRef.current = false
           setIsInPipMode(false)
           setPipWindowSize(null)
           if (pipTransitionTimeoutRef.current) {
             clearTimeout(pipTransitionTimeoutRef.current)
             pipTransitionTimeoutRef.current = null
           }
         }

        if (!currentVideoRef.current) {
          restoreLastClosedVideo('foreground')
        } else if (playerModeRef.current === 'hidden' && currentVideoRef.current) {
          console.log('[VideoPlayerContext] Foreground while hidden, restoring fullscreen')
          setPlayerMode('fullscreen')
        }

        if (remotePlayWhileBackgroundedRef.current) {
          remotePlayWhileBackgroundedRef.current = false
          if (!forceReloadPlayback('foreground-remote-play')) {
            restoreLastClosedVideo('foreground-remote-play')
          }
        }

         // Foreground seek "nudge" is useful after backgrounding, but it can cause
         // audible/visible stutter when returning from PiP (single-player continues).
         if (!wasInPip && wasPlayingWhenBackgroundedRef.current && durationRef.current > 0) {
           const seekValue = currentTimeRef.current / durationRef.current
           setSeekPosition(seekValue)
           setTimeout(() => setSeekPosition(undefined), 100)
         }
       }
     }

    const subscription = AppState.addEventListener('change', handleAppStateChange)
    return () => subscription.remove()
  }, [forceReloadPlayback, restoreLastClosedVideo])

  useEffect(() => {
    if (Platform.OS !== 'android') return
    const shouldAvoidCutout = playerMode === 'fullscreen' && !isInPipMode
    MediaSession.setStatusBarOverlayEnabled(shouldAvoidCutout).catch(() => {})
  }, [playerMode, isInPipMode])

// MediaSession remote command listener (mobile only)
 useEffect(() => {
    if (Platform.OS === 'web') return

    const subscription = MediaSession.addRemoteCommandListener((event) => {
      console.log('[VideoPlayerContext] Remote command received:', event.command)
      const resumeFromRemote = () => {
        if (!currentVideoRef.current) {
          if (!restoreLastClosedVideo('remote-play')) {
            return
          }
        } else if (playerModeRef.current === 'hidden' && currentVideoRef.current) {
          console.log('[VideoPlayerContext] Remote play while hidden, restoring fullscreen')
          setPlayerMode('fullscreen')
        }
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
          if (isBackgroundedRef.current) {
            remotePlayWhileBackgroundedRef.current = true
            return
          }
          resumeFromRemote()
          break
        case 'pause':
          console.log('[VideoPlayerContext] Setting isPlaying = false')
          if (
            Platform.OS === 'android' &&
            !isInPipModeRef.current &&
            pipExitExpectedPlayingRef.current &&
            Date.now() <= pipExitResumeUntilRef.current
          ) {
            // Android PiP exit can emit a spurious pause from MediaSession/AudioFocus.
            // Keep UI stable and immediately re-assert play to avoid an audible gap.
            reassertNativePlayAfterPipExit('remote-pause-during-pip-exit')
            return
          }
          setIsPlaying(false)
          break
        case 'stop':
          console.log('[VideoPlayerContext] Stopping playback')
          setIsPlaying(false)
          break
        case 'togglePlayPause':
          console.log('[VideoPlayerContext] Toggling play/pause')
          if (isPlayingRef.current) {
            setIsPlaying(false)
          } else {
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
  }, [restoreLastClosedVideo, reassertNativePlayAfterPipExit])

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

      // IMPORTANT: Mark PiP exit transition immediately.
      // Some devices emit a MediaSession "pause" (and/or VLC onPaused) right as the
      // PiP window is closed, BEFORE our debounced/timeout PiP handler runs. If we let
      // that pause flip `isPlaying=false`, the native player will pause briefly and
      // you hear a gap. Precomputing expectedPlaying here lets us ignore those pauses.
      if (!event.isInPictureInPicture && wasInPip) {
        const expectedPlaying = Boolean(event.isPlaying ?? wasPlayingWhenPipEnteredRef.current ?? isPlayingRef.current)
        pipExitExpectedPlayingRef.current = expectedPlaying
        pipExitShouldResumeRef.current = expectedPlaying
        pipExitResumeUntilRef.current = expectedPlaying ? (Date.now() + 2000) : 0
      }

      // Only debounce if BOTH boolean AND dimensions are identical
      // This ensures dimension changes are always processed, even if boolean is the same
      const sameState = event.isInPictureInPicture === wasInPip
      const sameDimensions = event.width === pipWindowSizeRef.current?.width && event.height === pipWindowSizeRef.current?.height
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

      // Capture playerMode SYNCHRONOUSLY before setTimeout - the closure captures stale values
      // because this useEffect has empty deps []
      if (event.isInPictureInPicture) {
        // Save playerMode now, not inside setTimeout where it would be stale
        playerModeBeforePipRef.current = playerModeRef.current
        console.log('[VideoPlayerContext] Entering PiP, saving playerMode:', playerModeRef.current)
      }

      // Use setTimeout instead of RAF - RAF doesn't fire in PiP/background mode
      if (pipTransitionTimeoutRef.current) {
        clearTimeout(pipTransitionTimeoutRef.current)
      }
      pipTransitionTimeoutRef.current = setTimeout(() => {
        if (event.isInPictureInPicture !== isInPipModeRef.current) {
          return
        }

        if (event.isInPictureInPicture) {
          const wasPlaying = isPlayingRef.current || wasPlayingWhenBackgroundedRef.current
          wasPlayingWhenPipEnteredRef.current = wasPlaying
          console.log('[VideoPlayerContext] Entering PiP, wasPlaying:', wasPlaying, 'playerMode:', playerModeBeforePipRef.current)
          if (wasPlaying) {
            setTimeout(() => {
              console.log('[VideoPlayerContext] Resuming playback in PiP')
              setIsPlaying(true)
            }, 150)
          }
        } else if (wasInPip) {
          const shouldResume = event.isPlaying ?? wasPlayingWhenPipEnteredRef.current
          console.log('[VideoPlayerContext] PiP closed, restoring playback:', shouldResume)
          pipExitShouldResumeRef.current = shouldResume
          pipExitExpectedPlayingRef.current = Boolean(shouldResume)
          pipExitResumeUntilRef.current = shouldResume ? Math.max(pipExitResumeUntilRef.current, Date.now() + 2000) : 0
          wasPlayingWhenPipEnteredRef.current = false
          // Restore the playerMode that was active before PiP entry
          const modeToRestore = playerModeBeforePipRef.current
          console.log('[VideoPlayerContext] Exiting PiP, restoring playerMode:', modeToRestore)

          // Single-player architecture: same player continues, position is already synced
          setPlayerMode(modeToRestore)
          setIsPlaying(shouldResume)

          if (shouldResume) {
            // Proactively reassert play during the first few frames after PiP exit.
            // This is a no-op on healthy devices but prevents short silent gaps on others.
            reassertNativePlayAfterPipExit('pip-exit-immediate')
            setTimeout(() => reassertNativePlayAfterPipExit('pip-exit+120ms'), 120)
            setTimeout(() => reassertNativePlayAfterPipExit('pip-exit+320ms'), 320)
          }
        }
      })
    })

    return () => {
      subscription.remove()
    }
  }, [reassertNativePlayAfterPipExit])

  // Subscribe to video stats events from backend
  useEffect(() => {
    const unsubscribe = _videoStatsEventEmitter.subscribe((driveKey, videoPath, stats) => {
      // Use ref for synchronous access (state may not be updated yet)
      const video = currentVideoRef.current
      console.log('[VideoPlayerContext] Stats event received, checking match:', {
        videoPath,
        driveKey,
        currentPath: video?.path,
        currentKey: video?.channelKey
      })
      // Only update if this is for the current video.
      // Some layers identify a video by id while others may still use legacy path formats.
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
        // Keep the loading overlay up until the player actually starts.
        // (We still display live P2P stats while waiting.)
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
    // Update refs synchronously FIRST (before emitting event)
    currentVideoRef.current = video
    videoUrlRef.current = url
    setCurrentVideo(video)
    setVideoUrl(url)
    setIsPlaying(true)
    setPlayerMode('fullscreen')
    setVideoStats(null)
    // Show loading overlay until playback actually starts.
    // Some player builds don't reliably emit initial buffering events, which can
    // otherwise lead to a confusing black screen while data is loading.
    setIsLoading(true)
    setCurrentTime(0)
    setDuration(0)
    setVideoAspectRatio(null)
    // Emit load event so _layout.tsx can trigger prefetch
    _videoLoadEventEmitter.emit(video)
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
    lastClosedVideoRef.current = currentVideoRef.current
    lastClosedUrlRef.current = videoUrlRef.current
    currentVideoRef.current = null
    videoUrlRef.current = null
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

    // Keep the seek prop set until playback progress confirms the seek landed.
    // This avoids flaky/late seeks on some VLC builds and prevents UI from snapping back.
    seekConfirmRef.current = { targetSeconds: clampedTime, startedAt: Date.now() }
    if (seekClearTimeoutRef.current) clearTimeout(seekClearTimeoutRef.current)
    seekClearTimeoutRef.current = setTimeout(() => {
      // Failsafe: clear even if we never got a confirming progress event.
      seekConfirmRef.current = null
      setSeekPosition(undefined)
      seekClearTimeoutRef.current = null
    }, 1200)
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

    seekConfirmRef.current = { targetSeconds: newTime, startedAt: Date.now() }
    if (seekClearTimeoutRef.current) clearTimeout(seekClearTimeoutRef.current)
    seekClearTimeoutRef.current = setTimeout(() => {
      seekConfirmRef.current = null
      setSeekPosition(undefined)
      seekClearTimeoutRef.current = null
    }, 1200)
  }, [])

  // Set playback speed
  const setPlaybackRate = useCallback((rate: number) => {
    console.log('[VideoPlayerContext] Setting playback rate:', rate)
    setPlaybackRateState(rate)
    // VLC handles this via the rate prop
  }, [])

  const lastMediaSessionUpdateRef = useRef(0)
  const onProgress = useCallback((data: { currentTime: number; duration: number }) => {
    if (Platform.OS === 'android' && pipExitExpectedPlayingRef.current && !isInPipModeRef.current) {
      console.log('[VideoPlayerContext] PiP exit resume confirmed via progress')
      pipExitShouldResumeRef.current = false
      pipExitExpectedPlayingRef.current = false
      pipExitResumeUntilRef.current = 0
    }
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

    // Confirm any pending seek once progress is close to the target.
    const pending = seekConfirmRef.current
    if (pending) {
      const closeEnough = Math.abs(timeS - pending.targetSeconds) < 0.75
      const tooOld = now - pending.startedAt > 1500
      if (closeEnough || tooOld) {
        seekConfirmRef.current = null
        if (seekClearTimeoutRef.current) {
          clearTimeout(seekClearTimeoutRef.current)
          seekClearTimeoutRef.current = null
        }
        setSeekPosition(undefined)
      }
    }
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
    tryApplyPendingSeek()
    if (Platform.OS !== 'web') {
      MediaSession.setPlaybackState({
        isPlaying: true,
        position: currentTimeRef.current,
        duration: durationRef.current,
        rate: playbackRateRef.current,
      }).catch(() => {})
    }
  }, [tryApplyPendingSeek])

  const onPaused = useCallback(() => {
    if (Platform.OS === 'android' && pipExitExpectedPlayingRef.current && !isInPipModeRef.current) {
      // A pause right after PiP exit is often transient. Reassert play for a short window.
      reassertNativePlayAfterPipExit('vlc-paused-during-pip-exit')

      // If we keep seeing pauses beyond the grace window, accept the pause
      // so the UI can reflect the real state.
      if (Date.now() <= pipExitResumeUntilRef.current) {
        return
      }
      pipExitShouldResumeRef.current = false
      pipExitExpectedPlayingRef.current = false
    }
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
  }, [reassertNativePlayAfterPipExit])

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
    console.error('[VideoPlayerContext] VLC error:', error, 'URL:', videoUrlRef.current)
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

  // PERFORMANCE: Memoize context value to prevent unnecessary re-renders
  // Components consuming this context will only re-render when these specific values change
  const contextValue = useMemo<VideoPlayerContextType>(() => ({
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
  }), [
    // Low-frequency dependencies (video changes)
    currentVideo, videoUrl, videoStats,
    // Medium-frequency dependencies (control state)
    isPlaying, isLoading, playerMode, playbackRate, playbackSession,
    isInPipMode, pipWindowSize, shouldEnablePip, videoAspectRatio, seekPosition,
    // High-frequency dependencies (progress - NOTE: this still causes re-renders at 4Hz)
    currentTime, duration, progress,
    // Callbacks (stable references via useCallback)
    loadAndPlayVideo, pauseVideo, resumeVideo,
    closeVideo, minimizePlayer, maximizePlayer, seekTo, seekBy, setPlaybackRate,
    onProgress, onPlaying, onPaused, onBuffering,
    onEnded, onError, onVideoStateChange,
  ])

  return (
    <VideoPlayerContext.Provider value={contextValue}>
      {children}
    </VideoPlayerContext.Provider>
  )
}
