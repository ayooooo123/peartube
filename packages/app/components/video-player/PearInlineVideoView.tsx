import { memo, ReactNode, RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Platform, StyleProp, StyleSheet, View, ViewStyle } from 'react-native'
import Video, {
  type OnLoadData,
  type OnProgressData,
  type OnBufferData,
  type VideoRef,
  type BufferConfig,
} from 'react-native-video'

type PearInlineVideoViewProps = {
  style?: StyleProp<ViewStyle>
  playerRef: RefObject<any>
  videoUrl: string
  playbackSession: number
  currentVideoKey?: string
  isPlaying: boolean
  playbackRate: number
  seekPosition?: number
  isInPipMode?: boolean
  pipWindowSize?: { width: number; height: number } | null
  pipEnabled?: boolean
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

/** Android buffer configuration following mediastorm reference */
const ANDROID_BUFFER_CONFIG: BufferConfig = {
  minBufferMs: 10000,
  maxBufferMs: 20000,
  bufferForPlaybackMs: 2500,
  bufferForPlaybackAfterRebufferMs: 5000,
  backBufferDurationMs: 10000,
}

function getEventVideoSize(data: any) {
  const width = Number(data?.videoSize?.width ?? data?.width ?? data?.naturalSize?.width ?? data?.mVideoWidth)
  const height = Number(data?.videoSize?.height ?? data?.height ?? data?.naturalSize?.height ?? data?.mVideoHeight)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return undefined
  }
  return { width, height }
}

function getEventDurationMs(data: any) {
  const rawDurationMs = Number(data?.durationMs)
  if (Number.isFinite(rawDurationMs) && rawDurationMs > 0) {
    return rawDurationMs
  }
  const rawDurationSeconds = Number(data?.duration)
  if (Number.isFinite(rawDurationSeconds) && rawDurationSeconds > 0) {
    return rawDurationSeconds * 1000
  }
  return 0
}

export const PearInlineVideoView = memo(function PearInlineVideoView({
  style,
  playerRef,
  videoUrl,
  playbackSession,
  currentVideoKey,
  isPlaying,
  playbackRate,
  seekPosition,
  onLoad,
  onProgress,
  onPlaying,
  onPaused,
  onBuffering,
  onEnded,
  onError,
  onVideoStateChange,
  onPictureInPictureChanged,
  children,
}: PearInlineVideoViewProps) {
  const videoRef = useRef<VideoRef>(null)
  const durationMsRef = useRef(0)
  const lastAppliedSeekRef = useRef<number | null>(null)

  // Stuck playback detection (from mediastorm reference)
  const [sourceKey, setSourceKey] = useState(0)
  const playbackStartedAtRef = useRef<number | null>(null)
  const hasAdvancedRef = useRef(false)
  const hasRenderedFrameRef = useRef(false)
  const reloadAttemptRef = useRef(0)
  const MAX_RELOAD_ATTEMPTS = 2
  const STUCK_THRESHOLD_MS = 4000
  const NO_RENDER_THRESHOLD_MS = 3000

  // Reset stuck detection on source change
  useEffect(() => {
    playbackStartedAtRef.current = null
    hasAdvancedRef.current = false
    hasRenderedFrameRef.current = false
    reloadAttemptRef.current = 0
    setSourceKey(0)
  }, [videoUrl])

  const applyPendingSeek = useCallback(async (nextSeekPosition: number | undefined, durationMsOverride?: number) => {
    if (nextSeekPosition === undefined) {
      lastAppliedSeekRef.current = null
      return
    }
    if (!Number.isFinite(nextSeekPosition)) return

    const durationMs = durationMsOverride ?? durationMsRef.current
    if (durationMs <= 0) return

    const clampedSeek = Math.max(0, Math.min(1, nextSeekPosition))
    const targetMs = Math.round(clampedSeek * durationMs)
    if (lastAppliedSeekRef.current === targetMs) return

    lastAppliedSeekRef.current = targetMs
    // react-native-video seek takes seconds
    videoRef.current?.seek(targetMs / 1000)
  }, [])

  const adapter = useMemo(
    () => ({
      play: async () => {
        videoRef.current?.resume?.()
      },
      pause: async () => {
        videoRef.current?.pause?.()
      },
      stop: async () => {
        videoRef.current?.pause?.()
        videoRef.current?.seek(0)
      },
      destroy: async () => {
        videoRef.current?.pause?.()
        videoRef.current?.seek(0)
      },
      seek: async (timeSeconds: number) => {
        videoRef.current?.seek(Math.max(0, timeSeconds))
      },
      resume: async (playing: boolean) => {
        if (playing) {
          videoRef.current?.resume?.()
        } else {
          videoRef.current?.pause?.()
        }
      },
      enterPip: () => {
        videoRef.current?.enterPictureInPicture()
      },
    }),
    [],
  )

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
    void applyPendingSeek(seekPosition)
  }, [applyPendingSeek, seekPosition])

  const handleLoad = useCallback((event: OnLoadData | any) => {
    const durationMs = getEventDurationMs(event)
    if (durationMs > 0) {
      durationMsRef.current = durationMs
      void applyPendingSeek(seekPosition, durationMs)
    }

    const videoSize = getEventVideoSize(event)
    onLoad?.({
      duration: typeof event?.duration === 'number' ? event.duration : durationMs / 1000,
      durationMs,
      videoSize,
      engine: event.engine,
    })

    if (videoSize) {
      onVideoStateChange?.({
        type: 'video-size',
        mVideoWidth: videoSize.width,
        mVideoHeight: videoSize.height,
        engine: event.engine,
      })
    }
  }, [applyPendingSeek, onLoad, onVideoStateChange, seekPosition])

  const handleProgress = useCallback((data: OnProgressData | any) => {
    const durationMs = Math.max(0, Math.round(Number(data?.seekableDuration ?? data?.duration ?? 0) * 1000))
    if (durationMs > 0) {
      durationMsRef.current = durationMs
    }

    // Stuck playback detection is only needed on the react-native-video path.
    if (Number(data?.currentTime) > 0.1) {
      if (!hasAdvancedRef.current) {
        hasAdvancedRef.current = true
      }
      if (
        !hasRenderedFrameRef.current &&
        playbackStartedAtRef.current !== null &&
        reloadAttemptRef.current < MAX_RELOAD_ATTEMPTS
      ) {
        const playingDuration = Date.now() - playbackStartedAtRef.current
        if (playingDuration > NO_RENDER_THRESHOLD_MS) {
          console.warn('[PearInlineVideoView] No video render detected — reloading', {
            attempt: reloadAttemptRef.current + 1,
          })
          reloadAttemptRef.current += 1
          playbackStartedAtRef.current = null
          hasAdvancedRef.current = false
          hasRenderedFrameRef.current = false
          setSourceKey((prev) => prev + 1)
          return
        }
      }
    } else if (playbackStartedAtRef.current !== null && !hasAdvancedRef.current) {
      const stuckDuration = Date.now() - playbackStartedAtRef.current
      if (stuckDuration > STUCK_THRESHOLD_MS && reloadAttemptRef.current < MAX_RELOAD_ATTEMPTS) {
        console.warn('[PearInlineVideoView] Stuck playback detected — reloading', {
          attempt: reloadAttemptRef.current + 1,
        })
        reloadAttemptRef.current += 1
        playbackStartedAtRef.current = null
        hasRenderedFrameRef.current = false
        setSourceKey((prev) => prev + 1)
        return
      }
    }

    onProgress?.({
      currentTime: Math.max(0, Math.round(Number(data?.currentTime || 0) * 1000)),
      duration: durationMs,
    })
  }, [onProgress])

  const handleBuffer = useCallback((data: OnBufferData | any) => {
    onBuffering?.({ isBuffering: Boolean(data?.isBuffering) })
  }, [onBuffering])

  const handleReadyForDisplay = useCallback(() => {
    hasRenderedFrameRef.current = true
    onBuffering?.({ isBuffering: false })
  }, [onBuffering])

  const handlePlaybackStateChanged = useCallback((state: { isPlaying: boolean; isSeeking: boolean }) => {
    if (state.isPlaying && !state.isSeeking && playbackStartedAtRef.current === null) {
      playbackStartedAtRef.current = Date.now()
    }
    if (state.isPlaying) {
      onPlaying?.()
    } else if (!state.isSeeking) {
      onPaused?.()
    }
  }, [onPlaying, onPaused])

  const handleEnd = useCallback(() => {
    onEnded?.()
  }, [onEnded])

  const handleError = useCallback((error: any) => {
    console.error('[PearInlineVideoView] error:', error)
    onError?.({
      message: error?.message || error?.error?.errorString || error?.error?.message || 'Unknown error',
      engine: error?.engine,
    })
  }, [onError])

  const handlePictureInPictureStatusChanged = useCallback((e: { isActive: boolean }) => {
    onPictureInPictureChanged?.({
      isInPictureInPicture: e.isActive,
      width: 0,
      height: 0,
    })
  }, [onPictureInPictureChanged])

  if (Platform.OS === 'web') {
    return null
  }

  return (
    <View style={[styles.container, style]}>
      <Video
        key={`rnv-${playbackSession}:${currentVideoKey || ''}:${sourceKey}`}
        ref={videoRef}
        source={{ uri: videoUrl }}
        style={StyleSheet.absoluteFill}
        onVideoSize={(data: any) => {
          const videoSize = getEventVideoSize(data)
          if (!videoSize) return
          onVideoStateChange?.({
            type: 'video-size',
            mVideoWidth: videoSize.width,
            mVideoHeight: videoSize.height,
          })
        }}
        paused={!isPlaying}
        rate={playbackRate}
        controls={false}
        resizeMode="contain"
        progressUpdateInterval={500}
        // TextureView for proper resizeMode support on Android
        useTextureView={Platform.OS === 'android'}
        // Callbacks
        onLoad={handleLoad}
        onProgress={handleProgress}
        onBuffer={handleBuffer}
        onEnd={handleEnd}
        onError={handleError}
        onReadyForDisplay={handleReadyForDisplay}
        onPlaybackStateChanged={handlePlaybackStateChanged}
        // PiP
        onPictureInPictureStatusChanged={handlePictureInPictureStatusChanged}
        // Background & PiP support
        playInBackground={true}
        playWhenInactive={true}
        // showNotificationControls MUST be false — PearTube has its own
        // MediaSession via expo-media-session. Enabling this creates a second
        // MediaSession that fights with ours (play/pause loop).
        showNotificationControls={false}
        // Buffer config for Android ExoPlayer
        bufferConfig={Platform.OS === 'android' ? ANDROID_BUFFER_CONFIG : undefined}
        // Suppress HLS "LIVE" indicator (PearTube uses HLS for VOD)
        controlsStyles={{ liveLabel: '' }}
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
