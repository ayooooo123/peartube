import { useEventListener } from 'expo'
import { VideoPlayer, VideoView, useVideoPlayer } from 'expo-video'
import { memo, ReactNode, RefObject, useCallback, useEffect, useMemo, useRef } from 'react'
import { AppState, AppStateStatus, Platform, StyleProp, StyleSheet, View, ViewStyle } from 'react-native'
import { createPlayerPort, type PlayerPort } from '@/lib/video-player'

type PearInlineVideoViewProps = {
  style?: StyleProp<ViewStyle>
  testID?: string
  playerRef: RefObject<PlayerPort | null>
  videoUrl: string
  playbackSession: number
  currentVideoKey?: string
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
  const previousStatusRef = useRef<string | null>(null)

  const player = useVideoPlayer({ uri: videoUrl, metadata: {
    title: videoTitle || undefined,
    artist: channelName || undefined,
    artwork: thumbnailUrl || undefined,
  } }, (nextPlayer) => {
    playerRefForCallbacks.current = nextPlayer
    nextPlayer.timeUpdateEventInterval = 0.5
    nextPlayer.loop = false
    nextPlayer.playbackRate = playbackRate
    nextPlayer.showNowPlayingNotification = showNotificationControls
    nextPlayer.staysActiveInBackground = showNotificationControls
    if (Platform.OS === 'android') {
      try {
        nextPlayer.bufferOptions = ANDROID_BUFFER_OPTIONS as any
      } catch {
        // Some Expo Video versions expose bufferOptions as read-only before source load.
      }
    }
    if (isPlaying) nextPlayer.play()
  })

  playerRefForCallbacks.current = player

  useEffect(() => {
    hasAdvancedRef.current = false
    hasRenderedFrameRef.current = false
    hasReceivedPlayEventRef.current = false
    playbackStartedAtRef.current = null
    lastAppliedSeekRef.current = null
    previousStatusRef.current = null
    playerRefForCallbacks.current = player
  }, [player, videoUrl, playbackSession, currentVideoKey])

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
    player.currentTime = Math.max(0, targetSeconds)
  }, [player])

  const adapter = useMemo(
    () => createPlayerPort(
      {
        play: async () => {
          player.play()
        },
        pause: async () => {
          player.pause()
        },
        stop: async () => {
          player.pause()
        },
        destroy: async () => {
          player.pause()
        },
        seek: async (timeSeconds: number) => {
          player.currentTime = Math.max(0, timeSeconds)
        },
        resume: async (playing: boolean) => {
          if (playing) {
            player.play()
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
    [player, showNotificationControls],
  )

  useEffect(() => {
    player.playbackRate = playbackRate
  }, [player, playbackRate])

  useEffect(() => {
    player.showNowPlayingNotification = showNotificationControls
    player.staysActiveInBackground = showNotificationControls
  }, [player, showNotificationControls])

  useEffect(() => {
    if (isPlaying) {
      player.play()
    } else {
      player.pause()
    }
  }, [player, isPlaying])

  useEffect(() => {
    applyPendingSeek(seekPosition)
  }, [applyPendingSeek, seekPosition])

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
    if (!playerRef) return
    playerRef.current = adapter
    return () => {
      if (playerRef.current === adapter) {
        playerRef.current = null
      }
    }
  }, [adapter, playerRef])

  useEffect(() => {
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
  }, [adapter, playerRef])

  useEventListener(player, 'sourceLoad', (event) => {
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
    const durationMs = Math.max(0, Math.round(Number(player.duration || 0) * 1000))
    if (durationMs > 0) durationMsRef.current = durationMs

    const currentTime = Math.max(0, Number(event.currentTime || 0))
    const suppressStuckRecovery = shouldSuppressStuckPlaybackRecovery()
    if (suppressStuckRecovery && playbackStartedAtRef.current !== null) {
      playbackStartedAtRef.current = Date.now()
    }
    if (currentTime > 0.1) {
      hasAdvancedRef.current = true
    }

    onProgress?.({
      currentTime: Math.round(currentTime * 1000),
      duration: durationMs,
    })
  })

  useEventListener(player, 'playingChange', ({ isPlaying: nativePlaying }) => {
    if (nativePlaying && playbackStartedAtRef.current === null) {
      playbackStartedAtRef.current = Date.now()
    }
    if (nativePlaying) {
      hasReceivedPlayEventRef.current = true
      pipExitPlayingRef.current = false
      onPlaying?.()
      return
    }

    if (Platform.OS === 'web' && !hasReceivedPlayEventRef.current) return
    if (pipExitPlayingRef.current) return
    onPaused?.()
  })

  useEventListener(player, 'statusChange', ({ status, error }) => {
    if (status !== previousStatusRef.current) {
      previousStatusRef.current = status
      if (status === 'loading') {
        onBuffering?.({ isBuffering: true })
      } else if (status === 'readyToPlay') {
        onBuffering?.({ isBuffering: false })
      }
    }
    if (status === 'error') {
      console.error('[PearInlineVideoView] error:', error)
      onError?.({
        message: error?.message || 'Unknown error',
        code: error?.code,
        engine: 'expo-video',
      })
    }
  })

  useEventListener(player, 'playToEnd', () => {
    onEnded?.()
  })

  if (wasInPipRef.current && !isInPipMode) {
    pipExitPlayingRef.current = true
  }
  wasInPipRef.current = isInPipMode

  return (
    <View testID={testID} style={[styles.container, style]}>
      <VideoView
        key={`expo-video-${playbackSession}:${currentVideoKey || ''}`}
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
      {children}
    </View>
  )
})

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
  },
})
