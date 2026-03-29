import { memo, ReactNode, RefObject } from 'react'
import { StyleProp, ViewStyle } from 'react-native'

type MpvMobileVideoViewProps = {
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
  onLoad?: (data: any) => void
  onProgress?: (data: any) => void
  onPlaying?: () => void
  onPaused?: () => void
  onBuffering?: (data: any) => void
  onEnded?: () => void
  onError?: (error: any) => void
  onVideoStateChange?: (data: any) => void
  children?: ReactNode
}

export const MpvMobileVideoView = memo(function MpvMobileVideoView(_props: MpvMobileVideoViewProps) {
  return null
})
