import React, { RefObject, useEffect, useMemo, useRef } from 'react'
import { StyleProp, ViewStyle } from 'react-native'
import { NitroVLCView, NitroVLCModule } from 'react-native-nitro-vlc'
import type {
  NitroVLCMethods,
  VideoInfo,
  OnPlayingEventProps,
  OnProgressEventProps,
  SimpleCallbackEventProps,
  VLCPlayerSource,
  PlayerResizeMode,
} from 'react-native-nitro-vlc'

type Props = {
  style?: StyleProp<ViewStyle>
  playerRef?: RefObject<any>
  source: VLCPlayerSource
  paused?: boolean
  rate?: number
  volume?: number
  muted?: boolean
  seek?: number
  resizeMode?: PlayerResizeMode
  autoAspectRatio?: boolean
  playInBackground?: boolean
  onLoad?: (event: VideoInfo) => void
  onProgress?: (event: OnProgressEventProps) => void
  onPlaying?: (event?: OnPlayingEventProps) => void
  onPaused?: (event?: SimpleCallbackEventProps) => void
  onBuffering?: (event: { isBuffering: boolean }) => void
  onEnded?: (event?: SimpleCallbackEventProps) => void
  onError?: (event: SimpleCallbackEventProps) => void
  onVideoStateChange?: (event: { type?: string; mVideoWidth?: number; mVideoHeight?: number }) => void
}

let viewIdCounter = 0

export const NitroVlcVideoView: React.FC<Props> = ({
  style,
  playerRef,
  source,
  paused,
  rate,
  volume,
  muted,
  seek,
  resizeMode,
  autoAspectRatio,
  playInBackground,
  onLoad,
  onProgress,
  onPlaying,
  onPaused,
  onBuffering,
  onEnded,
  onError,
  onVideoStateChange,
}) => {
  // Stable viewId for the lifetime of this component instance
  const viewId = useRef(`vlc-${++viewIdCounter}`).current

  // Store all callbacks in refs so the imperative setters can always
  // call the latest version without needing to re-register
  const onLoadRef = useRef(onLoad)
  const onProgressRef = useRef(onProgress)
  const onPlayingRef = useRef(onPlaying)
  const onPausedRef = useRef(onPaused)
  const onBufferingRef = useRef(onBuffering)
  const onEndedRef = useRef(onEnded)
  const onErrorRef = useRef(onError)
  const onVideoStateChangeRef = useRef(onVideoStateChange)

  // Keep refs current
  onLoadRef.current = onLoad
  onProgressRef.current = onProgress
  onPlayingRef.current = onPlaying
  onPausedRef.current = onPaused
  onBufferingRef.current = onBuffering
  onEndedRef.current = onEnded
  onErrorRef.current = onError
  onVideoStateChangeRef.current = onVideoStateChange

  // Expose imperative methods via playerRef
  const viewObjRef = useRef<NitroVLCMethods | null>(null)
  const playerAdapter = useMemo(
    () => ({
      play: () => viewObjRef.current?.play?.(),
      pause: () => viewObjRef.current?.pause?.(),
      stop: () => viewObjRef.current?.stop?.(),
      seek: (position: number) => viewObjRef.current?.seek?.(position),
    }),
    []
  )

  useEffect(() => {
    if (playerRef) {
      playerRef.current = playerAdapter
    }
    return () => {
      if (playerRef?.current === playerAdapter) {
        playerRef.current = null
      }
    }
  }, [playerRef, playerAdapter])

  // Store prop values in refs for the setup function to read
  const sourceRef = useRef(source)
  const pausedRef = useRef(paused)
  const rateRef = useRef(rate)
  const volumeRef = useRef(volume)
  const mutedRef = useRef(muted)
  const seekRef = useRef(seek)
  const resizeModeRef = useRef(resizeMode)
  const autoAspectRatioRef = useRef(autoAspectRatio)
  const playInBackgroundRef = useRef(playInBackground)

  // Keep prop refs current
  sourceRef.current = source
  pausedRef.current = paused
  rateRef.current = rate
  volumeRef.current = volume
  mutedRef.current = muted
  seekRef.current = seek
  resizeModeRef.current = resizeMode
  autoAspectRatioRef.current = autoAspectRatio
  playInBackgroundRef.current = playInBackground

  // Get native view reference, set listeners and initial props imperatively.
  // This runs once per mount — callbacks use refs internally so
  // they always dispatch to the latest JS callback.
  useEffect(() => {
    let mounted = true
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    const startMs = Date.now()
    const maxWaitMs = 5000
    let didLogReady = false

    const setup = (attempt: number) => {
      if (!mounted) return

      let nativeView: NitroVLCMethods | undefined
      try {
        nativeView = NitroVLCModule.getView(viewId) as unknown as NitroVLCMethods | undefined
      } catch {
        nativeView = undefined
      }
      if (!nativeView) {
        const elapsed = Date.now() - startMs
        if (elapsed < maxWaitMs) {
          retryTimer = setTimeout(() => setup(attempt + 1), 50)
          return
        }
        if (__DEV__) {
          console.warn('[NitroVlcVideoView] native view not registered in time:', {
            viewId,
            attempts: attempt,
            waitedMs: elapsed,
          })
        }
        return
      }

      if (!mounted) return
      viewObjRef.current = nativeView
      if (__DEV__ && !didLogReady) {
        didLogReady = true
        console.log('[NitroVlcVideoView] native view ready:', {
          viewId,
          waitedMs: Date.now() - startMs,
          attempt,
        })
      }

      // Set listeners imperatively on the HybridObject.
      // These are stored as private vars on the native object,
      // NOT in Fabric ShadowNode props — safe from bg thread destruction.
      nativeView.setOnLoad((event: VideoInfo) => {
        onLoadRef.current?.(event)
        const width = event?.videoSize?.width
        const height = event?.videoSize?.height
        if (width && height) {
          onVideoStateChangeRef.current?.({
            type: 'onNewVideoLayout',
            mVideoWidth: width,
            mVideoHeight: height,
          })
        }
      })

      nativeView.setOnPlaying(() => {
        onBufferingRef.current?.({ isBuffering: false })
        onPlayingRef.current?.()
      })

      nativeView.setOnProgress((event: OnProgressEventProps) => {
        onProgressRef.current?.(event)
      })

      nativeView.setOnPaused(() => {
        onBufferingRef.current?.({ isBuffering: false })
        onPausedRef.current?.()
      })

      nativeView.setOnBuffering((event: SimpleCallbackEventProps) => {
        // Android: target carries buffering % (0-100); >= 100 means buffer full.
        // iOS: target is always 0 (buffering state only); onPlaying clears it.
        const isBuffering = event.target < 100
        onBufferingRef.current?.({ isBuffering })
      })

      nativeView.setOnEnded(() => {
        onEndedRef.current?.()
      })

      nativeView.setOnError((event: SimpleCallbackEventProps) => {
        onErrorRef.current?.(event)
      })

      nativeView.setOnStopped(() => {
        // no-op for now, matches previous behavior
      })

      // Configure value props FIRST (order matters — source reads these during loadMedia)
      nativeView.setPaused(pausedRef.current ?? false)
      nativeView.setRate(rateRef.current ?? 1)
      nativeView.setVolume(volumeRef.current ?? 1)
      nativeView.setMuted(mutedRef.current ?? false)
      nativeView.setResizeMode(resizeModeRef.current ?? 'contain')
      nativeView.setAutoAspectRatio(autoAspectRatioRef.current ?? false)
      nativeView.setPlayInBackground(playInBackgroundRef.current ?? false)

      // Source LAST — triggers loadMedia which reads above values
      nativeView.setSource(sourceRef.current)
    }

    // Small delay to ensure native view is mounted and registered
    retryTimer = setTimeout(() => setup(0), 16)

    return () => {
      mounted = false
      if (retryTimer) clearTimeout(retryTimer)
      viewObjRef.current = null
    }
  }, [viewId])

  // Individual useEffect hooks for prop changes after mount
  useEffect(() => {
    if (!viewObjRef.current) return
    viewObjRef.current.setPaused(paused ?? false)
  }, [paused])

  useEffect(() => {
    if (!viewObjRef.current) return
    viewObjRef.current.setRate(rate ?? 1)
  }, [rate])

  useEffect(() => {
    if (!viewObjRef.current) return
    viewObjRef.current.setVolume(volume ?? 1)
  }, [volume])

  useEffect(() => {
    if (!viewObjRef.current) return
    viewObjRef.current.setMuted(muted ?? false)
  }, [muted])

  useEffect(() => {
    if (!viewObjRef.current || seek === undefined) return
    viewObjRef.current.seek(seek)
  }, [seek])

  useEffect(() => {
    if (!viewObjRef.current) return
    viewObjRef.current.setResizeMode(resizeMode ?? 'contain')
  }, [resizeMode])

  useEffect(() => {
    if (!viewObjRef.current) return
    viewObjRef.current.setAutoAspectRatio(autoAspectRatio ?? false)
  }, [autoAspectRatio])

  useEffect(() => {
    if (!viewObjRef.current) return
    viewObjRef.current.setPlayInBackground(playInBackground ?? false)
  }, [playInBackground])

  // Only viewId and style go through Fabric — everything else is imperative
  return (
    <NitroVLCView
      collapsable={false}
      style={style as any}
      viewId={viewId}
    />
  )
}
