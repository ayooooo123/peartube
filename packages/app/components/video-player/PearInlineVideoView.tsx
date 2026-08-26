import { useEventListener } from 'expo'
import { VideoView, useVideoPlayer, type VideoPlayer, type VideoSource } from 'expo-video'
import { memo, ReactNode, RefObject, useCallback, useEffect, useMemo, useRef } from 'react'
import { AppState, AppStateStatus, Platform, StyleProp, StyleSheet, View, ViewStyle } from 'react-native'
import { createPlayerPort, type PlayerPort } from '@/lib/video-player'
import { classifyPlayerError } from '@/lib/video-player/playback-errors'
import { WebMseVideoBackend } from './WebMseVideoBackend'
import type { CompatPlaybackResult } from './WebMseVideoBackend.types'

type PearInlineVideoViewProps = {
  style?: StyleProp<ViewStyle>
  testID?: string
  playerRef: RefObject<PlayerPort | null>
  videoUrl: string
  playbackSession: number
  currentVideoKey?: string
  webPlaybackBackend?: 'native' | 'mse'
  requestCompatPlayback?: () => Promise<CompatPlaybackResult>
  isPlaying: boolean
  playbackRate: number
  seekPosition?: number
  isInPipMode?: boolean
  pipWindowSize?: { width: number; height: number } | null
  pipEnabled?: boolean
  autoEnterPipOnLeave?: boolean
  showNotificationControls?: boolean
  videoTitle?: string
  channelName?: string
  thumbnailUrl?: string | null
  onLoad?: (data: any) => void
  onProgress?: (data: any) => void
  onPlaying?: () => void
  onPaused?: () => void
  onBuffering?: (data: any) => void
  onEnded?: () => void
  onError?: (error: any) => void
  onVideoStateChange?: (data: any) => void
  onPictureInPictureChanged?: (event: { isInPictureInPicture: boolean; width: number; height: number }) => void
  children?: ReactNode
}

export function getPearInlinePlayerId(playbackSession: number, currentVideoKey?: string) {
  return `pear-inline-${playbackSession}-${currentVideoKey || 'video'}`
}

const ANDROID_BUFFER_OPTIONS = {
  minBufferForPlayback: 2.5,
  preferredForwardBufferDuration: 20,
  waitsToMinimizeStalling: true,
}
// iOS (AVPlayer) was using the default forward buffer, so for large P2P-streamed
// archives it would only read a little ahead and stall whenever the relay peers
// lagged. Match Android's 20s forward buffer and let AVPlayer wait to minimize
// stalling so it refills before resuming instead of stuttering block-by-block.
const IOS_BUFFER_OPTIONS = {
  preferredForwardBufferDuration: 20,
  waitsToMinimizeStalling: true,
}
const SEEK_PLAYBACK_RECOVERY_MS = 6000
// Fatal player errors used to leave the surface frozen forever. The common
// trigger is seeking into an uncached region of a P2P-streamed file: the blob
// server resets the HTTP range request when peers don't deliver the blocks in
// time, and the native player gives up with a network error. Re-attach the
// source and resume from the last position a few times before surfacing the
// error — by then the prioritized download usually has the seek target cached.
const PLAYBACK_ERROR_RECOVERY_MAX_ATTEMPTS = 4
const PLAYBACK_ERROR_RECOVERY_BASE_DELAY_MS = 1000
const PLAYBACK_ERROR_RECOVERY_PROGRESS_SEC = 2
// The playingChange/statusChange guards only run when the native player emits
// an event. A play() issued while the native/html element is mid source-replace
// can be dropped, leaving the player parked at readyToPlay + paused with no
// further events — so videos open frozen on the first frame. Poll the exposed
// HTML video ref and re-assert play with bounded backoff through slow P2P startup
// (0.1s through 6.4s; 12.7s total) until the first real play event arrives.
const AUTOPLAY_VERIFY_BASE_DELAY_MS = 100
const AUTOPLAY_VERIFY_MAX_ATTEMPTS = 7
const WEB_MEDIA_START_EVENTS = ['loadedmetadata', 'loadeddata', 'canplay'] as const

function getExpoEventDurationMs(data: any, player?: VideoPlayer | null) {
  const rawDurationSeconds = Number(data?.duration ?? player?.duration ?? 0)
  if (Number.isFinite(rawDurationSeconds) && rawDurationSeconds > 0) {
    return Math.round(rawDurationSeconds * 1000)
  }
  return 0
}

function getExpoEventVideoSize(data: any, player?: VideoPlayer | null) {
  const track = data?.videoTrack ?? player?.videoTrack
  const width = Number(data?.videoSize?.width ?? data?.width ?? data?.naturalSize?.width ?? track?.size?.width ?? track?.width)
  const height = Number(data?.videoSize?.height ?? data?.height ?? data?.naturalSize?.height ?? track?.size?.height ?? track?.height)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return undefined
  }
  return { width, height }
}

export const PearInlineVideoView = memo(function PearInlineVideoView({
  style,
  testID,
  playerRef,
  videoUrl,
  playbackSession,
  currentVideoKey,
  webPlaybackBackend = 'native',
  requestCompatPlayback,
  isPlaying,
  playbackRate,
  seekPosition,
  isInPipMode,
  onLoad,
  onProgress,
  onPlaying,
  onPaused,
  onBuffering,
  onEnded,
  onError,
  onVideoStateChange,
  onPictureInPictureChanged,
  autoEnterPipOnLeave = true,
  showNotificationControls = autoEnterPipOnLeave,
  videoTitle,
  channelName,
  thumbnailUrl,
  children,
}: PearInlineVideoViewProps) {
  const durationMsRef = useRef(0)
  const lastAppliedSeekRef = useRef<number | null>(null)
  const playbackStartedAtRef = useRef<number | null>(null)
  const hasAdvancedRef = useRef(false)
  const hasRenderedFrameRef = useRef(false)
  const hasReceivedPlayEventRef = useRef(false)
  const appStateRef = useRef<AppStateStatus>(AppState.currentState)
  const suppressStuckPlaybackRecoveryUntilRef = useRef(0)
  const pipExitPlayingRef = useRef(false)
  const wasInPipRef = useRef(isInPipMode)
  const playerRefForCallbacks = useRef<VideoPlayer | null>(null)
  const nativeVideoViewRef = useRef<any>(null)
  const webVideoEventTargetRef = useRef<HTMLVideoElement | null>(null)
  const previousStatusRef = useRef<string | null>(null)
  const seekPlaybackRecoveryUntilRef = useRef(0)
  const isPlayingRef = useRef(isPlaying)
  const playbackRateRef = useRef(playbackRate)
  const notificationControlsRef = useRef(showNotificationControls)
  const onErrorRef = useRef(onError)
  const onPausedRef = useRef(onPaused)
  const sourceReplaceGenerationRef = useRef(0)
  const lastPlaybackPositionSecRef = useRef(0)
  const errorRecoveryAttemptsRef = useRef(0)
  const errorRecoveryResumePositionRef = useRef(0)
  const errorRecoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Set to the vocabulary code once a failure is classified terminal: the
  // source itself cannot be decoded, so every automatic path that would fetch
  // or re-assert playback stops until a new source/session arrives.
  const terminalPlaybackErrorRef = useRef<string | null>(null)
  const autoplayVerifyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const webVideoStartListenersCleanupRef = useRef<(() => void) | null>(null)
  const useMseBackend = Platform.OS === 'web' && webPlaybackBackend === 'mse'

  const videoSource = useMemo<VideoSource>(() => ({
    uri: videoUrl,
    metadata: {
      title: videoTitle || undefined,
      artist: channelName || undefined,
      artwork: thumbnailUrl || undefined,
    },
  }), [channelName, thumbnailUrl, videoTitle, videoUrl])

  const player = useVideoPlayer(null, (nextPlayer) => {
    playerRefForCallbacks.current = nextPlayer
    nextPlayer.timeUpdateEventInterval = 0.5
    nextPlayer.loop = false
    nextPlayer.playbackRate = playbackRate
    nextPlayer.showNowPlayingNotification = showNotificationControls
    nextPlayer.staysActiveInBackground = showNotificationControls
    try {
      nextPlayer.bufferOptions = (Platform.OS === 'android'
        ? ANDROID_BUFFER_OPTIONS
        : IOS_BUFFER_OPTIONS) as any
    } catch {
      // Some Expo Video versions expose bufferOptions as read-only before source load.
    }
  })

  playerRefForCallbacks.current = player

  useEffect(() => {
    hasAdvancedRef.current = false
    hasRenderedFrameRef.current = false
    hasReceivedPlayEventRef.current = false
    playbackStartedAtRef.current = null
    lastAppliedSeekRef.current = null
    previousStatusRef.current = null
    seekPlaybackRecoveryUntilRef.current = 0
    lastPlaybackPositionSecRef.current = 0
    errorRecoveryAttemptsRef.current = 0
    errorRecoveryResumePositionRef.current = 0
    terminalPlaybackErrorRef.current = null
    if (errorRecoveryTimerRef.current) {
      clearTimeout(errorRecoveryTimerRef.current)
      errorRecoveryTimerRef.current = null
    }
    if (autoplayVerifyTimerRef.current) {
      clearTimeout(autoplayVerifyTimerRef.current)
      autoplayVerifyTimerRef.current = null
    }
    if (Platform.OS === 'web') {
      webVideoStartListenersCleanupRef.current?.()
      webVideoStartListenersCleanupRef.current = null
    }
    playerRefForCallbacks.current = player
  }, [player, videoUrl, playbackSession, currentVideoKey, webPlaybackBackend])

  useEffect(() => () => {
    if (errorRecoveryTimerRef.current) {
      clearTimeout(errorRecoveryTimerRef.current)
      errorRecoveryTimerRef.current = null
    }
    if (autoplayVerifyTimerRef.current) {
      clearTimeout(autoplayVerifyTimerRef.current)
      autoplayVerifyTimerRef.current = null
    }
    webVideoStartListenersCleanupRef.current?.()
    webVideoStartListenersCleanupRef.current = null
  }, [])

  useEffect(() => {
    isPlayingRef.current = isPlaying
  }, [isPlaying])

  useEffect(() => {
    playbackRateRef.current = playbackRate
  }, [playbackRate])

  useEffect(() => {
    notificationControlsRef.current = showNotificationControls
  }, [showNotificationControls])

  useEffect(() => {
    onErrorRef.current = onError
  }, [onError])

  useEffect(() => {
    onPausedRef.current = onPaused
  }, [onPaused])

  const clearAutoplayVerify = useCallback(() => {
    if (autoplayVerifyTimerRef.current) {
      clearTimeout(autoplayVerifyTimerRef.current)
      autoplayVerifyTimerRef.current = null
    }
  }, [])

  function getWebNativeVideoElement() {
    if (Platform.OS !== 'web') return null
    return nativeVideoViewRef.current?.nativeRef?.current ?? null
  }

  function attachWebVideoStartListeners() {
    if (Platform.OS !== 'web' || useMseBackend) return
    const webVideo = getWebNativeVideoElement()
    if (!webVideo || webVideoEventTargetRef.current === webVideo) return

    webVideoStartListenersCleanupRef.current?.()

    const handleStartupEvent = () => {
      if (!isPlayingRef.current || hasReceivedPlayEventRef.current) return
      requestNativePlayback()
      scheduleAutoplayVerify()
    }
    const handlePlaying = () => {
      if (isPlayingRef.current && !hasReceivedPlayEventRef.current) {
        scheduleAutoplayVerify()
      }
    }
    const handlePause = () => {
      if (hasReceivedPlayEventRef.current || !isPlayingRef.current) return
      requestNativePlayback()
      scheduleAutoplayVerify()
    }

    for (const eventName of WEB_MEDIA_START_EVENTS) {
      webVideo.addEventListener(eventName, handleStartupEvent)
    }
    webVideo.addEventListener('playing', handlePlaying)
    webVideo.addEventListener('pause', handlePause)
    webVideoEventTargetRef.current = webVideo
    webVideoStartListenersCleanupRef.current = () => {
      for (const eventName of WEB_MEDIA_START_EVENTS) {
        webVideo.removeEventListener(eventName, handleStartupEvent)
      }
      webVideo.removeEventListener('playing', handlePlaying)
      webVideo.removeEventListener('pause', handlePause)
      if (webVideoEventTargetRef.current === webVideo) {
        webVideoEventTargetRef.current = null
      }
    }
  }

  const requestNativePlayback = useCallback(() => {
    attachWebVideoStartListeners()
    const webVideo = getWebNativeVideoElement()
    if (webVideo) {
      try {
        const playResult = webVideo.play()
        playResult?.catch?.(() => {})
      } catch {
        // A blocked web play can be retried by the bounded verifier.
      }
      return
    }
    player.play()
  }, [player])

  const scheduleAutoplayVerify = useCallback((attempt: number = 0) => {
    if (terminalPlaybackErrorRef.current) return
    if (attempt === 0 && autoplayVerifyTimerRef.current) return
    clearAutoplayVerify()
    if (attempt >= AUTOPLAY_VERIFY_MAX_ATTEMPTS) {
      if (
        Platform.OS === 'web' &&
        isPlayingRef.current &&
        !hasReceivedPlayEventRef.current
      ) {
        const webVideo = getWebNativeVideoElement()
        if (webVideo?.paused) {
          isPlayingRef.current = false
          onPausedRef.current?.()
        }
      }
      return
    }
    autoplayVerifyTimerRef.current = setTimeout(() => {
      autoplayVerifyTimerRef.current = null
      if (hasReceivedPlayEventRef.current || !isPlayingRef.current) return
      const currentPlayer = playerRefForCallbacks.current
      if (!currentPlayer) return
      try {
        attachWebVideoStartListeners()
        const webVideo = getWebNativeVideoElement()
        if (webVideo) {
          if (webVideo.paused && !webVideo.ended) {
            const playResult = webVideo.play()
            playResult?.catch?.(() => {})
          }
        } else if (!currentPlayer.playing) {
          currentPlayer.play()
        }
      } catch {
        // The player can be mid source-replace or already released; the next
        // verification retries.
      }
      scheduleAutoplayVerify(attempt + 1)
    }, AUTOPLAY_VERIFY_BASE_DELAY_MS * 2 ** attempt)
  }, [clearAutoplayVerify])

  useEffect(() => {
    if (useMseBackend) return
    // Re-attaching a source the demuxer already rejected re-reads every byte
    // from the peer for the same answer.
    if (terminalPlaybackErrorRef.current) return
    let cancelled = false
    const generation = sourceReplaceGenerationRef.current + 1
    sourceReplaceGenerationRef.current = generation

    const applySource = async () => {
      try {
        if (typeof player.replaceAsync === 'function') {
          await player.replaceAsync(videoSource)
        } else {
          player.replace(videoSource)
        }

        if (cancelled || sourceReplaceGenerationRef.current !== generation) return

        player.playbackRate = playbackRateRef.current
        player.showNowPlayingNotification = notificationControlsRef.current
        player.staysActiveInBackground = notificationControlsRef.current
        if (isPlayingRef.current) {
          requestNativePlayback()
          scheduleAutoplayVerify()
        }
      } catch (error) {
        if (cancelled || sourceReplaceGenerationRef.current !== generation) return
        const message = error instanceof Error ? error.message : 'Failed to load video source'
        const code = typeof error === 'object' && error !== null && 'code' in error
          ? (error as { code?: unknown }).code
          : undefined
        onErrorRef.current?.({
          message,
          code,
          engine: 'expo-video',
        })
      }
    }

    void applySource()

    return () => {
      cancelled = true
    }
  }, [player, requestNativePlayback, scheduleAutoplayVerify, useMseBackend, videoSource])

  const shouldSuppressStuckPlaybackRecovery = useCallback(() => {
    if (Platform.OS !== 'android') return false
    if (isInPipMode) return true
    if (appStateRef.current !== 'active') return true
    return Date.now() <= suppressStuckPlaybackRecoveryUntilRef.current
  }, [isInPipMode])

  const applyPendingSeek = useCallback((nextSeekPosition: number | undefined, durationMsOverride?: number) => {
    if (nextSeekPosition === undefined) {
      lastAppliedSeekRef.current = null
      return
    }
    if (!Number.isFinite(nextSeekPosition)) return

    const durationMs = durationMsOverride ?? durationMsRef.current
    if (durationMs <= 0) return

    const clampedSeek = Math.max(0, Math.min(1, nextSeekPosition))
    const targetSeconds = Math.round(clampedSeek * durationMs) / 1000
    if (lastAppliedSeekRef.current === Math.round(targetSeconds * 1000)) return

    lastAppliedSeekRef.current = Math.round(targetSeconds * 1000)
    seekPlaybackRecoveryUntilRef.current = Date.now() + SEEK_PLAYBACK_RECOVERY_MS
    player.currentTime = Math.max(0, targetSeconds)
  }, [player])

  /**
   * Re-attach the current source and resume from the last playback position.
   * Returns false once the attempt budget is exhausted (attempts reset when
   * playback advances past the recovery point), letting the caller surface
   * the error instead.
   */
  const tryRecoverFromPlaybackError = useCallback(() => {
    if (terminalPlaybackErrorRef.current) return false
    if (errorRecoveryAttemptsRef.current >= PLAYBACK_ERROR_RECOVERY_MAX_ATTEMPTS) return false
    errorRecoveryAttemptsRef.current += 1
    const attempt = errorRecoveryAttemptsRef.current
    // Rewind slightly so resume lands on data that was already playable.
    const resumeAt = Math.max(0, lastPlaybackPositionSecRef.current - 0.5)
    errorRecoveryResumePositionRef.current = resumeAt
    const generation = sourceReplaceGenerationRef.current
    onBuffering?.({ isBuffering: true })
    if (errorRecoveryTimerRef.current) clearTimeout(errorRecoveryTimerRef.current)
    errorRecoveryTimerRef.current = setTimeout(() => {
      errorRecoveryTimerRef.current = null
      if (sourceReplaceGenerationRef.current !== generation || terminalPlaybackErrorRef.current) return
      void (async () => {
        try {
          if (typeof player.replaceAsync === 'function') {
            await player.replaceAsync(videoSource)
          } else {
            player.replace(videoSource)
          }
          if (sourceReplaceGenerationRef.current !== generation) return
          player.playbackRate = playbackRateRef.current
          if (resumeAt > 0) {
            seekPlaybackRecoveryUntilRef.current = Date.now() + SEEK_PLAYBACK_RECOVERY_MS
            player.currentTime = resumeAt
          }
          if (isPlayingRef.current) {
            requestNativePlayback()
          }
        } catch (recoveryError) {
          if (sourceReplaceGenerationRef.current !== generation) return
          if (!tryRecoverFromPlaybackErrorRef.current()) {
            onErrorRef.current?.({
              message: recoveryError instanceof Error ? recoveryError.message : 'Playback recovery failed',
              engine: 'expo-video',
            })
          }
        }
      })()
    }, PLAYBACK_ERROR_RECOVERY_BASE_DELAY_MS * attempt)
    return true
  }, [onBuffering, player, requestNativePlayback, videoSource])

  const tryRecoverFromPlaybackErrorRef = useRef(tryRecoverFromPlaybackError)
  useEffect(() => {
    tryRecoverFromPlaybackErrorRef.current = tryRecoverFromPlaybackError
  }, [tryRecoverFromPlaybackError])

  const adapter = useMemo(
    () => createPlayerPort(
      {
        play: async () => {
          requestNativePlayback()
        },
        pause: async () => {
          player.pause()
        },
        stop: async () => {
          player.pause()
          player.currentTime = 0
        },
        destroy: async () => {
          player.pause()
          player.showNowPlayingNotification = false
          player.staysActiveInBackground = false
          player.currentTime = 0
          if (typeof player.replaceAsync === 'function') {
            await player.replaceAsync(null)
          } else {
            player.replace(null)
          }
        },
        seek: async (timeSeconds: number) => {
          seekPlaybackRecoveryUntilRef.current = Date.now() + SEEK_PLAYBACK_RECOVERY_MS
          player.currentTime = Math.max(0, timeSeconds)
        },
        resume: async (playing: boolean) => {
          if (playing) {
            requestNativePlayback()
          } else {
            player.pause()
          }
        },
        enterPip: () => {
          // Expo Video PiP is controlled through VideoView props.
        },
        exitPictureInPicture: () => {
          // Expo Video PiP is controlled through VideoView props.
        },
      },
      {
        kind: 'native',
        capabilities: {
          pictureInPicture: Platform.OS === 'android',
          playbackRate: true,
          backgroundAudio: showNotificationControls,
        },
      },
    ),
    [player, requestNativePlayback, showNotificationControls],
  )

  useEffect(() => {
    if (useMseBackend) return
    player.playbackRate = playbackRate
  }, [player, playbackRate, useMseBackend])

  useEffect(() => {
    if (useMseBackend) return
    player.showNowPlayingNotification = showNotificationControls
    player.staysActiveInBackground = showNotificationControls
  }, [player, showNotificationControls, useMseBackend])

  useEffect(() => {
    if (useMseBackend) return
    isPlayingRef.current = isPlaying
    if (isPlaying) {
      requestNativePlayback()
      if (!hasReceivedPlayEventRef.current) {
        scheduleAutoplayVerify()
      }
    } else {
      player.pause()
    }
  }, [player, isPlaying, requestNativePlayback, scheduleAutoplayVerify, useMseBackend])

  useEffect(() => {
    if (useMseBackend) return
    applyPendingSeek(seekPosition)
  }, [applyPendingSeek, seekPosition, useMseBackend])

  useEffect(() => {
    if (Platform.OS !== 'android') return
    const subscription = AppState.addEventListener('change', (nextState) => {
      appStateRef.current = nextState
      if (nextState !== 'active') {
        suppressStuckPlaybackRecoveryUntilRef.current = Date.now() + 6000
        if (!autoEnterPipOnLeave) {
          void adapter.destroy?.()
        }
      }
    })
    return () => subscription.remove()
  }, [adapter, autoEnterPipOnLeave])

  useEffect(() => {
    if (!playerRef || useMseBackend) return
    playerRef.current = adapter
    return () => {
      if (playerRef.current === adapter) {
        playerRef.current = null
      }
    }
  }, [adapter, playerRef, useMseBackend])

  useEffect(() => {
    if (useMseBackend) return
    return () => {
      try {
        void adapter.destroy?.()
      } catch {
        // Best-effort cleanup only. Some native player refs are already disposed
        // while React tears down the playback surface.
      }
      if (playerRef.current === adapter) {
        playerRef.current = null
      }
    }
  }, [adapter, playerRef, useMseBackend])

  useEventListener(player, 'sourceLoad', (event) => {
    if (useMseBackend) return
    const durationMs = getExpoEventDurationMs(event, player)
    if (durationMs > 0) {
      durationMsRef.current = durationMs
      applyPendingSeek(seekPosition, durationMs)
    }

    const videoSize = getExpoEventVideoSize(event, player)
    onLoad?.({
      duration: durationMs / 1000,
      durationMs,
      videoSize,
      engine: 'expo-video',
    })

    if (videoSize) {
      hasRenderedFrameRef.current = true
      onVideoStateChange?.({
        type: 'video-size',
        mVideoWidth: videoSize.width,
        mVideoHeight: videoSize.height,
        engine: 'expo-video',
      })
    }
  })

  useEventListener(player, 'videoTrackChange', (event) => {
    if (useMseBackend) return
    const videoSize = getExpoEventVideoSize(event, player)
    if (!videoSize) return
    hasRenderedFrameRef.current = true
    onVideoStateChange?.({
      type: 'video-size',
      mVideoWidth: videoSize.width,
      mVideoHeight: videoSize.height,
      engine: 'expo-video',
    })
    onBuffering?.({ isBuffering: false })
  })

  useEventListener(player, 'timeUpdate', (event) => {
    if (useMseBackend) return
    const durationMs = Math.max(0, Math.round(Number(player.duration || 0) * 1000))
    if (durationMs > 0) durationMsRef.current = durationMs

    const currentTime = Math.max(0, Number(event.currentTime || 0))
    lastPlaybackPositionSecRef.current = currentTime
    if (
      errorRecoveryAttemptsRef.current > 0 &&
      currentTime > errorRecoveryResumePositionRef.current + PLAYBACK_ERROR_RECOVERY_PROGRESS_SEC
    ) {
      // Playback advanced past the recovery point — the stall is over, so a
      // future error gets a fresh attempt budget.
      errorRecoveryAttemptsRef.current = 0
    }
    const suppressStuckRecovery = shouldSuppressStuckPlaybackRecovery()
    if (suppressStuckRecovery && playbackStartedAtRef.current !== null) {
      playbackStartedAtRef.current = Date.now()
    }
    if (currentTime > 0.1) {
      hasAdvancedRef.current = true
      if (Platform.OS === 'web' && isPlayingRef.current && !hasReceivedPlayEventRef.current) {
        pipExitPlayingRef.current = false
        seekPlaybackRecoveryUntilRef.current = 0
        if (playbackStartedAtRef.current === null) {
          playbackStartedAtRef.current = Date.now()
        }
        onPlaying?.()
        hasReceivedPlayEventRef.current = true
        clearAutoplayVerify()
      }
    }

    onProgress?.({
      currentTime: Math.round(currentTime * 1000),
      duration: durationMs,
    })
  })

  useEventListener(player, 'playingChange', ({ isPlaying: nativePlaying }) => {
    if (useMseBackend) return
    if (nativePlaying && Platform.OS === 'web') {
      // expo-video web reports `playingChange` from HTMLMediaElement's optimistic
      // `play` event. Only the later DOM `playing` event proves media is advancing.
      attachWebVideoStartListeners()
      scheduleAutoplayVerify()
      return
    }
    if (nativePlaying && playbackStartedAtRef.current === null) {
      playbackStartedAtRef.current = Date.now()
    }
    if (nativePlaying) {
      hasReceivedPlayEventRef.current = true
      pipExitPlayingRef.current = false
      seekPlaybackRecoveryUntilRef.current = 0
      clearAutoplayVerify()
      onPlaying?.()
      return
    }

    if (!hasReceivedPlayEventRef.current && isPlayingRef.current && !terminalPlaybackErrorRef.current) {
      try {
        requestNativePlayback()
      } catch {
        // Best effort: keep JS desired playback state from being cancelled by
        // an expo-video paused event emitted before the first native play event.
      }
      return
    }
    if (pipExitPlayingRef.current) return
    if (Date.now() <= seekPlaybackRecoveryUntilRef.current && isPlayingRef.current) {
      onBuffering?.({ isBuffering: true })
      return
    }
    onPaused?.()
  })

  useEventListener(player, 'statusChange', ({ status, error }) => {
    if (useMseBackend) return
    if (status !== previousStatusRef.current) {
      previousStatusRef.current = status
      if (status === 'loading') {
        onBuffering?.({ isBuffering: true })
      } else if (status === 'readyToPlay') {
        onBuffering?.({ isBuffering: false })
        if (!hasReceivedPlayEventRef.current && isPlayingRef.current) {
          try {
            requestNativePlayback()
          } catch {
            // Best effort: Android can report readyToPlay while remaining
            // paused if play() was requested before the source was ready.
          }
        } else if (Date.now() <= seekPlaybackRecoveryUntilRef.current && isPlayingRef.current) {
          requestNativePlayback()
        }
      }
    }
    if (status === 'error') {
      const classified = classifyPlayerError(error)
      console.error('[PearInlineVideoView] error:', classified.code, error)
      if (!classified.terminal && tryRecoverFromPlaybackError()) return
      if (classified.terminal) {
        // Nothing about the bytes will differ on a second read, so stop here
        // instead of re-fetching the whole file every few seconds.
        terminalPlaybackErrorRef.current = classified.code
        if (errorRecoveryTimerRef.current) {
          clearTimeout(errorRecoveryTimerRef.current)
          errorRecoveryTimerRef.current = null
        }
        clearAutoplayVerify()
      }
      // Browsers surface fatal MediaError details under error.error. Forward the
      // nested code so the active route can select a compatible playback backend
      // when the native element cannot demux the source.
      const raw: unknown = error
      let code: number | undefined
      if (raw && typeof raw === 'object') {
        if ('code' in raw && typeof raw.code === 'number') code = raw.code
        if ('error' in raw && raw.error && typeof raw.error === 'object') {
          const nested = raw.error
          if (code === undefined && 'code' in nested && typeof nested.code === 'number') code = nested.code
        }
      }
      onError?.({
        message: classified.message,
        detail: classified.detail,
        code,
        errorCode: classified.code,
        terminal: classified.terminal,
        engine: 'expo-video',
      })
    }
  })

  useEventListener(player, 'playToEnd', () => {
    if (useMseBackend) return
    onEnded?.()
  })

  if (wasInPipRef.current && !isInPipMode) {
    pipExitPlayingRef.current = true
  }
  wasInPipRef.current = isInPipMode

  return (
    <View testID={testID} style={[styles.container, style]}>
      {useMseBackend ? (
        <WebMseVideoBackend
          videoUrl={videoUrl}
          style={StyleSheet.absoluteFill}
          playerRef={playerRef}
          requestCompatPlayback={requestCompatPlayback}
          isPlaying={isPlaying}
          playbackRate={playbackRate}
          onPlaying={onPlaying}
          onPaused={onPaused}
          onLoad={onLoad}
          onProgress={onProgress}
          onEnded={onEnded}
          onError={onError}
        />
      ) : (
        <VideoView
          ref={nativeVideoViewRef}
          player={player}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          nativeControls={false}
          surfaceType="surfaceView"
          allowsPictureInPicture={autoEnterPipOnLeave}
          startsPictureInPictureAutomatically={autoEnterPipOnLeave}
          onFirstFrameRender={() => {
            hasRenderedFrameRef.current = true
            onBuffering?.({ isBuffering: false })
            if (isPlayingRef.current) requestNativePlayback()
          }}
          onPictureInPictureStart={() => {
            suppressStuckPlaybackRecoveryUntilRef.current = Date.now() + 6000
            onPictureInPictureChanged?.({ isInPictureInPicture: true, width: 0, height: 0 })
          }}
          onPictureInPictureStop={() => {
            suppressStuckPlaybackRecoveryUntilRef.current = Date.now() + 6000
            onPictureInPictureChanged?.({ isInPictureInPicture: false, width: 0, height: 0 })
          }}
        />
      )}
      {children}
    </View>
  )
})

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: '#000',
  },
})
