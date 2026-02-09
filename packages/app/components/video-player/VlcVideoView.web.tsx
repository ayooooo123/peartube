import { memo, type ReactNode, type RefObject } from 'react'
import type { StyleProp, ViewStyle } from 'react-native'

type VlcVideoViewProps = {
  style?: StyleProp<ViewStyle>
  playerRef: RefObject<any>
  videoUrl: string
  playbackSession: number
  currentVideoKey?: string
  isPlaying: boolean
  playbackRate: number
  vlcSeekPosition?: number
  networkCachingMs: number
  isInPipMode?: boolean
  pipWindowSize?: { width: number; height: number } | null
  videoAspectRatio?: number | null
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

// Web/Pear uses the mpv-based player path.
// This component must not import Nitro/VLC native modules on web.
export const VlcVideoView = memo(function VlcVideoView(_props: VlcVideoViewProps) {
  return null
})
