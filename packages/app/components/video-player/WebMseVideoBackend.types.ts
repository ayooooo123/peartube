import type React from 'react'

import type { PlayerPort } from '@/lib/video-player'

export type CompatPlaybackResult = {
  url?: string | null
  transcoded?: boolean
  transcodeError?: string | null
} | null | undefined

export type WebMseVideoBackendProps = {
  videoUrl: string
  style?: any
  isPlaying: boolean
  playbackRate?: number
  onProgress?: (data: { currentTime: number; duration: number }) => void
  onLoad?: (data?: any) => void
  onPlaying?: () => void
  onPaused?: () => void
  onEnded?: () => void
  onError?: (error: any) => void
  playerRef?: React.RefObject<PlayerPort | null>
  /**
   * Ask the backend for a compat (bare-ffmpeg) playback URL when this webview
   * cannot decode the source directly. Returns the webPreparePlayback result;
   * `transcoded: true` means `url` is a local fMP4-HLS stream to pull from.
   */
  requestCompatPlayback?: () => Promise<CompatPlaybackResult>
}
