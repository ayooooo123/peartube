import { forwardRef } from 'react'

interface MpvPlayerProps {
  url: string
  autoPlay?: boolean
  onProgress?: (data: { currentTime: number; duration: number }) => void
  onPlaying?: () => void
  onPaused?: () => void
  onEnded?: () => void
  onError?: (error: string) => void
  onCanPlay?: () => void
  style?: any
}

export interface MpvPlayerRef {
  play: () => void
  pause: () => void
  seek: (time: number) => void
  getCurrentTime: () => number
  getDuration: () => number
}

export const MpvPlayer = forwardRef<MpvPlayerRef, MpvPlayerProps>(() => null)

MpvPlayer.displayName = 'MpvPlayer'

export default MpvPlayer
