/**
 * VideoPlayerContext - Unified Video Player State Management
 *
 * Contains all video player state, controls, and media session handling.
 * Emits events via playbackActiveEmitter, videoStatsEventEmitter, and videoLoadEventEmitter
 * for cross-component communication.
 */

import { createContext, useContext, useState, useCallback, useRef, useEffect, useMemo, ReactNode } from 'react'
import { Platform, AppState, AppStateStatus } from 'react-native'
import type { VideoData, VideoStats } from '@peartube/core'
import type { PlayerMode } from './video-player'
import * as MediaSession from '../modules/expo-media-session/src'
import { usePlayerStateMachine } from './playerStateMachine'
import type { ModeBeforePip, PlayerState } from './playerStateMachine'

// Re-export types for backwards compatibility
export type { VideoData, VideoStats } from '@peartube/core'

// Re-export emitters for backwards compatibility
export {
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

  videoAspectRatio: number | null

  // Playback position
  currentTime: number
  duration: number
  progress: number // 0-1 percentage

  // Playback speed
  playbackRate: number

  seekPosition: number | undefined

  playerRef: React.MutableRefObject<any>

  // Actions
  loadAndPlayVideo: (video: VideoData, url: string) => void
  pauseVideo: () => void
  resumeVideo: () => void
  closeVideo: () => void
  suppressForegroundRestoreOnce: () => void
  suppressForegroundRestoreFor: (ms: number) => void
  clearLastClosedVideo: () => void
  minimizePlayer: () => void
  maximizePlayer: () => void
  maximizedForPipRef: React.MutableRefObject<boolean>
  seekTo: (time: number) => void
  seekBy: (delta: number) => void
  setPlaybackRate: (rate: number) => void
  setVideoStats: (stats: VideoStats | null) => void
  setIsLoading: (loading: boolean) => void

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
  const initialState = useMemo<PlayerState>(() => ({
    mode: 'hidden',
    video: null,
    url: null,
    wasPlayingWhenBackgrounded: false,
    wasPlayingWhenPipEntered: false,
    modeBeforePip: 'fullscreen',
  }), [])
  const { state, dispatch } = usePlayerStateMachine(initialState)

  // Video state
  const currentVideo = state.video
  const videoUrl = state.url
  const [isPlaying, setIsPlaying] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const playerMode: PlayerMode =
    state.mode === 'mini'
      ? 'mini'
      : state.mode === 'hidden'
        ? 'hidden'
        : 'fullscreen'
  const [videoStats, setVideoStats] = useState<VideoStats | null>(null)
  const [playbackSession, setPlaybackSession] = useState(0)
  const isInPipMode = state.mode === 'pip_active'
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

  const [seekPosition, setSeekPosition] = useState<number | undefined>(undefined)

  const playerRef = useRef<any>(null)

  // Ref for current video - updated synchronously to avoid race conditions with stats events
  const currentVideoRef = useRef<VideoData | null>(null)

  // Ref for video URL - used for error debugging
  const videoUrlRef = useRef<string | null>(null)
  const lastClosedVideoRef = useRef<VideoData | null>(null)
  const lastClosedUrlRef = useRef<string | null>(null)
  const lastClosedTimeRef = useRef<number | null>(null)
  const suppressForegroundRestoreRef = useRef(false)
  const suppressForegroundRestoreUntilRef = useRef<number>(0)
  const remotePlayWhileBackgroundedRef = useRef(false)
  const pipExitShouldResumeRef = useRef(false)
  const pipExitExpectedPlayingRef = useRef(false)
  const pipExitResumeUntilRef = useRef(0)
  const pipExitReassertLoggedAtRef = useRef(0)
  const iosIgnorePausedUntilRef = useRef(0)
  const pendingSeekSecondsRef = useRef<number | null>(null)
  const seekConfirmRef = useRef<{ targetSeconds: number; startedAt: number } | null>(null)
  const seekClearTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Background playback tracking refs
  const wasPlayingWhenBackgroundedRef = useRef(state.wasPlayingWhenBackgrounded)
  const isBackgroundedRef = useRef(false)
  const isInPipModeRef = useRef(false)
  const wasPlayingWhenPipEnteredRef = useRef(state.wasPlayingWhenPipEntered)
  const modeBeforePipRef = useRef<ModeBeforePip>(state.modeBeforePip)
  const playerModeRef = useRef<PlayerMode>(playerMode)  // Sync ref for PiP handler
  const maximizedForPipRef = useRef(false)  // True when we expanded mini→fullscreen for PiP
  const lastPipEventTimeRef = useRef(0)
  const pipTransitionTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const pipTransitionInFlightRef = useRef(false)  // True during PiP exit→fullscreen transition window
  const previousStateModeRef = useRef(state.mode)
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
  useEffect(() => {
    wasPlayingWhenBackgroundedRef.current = state.wasPlayingWhenBackgrounded
    wasPlayingWhenPipEnteredRef.current = state.wasPlayingWhenPipEntered
    modeBeforePipRef.current = state.modeBeforePip
  }, [state.modeBeforePip, state.wasPlayingWhenBackgrounded, state.wasPlayingWhenPipEntered])
  useEffect(() => {
    currentVideoRef.current = currentVideo
    videoUrlRef.current = videoUrl
  }, [currentVideo, videoUrl])

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
    setPlaybackSession((prev) => prev + 1)
    dispatch({
      type: 'RESTORE_FROM_LAST_CLOSED',
      source: 'restoreLastClosedVideo',
      video: lastClosedVideoRef.current,
      url: lastClosedUrlRef.current,
      resumeSeconds: lastClosedTimeRef.current ?? undefined,
    })
    setIsLoading(true)
    if (lastClosedTimeRef.current !== null) {
      pendingSeekSecondsRef.current = lastClosedTimeRef.current
    }
    setIsPlaying(true)
    return true
  }, [dispatch])

  const forceReloadPlayback = useCallback((reason: string) => {
    const video = currentVideoRef.current
    const url = videoUrlRef.current
    if (!video || !url) return false
    console.log('[VideoPlayerContext] Forcing playback reload:', reason)
    setPlaybackSession((prev) => prev + 1)
    dispatch({
      type: 'FORCE_RELOAD_PLAYBACK',
      source: 'forceReloadPlayback',
      video,
      url,
      resumeSeconds: currentTimeRef.current,
    })
    setIsLoading(true)
    pendingSeekSecondsRef.current = currentTimeRef.current
    setIsPlaying(true)
    return true
  }, [dispatch])

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

  useEffect(() => {
    const previousMode = previousStateModeRef.current
    const nextMode = state.mode
    previousStateModeRef.current = nextMode

    if (previousMode === nextMode) return

    if (nextMode === 'hidden') {
      if (seekClearTimeoutRef.current) {
        clearTimeout(seekClearTimeoutRef.current)
        seekClearTimeoutRef.current = null
      }
      if (pipTransitionTimeoutRef.current) {
        clearTimeout(pipTransitionTimeoutRef.current)
        pipTransitionTimeoutRef.current = null
      }
      seekConfirmRef.current = null
      pipTransitionInFlightRef.current = false
      pipExitShouldResumeRef.current = false
      pipExitExpectedPlayingRef.current = false
      pipExitResumeUntilRef.current = 0
      isInPipModeRef.current = false
      setPipWindowSize(null)
      setSeekPosition(undefined)
      setVideoStats(null)
      setVideoAspectRatio(null)
      setIsLoading(false)
      if (Platform.OS !== 'web') {
        MediaSession.clearNowPlaying().catch(() => {})
        setMediaSessionActive(false)
      }
      mediaSessionActiveRef.current = false
      return
    }

    if (nextMode === 'fullscreen') {
      if (Platform.OS !== 'web' && mediaSessionActiveRef.current) {
        MediaSession.setPlaybackState({
          isPlaying: isPlayingRef.current,
          position: currentTimeRef.current,
          duration: durationRef.current,
          rate: playbackRateRef.current,
        }).catch(() => {})
      }
      if (pipExitShouldResumeRef.current) {
        pipExitShouldResumeRef.current = false
        setIsPlaying(true)
        reassertNativePlayAfterPipExit('mode-fullscreen-transition')
      }
    }

    if (nextMode === 'pip_active') {
      const shouldKeepPlaying = state.wasPlayingWhenPipEntered || isPlayingRef.current
      if (shouldKeepPlaying) {
        setIsPlaying(true)
      }
    }

    if (previousMode === 'pip_active' && nextMode !== 'pip_active') {
      const shouldResume = pipExitShouldResumeRef.current || state.wasPlayingWhenPipEntered
      if (shouldResume) {
        setIsPlaying(true)
        reassertNativePlayAfterPipExit('pip-active-exit-transition')
      }
    }
  }, [reassertNativePlayAfterPipExit, setMediaSessionActive, state.mode, state.wasPlayingWhenPipEntered])

   // AppState listener for background/foreground transitions (mobile only)
   useEffect(() => {
     if (Platform.OS === 'web') return

        const handleAppStateChange = (nextState: AppStateStatus) => {
        const goingToBackground = nextState === 'background' || nextState === 'inactive'
        const comingToForeground = nextState === 'active'

      if (goingToBackground && !isBackgroundedRef.current) {
        isBackgroundedRef.current = true
        dispatch({
          type: 'APP_BACKGROUND',
          source: 'appStateBackgroundMiniAutoMaximizeForPip',
          appState: nextState,
          isPlaying: isPlayingRef.current,
        })
        console.log('[VideoPlayerContext] Going to background, wasPlaying:', isPlayingRef.current, 'playerMode:', playerModeRef.current)

        // Expand mini player to fullscreen before PiP activates.
        // PiP needs the native video surface at fullscreen dimensions — on Android
        // the Activity window IS the PiP content, on iOS the AVSampleBufferDisplayLayer
        // must be large enough for canStartPictureInPictureAutomaticallyFromInline.
        if (playerModeRef.current === 'mini' && isPlayingRef.current) {
          console.log('[VideoPlayerContext] Maximizing from mini for PiP')
          maximizedForPipRef.current = true
          dispatch({ type: 'MAXIMIZE', source: 'maximizePlayer' })
        }
       } else if (comingToForeground && isBackgroundedRef.current) {
         isBackgroundedRef.current = false
         maximizedForPipRef.current = false
          const wasInPip = isInPipModeRef.current || pipTransitionInFlightRef.current
          console.log('[VideoPlayerContext] Coming to foreground, wasPlaying:', wasPlayingWhenBackgroundedRef.current, 'wasInPiP:', wasInPip, 'pipInFlight:', pipTransitionInFlightRef.current)

         // IMPORTANT: Don't clear PiP state on foreground if we were in PiP.
         // When returning from PiP, Android can deliver the AppState "active" event
         // before the native PiP exit callback reaches JS. Clearing the ref here
         // makes the PiP exit handler think we were never in PiP, so it won't
         // restore playback state (leading to unintended pauses).
          if (!wasInPip) {
            console.log('[VideoPlayerContext] Clearing PiP state on foreground')
            isInPipModeRef.current = false
            setPipWindowSize(null)
            if (pipTransitionTimeoutRef.current) {
              clearTimeout(pipTransitionTimeoutRef.current)
             pipTransitionTimeoutRef.current = null
           }
         }

        const now = Date.now()
        const suppressOnce = suppressForegroundRestoreRef.current
        suppressForegroundRestoreRef.current = false
        const suppressWindow = suppressForegroundRestoreUntilRef.current > now
        const shouldSuppressRestore = suppressOnce || suppressWindow || wasInPip

        dispatch({
          type: 'APP_FOREGROUND',
          source: 'appStateForegroundHiddenRestore',
          appState: 'active',
          wasInPip,
          suppressRestore: shouldSuppressRestore,
        })

        if (!shouldSuppressRestore) {
          if (!currentVideoRef.current) {
            restoreLastClosedVideo('foreground')
          }
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
    }, [dispatch, forceReloadPlayback, restoreLastClosedVideo])

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
          const platform = Platform.OS === 'ios' ? 'ios' : 'android'
          dispatch({
            type: 'REMOTE_PLAY',
            source: 'remoteCommandHiddenRestore',
            isBackgrounded: isBackgroundedRef.current,
            platform,
          })
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
            if (Platform.OS === 'ios' && currentVideoRef.current) {
              setIsPlaying(true)
              try { playerRef.current?.play?.() } catch {}
            } else {
              remotePlayWhileBackgroundedRef.current = true
              return
            }
            break
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
            reassertNativePlayAfterPipExit('remote-pause-during-pip-exit')
            return
          }
          setIsPlaying(false)
          if (isBackgroundedRef.current && Platform.OS === 'ios') {
            try { playerRef.current?.pause?.() } catch {}
          }
          break
        case 'stop':
          console.log('[VideoPlayerContext] Stopping playback')
          setIsPlaying(false)
          break
        case 'togglePlayPause':
          console.log('[VideoPlayerContext] Toggling play/pause')
          if (isPlayingRef.current) {
            setIsPlaying(false)
          } else if (isBackgroundedRef.current && Platform.OS === 'ios' && currentVideoRef.current) {
            setIsPlaying(true)
            try { playerRef.current?.play?.() } catch {}
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
        dispatch({
          type: 'APP_BACKGROUND',
          source: 'appStateBackgroundMiniAutoMaximizeForPip',
          appState: 'inactive',
          isPlaying: isPlayingRef.current,
        })
        setIsPlaying(false)
      } else if (event.type === 'ended' && event.shouldResume) {
        if (wasPlayingWhenBackgroundedRef.current) {
          setIsPlaying(true)
        }
      }
    })

    return () => subscription.remove()
  }, [dispatch])

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

      // IMPORTANT: Mark PiP exit transition immediately.
      // PiP window is closed, BEFORE our debounced/timeout PiP handler runs. If we let
      // that pause flip `isPlaying=false`, the native player will pause briefly and
      // you hear a gap. Precomputing expectedPlaying here lets us ignore those pauses.
      if (!event.isInPictureInPicture && wasInPip) {
        const expectedPlaying = Boolean(event.isPlaying ?? wasPlayingWhenPipEnteredRef.current ?? isPlayingRef.current)
        pipExitExpectedPlayingRef.current = expectedPlaying
        pipExitShouldResumeRef.current = expectedPlaying
        pipExitResumeUntilRef.current = expectedPlaying ? (Date.now() + 2000) : 0
        pipTransitionInFlightRef.current = true
      }

      // Only debounce if BOTH boolean AND dimensions are identical
      // This ensures dimension changes are always processed, even if boolean is the same
      const sameState = event.isInPictureInPicture === wasInPip
      const sameDimensions = event.width === pipWindowSizeRef.current?.width && event.height === pipWindowSizeRef.current?.height
      const tooSoon = now - lastPipEventTimeRef.current < 50

      if (sameState && sameDimensions && tooSoon) {
        return
      }
      lastPipEventTimeRef.current = now

      // Update ref immediately to prevent race conditions
      isInPipModeRef.current = event.isInPictureInPicture

      // Update state immediately - RAF doesn't fire in PiP/background mode
      if (event.isInPictureInPicture) {
        dispatch({
          type: 'PIP_ENTERED_ANDROID',
          source: 'androidPipExitRestorePreviousMode',
          platform: 'android',
          dimensions:
            event.width && event.height
              ? { width: event.width, height: event.height }
              : undefined,
          isPlaying: event.isPlaying,
        })
      }
      if (event.isInPictureInPicture && event.width && event.height) {
        setPipWindowSize({ width: event.width, height: event.height })
      } else if (!event.isInPictureInPicture) {
        setPipWindowSize(null)
      }

      // Use setTimeout instead of RAF - RAF doesn't fire in PiP/background mode
      if (pipTransitionTimeoutRef.current) {
        clearTimeout(pipTransitionTimeoutRef.current)
      }
      pipTransitionTimeoutRef.current = setTimeout(() => {
        if (event.isInPictureInPicture !== isInPipModeRef.current) {
          pipTransitionInFlightRef.current = false
          return
        }

        if (event.isInPictureInPicture) {
          const wasPlaying = isPlayingRef.current || wasPlayingWhenBackgroundedRef.current
          if (wasPlaying) {
            setTimeout(() => {
              setIsPlaying(true)
            }, 150)
          }
        } else if (wasInPip) {
          const shouldResume = event.isPlaying ?? wasPlayingWhenPipEnteredRef.current
          pipExitShouldResumeRef.current = shouldResume
          pipExitExpectedPlayingRef.current = Boolean(shouldResume)
          pipExitResumeUntilRef.current = shouldResume ? Math.max(pipExitResumeUntilRef.current, Date.now() + 2000) : 0
          dispatch({
            type: 'PIP_EXITED_ANDROID',
            source: 'androidPipExitRestorePreviousMode',
            platform: 'android',
            wasInPip,
            shouldResume,
            restoreMode: modeBeforePipRef.current,
            dimensions:
              event.width && event.height
                ? { width: event.width, height: event.height }
                : undefined,
          })
          setIsPlaying(shouldResume)

          if (shouldResume) {
            // Proactively reassert play during the first few frames after PiP exit.
            // This is a no-op on healthy devices but prevents short silent gaps on others.
            reassertNativePlayAfterPipExit('pip-exit-immediate')
            setTimeout(() => reassertNativePlayAfterPipExit('pip-exit+120ms'), 120)
            setTimeout(() => reassertNativePlayAfterPipExit('pip-exit+320ms'), 320)
          }
        }
        pipTransitionInFlightRef.current = false
      })
    })

    return () => {
      subscription.remove()
    }
  }, [dispatch, reassertNativePlayAfterPipExit])

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
    dispatch({ type: 'LOAD_VIDEO', source: 'loadAndPlayVideo', video, url })
    setIsPlaying(true)
    setVideoStats(null)
    // Show loading overlay until playback actually starts.
    // Some player builds don't reliably emit initial buffering events, which can
    // otherwise lead to a confusing black screen while data is loading.
    setIsLoading(true)
    setCurrentTime(0)
    setDuration(0)
    setVideoAspectRatio(null)
    if (Platform.OS === 'ios') {
      iosIgnorePausedUntilRef.current = Date.now() + 1500
    }
    // Emit load event so _layout.tsx can trigger prefetch
    _videoLoadEventEmitter.emit(video)
  }, [dispatch])

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

    if (seekClearTimeoutRef.current) {
      clearTimeout(seekClearTimeoutRef.current)
      seekClearTimeoutRef.current = null
    }
    seekConfirmRef.current = null

    suppressForegroundRestoreRef.current = true
    const suppressUntil = Date.now() + 2000
    if (suppressUntil > suppressForegroundRestoreUntilRef.current) {
      suppressForegroundRestoreUntilRef.current = suppressUntil
    }

    lastClosedVideoRef.current = null
    lastClosedUrlRef.current = null
    lastClosedTimeRef.current = null
    currentVideoRef.current = null
    videoUrlRef.current = null

    setIsPlaying(false)
    dispatch({ type: 'CLOSE_VIDEO', source: 'closeVideo' })
    setVideoStats(null)
    setCurrentTime(0)
    setDuration(0)
  }, [dispatch])

  const suppressForegroundRestoreOnce = useCallback(() => {
    suppressForegroundRestoreRef.current = true
  }, [])

  const suppressForegroundRestoreFor = useCallback((ms: number) => {
    const now = Date.now()
    const until = now + Math.max(0, ms)
    if (until > suppressForegroundRestoreUntilRef.current) {
      suppressForegroundRestoreUntilRef.current = until
    }
  }, [])

  const clearLastClosedVideo = useCallback(() => {
    lastClosedVideoRef.current = null
    lastClosedUrlRef.current = null
    lastClosedTimeRef.current = null
  }, [])

  const minimizePlayer = useCallback(() => {
    console.log('[VideoPlayerContext] Minimizing to in-app mini player')
    dispatch({ type: 'MINIMIZE', source: 'minimizePlayer' })
  }, [dispatch])

  // Maximize from mini player
  const maximizePlayer = useCallback(() => {
    console.log('[VideoPlayerContext] Maximizing player')
    dispatch({ type: 'MAXIMIZE', source: 'maximizePlayer' })
  }, [dispatch])

  const setIsInPipMode = useCallback((value: boolean) => {
    if (Platform.OS !== 'android') {
      isInPipModeRef.current = value
      return
    }

    const wasInPip = isInPipModeRef.current
    isInPipModeRef.current = value

    if (value) {
      dispatch({
        type: 'PIP_ENTERED_ANDROID',
        source: 'androidPipExitRestorePreviousMode',
        platform: 'android',
        dimensions: pipWindowSizeRef.current ?? undefined,
        isPlaying: isPlayingRef.current,
      })
      return
    }

    dispatch({
      type: 'PIP_EXITED_ANDROID',
      source: 'androidPipExitRestorePreviousMode',
      platform: 'android',
      wasInPip,
      shouldResume: isPlayingRef.current,
      restoreMode: modeBeforePipRef.current,
      dimensions: pipWindowSizeRef.current ?? undefined,
    })
  }, [dispatch])

  const startSeekConfirm = useCallback((targetSeconds: number) => {
    seekConfirmRef.current = { targetSeconds, startedAt: Date.now() }
    if (seekClearTimeoutRef.current) clearTimeout(seekClearTimeoutRef.current)
    seekClearTimeoutRef.current = setTimeout(() => {
      seekConfirmRef.current = null
      setSeekPosition(undefined)
      seekClearTimeoutRef.current = null
    }, 1200)
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
    startSeekConfirm(clampedTime)
  }, [startSeekConfirm])

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
    startSeekConfirm(newTime)
  }, [startSeekConfirm])

  // Set playback speed
  const setPlaybackRate = useCallback((rate: number) => {
    console.log('[VideoPlayerContext] Setting playback rate:', rate)
    setPlaybackRateState(rate)
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
      if (Platform.OS === 'ios') {
        iosIgnorePausedUntilRef.current = 0
      }
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
    console.log('[VideoPlayerContext] Player playing')
    if (Platform.OS === 'ios') {
      iosIgnorePausedUntilRef.current = 0
    }
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
    if (Platform.OS === 'ios' && Date.now() < iosIgnorePausedUntilRef.current) {
      console.log('[VideoPlayerContext] Ignoring transient iOS paused event during source swap')
      return
    }
    if (pipExitExpectedPlayingRef.current && !isInPipModeRef.current) {
      reassertNativePlayAfterPipExit('player-paused-during-pip-exit')

      if (Date.now() <= pipExitResumeUntilRef.current) {
        return
      }
      pipExitShouldResumeRef.current = false
      pipExitExpectedPlayingRef.current = false
    }
    console.log('[VideoPlayerContext] Player paused')
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
    console.log('[VideoPlayerContext] Player buffering:', data?.isBuffering)
    // Only show loading when actually buffering, hide when buffering stops
    if (data?.isBuffering !== undefined) {
      setIsLoading(data.isBuffering)
    }
  }, [])

  const onEnded = useCallback(() => {
    console.log('[VideoPlayerContext] Player ended')
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
    const currentUrl = videoUrlRef.current
    console.error('[VideoPlayerContext] Player error:', error, 'URL:', currentUrl)
    setIsLoading(false)
  }, [])

  const onVideoStateChange = useCallback((data: { type?: string; mVideoWidth?: number; mVideoHeight?: number }) => {
    if (data.type === 'onNewVideoLayout' && data.mVideoWidth && data.mVideoHeight && data.mVideoWidth > 0 && data.mVideoHeight > 0) {
      const aspectRatio = data.mVideoWidth / data.mVideoHeight
      console.log('[VideoPlayerContext] Video dimensions:', data.mVideoWidth, 'x', data.mVideoHeight, '- aspect ratio:', aspectRatio.toFixed(3))
      setVideoAspectRatio(aspectRatio)
      if (Platform.OS === 'android') {
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
    seekPosition,
    playerRef,
    loadAndPlayVideo,
    pauseVideo,
    resumeVideo,
    closeVideo,
    suppressForegroundRestoreOnce,
    suppressForegroundRestoreFor,
    clearLastClosedVideo,
    minimizePlayer,
    maximizePlayer,
    maximizedForPipRef,
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
    closeVideo, suppressForegroundRestoreOnce, suppressForegroundRestoreFor, clearLastClosedVideo, minimizePlayer, maximizePlayer, seekTo, seekBy, setPlaybackRate,
    setIsInPipMode,
    onProgress, onPlaying, onPaused, onBuffering,
    onEnded, onError, onVideoStateChange,
  ])

  return (
    <VideoPlayerContext.Provider value={contextValue}>
      {children}
    </VideoPlayerContext.Provider>
  )
}
