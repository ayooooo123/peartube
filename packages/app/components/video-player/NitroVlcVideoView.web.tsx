import type { RefObject } from 'react'
import type { StyleProp, ViewStyle } from 'react-native'

type Props = {
  style?: StyleProp<ViewStyle>
  playerRef?: RefObject<any>
  source: unknown
  paused?: boolean
  rate?: number
  volume?: number
  muted?: boolean
  seek?: number
  resizeMode?: string
  autoAspectRatio?: boolean
  playInBackground?: boolean
  onLoad?: (event: any) => void
  onProgress?: (event: any) => void
  onPlaying?: (event?: any) => void
  onPaused?: (event?: any) => void
  onBuffering?: (event: { isBuffering: boolean }) => void
  onEnded?: (event?: any) => void
  onError?: (event: any) => void
  onVideoStateChange?: (event: { type?: string; mVideoWidth?: number; mVideoHeight?: number }) => void
}

// Web/Pear cannot access NitroModules (JSI). Keep as a no-op.
export const NitroVlcVideoView: React.FC<Props> = () => null
