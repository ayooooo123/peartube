/* eslint-disable no-empty, no-useless-escape */
/**
 * VideoPlayerContext - Unified Video Player State Management
 *
 * Contains all video player state, controls, and media session handling.
 * Emits events via playbackActiveEmitter, videoStatsEventEmitter, and videoLoadEventEmitter
 * for cross-component communication.
 */

import { createContext, useContext, useState, useCallback, useRef, useEffect, useMemo, ReactNode } from 'react'
import { Platform, AppState, AppStateStatus, DeviceEventEmitter } from 'react-native'
import type { VideoData, VideoStats } from '@peartube/core'
import type { PlayerMode, PlayerPort } from './video-player'
import { resolvePlayerPort } from './video-player'
import { usePlayerStateMachine } from './playerStateMachine'
import type { ModeBeforePip, PlayerState } from './playerStateMachine'
import * as watchHistory from './watch-history'
import type { WatchIdentity } from './watch-history'
import { hasPersonalStore } from './personal-encryption'

const WATCH_HISTORY_WRITE_INTERVAL_MS = 10000
const STARTUP_AUTOPLAY_GUARD_MS = 3000

/**
 * Where this video's watch state lives.
 *
 * The consumer surfaces play an entity rather than a publisher upload, so
 * identity is used when the player was handed one and the legacy
 * channel/video pair when it was not. Null means the video carries neither,
 * which is nothing watch state can be keyed on.
 */
function watchCoordinatesOf(video: VideoData | null): { videoId: string; channelKey: string; identity: WatchIdentity | null } | null {
  if (!video) return null
  const loose = video as VideoData & { driveKey?: string; path?: string; entityRef?: string; entityId?: string; editionRef?: string; memberRef?: string }
  const channelKey = video.channelKey || loose.driveKey || video.channel?.key || ''
  const videoId = video.id || loose.path || ''
  const entityRef = loose.entityRef || loose.entityId || (channelKey ? '' : videoId)
  const identity = entityRef
    ? { entityRef, editionRef: loose.editionRef ?? null, memberRef: loose.memberRef ?? null }
    : null
  if (!identity && !(channelKey && videoId)) return null
  return { videoId, channelKey, identity }
}

/**
 * Persist watch progress into this device's own encrypted personal store.
 *
 * Nothing is reported anywhere: there is no watch event, no recommender feed,
 * and no analytics call. Strictly best-effort — failures must never affect
 * playback. A write to coordinates the viewer has just deleted is refused by
 * the store adapter, so a player left mounted over a delete keeps playing
 * without putting the record back.
 *
 * A device that has no personal store is not asked at all: the write cannot
 * land, and a tick that asks anyway costs a round trip and an error the viewer
 * cannot act on. The rejection is swallowed here rather than left to a
 * synchronous catch, which never sees it.
 */
function recordWatchProgressSafe(video: VideoData | null, positionSec: number, durationSec: number): void {
  if (!video || !(durationSec > 0) || !(positionSec > 0)) return
  if (!hasPersonalStore()) return
  const coordinates = watchCoordinatesOf(video)
  if (!coordinates) return
  const loose = video as VideoData & { thumbnail?: string | null }
  void watchHistory.recordProgress({
    ...coordinates,
    publicBeeKey: video.publicBeeKey || null,
    title: video.title || 'Untitled',
    channelName: video.channel?.name,
    thumbnailUrl: video.thumbnailUrl || loose.thumbnail || null,
    positionSec,
    durationSec,
  }).catch(() => {})
}

let ACTIVE_VIDEO_PLAYER_CONTROLLER_ID: number | null = null
let NEXT_VIDEO_PLAYER_CONTROLLER_ID = 1

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
import { classifyPlayerError } from './video-player/playback-errors'

/**
 * A playback failure the viewer needs to be told about, in the one playback
 * error vocabulary. `terminal` means no automatic path can change the outcome,
 * so the session stops instead of re-asserting playback forever.
 */
export type PlaybackFailure = {
  code: string
  message: string
  terminal: boolean
}

interface VideoPlayerContextType {
  // Current video
  currentVideo: VideoData | null
  videoUrl: string | null

  // Player state
  isPlaying: boolean
  isLoading: boolean
  playbackError: PlaybackFailure | null
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

  playerRef: React.MutableRefObject<PlayerPort | null>

  // Actions
  loadAndPlayVideo: (video: VideoData, url: string) => void
  setAmbientVideoContext: (video: VideoData | null, url?: string | null, options?: { keepHidden?: boolean }) => void
  pauseVideo: () => void
  resumeVideo: () => void
  closeVideo: () => void
  enterBackgroundAudio: () => void
  suppressForegroundRestoreOnce: () => void
  suppressForegroundRestoreFor: (ms: number) => void
  clearLastClosedVideo: () => void
  minimizePlayer: (optionsOrEvent?: unknown) => void
  maximizePlayer: (source?: string) => void
  maximizedForPipRef: React.MutableRefObject<boolean>
  seekTo: (time: number) => void
  seekBy: (delta: number) => void
  setPlaybackRate: (rate: number) => void
  setVideoStats: (stats: VideoStats | null) => void
  setIsLoading: (loading: boolean) => void

  onProgress: (data: { currentTime: number; duration: number }) => void
  onLoaded: () => void
  onPlaying: () => void
  onPaused: () => void
  onBuffering: (data: { isBuffering: boolean }) => void
  onEnded: () => void
  onError: (error: unknown) => void
  onVideoStateChange: (data: { type?: string; mVideoWidth?: number; mVideoHeight?: number }) => void
}

type VideoPlayerSessionContextType = Pick<VideoPlayerContextType,
  | 'currentVideo'
  | 'videoUrl'
  | 'isPlaying'
  | 'isLoading'
  | 'playbackError'
  | 'playerMode'
  | 'videoStats'
  | 'playbackSession'
  | 'isInPipMode'
  | 'setIsInPipMode'
  | 'pipWindowSize'
  | 'setPipWindowSize'
  | 'shouldEnablePip'
  | 'videoAspectRatio'
  | 'playerRef'
>

type VideoPlayerProgressContextType = Pick<VideoPlayerContextType,
  | 'currentTime'
  | 'duration'
  | 'progress'
  | 'playbackRate'
  | 'seekPosition'
>

type VideoPlayerActionsContextType = Pick<VideoPlayerContextType,
  | 'loadAndPlayVideo'
  | 'setAmbientVideoContext'
  | 'pauseVideo'
  | 'resumeVideo'
  | 'closeVideo'
  | 'enterBackgroundAudio'
  | 'suppressForegroundRestoreOnce'
  | 'suppressForegroundRestoreFor'
  | 'clearLastClosedVideo'
  | 'minimizePlayer'
  | 'maximizePlayer'
  | 'maximizedForPipRef'
  | 'seekTo'
  | 'seekBy'
  | 'setPlaybackRate'
  | 'setVideoStats'
  | 'setIsLoading'
  | 'onProgress'
  | 'onLoaded'
  | 'onPlaying'
  | 'onPaused'
  | 'onBuffering'
  | 'onEnded'
  | 'onError'
  | 'onVideoStateChange'
>

const VideoPlayerContext = createContext<VideoPlayerContextType | null>(null)
const VideoPlayerSessionContext = createContext<VideoPlayerSessionContextType | null>(null)
const VideoPlayerProgressContext = createContext<VideoPlayerProgressContextType | null>(null)
const VideoPlayerActionsContext = createContext<VideoPlayerActionsContextType | null>(null)

function useRequiredVideoContext<T>(ctx: T | null, hookName: string): T {
  if (!ctx) throw new Error(`${hookName} must be used within VideoPlayerProvider`)
  return ctx
}

export function useVideoPlayerContext() {
  return useRequiredVideoContext(useContext(VideoPlayerContext), 'useVideoPlayerContext')
}

export function useVideoPlayerSession() {
  return useRequiredVideoContext(useContext(VideoPlayerSessionContext), 'useVideoPlayerSession')
}

export function useVideoPlayerProgress() {
  return useRequiredVideoContext(useContext(VideoPlayerProgressContext), 'useVideoPlayerProgress')
}

export function useVideoPlayerActions() {
  return useRequiredVideoContext(useContext(VideoPlayerActionsContext), 'useVideoPlayerActions')
}

/**
 * The actions when a player is mounted, null when one is not. A route that only
 * hands a prepared URL to the player still has to render without it - server
 * rendering and route-entry checks mount no provider.
 */
export function useOptionalVideoPlayerActions() {
  return useContext(VideoPlayerActionsContext)
}

interface VideoPlayerProviderProps {
  children: ReactNode
}

export function VideoPlayerProvider({ children }: VideoPlayerProviderProps) {
  const controllerIdRef = useRef<number>(NEXT_VIDEO_PLAYER_CONTROLLER_ID++)
  const [isPrimaryController, setIsPrimaryController] = useState(false)
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
  const [playbackError, setPlaybackError] = useState<PlaybackFailure | null>(null)
  const playerMode: PlayerMode =
    state.mode === 'mini'
      ? 'mini'
      : state.mode === 'hidden' || state.mode === 'background_audio'
        ? 'hidden'
        : 'fullscreen'
  const [videoStats, setVideoStats] = useState<VideoStats | null>(null)
  const [playbackSession, setPlaybackSession] = useState(0)
  const isInPipMode = state.mode === 'pip_active' || state.mode === 'pip_entering'
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

  const playerRef = useRef<PlayerPort | null>(null)
  const getPlayerPort = useCallback(() => resolvePlayerPort(playerRef.current), [])

  // Ref for current video - updated synchronously to avoid race conditions with stats events
  const currentVideoRef = useRef<VideoData | null>(null)
  const lastHistoryWriteRef = useRef(0)

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
  // Suppress the "Connecting to P2P..." loading overlay during transitions where
  // the player was already playing (PiP exit, background-audio return). ExoPlayer
  // emits brief buffering events during surface reattach that are not real stalls.
  // Set true on transition, cleared by the next onPlaying event.
  const suppressTransientBufferingRef = useRef(false)
  const pipExitReassertLoggedAtRef = useRef(0)
  const iosIgnorePausedUntilRef = useRef(0)
  const pendingSeekSecondsRef = useRef<number | null>(null)
  const lastPlaybackStartKeyRef = useRef<string | null>(null)
  const lastPlaybackStartAtRef = useRef(0)
  const startupAutoplayGuardRef = useRef<{ key: string; until: number } | null>(null)
  const queuedPlaybackStartRef = useRef<{ video: VideoData; url: string; source: string } | null>(null)
  const playbackStartDrainTimerRef = useRef<NodeJS.Timeout | null>(null)
  const startupAutoplayReassertTimersRef = useRef<NodeJS.Timeout[]>([])
  const playbackStartInFlightRef = useRef(false)
  const playbackStartCooldownUntilRef = useRef(0)
  const seekConfirmRef = useRef<{ targetSeconds: number; startedAt: number } | null>(null)
  const seekClearTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const closingVideoRef = useRef(false)

  // Background playback tracking refs
  const wasPlayingWhenBackgroundedRef = useRef(state.wasPlayingWhenBackgrounded)
  const isBackgroundedRef = useRef(false)
  const isInPipModeRef = useRef(false)
  const lastPipEventTimeRef = useRef(0)
  const modeBeforePipRef = useRef<ModeBeforePip>(state.modeBeforePip)
  const wasPlayingWhenPipEnteredRef = useRef(state.wasPlayingWhenPipEntered)
  const playerModeRef = useRef<PlayerMode>(playerMode)  // Sync ref for PiP handler
  const maximizedForPipRef = useRef(false)  // True when we expanded mini→fullscreen for PiP
  // Set to true when closing session for background-audio so the hidden-mode useEffect
  // knows NOT to clear the session (the PiP window continues playing with notification).
  const isClosingForBackgroundAudioRef = useRef(false)
  const pipTransitionTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const pipTransitionInFlightRef = useRef(false)  // True during PiP exit→fullscreen transition window
  const previousStateModeRef = useRef(state.mode)
  const currentTimeRef = useRef(0)
  const durationRef = useRef(0)
  const isPlayingRef = useRef(false)
  const isBufferingRef = useRef(false)
  const playbackRateRef = useRef(1)
  
  // Throttled UI state update interval (ms) - ~4fps for seek bar updates
  const UI_UPDATE_INTERVAL = 250
  const lastUIUpdateRef = useRef(0)

  useEffect(() => {
    const controllerId = controllerIdRef.current
    let cancelled = false

    const tryAcquireController = async () => {
      // MediaSession.isInPlayerActivity() removed - using react-native-video native PiP
      const shouldPreferThisController = false

      if (cancelled) return

      const activeId = ACTIVE_VIDEO_PLAYER_CONTROLLER_ID
      if (shouldPreferThisController || activeId === null || activeId === controllerId) {
        ACTIVE_VIDEO_PLAYER_CONTROLLER_ID = controllerId
        setIsPrimaryController(true)
        return
      }
      setIsPrimaryController(false)
    }

    void tryAcquireController()
    const timer = setInterval(() => {
      void tryAcquireController()
    }, 300)

    return () => {
      cancelled = true
      clearInterval(timer)
      if (ACTIVE_VIDEO_PLAYER_CONTROLLER_ID === controllerId) {
        ACTIVE_VIDEO_PLAYER_CONTROLLER_ID = null
      }
    }
  }, [])

  // Refs are now the source of truth for high-frequency values
  // State is only updated at throttled intervals for UI components
  useEffect(() => {
    isPlayingRef.current = isPlaying
    // Keep the backend/network warm for the lifetime of an open local video
    // session, not just while transport is actively playing. PiP/background
    // transitions can transiently flip isPlaying/isInPipMode false and cause
    // mistaken suspendNetwork() calls, which then surface as reconnect overlays
    // when returning to the video.
    _playbackActiveEmitter.set(currentVideo !== null)
  }, [isPlaying, currentVideo])
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
      getPlayerPort()?.play?.()
    } catch (e) {
      if (__DEV__) console.warn('[VideoPlayerContext] Failed to reassert play after PiP exit:', reason, e)
    }

    // Avoid log spam while still surfacing what happened.
    if (__DEV__ && now - pipExitReassertLoggedAtRef.current > 1000) {
      pipExitReassertLoggedAtRef.current = now
      console.log('[VideoPlayerContext] Reasserting play after PiP exit:', reason)
    }
  }, [])

  const setDesiredPlaying = useCallback((nextIsPlaying: boolean) => {
    isPlayingRef.current = nextIsPlaying
    setIsPlaying(nextIsPlaying)
  }, [])
  const clearStartupAutoplayGuard = useCallback(() => {
    startupAutoplayGuardRef.current = null
    for (const timer of startupAutoplayReassertTimersRef.current) {
      clearTimeout(timer)
    }
    startupAutoplayReassertTimersRef.current = []
  }, [])

  const scheduleStartupAutoplayReassertions = useCallback((playbackKey: string) => {
    for (const timer of startupAutoplayReassertTimersRef.current) {
      clearTimeout(timer)
    }
    startupAutoplayReassertTimersRef.current = []

    for (const delayMs of [50, 150, 350, 750]) {
      const timer = setTimeout(() => {
        const startupGuard = startupAutoplayGuardRef.current
        if (
          !startupGuard ||
          startupGuard.key !== playbackKey ||
          Date.now() > startupGuard.until ||
          lastPlaybackStartKeyRef.current !== playbackKey
        ) {
          return
        }
        setDesiredPlaying(true)
        try {
          getPlayerPort()?.play?.()
        } catch {}
      }, delayMs)
      startupAutoplayReassertTimersRef.current.push(timer)
    }
  }, [getPlayerPort, setDesiredPlaying])

  const restoreLastClosedVideo = useCallback((reason: string) => {
    if (!lastClosedVideoRef.current || !lastClosedUrlRef.current) return false
    if (__DEV__) console.log('[VideoPlayerContext] Restoring last closed video:', reason)
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
    setPlaybackError(null)
    if (lastClosedTimeRef.current !== null) {
      pendingSeekSecondsRef.current = lastClosedTimeRef.current
    }
    setDesiredPlaying(true)
    return true
  }, [dispatch, setDesiredPlaying])

  const forceReloadPlayback = useCallback((reason: string) => {
    const video = currentVideoRef.current
    const url = videoUrlRef.current
    if (!video || !url) return false
    if (__DEV__) console.log('[VideoPlayerContext] Forcing playback reload:', reason)
    setPlaybackSession((prev) => prev + 1)
    dispatch({
      type: 'FORCE_RELOAD_PLAYBACK',
      source: 'forceReloadPlayback',
      video,
      url,
      resumeSeconds: currentTimeRef.current,
    })
    setIsLoading(true)
    setPlaybackError(null)
    pendingSeekSecondsRef.current = currentTimeRef.current
    setDesiredPlaying(true)
    return true
  }, [dispatch, setDesiredPlaying])

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

  const closeSession = useCallback((
    reason: 'user' | 'remote-stop' | 'android-minimize-close' | 'pip-close' | 'background-audio' = 'user',
    opts?: { preserveLastClosed?: boolean },
  ) => {
    if (__DEV__) console.log('[VideoPlayerContext] Closing session:', reason)

    closingVideoRef.current = true
    clearStartupAutoplayGuard()

    queuedPlaybackStartRef.current = null
    playbackStartInFlightRef.current = false
    playbackStartCooldownUntilRef.current = 0
    if (playbackStartDrainTimerRef.current) {
      clearTimeout(playbackStartDrainTimerRef.current)
      playbackStartDrainTimerRef.current = null
    }

    if (seekClearTimeoutRef.current) {
      clearTimeout(seekClearTimeoutRef.current)
      seekClearTimeoutRef.current = null
    }
    seekConfirmRef.current = null

    pipExitShouldResumeRef.current = false
    pipExitResumeUntilRef.current = 0
    pipTransitionInFlightRef.current = false

    // For background-audio mode, do NOT stop/pause the native player (ExoPlayer).
    // The PiP window continues playing natively and we must not interfere with it.
    if (reason !== 'background-audio') {
      try {
        getPlayerPort()?.stop?.()
        getPlayerPort()?.pause?.()
      } catch {}
    }

    suppressForegroundRestoreRef.current = true
    const suppressUntil = Date.now() + 2000
    if (suppressUntil > suppressForegroundRestoreUntilRef.current) {
      suppressForegroundRestoreUntilRef.current = suppressUntil
    }

    // When closing for background-audio, preserve the last-closed video so the
    // user can seamlessly return to it when the app reopens.
    if (opts?.preserveLastClosed) {
      // keep lastClosedVideoRef, lastClosedUrlRef, lastClosedTimeRef as-is
    } else {
      lastClosedVideoRef.current = null
      lastClosedUrlRef.current = null
      lastClosedTimeRef.current = null
    }
    startupAutoplayGuardRef.current = null
    currentVideoRef.current = null
    videoUrlRef.current = null

    // When entering background-audio mode, do NOT stop the desired playing state —
    // the PiP window's ExoPlayer is still playing and we need to stay in sync.
    if (reason !== 'background-audio') {
      setDesiredPlaying(false)
    }
    isClosingForBackgroundAudioRef.current = reason === 'background-audio'
    dispatch({
      type: 'CLOSE_VIDEO',
      source:
        reason === 'remote-stop'
          ? 'remoteStopClose'
          : reason === 'android-minimize-close'
            ? 'androidMinimizeClose'
            : reason === 'pip-close'
              ? 'pipClose'
              : 'closeVideo',
    })
    setVideoStats(null)
    setCurrentTime(0)
    setDuration(0)

    // Reset the closing flag so foreground restore attempts (e.g. after
    // background-audio close) can proceed.  The flag was set above to prevent
    // a transient APP_FOREGROUND (fired during the same close) from
    // incorrectly restoring before the close is committed.
    closingVideoRef.current = false
  }, [clearStartupAutoplayGuard, dispatch, setDesiredPlaying])

  const closeVideo = useCallback(() => {
    closeSession('user')
  }, [closeSession])

  const enterBackgroundAudio = useCallback(() => {
    if (!currentVideoRef.current || !videoUrlRef.current) return
    if (__DEV__) console.log('[VideoPlayerContext] Entering background audio mode')
    // Transition to background_audio mode WITHOUT unmounting the Video component.
    // This keeps state.video and state.url intact so ExoPlayer continues playing
    // via VideoPlaybackService. When the app returns to foreground, the state machine
    // transitions background_audio → fullscreen via APP_FOREGROUND, and the player
    // resumes seamlessly from the current position (no remount, no seek).
    dispatch({ type: 'ENTER_BACKGROUND_AUDIO', source: 'enterBackgroundAudio' })
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

  // Activate media session while a video is loaded (keeps lock screen controls visible)
  useEffect(() => {
    // react-native-video's VideoPlaybackService handles MediaSession natively
  }, [currentVideo])

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
      isClosingForBackgroundAudioRef.current = false
      return
    }

    if (nextMode === 'fullscreen') {
      // Suppress transient buffering overlay when resuming from PiP or background audio.
      // ExoPlayer re-attaches its surface and may emit brief buffering events that
      // are not real P2P stalls.
      if (previousMode === 'pip_active' || previousMode === 'pip_exiting' || previousMode === 'background_audio') {
        suppressTransientBufferingRef.current = true
        setIsLoading(false)
      }
      if (pipExitShouldResumeRef.current) {
        pipExitShouldResumeRef.current = false
        reassertNativePlayAfterPipExit('mode-fullscreen-transition')
      }
    }

    if (previousMode === 'pip_active' && nextMode !== 'pip_active') {
      const shouldResume = pipExitShouldResumeRef.current || state.wasPlayingWhenPipEntered
      if (shouldResume) {
        reassertNativePlayAfterPipExit('pip-active-exit-transition')
      }
    }
  }, [reassertNativePlayAfterPipExit, state.mode, state.wasPlayingWhenPipEntered])

   // AppState listener for background/foreground transitions (mobile only)
   useEffect(() => {
     if (Platform.OS === 'web') return
     if (!isPrimaryController) return

        const handleAppStateChange = (nextState: AppStateStatus) => {
        const goingToBackground = nextState === 'background' || nextState === 'inactive'
        const comingToForeground = nextState === 'active'

      if (goingToBackground && !isBackgroundedRef.current) {
        isBackgroundedRef.current = true
        const wasPlaying = isPlayingRef.current
        const modeBeforeBackground = state.mode
        const skipAppBackgroundDispatchForPip =
          Platform.OS === 'android' && (isInPipModeRef.current || pipTransitionInFlightRef.current)

        if (!skipAppBackgroundDispatchForPip) {
          dispatch({
            type: 'APP_BACKGROUND',
            source: 'appStateBackgroundMiniAutoMaximizeForPip',
            appState: nextState,
            isPlaying: wasPlaying,
          })
        }
        if (__DEV__) {
          console.log(
            '[VideoPlayerContext] Going to background, wasPlaying:',
            wasPlaying,
            'playerMode:',
            playerModeRef.current,
            'rawMode:',
            modeBeforeBackground,
          )
        }
       } else if (comingToForeground && isBackgroundedRef.current) {
         isBackgroundedRef.current = false
         maximizedForPipRef.current = false
          const wasInPip = isInPipModeRef.current || pipTransitionInFlightRef.current
          // Suppress transient buffering overlay when returning from background.
          // The player was already running — any buffering is surface reattach, not a real stall.
          suppressTransientBufferingRef.current = true
          setIsLoading(false)
          if (__DEV__) {
            console.log('[VideoPlayerContext] Coming to foreground, wasPlaying:', wasPlayingWhenBackgroundedRef.current, 'wasInPiP:', wasInPip, 'pipInFlight:', pipTransitionInFlightRef.current)
          }

         // IMPORTANT: Don't clear PiP state on foreground if we were in PiP.
         // When returning from PiP, Android can deliver the AppState "active" event
         // before the native PiP exit callback reaches JS. Clearing the ref here
         // makes the PiP exit handler think we were never in PiP, so it won't
         // restore playback state (leading to unintended pauses).
          if (!wasInPip) {
            if (__DEV__) console.log('[VideoPlayerContext] Clearing PiP state on foreground')
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

        // The native player kept playing through the background period
        // (staysActiveInBackground + media notification). Reopening the app —
        // most commonly by tapping the playback notification — should surface
        // the player page rather than leave the session in the mini player.
        const resumedWithBackgroundPlayback =
          !wasInPip && Boolean(currentVideoRef.current) && wasPlayingWhenBackgroundedRef.current

        const skipAppForegroundDispatchForPip = Platform.OS === 'android' && wasInPip
        // Also skip the foreground dispatch if we have an active video still playing.
        // When PiP silently fails (wasInPip=false but video is still playing),
        // dispatching APP_FOREGROUND can transition playerMode to 'hidden' which
        // tears down the video unnecessarily.
        const skipForActivePlayback =
          Platform.OS === 'android' &&
          state.mode === 'fullscreen' &&
          !wasInPip &&
          currentVideoRef.current &&
          wasPlayingWhenBackgroundedRef.current
        if (!skipAppForegroundDispatchForPip && !skipForActivePlayback) {
          dispatch({
            type: 'APP_FOREGROUND',
            source: 'appStateForegroundHiddenRestore',
            appState: 'active',
            wasInPip,
            suppressRestore: shouldSuppressRestore,
            resumedWithBackgroundPlayback,
          })
        }

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

         // Foreground seek "nudge" re-syncs the native player after backgrounding,
         // but only when background playback actually stopped. If the player kept
         // playing the whole time (background audio via the media notification),
         // seeking forces ExoPlayer to rebuffer the P2P stream — an audible gap on
         // resume — and can jump backwards when the JS-side position is stale.
         if (!wasInPip && wasPlayingWhenBackgroundedRef.current && !isPlayingRef.current && durationRef.current > 0) {
           const seekValue = currentTimeRef.current / durationRef.current
           setSeekPosition(seekValue)
           setTimeout(() => setSeekPosition(undefined), 100)
         }
        }
      }

     const subscription = AppState.addEventListener('change', handleAppStateChange)
     return () => subscription.remove()
    }, [dispatch, forceReloadPlayback, isPrimaryController, restoreLastClosedVideo, state.mode])

  // Listen for native PiP close event (Android) — sync JS pause state
  useEffect(() => {
    if (Platform.OS !== 'android') return
    const closeSub = DeviceEventEmitter.addListener('onPipClosed', () => {
      if (__DEV__) console.log('[VideoPlayerContext] PiP closed (X button) — pausing')
      setDesiredPlaying(false)
    })
    return () => closeSub.remove()
  }, [setDesiredPlaying])

  // MediaSession listeners - removed
  // react-native-video handles PiP, remote commands, and audio interruptions natively via showNotificationControls=true
  // PiP state is now managed via react-native-video's onPictureInPictureStatusChanged callback
  useEffect(() => {
     if (!isPrimaryController) return
     const unsubscribe = _videoStatsEventEmitter.subscribe((driveKey, videoPath, stats) => {
       // Use ref for synchronous access (state may not be updated yet)
       const video = currentVideoRef.current
       if (__DEV__) {
         console.log('[VideoPlayerContext] Stats event received, checking match:', {
           videoPath,
           driveKey,
           currentPath: video?.path,
           currentKey: video?.channelKey
         })
       }
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

      const currentKeyRaw = (video as any)?.channelKey || (video as any)?.driveKey || null
      const currentKey =
        typeof currentKeyRaw === 'string' && currentKeyRaw.trim().length > 0 && currentKeyRaw !== 'unknown'
          ? currentKeyRaw
          : null
       const currentId = extractVideoId((video as any)?.id) ?? extractVideoId(video?.path)
       const incomingId = extractVideoId(videoPath)

      const keysCompatible = !currentKey || !driveKey || currentKey === driveKey
      const samePath = video?.path === videoPath
      const sameId = Boolean(currentId && incomingId && currentId === incomingId)
      const sameVideo = Boolean(video) && (samePath || sameId) && (keysCompatible || sameId)

       if (sameVideo) {
         if (__DEV__) console.log('[VideoPlayerContext] Received stats event:', stats.progress + '%')
        setVideoStats(stats)
        if (typeof stats.progress === 'number' && stats.progress > 0) {
          // Once the backend is serving bytes, stop showing the generic
          // "Connecting to P2P network" gate even if the native player has not
          // emitted onLoad/onReadyForDisplay yet.
          setIsLoading(false)
          isBufferingRef.current = false
        }
      }
     })
     return () => { unsubscribe() }
   }, [isPrimaryController])

  const performPlaybackStartNow = useCallback((video: VideoData, url: string, source: string) => {
    const playbackKey = `${video.channelKey || ''}:${video.id || video.path || ''}:${url}`
    const now = Date.now()
    if (
      lastPlaybackStartKeyRef.current === playbackKey &&
      now - lastPlaybackStartAtRef.current < 1000
    ) {
      if (__DEV__) {
        console.log('[VideoPlayerContext] Skipping duplicate playback start:', source)
      }
      return
    }
    lastPlaybackStartKeyRef.current = playbackKey
    lastPlaybackStartAtRef.current = now
    currentVideoRef.current = video
    videoUrlRef.current = url
    startupAutoplayGuardRef.current = {
      key: playbackKey,
      until: now + STARTUP_AUTOPLAY_GUARD_MS,
    }
    scheduleStartupAutoplayReassertions(playbackKey)

    currentVideoRef.current = video
    videoUrlRef.current = url
    startupAutoplayGuardRef.current = {
      key: playbackKey,
      until: now + STARTUP_AUTOPLAY_GUARD_MS,
    }
    // Starting playback is a new watch, and it is the only thing that lets
    // progress reach coordinates the viewer has deleted: a title removed from
    // history and then deliberately played again is recorded once more, while
    // the session that was already running when they removed it is not.
    const watchCoordinates = watchCoordinatesOf(video)
    if (watchCoordinates) watchHistory.beginWatchSession(watchCoordinates)
    setDesiredPlaying(true)
    try {
      getPlayerPort()?.stop?.()
      getPlayerPort()?.pause?.()
    } catch {}
    // MediaSession.clearPendingPlayerLaunchPayload removed - using react-native-video native PiP
    closingVideoRef.current = false
    pipExitShouldResumeRef.current = false
    pipExitExpectedPlayingRef.current = false
    pipExitResumeUntilRef.current = 0
    suppressTransientBufferingRef.current = false
    pipTransitionInFlightRef.current = false
    isInPipModeRef.current = false
    setPlaybackSession((prev) => prev + 1)
    dispatch({ type: 'LOAD_VIDEO', source: 'loadAndPlayVideo', video, url })
    setVideoStats(null)
    const cachedStats = _videoStatsEventEmitter.getLatest(video.channelKey, video.path || video.id)
    if (cachedStats) {
      setVideoStats(cachedStats)
    }
    setIsLoading(true)
    setPlaybackError(null)
    setCurrentTime(0)
    setDuration(0)
    setVideoAspectRatio(null)
    if (Platform.OS === 'ios') {
      iosIgnorePausedUntilRef.current = Date.now() + 1500
    }
    _videoLoadEventEmitter.emit(video)
  }, [dispatch, scheduleStartupAutoplayReassertions, setDesiredPlaying])

  const drainQueuedPlaybackStart = useCallback(() => {
    if (playbackStartInFlightRef.current) return
    const request = queuedPlaybackStartRef.current
    if (!request) return

    const now = Date.now()
    const cooldownRemaining = playbackStartCooldownUntilRef.current - now
    if (cooldownRemaining > 0) {
      if (playbackStartDrainTimerRef.current) {
        clearTimeout(playbackStartDrainTimerRef.current)
      }
      playbackStartDrainTimerRef.current = setTimeout(() => {
        playbackStartDrainTimerRef.current = null
        drainQueuedPlaybackStart()
      }, Math.min(250, cooldownRemaining))
      return
    }

    queuedPlaybackStartRef.current = null
    playbackStartInFlightRef.current = true
    try {
      performPlaybackStartNow(request.video, request.url, request.source)
    } finally {
      playbackStartInFlightRef.current = false
      playbackStartCooldownUntilRef.current = Date.now() + 250
      if (queuedPlaybackStartRef.current) {
        if (playbackStartDrainTimerRef.current) {
          clearTimeout(playbackStartDrainTimerRef.current)
        }
        playbackStartDrainTimerRef.current = setTimeout(() => {
          playbackStartDrainTimerRef.current = null
          drainQueuedPlaybackStart()
        }, 260)
      }
    }
  }, [performPlaybackStartNow])

  const startInActivityPlayback = useCallback((video: VideoData, url: string, source: string = 'direct') => {
    queuedPlaybackStartRef.current = { video, url, source }
    if (playbackStartDrainTimerRef.current) {
      clearTimeout(playbackStartDrainTimerRef.current)
      playbackStartDrainTimerRef.current = null
    }
    drainQueuedPlaybackStart()
  }, [drainQueuedPlaybackStart])

  useEffect(() => {
    return () => {
      if (playbackStartDrainTimerRef.current) {
        clearTimeout(playbackStartDrainTimerRef.current)
        playbackStartDrainTimerRef.current = null
      }
      clearStartupAutoplayGuard()
    }
  }, [clearStartupAutoplayGuard])

  // Load and play a new video (triggers overlay to fullscreen)
  const loadAndPlayVideo = useCallback((video: VideoData, url: string) => {
    if (__DEV__) console.log('[VideoPlayerContext] Loading video:', video.title)

    startInActivityPlayback(video, url, 'direct-load')
  }, [startInActivityPlayback])

  const setAmbientVideoContext = useCallback((video: VideoData | null, url: string | null = null, options: { keepHidden?: boolean } = {}) => {
    const currentKey = currentVideoRef.current
      ? `${currentVideoRef.current.channelKey || ''}:${currentVideoRef.current.id || currentVideoRef.current.path || ''}`
      : null
    const nextKey = video ? `${video.channelKey || ''}:${video.id || video.path || ''}` : null

    currentVideoRef.current = video
    videoUrlRef.current = url
    dispatch({
      type: 'SET_AMBIENT_VIDEO_CONTEXT',
      source: 'setAmbientVideoContext',
      video,
      url,
      keepHidden: options.keepHidden,
    })

    if (video && currentKey !== nextKey) {
      setVideoStats(null)
      setCurrentTime(0)
      setDuration(0)
      setVideoAspectRatio(null)
      _videoLoadEventEmitter.emit(video)
    }
  }, [dispatch])

  // Pause video
  const pauseVideo = useCallback(() => {
    if (__DEV__) console.log('[VideoPlayerContext] Pausing video')
    clearStartupAutoplayGuard()
    if (Platform.OS === 'web') {
      try {
        getPlayerPort()?.pause?.()
      } catch {}
    }
    setDesiredPlaying(false)
  }, [clearStartupAutoplayGuard, setDesiredPlaying])

  const resumeVideo = useCallback(() => {
    if (__DEV__) console.log('[VideoPlayerContext] Resuming video')

    // On iOS, do a seek while still paused to reinitialize audio, then resume
    // This avoids visible jitter since video isn't playing during the seek
    if (Platform.OS === 'ios' && durationRef.current > 0) {
      const seekValue = currentTimeRef.current / durationRef.current
      setSeekPosition(seekValue)

      setTimeout(() => {
        setSeekPosition(undefined)
        setDesiredPlaying(true)
      }, 100)
    } else {
      setDesiredPlaying(true)
      if (Platform.OS === 'web') {
        try {
          getPlayerPort()?.play?.()
        } catch {}
      }
    }
  }, [setDesiredPlaying])

  const minimizePlayer = useCallback((_optionsOrEvent?: unknown) => {
    if (Platform.OS === 'android') {
      const currentVideo = currentVideoRef.current
      const currentUrl = videoUrlRef.current
      if (!currentVideo || !currentUrl) {
        if (__DEV__) console.log('[VideoPlayerContext] No active video to minimize on Android')
        return
      }

      // Using react-native-video native PiP - no longer using split PlayerActivity
      if (__DEV__) console.log('[VideoPlayerContext] Minimizing to in-app mini player')
      dispatch({
        type: 'MINIMIZE',
        source: 'minimizePlayer',
        platform: 'android',
      })
      return
    }

    if (__DEV__) console.log('[VideoPlayerContext] Minimizing to in-app mini player')
    dispatch({
      type: 'MINIMIZE',
      source: 'minimizePlayer',
      platform: Platform.OS === 'web' ? 'web' : 'ios',
    })
  }, [dispatch, setDesiredPlaying])

  // Maximize from mini player
  const maximizePlayer = useCallback((source: string = 'unknown') => {
    if (__DEV__) console.log('[VideoPlayerContext] Maximizing player from:', source)
    dispatch({ type: 'MAXIMIZE', source: 'maximizePlayer' })
  }, [dispatch, setDesiredPlaying])

  const setIsInPipMode = useCallback((value: boolean) => {
    if (Platform.OS !== 'android') {
      isInPipModeRef.current = value
      return
    }

    const wasInPip = isInPipModeRef.current
    const wasPlaying = isPlayingRef.current

    if (value) {
      isInPipModeRef.current = true
      dispatch({
        type: 'PIP_ENTERED_ANDROID',
        source: 'androidPipExitRestorePreviousMode',
        platform: 'android',
        dimensions: pipWindowSizeRef.current ?? undefined,
        isPlaying: wasPlaying,
      })
      return
    }

    // PiP exit: delay clearing the ref so the AppState listener still sees
    // isInPipModeRef=true during the PiP exit animation. Android briefly
    // reports background/inactive state during this animation — if the ref
    // is already false, the AppState handler would pause playback.
    if (wasInPip) {
      setTimeout(() => { isInPipModeRef.current = false }, 500)
    } else {
      isInPipModeRef.current = false
    }

    if (wasInPip && wasPlaying) {
      pipExitExpectedPlayingRef.current = true
      pipExitResumeUntilRef.current = Date.now() + 3000
      try { getPlayerPort()?.play?.() } catch {}
    }

    dispatch({
      type: 'PIP_EXITED_ANDROID',
      source: 'androidPipExitRestorePreviousMode',
      platform: 'android',
      wasInPip,
      shouldResume: wasPlaying,
      restoreMode: modeBeforePipRef.current,
      dimensions: pipWindowSizeRef.current ?? undefined,
    })
  }, [dispatch, setDesiredPlaying])

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

    // Prefer imperative seek on all platforms when the player ref is ready.
    // The ratio-based seekPosition pipeline is kept only as a fallback for
    // cases where the native player isn't mounted/ready yet.
    let didImperativeSeek = false
    try {
      if (typeof getPlayerPort()?.seek === 'function') {
        getPlayerPort()?.seek(clampedTime)
        didImperativeSeek = true
      }
    } catch {}

    if (!didImperativeSeek) {
      const seekValue = clampedTime / dur
      if (__DEV__) console.log('[VideoPlayerContext] Fallback seekTo via seekPosition:', clampedTime, 'seconds, seek prop:', seekValue)
      setSeekPosition(seekValue)
    } else {
      setSeekPosition(undefined)
    }

    currentTimeRef.current = clampedTime
    setCurrentTime(clampedTime)
    startSeekConfirm(clampedTime)
  }, [startSeekConfirm])

  const seekBy = useCallback((delta: number) => {
    const dur = durationRef.current
    if (dur <= 0) return
    const newTime = Math.max(0, Math.min(currentTimeRef.current + delta, dur))

    let didImperativeSeek = false
    try {
      if (typeof getPlayerPort()?.seek === 'function') {
        getPlayerPort()?.seek(newTime)
        didImperativeSeek = true
      }
    } catch {}

    if (!didImperativeSeek) {
      const seekValue = newTime / dur
      if (__DEV__) console.log('[VideoPlayerContext] Fallback seekBy via seekPosition:', delta, 'to:', newTime, 'seek prop:', seekValue)
      setSeekPosition(seekValue)
    } else {
      setSeekPosition(undefined)
    }

    currentTimeRef.current = newTime
    setCurrentTime(newTime)
    startSeekConfirm(newTime)
  }, [startSeekConfirm])

  // Set playback speed
  const setPlaybackRate = useCallback((rate: number) => {
    if (__DEV__) console.log('[VideoPlayerContext] Setting playback rate:', rate)
    setPlaybackRateState(rate)
  }, [])

  const onProgress = useCallback((data: { currentTime: number; duration: number }) => {
    if (Platform.OS === 'android' && pipExitExpectedPlayingRef.current && !isInPipModeRef.current) {
      if (__DEV__) console.log('[VideoPlayerContext] PiP exit resume confirmed via progress')
      pipExitShouldResumeRef.current = false
      pipExitExpectedPlayingRef.current = false
      pipExitResumeUntilRef.current = 0
    }
    const timeS = data.currentTime / 1000
    const durationS = data.duration > 0 ? data.duration / 1000 : 0

    if (durationS > 0) {
      durationRef.current = durationS
    }

    const now = Date.now()
    const pending = seekConfirmRef.current
    const waitingForSeekCatchup = pending && Math.abs(timeS - pending.targetSeconds) >= 0.75 && (now - pending.startedAt) <= 1500

    // While waiting for a seek to land, ignore stale progress updates so the UI
    // doesn't briefly jump back to the old position before the player catches up.
    if (!waitingForSeekCatchup) {
      currentTimeRef.current = timeS
    }

    // Persist watch progress (throttled) so Continue Watching can resume. There
    // is no second write: the viewer's own store is the only destination.
    if (durationS > 0 && !waitingForSeekCatchup && now - lastHistoryWriteRef.current >= WATCH_HISTORY_WRITE_INTERVAL_MS) {
      lastHistoryWriteRef.current = now
      recordWatchProgressSafe(currentVideoRef.current, timeS, durationS)
    }

    if (data.currentTime > 0) {
      if (Platform.OS === 'ios') {
        iosIgnorePausedUntilRef.current = 0
      }
      setIsLoading((prev) => (prev ? false : prev))
    }

    // Confirm any pending seek once progress is close to the target.
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
      setCurrentTime(waitingForSeekCatchup && pending ? pending.targetSeconds : timeS)
      if (durationS > 0) {
        setDuration(durationS)
      }
    }
    // MediaSession playback state updates removed - react-native-video handles this natively
  }, [])

  const onLoaded = useCallback(() => {
    if (__DEV__) console.log('[VideoPlayerContext] Player loaded')
    isBufferingRef.current = false
    setIsLoading(false)
  }, [])

  const onPlaying = useCallback(() => {
    if (__DEV__) console.log('[VideoPlayerContext] Player playing')
    clearStartupAutoplayGuard()
    if (Platform.OS === 'ios') {
      iosIgnorePausedUntilRef.current = 0
    }
    isBufferingRef.current = false
    suppressTransientBufferingRef.current = false
    setIsLoading(false)
    // Sync JS state — playback may have been started by external controls
    // (PiP play button, notification controls, headset button)
    setIsPlaying(true)
    tryApplyPendingSeek()
  }, [clearStartupAutoplayGuard, tryApplyPendingSeek])

  const onPaused = useCallback(() => {
    if (Platform.OS === 'ios' && Date.now() < iosIgnorePausedUntilRef.current) {
      if (__DEV__) console.log('[VideoPlayerContext] Ignoring transient iOS paused event during source swap')
      return
    }
    const startupGuard = startupAutoplayGuardRef.current
    if (
      Platform.OS === 'android' &&
      startupGuard &&
      Date.now() <= startupGuard.until &&
      lastPlaybackStartKeyRef.current === startupGuard.key
    ) {
      setDesiredPlaying(true)
      try {
        getPlayerPort()?.play?.()
      } catch {}
      return
    }
    if (startupGuard && Date.now() > startupGuard.until) {
      clearStartupAutoplayGuard()
    }
    if (pipExitExpectedPlayingRef.current && !isInPipModeRef.current) {
      reassertNativePlayAfterPipExit('player-paused-during-pip-exit')

      if (Date.now() <= pipExitResumeUntilRef.current) {
        return
      }
      pipExitShouldResumeRef.current = false
      pipExitExpectedPlayingRef.current = false
    }
    if (seekConfirmRef.current && isPlayingRef.current) {
      if (__DEV__) console.log('[VideoPlayerContext] Ignoring transient paused event during seek')
      isBufferingRef.current = true
      try {
        getPlayerPort()?.play?.()
      } catch {}
      return
    }
    if (__DEV__) console.log('[VideoPlayerContext] Player paused')
    // Sync JS state for deliberate external pauses (PiP button, notification
    // pause, audio focus loss). Skip if the player is buffering — that's a
    // transient pause (e.g. after notification seek on uncached content) and
    // the player will auto-resume when data arrives. Setting isPlaying=false
    // during buffering would send paused={true} to the component, preventing
    // ExoPlayer from resuming.
    if (!isBufferingRef.current) {
      setIsPlaying(false)
      // A deliberate pause is a good resume point — persist it immediately.
      recordWatchProgressSafe(currentVideoRef.current, currentTimeRef.current, durationRef.current)
    }
  }, [clearStartupAutoplayGuard, getPlayerPort, reassertNativePlayAfterPipExit, setDesiredPlaying])

  const onBuffering = useCallback((data: { isBuffering: boolean }) => {
    if (__DEV__) console.log('[VideoPlayerContext] Player buffering:', data?.isBuffering)
    if (data?.isBuffering === undefined) return
    isBufferingRef.current = Boolean(data.isBuffering)

    // During an active seek, native players often emit a brief buffering event.
    // Don't show the "connecting P2P" loading overlay for that — it feels like
    // a network reload instead of a seek.
    if (seekConfirmRef.current) {
      if (!data.isBuffering) setIsLoading(false)
      return
    }

    // If the player is already advancing, a native buffering=true event means a
    // transient refill, not a new playback preparation. Keep the stats/details
    // visible instead of flipping the whole watch UI back to the loading gate.
    if (data.isBuffering && currentTimeRef.current > 0) {
      return
    }

    // Suppress transient buffering after returning from PiP or background audio.
    // ExoPlayer re-attaches its surface and fires brief buffering events.
    // Cleared by the next onPlaying event confirming real playback resumed.
    if (suppressTransientBufferingRef.current) {
      if (!data.isBuffering) setIsLoading(false)
      return
    }

    // During PiP transitions, the video surface can emit transient buffering
    // events as it resizes. Suppress the loading overlay during PiP enter/exit
    // so users don't see "connecting to P2P" flash on every PiP cycle.
    if (isInPipModeRef.current || pipTransitionInFlightRef.current || pipExitExpectedPlayingRef.current) {
      if (!data.isBuffering) setIsLoading(false)
      return
    }

    setIsLoading(data.isBuffering)
  }, [])

  const onEnded = useCallback(() => {
    if (__DEV__) console.log('[VideoPlayerContext] Player ended')
    isBufferingRef.current = false
    setDesiredPlaying(false)
    const video = currentVideoRef.current
    const durationS = durationRef.current
    if (video && durationS > 0) recordWatchProgressSafe(video, durationS, durationS)
  }, [setDesiredPlaying])

  const onError = useCallback((error: unknown) => {
    const classified = classifyPlayerError(error)
    if (__DEV__) {
      console.error('[VideoPlayerContext] Player error:', classified.code, error)
    }
    setIsLoading(false)
    if (!classified.terminal) return
    // The source itself cannot be decoded. Leaving desired playback on keeps
    // the startup re-assertions, and every later remount, re-arming a fetch of
    // bytes that were already rejected — so end the session and say why.
    // Same failure reported twice keeps the same object, so a repeat cannot
    // cascade re-renders through every session consumer.
    setPlaybackError((previous) => (
      previous?.code === classified.code
        ? previous
        : { code: classified.code, message: classified.message, terminal: true }
    ))
    // The startup re-assertions would otherwise keep re-declaring playback for
    // the next 750ms over a title that has stopped for good.
    clearStartupAutoplayGuard()
    setDesiredPlaying(false)
  }, [clearStartupAutoplayGuard, setDesiredPlaying])

  const onVideoStateChange = useCallback((data: { type?: string; mVideoWidth?: number; mVideoHeight?: number }) => {
    if (
      (data.type === 'onNewVideoLayout' || data.type === 'video-size') &&
      data.mVideoWidth &&
      data.mVideoHeight &&
      data.mVideoWidth > 0 &&
      data.mVideoHeight > 0
    ) {
      const aspectRatio = data.mVideoWidth / data.mVideoHeight
      if (__DEV__) console.log('[VideoPlayerContext] Video dimensions:', data.mVideoWidth, 'x', data.mVideoHeight, '- aspect ratio:', aspectRatio.toFixed(3))
      setVideoAspectRatio(aspectRatio)
      // PiP aspect ratio is handled natively by react-native-video
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

  const sessionValue = useMemo<VideoPlayerSessionContextType>(() => ({
    currentVideo,
    videoUrl,
    isPlaying,
    isLoading,
    playbackError,
    playerMode,
    videoStats,
    playbackSession,
    isInPipMode,
    setIsInPipMode,
    pipWindowSize,
    setPipWindowSize,
    shouldEnablePip,
    videoAspectRatio,
    playerRef,
  }), [
    currentVideo,
    videoUrl,
    isPlaying,
    isLoading,
    playbackError,
    playerMode,
    videoStats,
    playbackSession,
    isInPipMode,
    setIsInPipMode,
    pipWindowSize,
    shouldEnablePip,
    videoAspectRatio,
  ])

  const progressValue = useMemo<VideoPlayerProgressContextType>(() => ({
    currentTime,
    duration,
    progress,
    playbackRate,
    seekPosition,
  }), [currentTime, duration, progress, playbackRate, seekPosition])

  const actionsValue = useMemo<VideoPlayerActionsContextType>(() => ({
    loadAndPlayVideo,
    setAmbientVideoContext,
    pauseVideo,
    resumeVideo,
    closeVideo,
    enterBackgroundAudio,
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
    onLoaded,
    onPlaying,
    onPaused,
    onBuffering,
    onEnded,
    onError,
    onVideoStateChange,
  }), [
    loadAndPlayVideo, setAmbientVideoContext, pauseVideo, resumeVideo,
    closeVideo, enterBackgroundAudio, suppressForegroundRestoreOnce, suppressForegroundRestoreFor, clearLastClosedVideo, minimizePlayer, maximizePlayer, seekTo, seekBy, setPlaybackRate,
    onProgress, onLoaded, onPlaying, onPaused, onBuffering,
    onEnded, onError, onVideoStateChange,
  ])

  const contextValue = useMemo<VideoPlayerContextType>(() => ({
    ...sessionValue,
    ...progressValue,
    ...actionsValue,
  }), [actionsValue, progressValue, sessionValue])

  return (
    <VideoPlayerActionsContext.Provider value={actionsValue}>
      <VideoPlayerSessionContext.Provider value={sessionValue}>
        <VideoPlayerProgressContext.Provider value={progressValue}>
          <VideoPlayerContext.Provider value={contextValue}>
            {children}
          </VideoPlayerContext.Provider>
        </VideoPlayerProgressContext.Provider>
      </VideoPlayerSessionContext.Provider>
    </VideoPlayerActionsContext.Provider>
  )
}
