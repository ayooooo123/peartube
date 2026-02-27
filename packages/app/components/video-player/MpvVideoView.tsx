import React, { RefObject, useEffect, useMemo, useRef } from 'react'
import { StyleProp, ViewStyle } from 'react-native'
import { MpvCommands, MpvPlayerSource, MpvPlayerView as NativeMpvPlayerView } from '../../../react-native-mpv/src'

const MpvPlayerHostView = NativeMpvPlayerView as any

type MpvPlayerProps = {
  style?: StyleProp<ViewStyle>
  source: MpvPlayerSource
  paused?: boolean
  rate?: number
  volume?: number
  muted?: boolean
  seek?: number
  resizeMode?: 'contain' | 'cover' | 'stretch'
  pipEnabled?: boolean
  onLoad?: (event: any) => void
  onProgress?: (event: any) => void
  onPlaying?: (event?: any) => void
  onPaused?: (event?: any) => void
  onBuffering?: (event: { isBuffering: boolean }) => void
  onEnded?: (event?: any) => void
  onError?: (event: any) => void
  onVideoStateChange?: (event: { type?: string; mVideoWidth?: number; mVideoHeight?: number }) => void
  onPictureInPictureChanged?: (event: { isInPictureInPicture: boolean; width: number; height: number }) => void
}

type Props = MpvPlayerProps & {
  playerRef?: RefObject<any>
}

export function MpvVideoView({
  style,
  playerRef,
  source,
  paused,
  rate,
  volume,
  muted,
  seek,
  resizeMode,
  pipEnabled,
  onLoad,
  onProgress,
  onPlaying,
  onPaused,
  onBuffering,
  onEnded,
  onError,
  onVideoStateChange,
  onPictureInPictureChanged,
}: Props) {
  const nativeRef = useRef<any>(null)

  const adapter = useMemo(() => ({
    play: () => MpvCommands.play(nativeRef.current),
    pause: () => MpvCommands.pause(nativeRef.current),
    stop: () => MpvCommands.stop(nativeRef.current),
    seek: (timeSeconds: number) => MpvCommands.seekToSeconds(nativeRef.current, timeSeconds),
    resume: (playing: boolean) => {
      if (playing) MpvCommands.play(nativeRef.current)
      else MpvCommands.pause(nativeRef.current)
    },
    startPiP: () => MpvCommands.startPiP(nativeRef.current),
    stopPiP: () => MpvCommands.stopPiP(nativeRef.current),
  }), [])

  useEffect(() => {
    if (!playerRef) return
    playerRef.current = adapter
    return () => {
      if (playerRef.current === adapter) {
        playerRef.current = null
      }
    }
  }, [playerRef, adapter])

  return (
    <MpvPlayerHostView
      ref={nativeRef}
      style={style as any}
      source={source}
      paused={paused ?? true}
      rate={rate ?? 1}
      volume={volume ?? 1}
      muted={muted ?? false}
      seek={seek ?? -1}
      resizeMode={resizeMode ?? 'contain'}
      pipEnabled={pipEnabled ?? false}
      onLoad={(event: any) => {
        onLoad?.(event.nativeEvent ?? event)
      }}
      onProgress={(event: any) => {
        onProgress?.(event.nativeEvent ?? event)
      }}
      onPlaying={(event: any) => {
        onBuffering?.({ isBuffering: false })
        onPlaying?.(event.nativeEvent ?? event)
      }}
      onPaused={(event: any) => {
        onBuffering?.({ isBuffering: false })
        onPaused?.(event.nativeEvent ?? event)
      }}
      onBuffering={(event: any) => {
        const payload = event.nativeEvent ?? event
        onBuffering?.({ isBuffering: (payload?.target ?? 0) < 100 })
      }}
      onEnded={(event: any) => {
        onEnded?.(event.nativeEvent ?? event)
      }}
      onError={(event: any) => {
        const payload = event.nativeEvent ?? event
        onError?.(payload)
      }}
      onVideoStateChange={(event: any) => {
        onVideoStateChange?.(event.nativeEvent ?? event)
      }}
      onPictureInPictureChanged={(event: any) => {
        onPictureInPictureChanged?.(event.nativeEvent ?? event)
      }}
    />
  )
}
