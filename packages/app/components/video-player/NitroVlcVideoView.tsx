import React, { RefObject, useCallback, useMemo, useRef } from 'react'
import { StyleProp, ViewStyle } from 'react-native'
import { NitroVLCView, callback } from 'react-native-nitro-vlc'
import type {
  NitroVLCProps,
  VideoInfo,
  OnPlayingEventProps,
  OnProgressEventProps,
  SimpleCallbackEventProps,
} from 'react-native-nitro-vlc'

type Props = {
  style?: StyleProp<ViewStyle>
  playerRef?: RefObject<any>
  source: NitroVLCProps['source']
  paused?: boolean
  rate?: number
  volume?: number
  muted?: boolean
  seek?: number
  resizeMode?: NitroVLCProps['resizeMode']
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
  // Store all callbacks in refs so the wrapper functions have stable identity.
  // This is critical: Nitro Views store JSI callback references in Fabric
  // Props/State via BorrowingReference<jsi::Value>. When callback identity
  // changes, old CachedProp is destroyed (potentially on a bg thread).
  // By using refs, the wrapped callback objects passed to native never change,
  // so CachedProp reuses the cached value (no BorrowingReference churn).
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

  // Stable handlers — empty dep arrays because they read from refs
  const handleLoad = useCallback((event: VideoInfo) => {
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
  }, [])

  const handlePlaying = useCallback(() => {
    onBufferingRef.current?.({ isBuffering: false })
    onPlayingRef.current?.()
  }, [])

  const handlePaused = useCallback(() => {
    onBufferingRef.current?.({ isBuffering: false })
    onPausedRef.current?.()
  }, [])

  const handleBuffering = useCallback(() => {
    onBufferingRef.current?.({ isBuffering: true })
  }, [])

  const handleProgress = useCallback((event: OnProgressEventProps) => {
    onProgressRef.current?.(event)
  }, [])

  const handleEnded = useCallback(() => {
    onEndedRef.current?.()
  }, [])

  const handleError = useCallback((event: SimpleCallbackEventProps) => {
    onErrorRef.current?.(event)
  }, [])

  // Nitro Views require callbacks wrapped as { f: func } objects because
  // React Native converts bare functions to `true` when passing to native.
  // These are stable because the handlers above never change identity.
  const wrappedOnLoad = useMemo(() => callback(handleLoad), [handleLoad])
  const wrappedOnPlaying = useMemo(() => callback(handlePlaying), [handlePlaying])
  const wrappedOnProgress = useMemo(() => callback(handleProgress), [handleProgress])
  const wrappedOnPaused = useMemo(() => callback(handlePaused), [handlePaused])
  const wrappedOnBuffering = useMemo(() => callback(handleBuffering), [handleBuffering])
  const wrappedOnEnded = useMemo(() => callback(handleEnded), [handleEnded])
  const wrappedOnError = useMemo(() => callback(handleError), [handleError])

  return (
    <NitroVLCView
      ref={playerRef}
      style={style as any}
      source={source}
      paused={paused}
      rate={rate}
      volume={volume}
      muted={muted}
      seek={seek}
      resizeMode={resizeMode}
      autoAspectRatio={autoAspectRatio}
      playInBackground={playInBackground}
      onLoad={wrappedOnLoad}
      onPlaying={wrappedOnPlaying}
      onProgress={wrappedOnProgress}
      onPaused={wrappedOnPaused}
      onBuffering={wrappedOnBuffering}
      onEnded={wrappedOnEnded}
      onError={wrappedOnError}
    />
  )
}
