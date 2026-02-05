import React, { RefObject, useCallback } from 'react'
import { StyleProp, ViewStyle } from 'react-native'
import { NitroVLCView } from 'react-native-nitro-vlc'
import type { NitroVLCProps, VideoInfo } from 'react-native-nitro-vlc'

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
  onLoad?: (event: any) => void
  onProgress?: (event: any) => void
  onPlaying?: () => void
  onPaused?: () => void
  onBuffering?: (event: { isBuffering: boolean }) => void
  onEnded?: () => void
  onError?: (event: any) => void
  onVideoStateChange?: (event: { type?: string; mVideoWidth?: number; mVideoHeight?: number }) => void
}

export const NitroVlcVideoView: React.FC<Props> = (props) => {
  const handleLoad = useCallback(
    (event: VideoInfo) => {
      props.onLoad?.(event)
      const width = event?.videoSize?.width
      const height = event?.videoSize?.height
      if (width && height) {
        props.onVideoStateChange?.({
          type: 'onNewVideoLayout',
          mVideoWidth: width,
          mVideoHeight: height,
        })
      }
    },
    [props]
  )

  const handlePlaying = useCallback(() => {
    props.onBuffering?.({ isBuffering: false })
    props.onPlaying?.()
  }, [props])

  const handlePaused = useCallback(() => {
    props.onBuffering?.({ isBuffering: false })
    props.onPaused?.()
  }, [props])

  const handleBuffering = useCallback(() => {
    props.onBuffering?.({ isBuffering: true })
  }, [props])

  return (
    <NitroVLCView
      ref={props.playerRef}
      style={props.style}
      source={props.source}
      paused={props.paused}
      rate={props.rate}
      volume={props.volume}
      muted={props.muted}
      seek={props.seek}
      resizeMode={props.resizeMode}
      autoAspectRatio={props.autoAspectRatio}
      playInBackground={props.playInBackground}
      onLoad={handleLoad}
      onPlaying={handlePlaying}
      onProgress={props.onProgress}
      onPaused={handlePaused}
      onBuffering={handleBuffering}
      onEnded={props.onEnded}
      onError={props.onError}
    />
  )
}
