import { HybridView, HybridViewMethods, HybridViewProps } from 'react-native-nitro-modules'

/**
 * Video aspect ratio type.
 */
export type PlayerAspectRatio = 'ratio16x9' | 'ratio1x1' | 'ratio4x3' | 'ratio3x2' | 'ratio21x9' | 'ratio9x16'

/**
 * Video resize mode.
 */
export type PlayerResizeMode = 'fill' | 'contain' | 'cover' | 'none' | 'scale-down'

/**
 * VLC Player source configuration options.
 */
export interface VLCPlayerSource {
  /**
   * Media source URI to render.
   */
  uri: string

  /**
   * VLC Player initialization type.
   *
   * - Default configuration: `1`
   * - Custom configuration: `2`
   *
   * @default 1
   */
  initType?: 1 | 2

  /**
   * VLC Player initialization options.
   *
   * Example: `['--network-caching=50', '--rtsp-tcp']`
   *
   * If `repeat` is set on props this will default to `['--repeat']` unless
   * another `--repeat` or `--input-repeat` flag is passed.
   *
   * @default []
   */
  initOptions?: string[]
}

/**
 * Represents a track type in playback.
 */
export interface Track {
  /**
   * Track identification.
   */
  id: number

  /**
   * Track name.
   */
  name: string
}

/**
 * Represents playback video size.
 */
export interface VideoSize {
  /**
   * Video width.
   */
  width: number

  /**
   * Video height.
   */
  height: number
}

/**
 * Represents full playback information.
 */
export interface VideoInfo {
  /**
   * Total playback duration.
   */
  duration: number

  /**
   * Playback target.
   */
  target: number

  /**
   * Total playback video size.
   */
  videoSize: VideoSize

  /**
   * List of playback audio tracks.
   */
  audioTracks: Track[]

  /**
   * List of playback text tracks.
   */
  textTracks: Track[]
}

export interface OnPlayingEventProps {
  duration: number
  target: number
  seekable: boolean
}

export interface OnProgressEventProps {
  /**
   * Total playback duration.
   */
  duration: number

  /**
   * Playback target.
   */
  target: number

  /**
   * Current playback time.
   */
  currentTime: number

  /**
   * Current playback position.
   */
  position: number

  /**
   * Remaining time to end playback.
   */
  remainingTime: number
}

export interface SimpleCallbackEventProps {
  target: number
}

/**
 * Props passed through Fabric (minimal — only viewId).
 * All other configuration is done imperatively via methods to avoid
 * SIGSEGV/SIGABRT from CachedProp BorrowingReference destruction on bg threads.
 */
export interface NitroVLCProps extends HybridViewProps {
  /**
   * Unique view identifier for the registry lookup pattern.
   * Used by NitroVLCModule.getView() to retrieve the native view reference.
   */
  viewId: string
}

export interface NitroVLCMethods extends HybridViewMethods {
  // Playback control
  play(): void
  pause(): void
  stop(): void
  seek(position: number): void

  // Imperative property setters (moved off Fabric props)
  setSource(source: VLCPlayerSource): void
  setPaused(paused: boolean): void
  setLoop(loop: boolean): void
  setRate(rate: number): void
  setVolume(volume: number): void
  setMuted(muted: boolean): void
  setAudioTrack(audioTrack: number): void
  setTextTrack(textTrack: number): void
  setSubtitleUri(subtitleUri: string): void
  setPlayInBackground(playInBackground: boolean): void
  setVideoAspectRatio(videoAspectRatio: PlayerAspectRatio): void
  setAutoAspectRatio(autoAspectRatio: boolean): void
  setResizeMode(resizeMode: PlayerResizeMode): void
  setAutoplay(autoplay: boolean): void
  setAcceptInvalidCertificates(acceptInvalidCertificates: boolean): void

  // Imperative callback setters
  setOnPlaying(callback: (event: OnPlayingEventProps) => void): void
  setOnProgress(callback: (event: OnProgressEventProps) => void): void
  setOnPaused(callback: (event: SimpleCallbackEventProps) => void): void
  setOnStopped(callback: (event: SimpleCallbackEventProps) => void): void
  setOnBuffering(callback: (event: SimpleCallbackEventProps) => void): void
  setOnEnded(callback: (event: SimpleCallbackEventProps) => void): void
  setOnError(callback: (event: SimpleCallbackEventProps) => void): void
  setOnLoad(callback: (event: VideoInfo) => void): void
}

export type NitroVLCView = HybridView<NitroVLCProps, NitroVLCMethods>
